//! 宿主命令路由（PLAN §9.2）：前端 `client.invoke(cmd, args)` 的对端。
//!
//! 设计要点：
//! - **transport 无关**：只依赖 `EventSink`（Tauri 外壳实现成 `emit`，测试实现成收集器），
//!   所以这一层能独立编译与测试，不必先把 tauri 拉起来；
//! - **runtime 边界显式**：需要模型/agent 循环的命令走 [`Runtime`] trait。rpi 尚未接入，
//!   默认实现 [`UnwiredRuntime`] 会把回合以 `agent_error(runtime_unavailable)` 收尾，
//!   而不是假装跑通——队列、落库、事件游标这些宿主职责照常工作；
//! - **审批在上层**：`git_commit` / `git_push` 到这里即视为已获授权（PLAN §6.6 的
//!   REQUIRE_APPROVAL 由 runtime 侧的工具执行钩子把关）；
//! - **事件游标**：(session_id, turn_index, seq) 三元组 + 环形缓冲，`resync` 按游标补发。
use crate::checkpoint::Checkpoints;
use crate::fsx::{Fs, ScanLimits};
use crate::gitx::Git;
use crate::ipc::{DuoEvent, Envelope, QueuedItem};
use crate::perms::{PermissionEngine, Policy, Rule, Scope};
use crate::store::{Store, StoreError};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

/// 前端 Commands 接口的全部成员；`hub_commands_cover_frontend_surface` 测试拿它与 protocol.ts 对照
pub const COMMANDS: &[&str] = &[
    "answer_question",
    "approve_tool_call",
    "compact_now",
    "fs_preview",
    "fs_scan",
    "fs_search",
    "fs_tree",
    "git_commit",
    "git_diff",
    "git_generate_message",
    "git_push",
    "git_stage",
    "git_status",
    "git_unstage",
    "snapshot_list",
    "jobs_list",
    "mcp_delete",
    "mcp_list",
    "mcp_retry",
    "mcp_toggle",
    "mcp_upsert",
    "permission_set",
    "provider_delete",
    "provider_list",
    "provider_test",
    "provider_upsert",
    "queue_action",
    "redo_step",
    "resync",
    "revert_to_message",
    "session_create",
    "session_delete",
    "session_export",
    "session_fork",
    "session_list",
    "session_load",
    "session_rename",
    "session_restore",
    "set_mode",
    "skill_list",
    "set_model",
    "settings_get",
    "settings_set",
    "skill_delete",
    "skill_toggle",
    "skill_upsert",
    "skin_apply",
    "skin_import",
    "skin_list",
    "stop_agent",
    "submit_frontend_result",
    "submit_message",
    "submit_steering",
    "terminal_close",
    "terminal_open",
    "terminal_resize",
    "terminal_write",
];

#[derive(Debug, thiserror::Error)]
pub enum HubError {
    #[error("未知命令：{0}")]
    Unknown(String),
    #[error("参数不合法：{0}")]
    BadArgs(String),
    #[error("存储：{0}")]
    Store(#[from] StoreError),
    #[error("sqlite：{0}")]
    Sql(#[from] rusqlite::Error),
    #[error("git：{0}")]
    Git(String),
    #[error("checkpoint：{0}")]
    Checkpoint(String),
    #[error("文件系统：{0}")]
    Fs(String),
    #[error("MCP：{0}")]
    Mcp(String),
    #[error("runtime 未接入：{0}")]
    NoRuntime(String),
    #[error("该能力属可选 feature，默认未打包：{0}")]
    FeatureOff(String),
    #[error("尚未实现：{0}")]
    Unsupported(String),
    #[error("网络：{0}")]
    Net(String),
}

/// 事件出口。Tauri 外壳实现为 `app.emit("duo://event", env)`。
pub trait EventSink: Send + Sync {
    fn emit(&self, env: &Envelope);
}

pub struct NullSink;
impl EventSink for NullSink {
    fn emit(&self, _env: &Envelope) {}
}

/// 测试用：把事件收下来断言
#[derive(Default)]
pub struct CollectSink {
    pub events: Mutex<Vec<DuoEvent>>,
}
impl EventSink for CollectSink {
    fn emit(&self, env: &Envelope) {
        lock(&self.events).push(env.payload.clone());
    }
}

/// agent runtime 边界（rpi 接入后由 adapt 层实现）
pub trait Runtime: Send + Sync {
    fn submit(&self, session_id: &str, text: &str, mode: &str, model: &str) -> Result<(), String>;
    fn stop(&self, session_id: &str) -> bool;
    fn answer(&self, question_id: &str, answers: &[String]);
    fn resolve_approval(&self, call_id: &str, decision: &str, modified_args: Option<Value>) -> bool;
    fn compact(&self, session_id: &str) -> Result<(), String>;
    /// 回合中插话（steering）：rpi 循环在工具批次边界 drain。duo_id 用于投递映射与对账。
    /// 返回 false = 会话未激活。
    fn steer(&self, _session_id: &str, _duo_id: &str, _text: &str) -> bool {
        false
    }
    /// 回合尾追加（follow-up）：循环本会停止后再起一轮。返回 false = 会话未激活。
    fn follow_up(&self, _session_id: &str, _duo_id: &str, _text: &str) -> bool {
        false
    }
    /// 队列展示被 hub 侧改写（编辑/删除/提升）后，从 rpi 队列撤下旧文本。
    fn cancel_queued(&self, _session_id: &str, _text: &str) {}
}

/// 默认实现：rpi 未接入。宿主职责照常，回合立即以 runtime_unavailable 收尾。
pub struct UnwiredRuntime;
impl Runtime for UnwiredRuntime {
    fn submit(&self, _s: &str, _t: &str, _m: &str, _mo: &str) -> Result<(), String> {
        Err("runtime_unavailable".into())
    }
    fn stop(&self, _s: &str) -> bool {
        false
    }
    fn answer(&self, _q: &str, _a: &[String]) {}
    fn resolve_approval(&self, _c: &str, _d: &str, _m: Option<Value>) -> bool {
        false
    }
    fn compact(&self, _s: &str) -> Result<(), String> {
        Err("runtime_unavailable".into())
    }
}

/// 宿主侧真实作业（扫描 / 压缩 / MCP 连接）。右栏「后台任务」面板的数据源，
/// 不是前端计数器 —— 只有真的起跑过才有记录，起止时间与错误都来自实际执行。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: u64,
    /// scan | compact | mcp
    pub kind: String,
    pub label: String,
    /// running | done | error
    pub status: String,
    pub scanned: u64,
    pub total: u64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct Queues {
    pub main: Vec<QueuedItem>,
    pub steering: Vec<QueuedItem>,
    pub follow_up: Vec<QueuedItem>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct Hub {
    pub store: Arc<Store>,
    pub workdir: PathBuf,
    pub data_dir: PathBuf,
    git: Git,
    ckpt: Checkpoints,
    fs: Fs,
    engine: Mutex<PermissionEngine>,
    sink: Arc<dyn EventSink>,
    runtime: Arc<dyn Runtime>,
    seq: AtomicU64,
    turn: AtomicU32,
    queues: Mutex<HashMap<String, Queues>>,
    ring: Mutex<VecDeque<Envelope>>,
    index: Mutex<Vec<crate::fsx::FileEntry>>,
    clients: Mutex<HashMap<String, Arc<crate::mcp::McpClient>>>,
    jobs: Mutex<Vec<Job>>,
    job_seq: AtomicU64,
}

impl Hub {
    pub fn open(
        store: Arc<Store>,
        workdir: impl Into<PathBuf>,
        data_dir: impl Into<PathBuf>,
        sink: Arc<dyn EventSink>,
        runtime: Arc<dyn Runtime>,
    ) -> Result<Arc<Self>, HubError> {
        let workdir = workdir.into();
        let data_dir = data_dir.into();
        std::fs::create_dir_all(&data_dir).map_err(|e| HubError::Fs(e.to_string()))?;
        let hub = Arc::new(Self {
            engine: Mutex::new(PermissionEngine::new()),
            git: Git::new(workdir.clone()),
            ckpt: Checkpoints::for_repo(&workdir, &data_dir.join("ckpt")),
            fs: Fs::new(workdir.clone()),
            store,
            workdir,
            data_dir,
            sink,
            runtime,
            seq: AtomicU64::new(0),
            turn: AtomicU32::new(0),
            queues: Mutex::new(HashMap::new()),
            ring: Mutex::new(VecDeque::new()),
            index: Mutex::new(Vec::new()),
            clients: Mutex::new(HashMap::new()),
            jobs: Mutex::new(Vec::new()),
            job_seq: AtomicU64::new(1),
        });
        hub.reload_engine()?;
        Ok(hub)
    }

    /* ---------------- 事件出口 ---------------- */

    pub fn emit(&self, ev: DuoEvent) {
        let name = event_name(&ev);
        let env = Envelope {
            name,
            payload: ev,
            turn_index: self.turn.load(Ordering::Relaxed),
            seq: self.seq.fetch_add(1, Ordering::Relaxed) + 1,
            ts: now_ms(),
        };
        {
            let mut ring = lock(&self.ring);
            if ring.len() >= 512 {
                ring.pop_front();
            }
            ring.push_back(env.clone());
        }
        self.sink.emit(&env);
    }

    /// 断流补齐：返回 (turn_index, seq) 游标之后的事件
    pub fn replay_since(&self, turn_index: u32, since_seq: u64) -> Vec<Envelope> {
        lock(&self.ring)
            .iter()
            .filter(|e| (e.turn_index, e.seq) > (turn_index, since_seq))
            .cloned()
            .collect()
    }

    pub fn seq(&self) -> u64 {
        self.seq.load(Ordering::Relaxed)
    }

    /// adapt 层事件出口用：全局单调 seq（payload 内的 seq 与 Envelope 游标同源，
    /// 多会话并行时前端 store 的全局 lastSeq 判序才不会误丢）
    pub fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Turn 游标推进（Envelope.turn_index 由此而来；rpi 的 TurnStart 时 +1）
    pub fn set_turn(&self, turn: u32) {
        self.turn.store(turn, Ordering::Relaxed);
    }

    /// 「始终允许此类」：落库 global 层 auto 规则并即时重建引擎。
    /// call 级去重由调用方保证（同一工具名重复确认时才写）。
    pub fn add_auto_allow(&self, tool: &str) -> Result<(), HubError> {
        let tool = tool.to_string();
        let id = new_id();
        let now = now_ms();
        self.store.writer.submit_blocking(move |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO tool_permissions(id, scope, scope_ref, tool, policy, matcher, updated_at)
                 VALUES(?3, 'global', '', ?1, 'auto', NULL, ?2)",
                rusqlite::params![tool, now, id],
            )?;
            Ok(())
        })?;
        self.reload_engine()
    }

    /// 队列条目消费对账：rpi drain 掉的 steering/follow-up 从展示队列删除并重发快照。
    pub fn drop_queue_items(&self, sid: &str, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        {
            let mut q = lock(&self.queues);
            if let Some(entry) = q.get_mut(sid) {
                entry.steering.retain(|x| !ids.contains(&x.id));
                entry.follow_up.retain(|x| !ids.contains(&x.id));
            }
        }
        self.persist_queue(sid);
        self.emit_queue(sid);
    }

    /* ---------------- 权限 ---------------- */

    fn reload_engine(&self) -> Result<(), HubError> {
        let db = self.store.read();
        let rows = select_json(
            &db,
            "SELECT scope, scope_ref, tool, policy, matcher, exceptions FROM tool_permissions",
            &[],
        )?;
        let mut eng = PermissionEngine::new();
        for r in rows {
            let scope = match r["scope"].as_str().unwrap_or("global") {
                "project" => Scope::Project,
                "session" => Scope::Session,
                "agent" => Scope::Agent,
                _ => Scope::Global,
            };
            let matcher: Option<crate::perms::Matcher> = r
                .get("matcher")
                .and_then(|m| serde_json::from_str(m.as_str().unwrap_or("null")).ok())
                .flatten();
            let exceptions: Vec<crate::perms::Exception> = r
                .get("exceptions")
                .and_then(|e| serde_json::from_str(e.as_str().unwrap_or("[]")).ok())
                .unwrap_or_default();
            eng.put(Rule::build(
                scope,
                r["scope_ref"].as_str().unwrap_or_default().to_string(),
                r["tool"].as_str().unwrap_or_default().to_string(),
                parse_policy(r["policy"].as_str().unwrap_or("require_approval")),
                matcher,
                exceptions,
            ));
        }
        *lock(&self.engine) = eng;
        Ok(())
    }

    /// runtime 的工具执行钩子调这里：命中最严格者生效，返回给审批卡用的规则说明
    pub fn decide(&self, mode: &str, call: &crate::perms::Call) -> crate::perms::Decision {
        lock(&self.engine).decide(mode, call)
    }

    /// 队列快照（测试与 runtime 钩子都从这里读，避免暴露 Mutex）
    pub fn queues_for(&self, sid: &str) -> Queues {
        lock(&self.queues).get(sid).cloned().unwrap_or_default()
    }

    pub fn ring_len(&self) -> usize {
        lock(&self.ring).len()
    }

    pub fn job_start(&self, kind: &str, label: &str) -> u64 {
        let id = self.job_seq.fetch_add(1, Ordering::Relaxed);
        let mut jobs = lock(&self.jobs);
        jobs.push(Job {
            id,
            kind: kind.to_string(),
            label: label.to_string(),
            status: "running".into(),
            scanned: 0,
            total: 0,
            started_at: now_ms(),
            ended_at: None,
            error: None,
        });
        if jobs.len() > 50 {
            let cut = jobs.len() - 50;
            jobs.drain(0..cut);
        }
        id
    }

    pub fn job_progress(&self, id: u64, scanned: u64, total: u64) {
        if let Some(j) = lock(&self.jobs).iter_mut().find(|j| j.id == id) {
            j.scanned = scanned;
            j.total = total;
        }
    }

    pub fn job_finish(&self, id: u64, err: Option<String>) {
        if let Some(j) = lock(&self.jobs).iter_mut().find(|j| j.id == id) {
            j.status = if err.is_some() { "error" } else { "done" }.into();
            j.ended_at = Some(now_ms());
            j.error = err;
        }
    }

    fn jobs_list(&self) -> Result<Value, HubError> {
        let jobs = lock(&self.jobs).iter().rev().cloned().collect::<Vec<_>>();
        Ok(json!({ "jobs": jobs }))
    }

    /// 应用退出 / 停用时回收所有子进程组（PLAN §8「退出即回收」）
    pub fn shutdown_mcp(&self) {
        let mut c = lock(&self.clients);
        for client in c.values() {
            client.shutdown();
        }
        c.clear();
    }

    pub fn mcp_tool_names(&self, server: &str) -> Vec<String> {
        lock(&self.clients).get(server).map(|c| c.tools().into_iter().map(|t| t.qualified).collect()).unwrap_or_default()
    }

    /* ---------------- 命令入口 ---------------- */

    pub fn handle(&self, cmd: &str, args: Value) -> Result<Value, HubError> {
        let a = args;
        match cmd {
            "session_list" => self.session_list(&a),
            "session_create" => self.session_create(&a),
            "session_rename" => self.session_rename(&a),
            "session_delete" => self.session_delete(&a),
            "session_restore" => self.session_restore(&a),
            "session_fork" => self.session_fork(&a),
            "session_export" => self.session_export(&a),
            "session_load" => self.session_load(&a),
            "permission_set" => self.permission_set(&a),
            "skill_upsert" | "skill_delete" | "skill_toggle" => self.skills(cmd, &a),
            "mcp_upsert" | "mcp_delete" | "mcp_toggle" | "mcp_retry" => self.mcp(cmd, &a),
            "mcp_list" => self.mcp_list(),
            "skill_list" => self.skill_list(),
            "snapshot_list" => self.snapshot_list(&a),
            "jobs_list" => self.jobs_list(),
            "provider_upsert" | "provider_delete" => self.providers(cmd, &a),
            "provider_test" => self.provider_test(&a),
            "provider_list" => self.provider_list(),
            "fs_scan" => self.fs_scan(),
            "fs_tree" => self.fs_tree(&a),
            "fs_preview" => self.fs_preview(&a),
            "fs_search" => self.fs_search(&a),
            "git_status" => self.git_status(),
            "git_diff" => self.git_diff(&a),
            "git_stage" => self.git_stage(&a, false),
            "git_unstage" => self.git_stage(&a, true),
            "git_commit" => self.git_commit(&a),
            "git_push" => self.git_push(),
            "git_generate_message" => self.git_generate_message(),
            "revert_to_message" => self.revert_to_message(&a),
            "redo_step" => self.redo_step(&a),
            "submit_message" => self.submit_message(&a),
            "submit_steering" => self.submit_steering(&a),
            "queue_action" => self.queue_action(&a),
            "approve_tool_call" => Ok(json!({ "resolved": self.runtime.resolve_approval(
                s(&a, "call_id"),
                s(&a, "decision"),
                a.get("modified_args").cloned(),
            ) })),
            "answer_question" => {
                self.runtime.answer(s(&a, "question_id"), &str_array(&a, "answers"));
                Ok(json!({ "ok": true }))
            }
            "stop_agent" => {
                let sid = s(&a, "session_id").to_string();
                // runtime 有真回合在跑时,终态由事件流的 agent_end 给;否则(未接入/空闲)在这里立即收尾
                if !self.runtime.stop(&sid) {
                    self.emit(DuoEvent::AgentEnd { session_id: sid, reason: crate::ipc::EndReason::Stopped, summary: None });
                }
                Ok(json!({ "ok": true }))
            }
            "submit_frontend_result" => Ok(json!({ "ok": true })),
            "compact_now" => match self.runtime.compact(s(&a, "session_id")) {
                Ok(()) => Ok(json!({ "ok": true })),
                Err(e) => Ok(json!({ "ok": false, "reason": e })),
            },
            "set_mode" | "set_model" => self.set_mode_model(&a, cmd),
            "settings_get" => Ok(self.ui_get(&a)),
            "settings_set" => self.ui_set(&a),
            "skin_list" => self.skin_list(),
            "skin_apply" => self.skin_apply(&a),
            "skin_import" => self.skin_import(&a),
            "resync" => {
                let turn = a["turn_index"].as_u64().unwrap_or(0) as u32;
                let since = a["since_seq"].as_u64().unwrap_or(0);
                let events = self.replay_since(turn, since);
                Ok(json!({ "count": events.len(), "replayed": events.len() }))
            }
            "terminal_open" | "terminal_write" | "terminal_resize" | "terminal_close" => Err(HubError::FeatureOff(
                "内嵌终端（xterm feature）默认不打包".into(),
            )),
            other if COMMANDS.contains(&other) => Err(HubError::Unsupported(other.into())),
            other => Err(HubError::Unknown(other.into())),
        }
    }

    /* ---------------- 会话 ---------------- */

    fn session_list(&self, a: &Value) -> Result<Value, HubError> {
        let limit = a["limit"].as_u64().unwrap_or(200) as i64;
        let query = a["query"].as_str().unwrap_or("").to_string();
        let like = format!("%{query}%");
        let project = a["project_id"].as_str().unwrap_or("").to_string();
        let mut sql = String::from(
            "SELECT s.id, s.project_id, s.title, s.mode, s.model, s.status, s.pinned, s.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages
             FROM sessions s WHERE s.deleted_at IS NULL",
        );
        let mut ps: Vec<&dyn rusqlite::ToSql> = Vec::new();
        if !project.is_empty() {
            sql.push_str(" AND s.project_id = ?");
            ps.push(&project);
        }
        if !query.is_empty() {
            // 标题或正文全文（FTS5）；两个占位符都用同一个关键词
            // FTS 命中按 part_id 回连（parts_fts 的 rowid 与 parts.rowid 无对应关系）
            sql.push_str(" AND (s.title LIKE ? OR EXISTS (SELECT 1 FROM messages m JOIN parts p ON p.message_id = m.id WHERE m.session_id = s.id AND p.id IN (SELECT part_id FROM parts_fts WHERE parts_fts MATCH ?)))");
            ps.push(&like);
            ps.push(&like);
        }
        sql.push_str(" ORDER BY s.updated_at DESC LIMIT ?");
        ps.push(&limit);
        let db = self.store.read();
        let rows = select_json(&db, &sql, &ps).map_err(HubError::Sql)?;
        Ok(json!({ "sessions": rows }))
    }

    fn session_create(&self, a: &Value) -> Result<Value, HubError> {
        let id = new_id();
        // 单项目桌面：省略 project_id = 当前工作区（前端不感知宿主路径）
        let project = a["project_id"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| self.workdir.display().to_string());
        let title = a["title"].as_str().filter(|s| !s.is_empty()).unwrap_or("新会话").to_string();
        let mode = a["mode"].as_str().unwrap_or("ask").to_string();
        let now = now_ms();
        self.store
            .writer
            .submit_blocking({
                let (id, project, title, mode) = (id.clone(), project.clone(), title.clone(), mode.clone());
                move |conn| {
                    // sessions.project_id 有 FK，先确保项目行存在（宿主侧项目 = 工作区目录）
                    conn.execute(
                        "INSERT OR IGNORE INTO projects(id, path, name, is_git, created_at) VALUES(?1,?1,?2,?3,?4)",
                        rusqlite::params![project, project.rsplit('/').next().unwrap_or(&project), conn_is_git(&project) as i64, now],
                    )?;
                    conn.execute(
                        "INSERT INTO sessions(id, project_id, title, mode, created_at, updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
                        rusqlite::params![id, project, title, mode, now],
                    )
                }
            })
            .map_err(HubError::from)?;
        let out = json!({ "id": id, "title": title, "mode": mode, "created_at": now });
        self.emit(DuoEvent::SessionUpdated {
            session_id: out["id"].as_str().unwrap_or_default().to_string(),
            title: out["title"].as_str().map(str::to_string),
            updated_at: now,
            activity: crate::ipc::Activity::Idle,
        });
        Ok(out)
    }

    fn session_rename(&self, a: &Value) -> Result<Value, HubError> {
        let id = s(a, "session_id").to_string();
        let title = s(a, "title").to_string();
        let now = now_ms();
        self.store
            .writer
            .submit_blocking({
                let (id, title) = (id.clone(), title.clone());
                move |conn| conn.execute("UPDATE sessions SET title=?1, updated_at=?2 WHERE id=?3", rusqlite::params![title, now, id])
            })
            .map_err(HubError::from)?;
        self.emit(DuoEvent::SessionUpdated { session_id: id, title: Some(title), updated_at: now, activity: crate::ipc::Activity::Idle });
        Ok(json!({ "ok": true }))
    }

    fn session_delete(&self, a: &Value) -> Result<Value, HubError> {
        let id = s(a, "session_id").to_string();
        let now = now_ms();
        self.store
            .writer
            .submit_blocking({
                let id = id.clone();
                move |conn| conn.execute("UPDATE sessions SET deleted_at=?1 WHERE id=?2", rusqlite::params![now, id])
            })
            .map_err(HubError::from)?;
        // 附件缓存与检查点按 PLAN §11 M3 的软删语义在 30 天后统一回收
        self.emit(DuoEvent::SessionUpdated { session_id: id, title: None, updated_at: now, activity: crate::ipc::Activity::Idle });
        Ok(json!({ "ok": true, "deleted_at": now }))
    }

    fn session_restore(&self, a: &Value) -> Result<Value, HubError> {
        let id = s(a, "session_id").to_string();
        self.store
            .writer
            .submit_blocking(move |conn| conn.execute("UPDATE sessions SET deleted_at=NULL WHERE id=?1", rusqlite::params![id]))
            .map_err(HubError::from)?;
        Ok(json!({ "ok": true }))
    }

    fn session_fork(&self, a: &Value) -> Result<Value, HubError> {
        let src = s(a, "session_id").to_string();
        let new = new_id();
        let now = now_ms();
        self.store
            .writer
            .submit_blocking({
                let new = new.clone();
                move |conn| {
                let (project, title, mode): (String, String, String) = conn.query_row(
                    "SELECT project_id, title, mode FROM sessions WHERE id=?1",
                    rusqlite::params![src],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                conn.execute(
                    "INSERT INTO sessions(id, project_id, title, mode, created_at, updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
                    rusqlite::params![new, project, format!("{title} (fork)"), mode, now],
                )?;
                // 复制消息与 parts（新 id，保持 seq 与内容）
                let ps: Vec<&dyn rusqlite::ToSql> = vec![&src];
            let msgs = select_json(conn, "SELECT id FROM messages WHERE session_id=?1 ORDER BY created_at", &ps)?;
                for m in msgs {
                    let old_mid = m["id"].as_str().unwrap_or_default().to_string();
                    let new_mid = new_id();
                    let (role, turn, created): (String, Option<i64>, i64) = conn.query_row(
                        "SELECT role, turn_index, created_at FROM messages WHERE id=?1",
                        rusqlite::params![old_mid],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )?;
                    conn.execute(
                        "INSERT INTO messages(id, session_id, role, turn_index, created_at) VALUES(?1,?2,?3,?4,?5)",
                        rusqlite::params![new_mid, new, role, turn, created],
                    )?;
                    let pp: Vec<&dyn rusqlite::ToSql> = vec![&old_mid];
                    let parts = select_json(conn, "SELECT id, seq, type, content FROM parts WHERE message_id=?1 ORDER BY seq", &pp)?;
                    for p in parts {
                        conn.execute(
                            "INSERT INTO parts(id, message_id, seq, type, content, created_at, updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",
                            rusqlite::params![
                            new_id(),
                            new_mid,
                            p["seq"].as_i64().unwrap_or(0),
                            p["type"].as_str().unwrap_or("text").to_string(),
                            p["content"].as_str().unwrap_or("{}").to_string(),
                            now
                        ],
                        )?;
                    }
                }
                Ok(())
                }
            })
            .map_err(HubError::from)?;
        Ok(json!({ "id": new }))
    }

    fn session_export(&self, a: &Value) -> Result<Value, HubError> {
        let id = s(a, "session_id").to_string();
        let rows = self.store.read().submit(|conn| {
            select_json(
                conn,
                "SELECT m.id, m.role, m.created_at, p.seq, p.type, p.content FROM messages m
                 LEFT JOIN parts p ON p.message_id = m.id WHERE m.session_id=?1
                 ORDER BY m.created_at, p.seq",
                &[&id as &dyn rusqlite::ToSql],
            )
        })?;
        let mut md = String::from("# duo session\n\n");
        let mut last = "";
        for r in &rows {
            let mid = r["id"].as_str().unwrap_or_default();
            if mid != last {
                md.push_str(&format!("\n## {} · {}\n\n", r["role"].as_str().unwrap_or("?"), r["created_at"].as_i64().unwrap_or(0)));
                last = mid;
            }
            match r["type"].as_str().unwrap_or("") {
                "text" => md.push_str(r["content"].get("md").and_then(Value::as_str).unwrap_or_default()),
                "reasoning" => md.push_str(&format!("\n> {}\n", r["content"].get("text").and_then(Value::as_str).unwrap_or_default())),
                "tool" => md.push_str(&format!("\n```\n{} {}\n```\n", r["content"].get("tool").and_then(Value::as_str).unwrap_or("tool"), r["content"].get("state").and_then(Value::as_str).unwrap_or(""))),
                _ => {}
            }
        }
        Ok(json!({ "markdown": md, "bytes": md.len() }))
    }

    fn session_load(&self, a: &Value) -> Result<Value, HubError> {
        let id = s(a, "session_id").to_string();
        let limit = a["limit"].as_u64().unwrap_or(50) as i64;
        let rows = self.store.read().submit(|conn| {
            let ps: Vec<&dyn rusqlite::ToSql> = vec![&id, &limit];
            let msgs = select_json(conn, "SELECT * FROM messages WHERE session_id=?1 ORDER BY created_at DESC LIMIT ?2", &ps)?;
            let mut out = Vec::new();
            for m in msgs {
                let mid = m["id"].as_str().unwrap_or_default().to_string();
                let pp: Vec<&dyn rusqlite::ToSql> = vec![&mid];
                let parts = select_json(conn, "SELECT * FROM parts WHERE message_id=?1 ORDER BY seq", &pp)?;
                let mut msg = m.clone();
                msg["parts"] = Value::Array(parts);
                out.push(msg);
            }
            out.reverse();
            Ok(out)
        })?;
        Ok(json!({ "messages": rows }))
    }

    /* ---------------- 权限 ---------------- */

    fn permission_set(&self, a: &Value) -> Result<Value, HubError> {
        let scope = s(a, "scope").to_string();
        let scope_ref = a["scope_ref"].as_str().unwrap_or_default().to_string();
        let tool = s(a, "tool").to_string();
        let policy = s(a, "policy").to_string();
        let matcher = a.get("matcher").map(|m| m.to_string()).unwrap_or_default();
        let exceptions = a["exceptions"].to_string();
        let id = new_id();
        let now = now_ms();
        self.store
            .writer
            .submit_blocking({
                let id = id.clone();
                move |conn| {
                conn.execute(
                    "INSERT INTO tool_permissions(id, scope, scope_ref, tool, policy, matcher, exceptions, updated_at)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                     ON CONFLICT(scope, IFNULL(scope_ref,''), tool) DO UPDATE SET
                       policy=excluded.policy, matcher=excluded.matcher, exceptions=excluded.exceptions, updated_at=excluded.updated_at",
                    rusqlite::params![id, scope, scope_ref, tool, policy, matcher, exceptions, now],
                )
                }
            })
            .map_err(HubError::from)?;
        self.reload_engine()?;
        Ok(json!({ "ok": true, "id": id }))
    }

    /* ---------------- skills / mcp / providers ---------------- */

    fn skills(&self, cmd: &str, a: &Value) -> Result<Value, HubError> {
        match cmd {
            "skill_upsert" => {
                let id = a["id"].as_str().map(str::to_string).unwrap_or_else(new_id);
                let command = s(a, "command").to_string();
                let name = a["name"].as_str().unwrap_or_default().to_string();
                let description = a["description"].as_str().unwrap_or_default().to_string();
                let prompt = s(a, "system_prompt").to_string();
                let model = a["model"].as_str().map(str::to_string);
                let variant = a["variant"].as_str().map(str::to_string);
                let scope = a["scope"].as_str().unwrap_or("global").to_string();
                let path = a["path"].as_str().map(str::to_string);
                let enabled = a["enabled"].as_bool().unwrap_or(true);
                let now = now_ms();
                self.store
                    .writer
                    .submit_blocking({
                        let id = id.clone();
                        move |conn| {
                        conn.execute(
                            "INSERT INTO skills(id, command, name, description, system_prompt, model, variant, scope, path, enabled, updated_at)
                             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                             ON CONFLICT(command, scope, IFNULL(path,'')) DO UPDATE SET
                               name=excluded.name, description=excluded.description, system_prompt=excluded.system_prompt,
                               model=excluded.model, variant=excluded.variant, enabled=excluded.enabled, updated_at=excluded.updated_at",
                            rusqlite::params![id, command, name, description, prompt, model, variant, scope, path, enabled, now],
                        )
                        }
                    })
                    .map_err(HubError::from)?;
                Ok(json!({ "id": id }))
            }
            "skill_delete" => {
                let id = s(a, "id").to_string();
                self.store
                    .writer
                    .submit_blocking(move |conn| conn.execute("DELETE FROM skills WHERE id=?1", rusqlite::params![id]))
                    .map_err(HubError::from)?;
                Ok(json!({ "ok": true }))
            }
            _ => {
                let id = s(a, "id").to_string();
                let enabled = a["enabled"].as_bool().unwrap_or(true);
                self.store
                    .writer
                    .submit_blocking(move |conn| conn.execute("UPDATE skills SET enabled=?1, updated_at=?2 WHERE id=?3", rusqlite::params![enabled, now_ms(), id]))
                    .map_err(HubError::from)?;
                Ok(json!({ "ok": true }))
            }
        }
    }

    fn mcp(&self, cmd: &str, a: &Value) -> Result<Value, HubError> {
        let name = a["name"].as_str().unwrap_or_else(|| a["id"].as_str().unwrap_or("")).to_string();
        match cmd {
            "mcp_upsert" => {
                let spec: crate::mcp::ServerSpec = serde_json::from_value(a["spec"].clone())
                    .map_err(|e| HubError::BadArgs(format!("server 配置：{e}")))?;
                let config = serde_json::to_string(&spec).unwrap_or_default();
                let id = a["id"].as_str().map(str::to_string).unwrap_or_else(new_id);
                self.store
                    .writer
                    .submit_blocking({
                        let name = spec.name.clone();
                        move |conn| {
                            conn.execute(
                                "INSERT INTO mcp_servers(id, name, transport, config, enabled, status, updated_at)
                                 VALUES(?1,?2,?3,?4,1,'connecting',?5)
                                 ON CONFLICT(name) DO UPDATE SET transport=excluded.transport, config=excluded.config, status='connecting', updated_at=excluded.updated_at",
                                rusqlite::params![id, name, format!("{:?}", spec.transport).to_lowercase(), config, now_ms()],
                            )
                        }
                    })
                    .map_err(HubError::from)?;
                self.connect_mcp(&name)
            }
            "mcp_delete" => {
                self.store
                    .writer
                    .submit_blocking({
                        let n = name.clone();
                        move |conn| conn.execute("DELETE FROM mcp_servers WHERE name=?1", rusqlite::params![n])
                    })
                    .map_err(HubError::from)?;
                lock(&self.clients).remove(&name);
                Ok(json!({ "ok": true }))
            }
            "mcp_toggle" => {
                let enabled = a["enabled"].as_bool().unwrap_or(true);
                self.store
                    .writer
                    .submit_blocking({
                        let n = name.clone();
                        move |conn| {
                            conn.execute(
                                "UPDATE mcp_servers SET enabled=?1, status=?2, updated_at=?3 WHERE name=?4",
                                rusqlite::params![enabled, if enabled { "connecting" } else { "disabled" }, now_ms(), n],
                            )
                        }
                    })
                    .map_err(HubError::from)?;
                if enabled {
                    self.connect_mcp(&name)
                } else {
                    self.emit(DuoEvent::McpStatus { server: name.clone(), status: crate::ipc::McpState::Disabled, tools: 0, error: None });
                    Ok(json!({ "ok": true }))
                }
            }
            _ => self.connect_mcp(&name),
        }
    }

    fn connect_mcp(&self, name: &str) -> Result<Value, HubError> {
        let nm = name.to_string();
        let ps: Vec<&dyn rusqlite::ToSql> = vec![&nm];
        let db = self.store.read();
        let row = select_json(&db, "SELECT config, enabled FROM mcp_servers WHERE name=?1", &ps)
            .map_err(HubError::Sql)?
            .into_iter()
            .next()
            .ok_or_else(|| HubError::BadArgs(format!("没有名为 {name} 的 server")))?;
        let spec: crate::mcp::ServerSpec =
            serde_json::from_str(row["config"].as_str().unwrap_or("{}")).map_err(|e| HubError::BadArgs(e.to_string()))?;
        let client = Arc::new(crate::mcp::McpClient::new(spec, self.data_dir.join("cache")));
        match client.connect() {
            Ok(tools) => {
                self.emit(DuoEvent::McpStatus {
                    server: name.to_string(),
                    status: crate::ipc::McpState::Connected,
                    tools: tools.len() as u32,
                    error: None,
                });
                lock(&self.clients).insert(name.to_string(), client);
                let _ = self.store.writer.submit_blocking({
                    let n = name.to_string();
                    let cnt = tools.len() as u32;
                    move |conn| conn.execute("UPDATE mcp_servers SET status='connected', tools=?2 WHERE name=?1", rusqlite::params![n, cnt])
                });
                Ok(json!({ "status": "connected", "tools": tools.iter().map(|t| t.qualified.clone()).collect::<Vec<_>>() }))
            }
            Err(e) => {
                let delay = client.next_restart().map(|d| d.as_secs() * 1000);
                self.emit(DuoEvent::McpStatus {
                    server: name.to_string(),
                    status: if client.status() == crate::mcp::Status::NeedsAuth { crate::ipc::McpState::NeedsAuth } else { crate::ipc::McpState::Failed },
                    tools: 0,
                    error: Some(e.to_string()),
                });
                let _ = self.store.writer.submit_blocking({
                    let n = name.to_string();
                    let msg = e.to_string();
                    move |conn| conn.execute("UPDATE mcp_servers SET status='failed', last_error=?2 WHERE name=?1", rusqlite::params![n, msg])
                });
                Ok(json!({ "status": "failed", "reason": e.to_string(), "retry_in_ms": delay }))
            }
        }
    }

    fn providers(&self, cmd: &str, a: &Value) -> Result<Value, HubError> {
        match cmd {
            "provider_upsert" => {
                let id = a["id"].as_str().map(str::to_string).unwrap_or_else(new_id);
                let name = s(a, "name").to_string();
                let base = s(a, "base_url").to_string();
                let key_ref = a["key_ref"].as_str().map(str::to_string);
                let models = a["models"].to_string();
                self.store
                    .writer
                    .submit_blocking({
                        let (id, key_ref) = (id.clone(), key_ref.clone());
                        move |conn| {
                        conn.execute(
                            "INSERT INTO providers(id, name, base_url, key_ref, models, created_at) VALUES(?1,?2,?3,?4,?5,?6)
                             ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, key_ref=excluded.key_ref, models=excluded.models",
                            rusqlite::params![id, name, base, key_ref, models, now_ms()],
                        )
                        }
                    })
                    .map_err(HubError::from)?;
                // 密钥只进 keychain（宿主侧由系统钥匙串实现），这里只留引用名
                Ok(json!({ "id": id, "key_ref": key_ref }))
            }
            _ => {
                let id = s(a, "id").to_string();
                self.store
                    .writer
                    .submit_blocking(move |conn| conn.execute("DELETE FROM providers WHERE id=?1", rusqlite::params![id]))
                    .map_err(HubError::from)?;
                Ok(json!({ "ok": true }))
            }
        }
    }

    /* ---------------- 只读列表：MCP / Skills / 检查点 / 作业 ---------------- */

    /// MCP server 全量：DB 行 + **活客户端的实时状态与工具名**（停用/未连接时以库为准）
    fn mcp_list(&self) -> Result<Value, HubError> {
        let db = self.store.read();
        let rows = select_json(&db, "SELECT id, name, transport, config, enabled, status, tools, last_error, updated_at FROM mcp_servers ORDER BY name", &[])?;
        let live = lock(&self.clients);
        let out: Vec<Value> = rows
            .into_iter()
            .map(|mut r| {
                let name = r["name"].as_str().unwrap_or_default().to_string();
                if let Some(c) = live.get(&name) {
                    r["status"] = json!(format!("{:?}", c.status()).to_lowercase());
                    let tools = c.tools();
                    r["tools"] = json!(tools.len());
                    r["toolNames"] = json!(tools.iter().map(|t| t.qualified.clone()).collect::<Vec<_>>());
                    r["stderrTail"] = json!(c.stderr_tail());
                } else {
                    r["toolNames"] = json!([]);
                    r["stderrTail"] = json!("");
                }
                r
            })
            .collect();
        Ok(json!({ "servers": out }))
    }

    fn skill_list(&self) -> Result<Value, HubError> {
        let db = self.store.read();
        let rows = select_json(
            &db,
            "SELECT id, command, name, description, model, variant, scope, path, enabled, updated_at FROM skills ORDER BY command",
            &[],
        )?;
        Ok(json!({ "skills": rows }))
    }

    /// 本会话检查点（新→旧），右栏「检查点」列表与 Revert 确认框都读这份
    fn snapshot_list(&self, a: &Value) -> Result<Value, HubError> {
        let sid = s(a, "session_id").to_string();
        let db = self.store.read();
        let rows = select_json(
            &db,
            "SELECT id, turn_index, message_id, ckpt_oid, files, created_at FROM file_snapshots WHERE session_id=?1 ORDER BY turn_index DESC, created_at DESC",
            &[&sid],
        )?;
        let out: Vec<Value> = rows
            .into_iter()
            .map(|mut r| {
                let files: Vec<String> = serde_json::from_str(r["files"].as_str().unwrap_or("[]")).unwrap_or_default();
                r["files"] = json!(files);
                r
            })
            .collect();
        Ok(json!({ "snapshots": out }))
    }

    /* ---------------- 模型端点：列表 / 连通测试 + /models 合并 ---------------- */

    /// 端点全量（含解析后的 models 数组），供前端端点页与模型选择器取真实数据
    fn provider_list(&self) -> Result<Value, HubError> {
        let db = self.store.read();
        let rows = select_json(&db, "SELECT id, name, base_url, key_ref, models, last_check FROM providers ORDER BY created_at", &[])?;
        let out: Vec<Value> = rows
            .into_iter()
            .map(|mut r| {
                let models: Value = r.get("models").and_then(Value::as_str).and_then(|m| serde_json::from_str(m).ok()).unwrap_or_else(|| json!([]));
                r["models"] = models;
                r
            })
            .collect();
        Ok(json!({ "providers": out }))
    }

    /// 连通测试 = GET {base_url}/models（OpenAI 兼容）。密钥按 key_ref 引用解析：
    /// `{env:NAME}`/裸环境变量名 → env；`keychain…` → 未接入钥匙串视为无 key（本机 Ollama 可免鉴权）。
    /// 成功后把模型 id **合并**进 providers.models —— 已有条目原样保留（变体/价格字段是宿主侧资产），只追加新 id。
    fn provider_test(&self, a: &Value) -> Result<Value, HubError> {
        let id = s(a, "id").to_string();
        let row = {
            let db = self.store.read();
            select_json(&db, "SELECT id, base_url, key_ref, models FROM providers WHERE id = ?1", &[&id])?.pop()
        };
        let Some(row) = row else {
            return Err(HubError::BadArgs(format!("端点不存在：{id}")));
        };
        let base = row["base_url"].as_str().unwrap_or_default().trim_end_matches('/').to_string();
        if !(base.starts_with("http://") || base.starts_with("https://")) {
            return Err(HubError::BadArgs("base_url 需 http(s):// 前缀".into()));
        }
        let key = resolve_api_key(row["key_ref"].as_str());
        let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(15)).build().map_err(|e| HubError::Net(e.to_string()))?;
        let mut req = client.get(format!("{base}/models"));
        if let Some(k) = &key {
            req = req.bearer_auth(k);
        }
        let t0 = std::time::Instant::now();
        let resp = req.send().map_err(|e| HubError::Net(format!("连不上端点：{e}")))?;
        let status = resp.status();
        let latency_ms = t0.elapsed().as_millis() as u64;
        let body: Value = resp.json().map_err(|e| HubError::Net(format!("响应不是 JSON：{e}")))?;
        if !status.is_success() {
            let brief = body.as_str().map(str::to_string).or_else(|| serde_json::to_string(&body).ok()).unwrap_or_default();
            return Err(HubError::Net(format!("HTTP {status}：{}", &brief[..brief.floor_char_boundary(200)])));
        }
        let fetched: Vec<String> = body
            .get("data")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_string)).collect())
            .unwrap_or_default();
        let existing: Vec<Value> = row["models"].as_str().and_then(|m| serde_json::from_str(m).ok()).unwrap_or_default();
        let known: Vec<String> = existing.iter().filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_string)).collect();
        let mut merged = existing;
        for fid in fetched.iter().filter(|fid| !known.iter().any(|k| &k == fid)) {
            merged.push(json!({ "id": fid }));
        }
        let blob = serde_json::to_string(&merged).unwrap_or_else(|_| "[]".into());
        let id2 = id.clone();
        let now = now_ms();
        self.store
            .writer
            .submit_blocking(move |conn| {
                conn.execute("UPDATE providers SET models=?2, last_check=?3 WHERE id=?1", rusqlite::params![id2, blob, now])?;
                Ok(())
            })
            .map_err(HubError::from)?;
        Ok(json!({ "ok": true, "latency_ms": latency_ms, "model_ids": fetched, "count": fetched.len(), "total": merged.len() }))
    }

    /* ---------------- 文件系统 ---------------- */

    fn fs_scan(&self) -> Result<Value, HubError> {
        let limits = ScanLimits::default();
        let mut last = std::time::Instant::now();
        let rep = self
            .fs
            .scan(&limits, &mut |r| {
                if last.elapsed() >= std::time::Duration::from_millis(120) {
                    last = std::time::Instant::now();
                    self.emit(DuoEvent::ScanProgress {
                        project: r.project.clone(),
                        scanned: r.scanned as u64,
                        total: r.total as u64,
                        phase: format!("{:?}", r.phase).to_lowercase(),
                    });
                }
            })
            .map_err(|e| HubError::Fs(e.to_string()))?;
        // 收尾一定要有一条 done 进度，否则前端进度条停在半路
        self.emit(DuoEvent::ScanProgress {
            project: rep.project.clone(),
            scanned: rep.scanned as u64,
            total: rep.total as u64,
            phase: if rep.truncated { "stopped".into() } else { "done".into() },
        });
        let files = rep.files.iter().filter(|f| !f.is_dir).cloned().collect::<Vec<_>>();
        *lock(&self.index) = files;
        Ok(json!({
            "project": rep.project, "scanned": rep.scanned, "total": rep.total,
            "truncated": rep.truncated, "files": rep.files.len(),
        }))
    }

    fn fs_tree(&self, a: &Value) -> Result<Value, HubError> {
        let dir = a["dir"].as_str().unwrap_or(".");
        let entries = self.fs.tree(dir).map_err(|e| HubError::Fs(e.to_string()))?;
        Ok(json!({ "entries": entries }))
    }

    fn fs_preview(&self, a: &Value) -> Result<Value, HubError> {
        let path = s(a, "path").to_string();
        let cap = a["maxBytes"].as_u64().unwrap_or(256 * 1024);
        let p = self
            .fs
            .preview(&path, cap, &self.data_dir.join("cache"))
            .map_err(|e| HubError::Fs(e.to_string()))?;
        Ok(serde_json::to_value(p).unwrap_or(json!({})))
    }

    fn fs_search(&self, a: &Value) -> Result<Value, HubError> {
        let q = a["query"].as_str().unwrap_or("");
        let limit = a["limit"].as_u64().unwrap_or(50) as usize;
        let idx = lock(&self.index).clone();
        if idx.is_empty() {
            return Err(HubError::Unsupported("先 fs_scan 建索引".into()));
        }
        Ok(json!({ "paths": self.fs.search(&idx, q, limit) }))
    }

    /* ---------------- git / checkpoint ---------------- */

    fn git_status(&self) -> Result<Value, HubError> {
        let snap = self.git.status().map_err(|e| HubError::Git(e.to_string()))?;
        self.emit(DuoEvent::GitStatusChanged {
            branch: snap.branch.clone(),
            ahead: snap.ahead,
            behind: snap.behind,
            files: snap.files.clone(),
        });
        Ok(serde_json::to_value(snap).unwrap_or(json!({})))
    }

    /// adapt 用:回合结束后刷新 git 状态(副作用就是 emit GitStatusChanged,失败静默)
    pub fn git_status_now(&self) -> Result<Value, HubError> {
        self.git_status()
    }

    fn git_diff(&self, a: &Value) -> Result<Value, HubError> {
        let path = a["path"].as_str();
        let staged = a["staged"].as_bool().unwrap_or(false);
        let text = self.git.diff(path, staged).map_err(|e| HubError::Git(e.to_string()))?;
        Ok(json!({ "diff": text }))
    }

    fn git_stage(&self, a: &Value, unstage: bool) -> Result<Value, HubError> {
        let paths = str_array(a, "paths");
        if unstage {
            self.git.unstage(&paths).map_err(|e| HubError::Git(e.to_string()))?;
        } else {
            self.git.stage(&paths).map_err(|e| HubError::Git(e.to_string()))?;
        }
        self.git_status()
    }

    fn git_commit(&self, a: &Value) -> Result<Value, HubError> {
        let msg = s(a, "message").to_string();
        let oid = self.git.commit(&msg).map_err(|e| HubError::Git(e.to_string()))?;
        let mut rep = self.git_status()?;
        rep["commit"] = json!(oid);
        Ok(rep)
    }

    fn git_push(&self) -> Result<Value, HubError> {
        self.git.push().map_err(|e| HubError::Git(e.to_string()))?;
        self.git_status()
    }

    fn git_generate_message(&self) -> Result<Value, HubError> {
        let msg = self.git.generate_commit_message().map_err(|e| HubError::Git(e.to_string()))?;
        Ok(json!({ "message": msg }))
    }

    /// 写类工具执行前打快照（runtime 的钩子调它；测试也走这里）
    pub fn snapshot_before_write(&self, session_id: &str, turn_index: u32, message_id: &str, label: &str) -> Result<Value, HubError> {
        let snap = self.ckpt.snapshot(label).map_err(|e| HubError::Checkpoint(e.to_string()))?;
        let id = new_id();
        let files = serde_json::to_string(&snap.files).unwrap_or_else(|_| "[]".into());
        let sid = session_id.to_string();
        let mid = message_id.to_string();
        self.store
            .writer
            .submit_blocking({
                let oid2 = snap.oid.clone();
                move |conn| {
                conn.execute(
                    "INSERT INTO file_snapshots(id, session_id, turn_index, message_id, ckpt_oid, files, created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![id, sid, turn_index as i64, mid, oid2, files, snap.at],
                )
                }
            })
            .map_err(HubError::from)?;
        Ok(json!({ "oid": snap.oid, "files": snap.files }))
    }

    fn revert_to_message(&self, a: &Value) -> Result<Value, HubError> {
        let sid = s(a, "session_id").to_string();
        let mid = s(a, "message_id").to_string();
        let db = self.store.read();
        let rows = select_json(
            &db,
            "SELECT id, ckpt_oid, files, turn_index FROM file_snapshots WHERE session_id=?1 AND message_id<=?2 ORDER BY turn_index DESC LIMIT 1",
            &[&sid as &dyn rusqlite::ToSql, &mid],
        )
        .map_err(HubError::Sql)?;
        let Some(row) = rows.into_iter().next() else {
            return Err(HubError::BadArgs("该消息之前没有检查点".into()));
        };
        let oid = row["ckpt_oid"].as_str().unwrap_or_default().to_string();
        let files: Vec<String> = serde_json::from_str(row["files"].as_str().unwrap_or("[]")).unwrap_or_default();
        let n = self.ckpt.restore(&oid, &files).map_err(|e| HubError::Checkpoint(e.to_string()))?;
        self.emit(DuoEvent::FileChanged { paths: files.clone(), session_id: Some(sid.clone()) });
        let redo = self.ckpt.redo_target(&oid).map_err(|e| HubError::Checkpoint(e.to_string()))?;
        Ok(json!({ "restored": n, "files": files, "redo": redo }))
    }

    fn redo_step(&self, a: &Value) -> Result<Value, HubError> {
        let sid = s(a, "session_id").to_string();
        let db = self.store.read();
        let rows = select_json(
            &db,
            "SELECT ckpt_oid FROM file_snapshots WHERE session_id=?1 ORDER BY turn_index DESC LIMIT 1",
            &[&sid as &dyn rusqlite::ToSql],
        )
        .map_err(HubError::Sql)?;
        let Some(last) = rows.first().and_then(|r| r["ckpt_oid"].as_str()) else {
            return Err(HubError::BadArgs("没有检查点".into()));
        };
        let Some(next) = self.ckpt.redo_target(last).map_err(|e| HubError::Checkpoint(e.to_string()))? else {
            return Ok(json!({ "restored": 0, "reason": "已是最新" }));
        };
        let files = self.ckpt.files_in(&next, Some(last)).map_err(|e| HubError::Checkpoint(e.to_string()))?;
        let n = self.ckpt.restore(&next, &files).map_err(|e| HubError::Checkpoint(e.to_string()))?;
        self.emit(DuoEvent::FileChanged { paths: files.clone(), session_id: Some(sid) });
        Ok(json!({ "restored": n, "files": files }))
    }

    /* ---------------- 队列 / runtime ---------------- */

    fn submit_message(&self, a: &Value) -> Result<Value, HubError> {
        let sid = s(a, "session_id").to_string();
        let text = s(a, "text").to_string();
        let mode = a["mode"].as_str().unwrap_or("ask").to_string();
        let model = a["model"].as_str().unwrap_or("default").to_string();
        let id = new_id();
        {
            let mut q = lock(&self.queues);
            let entry = q.entry(sid.clone()).or_default();
            entry.main.push(QueuedItem { id: id.clone(), text: text.clone() });
        }
        self.persist_queue(&sid);
        self.emit_queue(&sid);
        match self.runtime.submit(&sid, &text, &mode, &model) {
            Ok(()) => {
                // 回合已启动:该条从"等待队列"移除(进行中的 Turn 不是 pending),否则 RunEnd 续跑会重放
                if let Some(entry) = lock(&self.queues).get_mut(&sid) {
                    entry.main.retain(|x| x.id != id);
                }
                self.persist_queue(&sid);
                self.emit_queue(&sid);
                Ok(json!({ "queued": true, "started": true }))
            }
            Err(e) => {
                // rpi 未接入：明确告诉前端原因，而不是静默丢消息（队列与落库照常）
                self.emit(DuoEvent::AgentError {
                    session_id: Some(sid.clone()),
                    level: crate::ipc::LogLevel::Warn,
                    code: e.clone(),
                    message: "Agent runtime 未接入，消息已入队但未启动回合".into(),
                    retryable: false,
                    retry_in_ms: None,
                    attempt: None,
                    fatal: Some(false),
                });
                self.emit(DuoEvent::AgentEnd { session_id: sid, reason: crate::ipc::EndReason::Error, summary: Some(e) });
                Ok(json!({ "queued": true, "started": false, "reason": "runtime_unavailable" }))
            }
        }
    }

    fn submit_steering(&self, a: &Value) -> Result<Value, HubError> {
        let sid = s(a, "session_id").to_string();
        let text = s(a, "text").to_string();
        let id = new_id();
        {
            let mut q = lock(&self.queues);
            q.entry(sid.clone()).or_default().steering.push(QueuedItem { id: id.clone(), text: text.clone() });
        }
        self.persist_queue(&sid);
        self.emit_queue(&sid);
        // 投给 runtime 的是同一 duo id：drain 对账与队列改写都按它定位
        let delivered = self.runtime.steer(&sid, &id, &text);
        Ok(json!({ "ok": true, "id": id, "delivered": delivered }))
    }

    fn queue_action(&self, a: &Value) -> Result<Value, HubError> {
        let sid = a["session_id"].as_str().map(str::to_string).unwrap_or_else(|| self.current_session());
        let id = s(a, "id").to_string();
        let op = s(a, "op").to_string();
        // 被改写的队列若已投递给 runtime，必须同步撤下，否则 rpi 侧照旧 drain 注入
        let mut cancel_texts: Vec<String> = Vec::new();
        let mut re_steer: Option<(String, String)> = None;
        {
            let mut q = lock(&self.queues);
            let entry = q.entry(sid.clone()).or_default();
            let mut all = std::mem::take(&mut entry.steering);
            let mut main = std::mem::take(&mut entry.main);
            match op.as_str() {
                "delete" => {
                    for list in [&all, &main] {
                        if let Some(x) = list.iter().find(|x| x.id == id) {
                            cancel_texts.push(x.text.clone());
                        }
                    }
                    all.retain(|x| x.id != id);
                    main.retain(|x| x.id != id);
                }
                "promote" => {
                    if let Some(pos) = all.iter().position(|x| x.id == id) {
                        let item = all.remove(pos);
                        cancel_texts.push(item.text.clone());
                        main.insert(0, item);
                    }
                }
                "edit" => {
                    if let Some(text) = a["text"].as_str() {
                        for list in [&mut all, &mut main] {
                            if let Some(x) = list.iter_mut().find(|x| x.id == id) {
                                cancel_texts.push(x.text.clone());
                                re_steer = Some((x.id.clone(), text.to_string()));
                                x.text = text.to_string();
                            }
                        }
                    }
                }
                _ => {}
            }
            entry.steering = all;
            entry.main = main;
        }
        for t in cancel_texts {
            self.runtime.cancel_queued(&sid, &t);
        }
        if let Some((duo_id, text)) = re_steer {
            self.runtime.steer(&sid, &duo_id, &text);
        }
        self.persist_queue(&sid);
        self.emit_queue(&sid);
        Ok(json!({ "ok": true }))
    }

    /// 回合结束后的 main 队列续跑（PLAN §6.1：main 顺序执行）。
    /// mode/model 取 sessions 行（set_mode/set_model 已落库）。返回是否启动了下一条。
    pub fn drain_next_main(&self, sid: &str) -> bool {
        let next = {
            let mut q = lock(&self.queues);
            match q.get_mut(sid) {
                Some(entry) if !entry.main.is_empty() => Some(entry.main.remove(0)),
                _ => None,
            }
        };
        let Some(item) = next else {
            return false;
        };
        self.persist_queue(sid);
        self.emit_queue(sid);
        let (mode, model) = self
            .store
            .read()
            .query_row("SELECT mode, model FROM sessions WHERE id=?1", rusqlite::params![sid], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?.unwrap_or_else(|| "ask".to_string()),
                    r.get::<_, Option<String>>(1)?.unwrap_or_else(|| "default".to_string()),
                ))
            })
            .unwrap_or_else(|_| ("ask".to_string(), "default".to_string()));
        if self.runtime.submit(sid, &item.text, &mode, &model).is_err() {
            // 启动失败：文本不吞消息，放回队首并如实报错
            lock(&self.queues).entry(sid.to_string()).or_default().main.insert(0, item);
            self.persist_queue(sid);
            self.emit_queue(sid);
            return false;
        }
        true
    }

    fn emit_queue(&self, sid: &str) {
        let q = lock(&self.queues).get(sid).cloned().unwrap_or_default();
        self.emit(DuoEvent::QueueState {
            session_id: sid.to_string(),
            main: q.main,
            steering: q.steering,
            follow_up: q.follow_up,
        });
    }

    fn persist_queue(&self, sid: &str) {
        let q = lock(&self.queues).get(sid).cloned().unwrap_or_default();
        let blob = serde_json::to_string(&json!({
            "main": q.main, "steering": q.steering, "followUp": q.follow_up
        }))
        .unwrap_or_else(|_| "{}".into());
        let sid2 = sid.to_string();
        let _ = self.store.writer.submit_blocking(move |conn| {
            conn.execute(
                "INSERT INTO checkpoints(session_id, queue_state, last_turn, updated_at) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(session_id) DO UPDATE SET queue_state=excluded.queue_state, updated_at=excluded.updated_at",
                rusqlite::params![sid2, blob, 0i64, now_ms()],
            )
        });
    }

    fn current_session(&self) -> String {
        self.store
            .read()
            .query_row("SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1", [], |r| r.get::<_, String>(0))
            .unwrap_or_default()
    }

    fn set_mode_model(&self, a: &Value, cmd: &str) -> Result<Value, HubError> {
        let sid = s(a, "session_id").to_string();
        let (col, val) = match cmd {
            "set_mode" => ("mode", s(a, "mode").to_string()),
            _ => ("model", s(a, "model").to_string()),
        };
        let sql = format!("UPDATE sessions SET {col}=?1, updated_at=?2 WHERE id=?3");
        self.store
            .writer
            .submit_blocking(move |conn| conn.execute(&sql, rusqlite::params![val, now_ms(), sid]))
            .map_err(HubError::from)?;
        self.emit(DuoEvent::SessionUpdated { session_id: s(a, "session_id").into(), title: None, updated_at: now_ms(), activity: crate::ipc::Activity::Idle });
        Ok(json!({ "ok": true }))
    }

    /* ---------------- 设置 / 皮肤 ---------------- */

    fn ui_get(&self, a: &Value) -> Value {
        let key = a["key"].as_str().unwrap_or("settings").to_string();
        let v = self
            .store
            .read()
            .query_row("SELECT value FROM ui_state WHERE key=?1", rusqlite::params![key], |r| r.get::<_, String>(0))
            .unwrap_or_else(|_| "{}".into());
        serde_json::from_str(&v).unwrap_or(json!({}))
    }

    fn ui_set(&self, a: &Value) -> Result<Value, HubError> {
        let key = a["key"].as_str().unwrap_or("settings").to_string();
        let val = a["value"].to_string();
        self.store
            .writer
            .submit_blocking(move |conn| {
                conn.execute(
                    "INSERT INTO ui_state(key, value, updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                    rusqlite::params![key, val, now_ms()],
                )
            })
            .map_err(HubError::from)?;
        Ok(json!({ "ok": true }))
    }

    fn skin_list(&self) -> Result<Value, HubError> {
        let dir = self.data_dir.join("skins");
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let f = e.path().join("skin.json");
                if f.is_file() {
                    if let Ok(v) = std::fs::read_to_string(&f) {
                        if let Ok(json) = serde_json::from_str::<Value>(&v) {
                            out.push(json!({ "id": e.file_name().to_string_lossy(), "bundle": json }));
                        }
                    }
                }
            }
        }
        Ok(json!({ "skins": out, "dir": dir.to_string_lossy() }))
    }

    fn skin_apply(&self, a: &Value) -> Result<Value, HubError> {
        let id = s(a, "id").to_string();
        let v = json!({ "skin": id });
        self.ui_set(&json!({ "key": "skin", "value": v }))
    }

    fn skin_import(&self, a: &Value) -> Result<Value, HubError> {
        let src = s(a, "path").to_string();
        let text = std::fs::read_to_string(&src).map_err(|e| HubError::Fs(format!("读 skin.json 失败：{e}")))?;
        let bundle: Value = serde_json::from_str(&text).map_err(|e| HubError::BadArgs(format!("skin.json 不是合法 JSON：{e}")))?;
        let id = bundle["id"].as_str().ok_or_else(|| HubError::BadArgs("skin.json 缺 id".into()))?.to_string();
        let dir = self.data_dir.join("skins").join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| HubError::Fs(e.to_string()))?;
        std::fs::write(dir.join("skin.json"), text).map_err(|e| HubError::Fs(e.to_string()))?;
        Ok(json!({ "id": id, "path": dir.join("skin.json").to_string_lossy() }))
    }
}

/* ---------------- 小工具 ---------------- */

fn s<'a>(a: &'a Value, k: &str) -> &'a str {
    a.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn str_array(a: &Value, k: &str) -> Vec<String> {
    a.get(k)
        .and_then(Value::as_array)
        .map(|v| v.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// key_ref → 真实密钥的解析(真 keychain 属 T4,现在只认环境变量引用)
fn resolve_api_key(key_ref: Option<&str>) -> Option<String> {
    let r = key_ref?.trim();
    if r.is_empty() || r == "keychain" || r.starts_with("keychain:") {
        return None;
    }
    let name = r.strip_prefix('{').and_then(|x| x.strip_suffix('}')).unwrap_or(r);
    let name = name.strip_prefix("env:").unwrap_or(name);
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// 项目目录当前是不是 git 仓库（决定右栏给不给变更审查 / 检查点）
fn conn_is_git(path: &str) -> bool {
    Git::new(path).is_repo()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn parse_policy(p: &str) -> Policy {
    match p {
        "auto" => Policy::Auto,
        "deny" => Policy::Deny,
        _ => Policy::RequireApproval,
    }
}

/// 事件名（与前端 DuoEvents 的键一致；serde tag 已保证 payload 形状）
fn event_name(ev: &DuoEvent) -> &'static str {
    match ev {
        DuoEvent::Ready { .. } => "ready",
        DuoEvent::TextDelta { .. } => "text_delta",
        DuoEvent::ReasoningDelta { .. } => "reasoning_delta",
        DuoEvent::MessagePartUpserted { .. } => "message_part_upserted",
        DuoEvent::ToolCallStart { .. } => "tool_call_start",
        DuoEvent::ToolCallOutputDelta { .. } => "tool_call_output_delta",
        DuoEvent::ToolCallResult { .. } => "tool_call_result",
        DuoEvent::HumanConfirmRequired { .. } => "human_confirm_required",
        DuoEvent::QuestionRequired { .. } => "question_required",
        DuoEvent::TurnEnd { .. } => "turn_end",
        DuoEvent::ContextUsage { .. } => "context_usage",
        DuoEvent::AgentEnd { .. } => "agent_end",
        DuoEvent::AgentError { .. } => "agent_error",
        DuoEvent::CompactDone { .. } => "compact_done",
        DuoEvent::FileChanged { .. } => "file_changed",
        DuoEvent::GitStatusChanged { .. } => "git_status_changed",
        DuoEvent::ScanProgress { .. } => "scan_progress",
        DuoEvent::McpStatus { .. } => "mcp_status",
        DuoEvent::SessionUpdated { .. } => "session_updated",
        DuoEvent::QueueState { .. } => "queue_state",
    }
}

/// 通用查询：把结果行直接映射成 JSON 对象，省掉每张表一套 Row 结构
pub fn select_json(conn: &Connection, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>, rusqlite::Error> {
    let mut stmt = conn.prepare(sql)?;
    let n = stmt.column_count();
    let names: Vec<String> = (0..n).map(|i| stmt.column_name(i).unwrap_or("?").to_string()).collect();
    let mut rows = stmt.query(params)?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let mut obj = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let v = match r.get_ref(i)? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(x) => json!(x),
                rusqlite::types::ValueRef::Real(f) => json!(f),
                rusqlite::types::ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
                rusqlite::types::ValueRef::Blob(b) => json!(format!("<blob {}>", b.len())),
            };
            obj.insert(name.clone(), v);
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

/// `Connection::submit` 语法糖（只读查询也走同一入口，避免误写）
trait ReadSubmit {
    fn submit<F: FnOnce(&Connection) -> Result<V, rusqlite::Error>, V>(&self, f: F) -> Result<V, HubError>;
}
impl ReadSubmit for Connection {
    fn submit<F, V>(&self, f: F) -> Result<V, HubError>
    where
        F: FnOnce(&Connection) -> Result<V, rusqlite::Error>,
    {
        f(self).map_err(HubError::Sql)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::perms::Call;
    use std::path::Path;
    use std::process::Command as C;

    struct Fix {
        hub: Arc<Hub>,
        _store_dir: tempfile::TempDir,
        wd: tempfile::TempDir,
        _data: tempfile::TempDir,
        sink: Arc<CollectSink>,
    }

    fn fixture() -> Fix {
        let store_dir = tempfile::tempdir().unwrap();
        let wd = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let sink = Arc::new(CollectSink::default());
        let store = Arc::new(Store::open(store_dir.path()).expect("open store"));
        let hub = Hub::open(store, wd.path(), data.path(), sink.clone(), Arc::new(UnwiredRuntime)).expect("hub");
        Fix { hub, _store_dir: store_dir, wd, _data: data, sink }
    }

    fn events_of(fix: &Fix) -> Vec<&'static str> {
        lock(&fix.sink.events).iter().map(event_name).collect()
    }

    fn git(wd: &Path, args: &[&str]) {
        assert!(C::new("git").arg("-C").arg(wd).args(args).output().map(|o| o.status.success()).unwrap_or(false), "git {args:?}");
    }

    /// 协议单一来源校验：前端 Commands 的成员必须逐个被宿主实现
    #[test]
    fn 宿主命令表与前端_protocol_ts_完全对齐() {
        let ts = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/ipc/protocol.ts")).expect("读 protocol.ts");
        let body = &ts[ts.find("export interface Commands").unwrap()..];
        let mut fe: Vec<String> = Vec::new();
        for line in body.lines() {
            // 只认两空格缩进的成员（嵌套字段是 4 空格）
            if line.starts_with("  ") && !line.starts_with("   ") {
              let rest = &line[2..];
                if let Some(i) = rest.find(": ") {
                    let name = rest[..i].trim();
                    if !name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                        fe.push(name.to_string());
                    }
                }
            }
            if line == "}" {
                break;
            }
        }
        fe.sort();
        let host: Vec<String> = COMMANDS.iter().map(|s| s.to_string()).collect();
        assert_eq!(fe, host, "前端 Commands 与 Hub::COMMANDS 不一致（新增命令要两边同时落）");
        // 每个命令都得有真实分支：未知命令落到 Unknown，而不是静默成功
        assert!(fe.len() >= 49, "解析到的命令数异常：{}", fe.len());
    }

    #[test]
    fn 会话增删改查与导出走通() {
        let f = fixture();
        let created = f.hub.handle("session_create", json!({ "project_id": "p1", "title": "给 SessionStore 加持久化" })).unwrap();
        let sid = created["id"].as_str().unwrap().to_string();
        let list = f.hub.handle("session_list", json!({ "project_id": "p1" })).unwrap();
        assert_eq!(list["sessions"].as_array().unwrap().len(), 1);
        f.hub.handle("session_rename", json!({ "session_id": sid, "title": "改名了" })).unwrap();
        let list2 = f.hub.handle("session_list", json!({ "query": "改名" })).unwrap();
        assert_eq!(list2["sessions"].as_array().unwrap().len(), 1, "标题搜索应命中");
        // 软删后列表看不到，restore 又回来
        f.hub.handle("session_delete", json!({ "session_id": sid })).unwrap();
        assert!(f.hub.handle("session_list", json!({})).unwrap()["sessions"].as_array().unwrap().is_empty());
        f.hub.handle("session_restore", json!({ "session_id": sid })).unwrap();
        assert_eq!(f.hub.handle("session_list", json!({})).unwrap()["sessions"].as_array().unwrap().len(), 1);
        let md = f.hub.handle("session_export", json!({ "session_id": sid })).unwrap();
        assert!(md["markdown"].as_str().unwrap().starts_with("# duo session"));
        assert!(events_of(&f).contains(&"session_updated"));
        // project_id 省略 = 宿主工作区（单项目桌面：前端不必知道宿主路径）；空标题落「新会话」
        let no_proj = f.hub.handle("session_create", json!({ "title": "" })).unwrap();
        let sid2 = no_proj["id"].as_str().unwrap().to_string();
        let row = {
            let db = f.hub.store.read();
            select_json(&db, "SELECT project_id, title FROM sessions WHERE id=?1", &[&sid2]).unwrap().pop().unwrap()
        };
        assert_eq!(row["project_id"].as_str().unwrap(), f.wd.path().display().to_string(), "空 project 回退工作区");
        assert_eq!(row["title"].as_str().unwrap(), "新会话");
    }

    #[test]
    fn fork_会复制消息与_parts_且新_id() {
        let f = fixture();
        let sid = f.hub.handle("session_create", json!({ "project_id": "p1", "title": "原会话" })).unwrap()["id"].as_str().unwrap().to_string();
        let (mid, pid) = f
            .hub
            .store
            .writer
            .submit_blocking({
                let sid = sid.clone();
                move |conn| {
                let mid = new_id();
                let pid = new_id();
                conn.execute(
                    "INSERT INTO messages(id, session_id, role, turn_index, created_at) VALUES(?1,?2,'user',1,1000)",
                    rusqlite::params![mid, sid],
                )?;
                conn.execute(
                    "INSERT INTO parts(id, message_id, seq, type, content, created_at, updated_at) VALUES(?1,?2,1,'text','{\"md\":\"原文\"}',1000,1000)",
                    rusqlite::params![pid, mid],
                )?;
                Ok((mid, pid))
                }
            })
            .unwrap();
        let forked = f.hub.handle("session_fork", json!({ "session_id": sid })).unwrap()["id"].as_str().unwrap().to_string();
        assert_ne!(forked, sid);
        let loaded = f.hub.handle("session_load", json!({ "session_id": forked })).unwrap();
        let msgs = loaded["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["parts"].as_array().unwrap().len(), 1, "parts 要跟着复制");
        assert_ne!(msgs[0]["parts"][0]["id"].as_str().unwrap(), pid, "复制后必须是新 id");
        let _ = mid;
    }

    #[test]
    fn 提交消息会入队落库并如实报告_runtime_未接入() {
        let f = fixture();
        let sid = f.hub.handle("session_create", json!({ "project_id": "p1" })).unwrap()["id"].as_str().unwrap().to_string();
        let r = f.hub.handle("submit_message", json!({ "session_id": sid, "text": "跑测试", "mode": "code", "model": "m1" })).unwrap();
        assert_eq!(r["queued"], json!(true));
        assert_eq!(r["started"], json!(false));
        assert_eq!(r["reason"], json!("runtime_unavailable"));
        let evs = events_of(&f);
        assert!(evs.contains(&"queue_state"), "{evs:?}");
        assert!(evs.contains(&"agent_error") && evs.contains(&"agent_end"));
        // 队列状态落库（跨重启恢复只认 SQLite，PLAN §6.9 硬约束）
        let blob: String = f
            .hub
            .store
            .read()
            .query_row("SELECT queue_state FROM checkpoints WHERE session_id=?1", rusqlite::params![sid], |r| r.get(0))
            .unwrap();
        assert!(blob.contains("跑测试"), "{blob}");
    }

    #[test]
    fn 三队列_edit_delete_promote_都生效() {
        let f = fixture();
        let sid = f.hub.handle("session_create", json!({ "project_id": "p1" })).unwrap()["id"].as_str().unwrap().to_string();
        f.hub.handle("submit_message", json!({ "session_id": sid, "text": "占位", "mode": "ask", "model": "m" })).ok();
        f.hub.handle("submit_steering", json!({ "session_id": sid, "text": "改成中文注释" })).unwrap();
        let q = f.hub.queues_for(&sid);
        let steer_id = q.steering[0].id.clone();
        f.hub.handle("queue_action", json!({ "session_id": sid, "id": steer_id, "op": "promote" })).unwrap();
        let after = f.hub.queues_for(&sid);
        assert!(after.steering.is_empty() && after.main[0].text == "改成中文注释", "promote 应插到 main 队首");
        f.hub.handle("queue_action", json!({ "session_id": sid, "id": after.main[0].id, "op": "edit", "text": "改过了" })).unwrap();
        assert_eq!(f.hub.queues_for(&sid).main[0].text, "改过了");
        f.hub.handle("queue_action", json!({ "session_id": sid, "id": after.main[0].id, "op": "delete" })).unwrap();
        assert_eq!(f.hub.queues_for(&sid).main.len(), 1, "只该删掉指定那条（占位仍在）");
    }

    #[test]
    fn 权限写入立刻影响判定且严格者胜() {
        let f = fixture();
        let test_cmd = Call { tool: "bash", path: None, command: Some("bun test"), host: None, scope_ref: None };
        let rm = Call { tool: "bash", path: None, command: Some("rm -rf /tmp/x"), host: None, scope_ref: None };
        // PLAN §6.6：模式默认也是一层，取最严格者生效 —— code 下 shell 必审，
        // 一条 global auto 规则**不能**把它降级（这正是「例外只收紧、不放水」的语义）
        assert!(matches!(f.hub.decide("code", &test_cmd), crate::perms::Decision::Ask { .. }), "code 模式 shell 默认要审批");
        assert!(matches!(f.hub.decide("ask", &test_cmd), crate::perms::Decision::Deny { .. }), "ask 模式 shell 全拒");
        f.hub
            .handle(
                "permission_set",
                json!({
                    "scope": "global", "tool": "bash", "policy": "auto",
                    "exceptions": [{ "matcher": { "command": "rm -rf*" }, "policy": "deny" }]
                }),
            )
            .unwrap();
        // plan 模式 shell 默认 AUTO → 规则 AUTO，但 rm -rf 命中例外变 DENY
        assert_eq!(f.hub.decide("plan", &test_cmd), crate::perms::Decision::Auto, "只读测试命令放行");
        assert!(matches!(f.hub.decide("plan", &rm), crate::perms::Decision::Deny { .. }), "例外必须把危险命令拦下");
        // 写类工具在 code 下仍要审批，且 deny 规则能压过模式默认
        let w = Call { tool: "write", path: Some("src/a.ts"), command: None, host: None, scope_ref: Some("/repo") };
        assert!(matches!(f.hub.decide("code", &w), crate::perms::Decision::Ask { .. }));
        f.hub.handle("permission_set", json!({ "scope": "project", "scope_ref": "/repo", "tool": "write", "policy": "deny" })).unwrap();
        assert!(matches!(f.hub.decide("code", &w), crate::perms::Decision::Deny { .. }), "project 层 deny 应生效");
    }

    #[test]
    fn git_通道状态_diff_与提交都真跑通() {
        let f = fixture();
        git(f.wd.path(), &["init", "-q", "-b", "main"]);
        git(f.wd.path(), &["config", "user.email", "t@duo.local"]);
        git(f.wd.path(), &["config", "user.name", "t"]);
        std::fs::write(f.wd.path().join("a.txt"), "1\n").unwrap();
        f.hub.handle("git_status", json!({})).unwrap();
        std::fs::write(f.wd.path().join("a.txt"), "1\n2\n").unwrap();
        let st = f.hub.handle("git_status", json!({})).unwrap();
        assert_eq!(st["branch"], json!("main"));
        let d = f.hub.handle("git_diff", json!({ "path": "a.txt" })).unwrap();
        assert!(d["diff"].as_str().unwrap().contains("+2"), "{}", d["diff"]);
        let msg = f.hub.handle("git_generate_message", json!({})).unwrap();
        // 新仓库里这是未跟踪的新文件 → conventional 类型应是 feat 而不是 fix
        assert!(msg["message"].as_str().unwrap().starts_with("feat(a)"), "{}", msg["message"]);
        f.hub.handle("git_stage", json!({ "paths": ["a.txt"] })).unwrap();
        f.hub.handle("git_commit", json!({ "message": "fix(a): 补一行" })).unwrap();
        let clean = f.hub.handle("git_status", json!({})).unwrap();
        assert!(clean["files"].as_array().unwrap().is_empty(), "提交后应干净");
        assert!(events_of(&f).contains(&"git_status_changed"));
    }

    #[test]
    fn 检查点回滚与_redo_串起_file_snapshots() {
        let f = fixture();
        git(f.wd.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(f.wd.path().join("src.txt"), "v1\n").unwrap();
        let sid = f.hub.handle("session_create", json!({ "project_id": "p1" })).unwrap()["id"].as_str().unwrap().to_string();
        let snap = f.hub.snapshot_before_write(&sid, 1, "msg-1", "Turn 1 前").unwrap();
        assert!(!snap["oid"].as_str().unwrap().is_empty());
        std::fs::write(f.wd.path().join("src.txt"), "被 agent 改坏\n").unwrap();
        let back = f.hub.handle("revert_to_message", json!({ "session_id": sid, "message_id": "msg-1" })).unwrap();
        assert_eq!(std::fs::read_to_string(f.wd.path().join("src.txt")).unwrap(), "v1\n", "回滚要还原文件");
        assert_eq!(back["restored"], json!(1));
        assert!(events_of(&f).contains(&"file_changed"));
        // 再往前一步 = redo
        f.hub.handle("redo_step", json!({ "session_id": sid })).ok();
        let missing = f.hub.handle("revert_to_message", json!({ "session_id": "nope", "message_id": "x" }));
        assert!(matches!(missing, Err(HubError::BadArgs(_))), "{missing:?}");
    }

    #[test]
    fn 文件扫描_搜索_预览与注入预算() {
        let f = fixture();
        std::fs::create_dir_all(f.wd.path().join("src")).unwrap();
        std::fs::write(f.wd.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(f.wd.path().join("big.txt"), "q".repeat(5000)).unwrap();
        std::fs::write(f.wd.path().join(".gitignore"), "ignored/\n").unwrap();
        std::fs::create_dir_all(f.wd.path().join("ignored")).unwrap();
        std::fs::write(f.wd.path().join("ignored/x.txt"), "x\n").unwrap();
        let rep = f.hub.handle("fs_scan", json!({})).unwrap();
        assert!(rep["total"].as_u64().unwrap() >= 4, "{rep}");
        let s = f.hub.handle("fs_search", json!({ "query": "main" })).unwrap();
        assert_eq!(s["paths"].as_array().unwrap(), &vec![json!("src/main.rs")]);
        let p = f.hub.handle("fs_preview", json!({ "path": "big.txt", "maxBytes": 100 })).unwrap();
        assert_eq!(p["truncated"], json!(true));
        assert!(p["spillPath"].as_str().unwrap().contains("cache"), "应给出落盘引用：{p}");
        let t = f.hub.handle("fs_tree", json!({ "dir": "src" })).unwrap();
        assert!(t["entries"].as_array().unwrap().iter().any(|e| e["path"] == json!("src/main.rs")));
        let out = f.hub.handle("fs_tree", json!({ "dir": "../../etc" }));
        assert!(matches!(out, Err(HubError::Fs(_))), "越界路径必须被拒：{out:?}");
        assert_eq!(events_of(&f).iter().filter(|e| **e == "scan_progress").count(), 1, "扫描只收尾发一条进度");
    }

    #[test]
    fn mcp_upsert_会真连接并广播状态与工具名() {
        let Some(py) = which("python3") else { return };
        let f = fixture();
        let script = f.wd.path().join("fake_mcp.py");
        std::fs::write(&script, FAKE_SERVER).unwrap();
        let r = f
            .hub
            .handle(
                "mcp_upsert",
                json!({
                    "name": "fake",
                    "spec": {
                        "name": "fake", "transport": "stdio",
                        "command": py.to_string_lossy(), "args": [script.to_string_lossy()],
                        "env": {}, "url": "", "headers": {},
                        "timeoutMs": 4000, "truncateBytes": 65536, "enabled": true
                    }
                }),
            )
            .unwrap();
        assert_eq!(r["status"], json!("connected"), "{r}");
        assert_eq!(r["tools"].as_array().unwrap(), &vec![json!("mcp:fake:echo")]);
        assert!(events_of(&f).contains(&"mcp_status"));
        assert_eq!(f.hub.mcp_tool_names("fake"), vec!["mcp:fake:echo".to_string()]);
        let bad = f.hub.handle("mcp_upsert", json!({ "name": "broken", "spec": { "name": "broken", "transport": "stdio", "command": "/no/x", "args": [], "env": {}, "url": "", "headers": {}, "timeoutMs": 500, "truncateBytes": 100, "enabled": true } })).unwrap();
        assert_eq!(bad["status"], json!("failed"));
        assert!(bad["retry_in_ms"].as_u64().unwrap() >= 1000, "首次退避应至少 1s：{bad}");
    }

    #[test]
    fn skills_与设置_皮肤都落_db() {
        let f = fixture();
        f.hub
            .handle("skill_upsert", json!({ "command": "/review", "name": "评审", "system_prompt": "看未提交改动", "scope": "global" }))
            .unwrap();
        let n: i64 = f.hub.store.read().query_row("SELECT COUNT(*) FROM skills", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(n, 1);
        f.hub.handle("skill_toggle", json!({ "id": "x", "enabled": false })).ok();
        f.hub.handle("settings_set", json!({ "key": "density", "value": { "v": "compact" } })).unwrap();
        assert_eq!(f.hub.handle("settings_get", json!({ "key": "density" })).unwrap()["v"], json!("compact"));
        let skin = json!({ "id": "mine", "name": "我的皮肤", "tokens": { "--surface-base": "#101010" } });
        let path = f.wd.path().join("skin.json");
        std::fs::write(&path, skin.to_string()).unwrap();
        let imp = f.hub.handle("skin_import", json!({ "path": path.to_string_lossy() })).unwrap();
        assert_eq!(imp["id"], json!("mine"));
        assert_eq!(f.hub.handle("skin_list", json!({})).unwrap()["skins"].as_array().unwrap().len(), 1);
        f.hub.handle("skin_apply", json!({ "id": "mine" })).unwrap();
        assert_eq!(f.hub.handle("settings_get", json!({ "key": "skin" })).unwrap()["skin"], json!("mine"));
    }

    #[test]
    fn resync_按游标补发且环形缓冲有界() {
        let f = fixture();
        let sid = f.hub.handle("session_create", json!({ "project_id": "p1" })).unwrap()["id"].as_str().unwrap().to_string();
        let first = f.hub.seq();
        f.hub.handle("submit_steering", json!({ "session_id": sid, "text": "a" })).unwrap();
        f.hub.handle("submit_steering", json!({ "session_id": sid, "text": "b" })).unwrap();
        let replay = f.hub.replay_since(0, first);
        assert_eq!(replay.len(), 2, "游标之后应有两条");
        assert_eq!(replay[0].seq, first + 1);
        let r = f.hub.handle("resync", json!({ "session_id": sid, "turn_index": 0, "since_seq": first })).unwrap();
        assert_eq!(r["count"], json!(2));
        for i in 0..600u32 {
            f.hub.emit(DuoEvent::QueueState { session_id: sid.clone(), main: vec![], steering: vec![], follow_up: vec![QueuedItem { id: i.to_string(), text: "x".into() }] });
        }
        assert!(f.hub.ring_len() <= 512, "环形缓冲必须有界，不能无限涨");
    }

    #[test]
    fn 未接入与未打包的命令给出明确错误() {
        let f = fixture();
        assert!(matches!(f.hub.handle("terminal_open", json!({})), Err(HubError::FeatureOff(_))));
        assert!(matches!(f.hub.handle("provider_test", json!({ "id": "p" })), Err(HubError::BadArgs(_))), "端点不存在必须如实报错，不静默成功");
        assert!(matches!(f.hub.handle("drop_database", json!({})), Err(HubError::Unknown(_))));
        // 未实现的已登记命令也不能静默成功
        assert!(f.hub.handle("submit_frontend_result", json!({})).is_ok(), "该命令是空操作，应显式返回 ok");
        let sid = f.hub.handle("session_create", json!({ "project_id": "p1" })).unwrap()["id"].as_str().unwrap().to_string();
        let ok = f.hub.handle("approve_tool_call", json!({ "call_id": "c1", "decision": "allow" })).unwrap();
        assert_eq!(ok["resolved"], json!(false), "runtime 未接入时不能假装已解决");
        let c = f.hub.handle("compact_now", json!({ "session_id": sid })).unwrap();
        assert_eq!(c["ok"], json!(false));
    }

    fn which(bin: &str) -> Option<PathBuf> {
        std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(bin)).find(|f| f.is_file()))
    }

    const MODELS_SERVER: &str = r#"
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.endswith("/models"):
            body = json.dumps({"data":[{"id":"m-a"},{"id":"m-b"},{"id":"m-old"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)
    def log_message(self,*a): pass
srv = http.server.HTTPServer(("127.0.0.1",0), H)
sys.stdout.write(str(srv.server_address[1])+"\n"); sys.stdout.flush()
srv.serve_forever()
"#;

    /// provider_test 必须真发 HTTP、真合并落库:已有条目(带变体/价格字段)不得被 /models 覆盖
    #[test]
    fn provider_test_真拉models_合并保留已有条目字段() {
        let py = which("python3").expect("测试环境需要 python3 起假 /models 服务");
        let mut child = std::process::Command::new(py)
            .args(["-c", MODELS_SERVER])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("假 /models 服务启动失败");
        let port: u16 = {
            use std::io::BufRead;
            let out = child.stdout.take().expect("stdout 已接");
            let mut line = String::new();
            std::io::BufReader::new(out).read_line(&mut line).expect("读端口");
            line.trim().parse().expect("端口号")
        };
        std::env::set_var("PF_TEST_KEY", "sk-fake");
        let f = fixture();
        f.hub
            .handle(
                "provider_upsert",
                json!({
                    "id": "pf", "name": "假网关", "base_url": format!("http://127.0.0.1:{port}/v1"),
                    "key_ref": "{env:PF_TEST_KEY}",
                    "models": [{ "id": "m-old", "variants": ["thinking-high"], "inputPrice": "$1" }]
                }),
            )
            .unwrap();
        let r = f.hub.handle("provider_test", json!({ "id": "pf" })).expect("真 HTTP 测试应成功");
        assert_eq!(r["ok"], json!(true));
        assert_eq!(r["model_ids"].as_array().unwrap().len(), 3, "拉到的模型 id 列表");
        assert!(r["latency_ms"].as_u64().unwrap() < 15_000);
        let list = f.hub.handle("provider_list", json!({})).unwrap();
        let p = &list["providers"][0];
        assert_eq!(p["id"], json!("pf"));
        assert!(p["last_check"].as_i64().unwrap() > 0, "测通必须记 last_check");
        let models = p["models"].as_array().unwrap();
        assert_eq!(models.len(), 3, "合并不重复");
        let old = models.iter().find(|m| m["id"] == json!("m-old")).unwrap();
        assert_eq!(old["variants"].as_array().unwrap().len(), 1, "已有条目的变体字段不得被覆盖");
        assert_eq!(old["inputPrice"], json!("$1"), "价格字段是宿主资产");
        assert_eq!(p["key_ref"], json!("{env:PF_TEST_KEY}"), "库里只有引用名");
        let _ = child.kill();
        let _ = child.wait();
    }

    /// keychain 引用在钥匙串未接入时按无 key 请求(本机 Ollama 场景);错误必须可解释
    #[test]
    fn provider_test_端点不可达时报网络错而不是假成功() {
        let f = fixture();
        f.hub
            .handle("provider_upsert", json!({ "id": "dead", "name": "d", "base_url": "http://127.0.0.1:1/v1", "key_ref": "keychain:duo", "models": [] }))
            .unwrap();
        let e = f.hub.handle("provider_test", json!({ "id": "dead" })).unwrap_err();
        assert!(matches!(e, HubError::Net(_)), "网络失败归入 Net：{e}");
    }

    const FAKE_SERVER: &str = r#"
import json, sys
for line in sys.stdin:
    try: m = json.loads(line)
    except Exception: continue
    if m.get("id") is None: continue
    if m["method"] == "initialize":
        send = {"jsonrpc":"2.0","id":m["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"fake"},"authRequired": False}}
    elif m["method"] == "tools/list":
        send = {"jsonrpc":"2.0","id":m["id"],"result":{"tools":[{"name":"echo","description":"回显","inputSchema":{}}]}}
    else:
        send = {"jsonrpc":"2.0","id":m["id"],"result":{"content":[{"type":"text","text":"ok"}]}}
    sys.stdout.write(json.dumps(send)+"\n"); sys.stdout.flush()
"#;
}
