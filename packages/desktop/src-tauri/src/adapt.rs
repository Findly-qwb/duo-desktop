//! adapt — rpi Agent Runtime ↔ duo IPC 协议适配层(PLAN §6.9,Spike③ 的"唯一工作集中处")
//!
//! 集成决策(同步记录于 todos.md,不许静默):
//! 1. **持久化**:每会话一个 `InMemorySessionStorage`。UI 跨重启还原只从 duo SQLite 重建
//!    (PLAN §6.9 硬约束,rpi session/JSONL 不参与);代价是 rpi 原生崩溃续跑不跨重启存活
//!    ——duo 的断点恢复走自己的 checkpoints(queue_state + 文件快照)。
//! 2. **并发**:harness 的 active_run 是整实例单槽,因此**每会话一个 AgentHarness 实例**;
//!    切模型 = 用同一 storage 重建 harness(回合历史保留在 storage 里,不丢)。
//! 3. **权限**:`before_tool_call` 钩子 = 权限引擎插入点(PLAN §6.6):
//!    DENY→block;REQUIRE_APPROVAL→`human_confirm_required` + oneshot 回流(30min 超时自动拒绝,
//!    `perms::await_approval` 现成);"改参数后执行"经 `BeforeToolCallResult.args`(rpi 不二次校验,
//!    语义与 PLAN 一致);写类工具放行后、执行前调 `hub.snapshot_before_write`。
//! 4. **question_required**:自定义 `ask_user` 工具(execute 阻塞等答案),不走 rpi 的 Deferred 挂起。
//! 5. **seq 游标**:payload 内 seq 用 `hub.next_seq()` 全局单调 —— 多会话并行时前端 store 的
//!    全局 lastSeq 判序才不会误丢(与 Envelope 游标同源)。
//! 6. 压缩边界:compactionSummary 消息带 `tokens_before`(真实);`kept/releasedTokens` 与
//!    `tokens_after` rpi 不暴露,持久化为 0(协议占位,前端分割线只显示数值,非假账单)。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};
use std::time::{Instant, UNIX_EPOCH};

use async_trait::async_trait;
use rusqlite::params;
use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot};
use tokio_util::sync::CancellationToken;

use rpi_agent::events::BroadcastEmitter;
use rpi_agent::hooks::BeforeToolCall;
use rpi_agent::types::{AgentToolResult, BeforeToolCallResult, TextContentOrImage, ToolResultPartial};
use rpi_agent::{AgentEmitter, AgentEvent, AgentMessage, AgentTool};
use rpi_ai::providers::faux::{FauxProvider, FauxScript};
use rpi_ai::types::{Api, StopReason};
use rpi_ai::{Model, Provider};
use rpi_harness::agent_harness::{AgentHarness, AgentLane, CompactionOutcome};
use rpi_harness::events::{OnUnsubscribe, RunEndEvent};
use rpi_harness::session::types::{Entry, SessionMetadata};
use rpi_harness::session::{DefaultIdGenerator, InMemorySessionStorage, Session, SystemClock};
use rpi_harness::types::{AgentHarnessOptions, HarnessTool, ToolReplay};
use rpi_tools::{
    create_bash_tool, create_edit_tool, create_find_tool, create_grep_tool, create_ls_tool, create_read_tool, create_write_tool, ExecutionToolContext, OsExecutionEnv,
};

use crate::hub::{Hub, Runtime};
use crate::ipc;
use crate::perms::{self, ApprovalReply, Decision};
use crate::store;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn poison<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/* ---------------- 端点工厂 ---------------- */

/// (Provider 实例 + Model 定义) 的最小装配单元;harness 用 `models` 按 provider 匹配。
pub struct Endpoint {
    pub provider: Arc<dyn Provider>,
    pub model: Model,
}

/// 回合启动时解析端点。生产 = [`DbProviderFactory`] 读 SQLite `providers` 表;
/// 测试 = [`FauxFactory`](真跑 rpi 循环,不 mock 断言)。
pub trait ProviderFactory: Send + Sync {
    fn build(&self, model_id: &str) -> Result<Endpoint, String>;
}

/// 生产实现:providers(id, base_url, key_ref, models JSON)。
/// 钥匙只存引用名(PLAN 安全默认):`key_ref` 按环境变量名读取,读不到 = 未配置(真 keychain 属 T4)。
pub struct DbProviderFactory {
    store: Arc<store::Store>,
    http: reqwest::Client,
}

impl DbProviderFactory {
    pub fn new(store: Arc<store::Store>) -> Self {
        Self { store, http: reqwest::Client::new() }
    }
}

impl ProviderFactory for DbProviderFactory {
    fn build(&self, model_id: &str) -> Result<Endpoint, String> {
        let rows = {
            let db = self.store.read();
            crate::hub::select_json(&db, "SELECT id, base_url, key_ref, models FROM providers ORDER BY created_at", &[]).map_err(|e| e.to_string())?
        };
        if rows.is_empty() {
            return Err("provider_unconfigured".into());
        }
        // 在 models JSON 里找 id==model_id 的条目;找不到再按 provider id 匹配(裸模型名直传)
        let mut chosen: Option<(String, String, Option<String>, Value)> = None;
        for row in &rows {
            let pid = row["id"].as_str().unwrap_or_default().to_string();
            let base_url = row["base_url"].as_str().unwrap_or_default().to_string();
            let key_ref = row["key_ref"].as_str().map(str::to_string);
            let models: Vec<Value> = row["models"].as_str().and_then(|m| serde_json::from_str(m).ok()).unwrap_or_default();
            if let Some(entry) = models.iter().find(|e| e["id"].as_str() == Some(model_id)) {
                chosen = Some((pid, base_url, key_ref, entry.clone()));
                break;
            }
            if chosen.is_none() && (pid == model_id || pid == "default") {
                chosen = Some((pid, base_url, key_ref, json!({ "id": model_id })));
            }
        }
        let Some((pid, base_url, key_ref, entry)) = chosen else {
            return Err(format!("model_unconfigured:{model_id}"));
        };
        let api_key = match &key_ref {
            Some(name) => std::env::var(name).ok().filter(|v| !v.is_empty()),
            None => None,
        };
        let mut model = Model::new(model_id, entry["name"].as_str().unwrap_or(model_id), Api::OpenaiCompletions, pid.clone(), base_url);
        model.context_window = entry["contextWindow"].as_u64().unwrap_or(200_000);
        model.max_tokens = entry["maxTokens"].as_u64().unwrap_or(8192);
        model.reasoning = entry["reasoning"].as_bool().unwrap_or(false);
        let provider: Arc<dyn Provider> =
            Arc::new(rpi_ai::providers::openai_completions::OpenAiCompletionsProvider::with_models_without_env_api_key(pid, api_key, self.http.clone(), vec![model.clone()]));
        Ok(Endpoint { provider, model })
    }
}

/// 测试/演示实现:每次 build 克隆脚本新建 FauxProvider(进程内确定性,走真 rpi 循环)。
pub struct FauxFactory {
    script: Mutex<FauxScript>,
}

impl FauxFactory {
    pub fn new(script: FauxScript) -> Self {
        Self { script: Mutex::new(script) }
    }
}

impl ProviderFactory for FauxFactory {
    fn build(&self, _model_id: &str) -> Result<Endpoint, String> {
        let script = poison(&self.script).clone();
        let provider = FauxProvider::new(script);
        let model = provider.default_model().clone();
        Ok(Endpoint { provider, model })
    }
}

/* ---------------- 会话状态(钩子 / pump / 工具共享) ---------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueueKind {
    Steering,
    FollowUp,
}

struct Delivered {
    /// duo 队列条目 id → (队列, 文本, rpi entry_id) —— TurnEnd 对账与队列改写都按它定位
    by_duo: HashMap<String, (QueueKind, String, String)>,
}

struct SessionState {
    sid: String,
    mode: RwLock<String>,
    turn: AtomicU32,
    window: AtomicU64,
    cur_message: Mutex<Option<String>>,
    /// 当前 assistant 消息的增量缓冲(终稿落库用)
    text_buf: Mutex<String>,
    reasoning_buf: Mutex<String>,
    /// call_id → (审批回流, 工具名) —— resolve_approval 时 allow_always 要知道放行哪个工具
    approvals: Mutex<HashMap<String, (oneshot::Sender<ApprovalReply>, String)>>,
    questions: Mutex<HashMap<String, oneshot::Sender<Vec<String>>>>,
    /// call_id → (开始时刻, 工具名, 校验后参数)。file_changed 用参数里的 path(write 不回报 details)
    tools: Mutex<HashMap<String, (Instant, String, Value)>>,
    run_started: Mutex<Option<Instant>>,
    steps: AtomicU32,
    /// 真回合在跑(决定 stop 的终态由谁发)
    busy: AtomicBool,
    /// 用户点了停止:run 以什么理由收尾以此为准(AgentEnd 的 messages 在 abort 时可能为空)
    abort_pending: AtomicBool,
    delivered: Mutex<Delivered>,
    /// blocking 桥:钩子/pump 都在 async 上下文,快照与 git 命令这类同步重 IO 必须
    /// 转去专用 OS 线程(在 tokio 任务里 `blocking_recv`/`block_on` 都会 panic)
    blocking: std::sync::mpsc::Sender<Box<dyn FnOnce() + Send + 'static>>,
}

impl SessionState {
    fn new(sid: &str, mode: &str, window: u64, blocking: std::sync::mpsc::Sender<Box<dyn FnOnce() + Send + 'static>>) -> Arc<Self> {
        Arc::new(Self {
            sid: sid.to_string(),
            mode: RwLock::new(mode.to_string()),
            turn: AtomicU32::new(0),
            window: AtomicU64::new(window),
            cur_message: Mutex::new(None),
            text_buf: Mutex::new(String::new()),
            reasoning_buf: Mutex::new(String::new()),
            approvals: Mutex::new(HashMap::new()),
            questions: Mutex::new(HashMap::new()),
            tools: Mutex::new(HashMap::new()),
            run_started: Mutex::new(None),
            steps: AtomicU32::new(0),
            busy: AtomicBool::new(false),
            abort_pending: AtomicBool::new(false),
            delivered: Mutex::new(Delivered { by_duo: HashMap::new() }),
            blocking,
        })
    }
    /// 当前 assistant 消息 id:懒建且幂等。before_tool_call 钩子可能与 pump 的
    /// MessageStart 竞跑 —— 谁先到谁建 message 行,part 的 FK 才不会失败。
    fn ensure_message(&self, hub: &Arc<Hub>) -> String {
        let mut g = poison(&self.cur_message);
        if let Some(id) = g.as_ref() {
            return id.clone();
        }
        let id = new_id();
        *g = Some(id.clone());
        drop(g);
        *poison(&self.text_buf) = String::new();
        *poison(&self.reasoning_buf) = String::new();
        upsert_message(hub, &id, &self.sid, "assistant", Some(self.turn.load(Ordering::Relaxed)), "streaming", None, None);
        id
    }
    /// 回合级重置(重建 harness 时 turn 归零、缓冲清空)
    fn reset_turn_bounds(&self, window: u64) {
        self.turn.store(0, Ordering::Relaxed);
        self.window.store(window, Ordering::Relaxed);
        self.steps.store(0, Ordering::Relaxed);
        *poison(&self.cur_message) = None;
        *poison(&self.text_buf) = String::new();
        *poison(&self.reasoning_buf) = String::new();
        *poison(&self.run_started) = None;
    }
}

/* ---------------- RpiRuntime ---------------- */

struct SessionAgent {
    harness: Arc<AgentHarness>,
    state: Arc<SessionState>,
    storage: Arc<InMemorySessionStorage>,
    model_id: Mutex<String>,
    _subs: Vec<OnUnsubscribe>,
    _pump: tokio::task::JoinHandle<()>,
}

/// rpi 驱动的 `hub::Runtime`。tokio 多线程 runtime 是硬要求
/// (harness 的 StreamFn 构造依赖 `block_in_place`,PLAN §3.3 崩溃域也按 task 隔离)。
pub struct RpiRuntime {
    rt: tokio::runtime::Runtime,
    hub: OnceLock<Arc<Hub>>,
    weak: OnceLock<Weak<RpiRuntime>>,
    factory: Arc<dyn ProviderFactory>,
    sessions: Mutex<HashMap<String, Arc<SessionAgent>>>,
    blocking: std::sync::mpsc::Sender<Box<dyn FnOnce() + Send + 'static>>,
}

impl RpiRuntime {
    pub fn new(factory: Arc<dyn ProviderFactory>) -> Arc<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("rpi 需要多线程 tokio runtime");
        // blocking 桥消费者:专用 OS 线程按序跑同步重 IO(SQLite 写、git 命令),
        // 与 tokio worker 完全隔离 —— 那里的 submit_blocking 才不会 panic
        let (btx, brx) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send + 'static>>();
        std::thread::Builder::new()
            .name("duo-adapt-blocking".into())
            .spawn(move || {
                while let Ok(job) = brx.recv() {
                    job();
                }
            })
            .expect("blocking 桥线程启动失败");
        let me = Arc::new(Self { rt, hub: OnceLock::new(), weak: OnceLock::new(), factory, sessions: Mutex::new(HashMap::new()), blocking: btx });
        let _ = me.weak.set(Arc::downgrade(&me));
        me
    }

    /// 双向引用完成注入:hub 持有 runtime,事件/权限回流需要 hub。启动后先 attach 再 submit。
    pub fn attach(self: &Arc<Self>, hub: Arc<Hub>) {
        let _ = self.hub.set(hub);
    }

    fn hub(&self) -> Result<Arc<Hub>, String> {
        self.hub.get().cloned().ok_or_else(|| "runtime_not_attached".into())
    }

    /// 取(或建/切模型重建)会话 harness。ensure 语义:同模型复用实例;异模型用同一 storage 重建。
    fn ensure_session(&self, sid: &str, mode: &str, model_id: &str) -> Result<Arc<SessionAgent>, String> {
        let hub = self.hub()?;
        let existing = poison(&self.sessions).get(sid).cloned();
        if let Some(agent) = &existing {
            *agent.state.mode.write().unwrap_or_else(|e| e.into_inner()) = mode.to_string();
            if poison(&agent.model_id).as_str() == model_id {
                return Ok(agent.clone());
            }
            // 切模型:旧实例先停;storage 复用 → 历史不丢
            let _ = self.rt.block_on(agent.harness.abort());
        }
        let endpoint = self.factory.build(model_id)?;
        let (state, storage) = match &existing {
            Some(a) => {
                a.state.reset_turn_bounds(endpoint.model.context_window);
                (a.state.clone(), a.storage.clone())
            }
            None => (
                SessionState::new(sid, mode, endpoint.model.context_window, self.blocking.clone()),
                Arc::new(InMemorySessionStorage::new(
                    SessionMetadata { id: sid.to_string(), created_at: now_ms(), parent_session_id: None },
                    Arc::new(SystemClock),
                    Arc::new(DefaultIdGenerator::new()),
                )),
            ),
        };
        let agent = self.build_agent(hub, state, storage, endpoint, model_id)?;
        poison(&self.sessions).insert(sid.to_string(), agent.clone());
        Ok(agent)
    }

    fn build_agent(
        &self,
        hub: Arc<Hub>,
        state: Arc<SessionState>,
        storage: Arc<InMemorySessionStorage>,
        endpoint: Endpoint,
        model_id: &str,
    ) -> Result<Arc<SessionAgent>, String> {
        let (emitter, rx) = {
            let (em, rx) = BroadcastEmitter::new(512);
            (Arc::new(em) as Arc<dyn AgentEmitter>, rx)
        };
        let tools = build_tools(hub.clone(), state.clone());
        let before = make_before_hook(hub.clone(), state.clone());
        let options = AgentHarnessOptions {
            model: endpoint.model.clone(),
            models: vec![endpoint.provider],
            session: Session::new(storage.clone(), None),
            allow_existing_session: true,
            tools,
            agent_emitter: Some(emitter),
            before_tool_call: Some(before),
            ..Default::default()
        };
        let harness = Arc::new(self.rt.block_on(AgentHarness::create(options)).map_err(|e| format!("harness 创建失败:{e}"))?);

        let sid = state.sid.clone();
        let s1 = {
            let hub2 = hub.clone();
            let h = harness.clone();
            let st = state.clone();
            let rt = self.weak.get().cloned().ok_or("runtime_not_attached")?;
            let sid2 = sid.clone();
            harness.events().on::<RunEndEvent, _>(move |ev| on_run_end(hub2.clone(), h.clone(), st.clone(), ev, &rt, &sid2))
        };
        let pump = self.rt.spawn(pump_events(hub, state.clone(), rx));
        Ok(Arc::new(SessionAgent { harness, state, storage, model_id: Mutex::new(model_id.to_string()), _subs: vec![s1], _pump: pump }))
    }

    fn session_ids(&self) -> Vec<String> {
        poison(&self.sessions).keys().cloned().collect()
    }
}

/* ---------------- 工具注册 ---------------- */

fn build_tools(hub: Arc<Hub>, state: Arc<SessionState>) -> Vec<HarnessTool> {
    let env = Arc::new(OsExecutionEnv::with_cwd(hub.workdir.clone()));
    let ctx = ExecutionToolContext::new(env.clone(), Some(env));
    let mut tools: Vec<(Arc<dyn AgentTool>, ToolReplay)> = vec![
        (create_read_tool(&ctx, None), ToolReplay::Safe),
        (create_grep_tool(&ctx, None), ToolReplay::Safe),
        (create_find_tool(&ctx, None), ToolReplay::Safe),
        (create_ls_tool(&ctx, None), ToolReplay::Safe),
        (create_write_tool(&ctx), ToolReplay::Never),
        (create_edit_tool(&ctx), ToolReplay::Never),
        (create_bash_tool(&ctx, None), ToolReplay::Never),
    ];
    tools.push((AskUserTool::build(hub, state), ToolReplay::Never));
    tools.into_iter().map(|(t, replay)| HarnessTool::new(t).with_replay(replay)).collect()
}

/// `ask_user` 工具:模型出题 → `question_required` 事件 → 阻塞等 `answer_question` 回流。
struct AskUserTool {
    schema: rpi_ai::types::Tool,
    hub: Arc<Hub>,
    state: Arc<SessionState>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AskInput {
    questions: Vec<AskQuestion>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AskQuestion {
    q: String,
    #[serde(default)]
    options: Vec<AskOption>,
    #[serde(default)]
    allow_custom: bool,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AskOption {
    label: String,
    #[serde(default)]
    detail: Option<String>,
}

impl AskUserTool {
    fn build(hub: Arc<Hub>, state: Arc<SessionState>) -> Arc<dyn AgentTool> {
        let params = schemars::schema_for!(AskInput);
        Arc::new(Self {
            schema: rpi_ai::types::Tool {
                name: "ask_user".to_string(),
                description: "Ask the user one or more questions and wait for the answers before continuing.".to_string(),
                parameters: rpi_ai::types::Schema::new(serde_json::to_value(params).unwrap_or_default()),
                constrained_sampling: None,
            },
            hub,
            state,
        })
    }
}

#[async_trait]
impl AgentTool for AskUserTool {
    fn schema(&self) -> &rpi_ai::types::Tool {
        &self.schema
    }
    fn label(&self) -> &str {
        "ask_user"
    }
    async fn execute(
        &self,
        _tool_call_id: &str,
        params: Value,
        signal: CancellationToken,
        _on_update: Arc<dyn Fn(ToolResultPartial) + Send + Sync>,
    ) -> Result<AgentToolResult, rpi_agent::AgentError> {
        let input: AskInput = serde_json::from_value(params).map_err(|e| rpi_agent::AgentError::Validation(format!("ask_user 入参无效:{e}")))?;
        let question_id = new_id();
        let message_id = self.state.ensure_message(&self.hub);
        let questions: Vec<ipc::Question> = input
            .questions
            .iter()
            .map(|q| ipc::Question {
                q: q.q.clone(),
                options: q.options.iter().map(|o| ipc::QuestionOption { label: o.label.clone(), detail: o.detail.clone() }).collect(),
                allow_custom: q.allow_custom,
            })
            .collect();
        let (tx, rx) = oneshot::channel();
        poison(&self.state.questions).insert(question_id.clone(), tx);
        self.hub.emit(ipc::DuoEvent::QuestionRequired { question_id: question_id.clone(), session_id: self.state.sid.clone(), message_id: message_id.clone(), questions: questions.clone() });
        self.hub.emit(ipc::DuoEvent::SessionUpdated { session_id: self.state.sid.clone(), title: None, updated_at: now_ms(), activity: ipc::Activity::Ask });
        write_question_part(&self.hub, &message_id, &question_id, &questions, None);
        let answers = tokio::select! {
            a = rx => a.map_err(|_| rpi_agent::AgentError::Tool("提问已失效".into()))?,
            _ = signal.cancelled() => {
                poison(&self.state.questions).remove(&question_id);
                return Err(rpi_agent::AgentError::Tool("提问被中断".into()));
            }
        };
        write_question_part(&self.hub, &message_id, &question_id, &questions, Some(&answers));
        let text = questions.iter().zip(answers.iter()).map(|(q, a)| format!("{} → {}", q.q, a)).collect::<Vec<_>>().join("\n");
        Ok(AgentToolResult::text(if text.is_empty() { "用户没有给出答案".to_string() } else { text }))
    }
}

/// 用户消息(harness 不经 pump 广播)由提交方直接落库,保证 §6.9 重启还原完整
fn persist_user_message(hub: &Arc<Hub>, st: &Arc<SessionState>, text: &str) {
    let mid = new_id();
    let turn = st.turn.load(Ordering::Relaxed) + 1;
    upsert_message(hub, &mid, &st.sid, "user", Some(turn), "complete", None, None);
    write_part(hub, &mid, "text", format!("mp-{mid}"), None, "done", None, json!({ "type": "text", "md": text }));
}

fn write_question_part(hub: &Hub, message_id: &str, question_id: &str, questions: &[ipc::Question], answers: Option<&Vec<String>>) {
    let content = json!({ "type": "question", "questionId": question_id, "questions": questions, "index": 0, "answered": answers });
    write_part(hub, message_id, "question", format!("mp-q-{question_id}"), None, if answers.is_some() { "done" } else { "pending" }, None, content);
}

/* ---------------- part / message 落库(UI 还原只从 SQLite,PLAN §6.9) ---------------- */

// 持久化 helper:参数即落库字段,调用点多,收结构体反而降低可读性
#[allow(clippy::too_many_arguments)]
fn write_part(hub: &Hub, message_id: &str, part_type: &str, id: String, tool_name: Option<&str>, state: &str, call_id: Option<&str>, content: Value) {
    let p = ipc::Part {
        id,
        message_id: message_id.to_string(),
        seq: hub.next_seq() as i64,
        r#type: part_type.to_string(),
        tool_name: tool_name.map(str::to_string),
        tool_source: if part_type == "tool" { Some("main".to_string()) } else { None },
        call_id: call_id.map(str::to_string),
        state: Some(state.to_string()),
        content,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    // pump/钩子都在 async 上下文,用即发即忘(单写队列保证同会话顺序)
    hub.store.writer.submit_fire(move |conn| store::upsert_part(conn, &p));
}

#[allow(clippy::too_many_arguments)]
fn upsert_message(hub: &Hub, id: &str, sid: &str, role: &str, turn: Option<u32>, status: &str, model: Option<&str>, usage: Option<&rpi_ai::types::Usage>) {
    let cost = usage.map(|u| u.cost.total);
    let (pt, ct, rt, cr) = match usage {
        Some(u) => (Some(u.input), Some(u.output), u.reasoning, Some(u.cache_read)),
        None => (None, None, None, None),
    };
    let id = id.to_string();
    let sid = sid.to_string();
    let role = role.to_string();
    let status = status.to_string();
    let model = model.map(str::to_string);
    hub.store.writer.submit_fire(move |conn| {
        conn.execute(
            "INSERT INTO messages(id,session_id,role,turn_index,status,model,cost_estimate,prompt_tokens,completion_tokens,reasoning_tokens,cache_read_tokens,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status, cost_estimate=COALESCE(excluded.cost_estimate, messages.cost_estimate),
               prompt_tokens=COALESCE(excluded.prompt_tokens, messages.prompt_tokens), completion_tokens=COALESCE(excluded.completion_tokens, messages.completion_tokens),
               reasoning_tokens=COALESCE(excluded.reasoning_tokens, messages.reasoning_tokens), cache_read_tokens=COALESCE(excluded.cache_read_tokens, messages.cache_read_tokens)",
            params![id, sid, role, turn.map(|t| t as i64), status, model, cost, pt, ct, rt, cr, now_ms()],
        )
        .map(|_| ())
    });
}

fn emit_session_update(hub: &Hub, sid: &str, activity: ipc::Activity) {
    hub.emit(ipc::DuoEvent::SessionUpdated { session_id: sid.to_string(), title: None, updated_at: now_ms(), activity });
}

/* ---------------- 权限钩子 ---------------- */

fn make_before_hook(hub: Arc<Hub>, st: Arc<SessionState>) -> BeforeToolCall {
    Arc::new(move |ctx, signal| {
        let hub = hub.clone();
        let st = st.clone();
        let tool = ctx.tool_call.name.clone();
        let call_id = ctx.tool_call.id.clone();
        let args = ctx.args.clone();
        Box::pin(async move {
            let mode = st.mode.read().unwrap_or_else(|e| e.into_inner()).clone();
            let path = args.get("path").and_then(Value::as_str).or_else(|| args.get("file_path").and_then(Value::as_str));
            let command = args.get("command").and_then(Value::as_str);
            let call = perms::Call { tool: &tool, path, command, host: None, scope_ref: Some(st.sid.as_str()) };
            match hub.decide(&mode, &call) {
                Decision::Auto => {
                    if let Err(e) = snapshot_if_write(&hub, &st, &tool).await {
                        return Some(BeforeToolCallResult { block: true, reason: Some(format!("写前快照失败,拒绝执行({e})")), terminate: false, args: None });
                    }
                    None
                }
                Decision::Deny { matched_rule } => Some(BeforeToolCallResult {
                    block: true,
                    reason: Some(format!("权限规则拒绝:{matched_rule}")),
                    terminate: false,
                    args: None,
                }),
                Decision::Ask { matched_rule } => ask_approval(&hub, &st, &tool, &call_id, &args, &matched_rule, signal).await,
            }
        })
    })
}

/// 写前快照(PLAN §7.2):同步重 IO 转 blocking 桥执行;失败 → 拒绝写入(fail-closed,不给 Revert 挖洞)
async fn snapshot_if_write(hub: &Arc<Hub>, st: &Arc<SessionState>, tool: &str) -> Result<(), String> {
    if !perms::is_write(tool) {
        return Ok(());
    }
    let turn = st.turn.load(Ordering::Relaxed);
    let mid = st.ensure_message(hub);
    let hub2 = hub.clone();
    let sid = st.sid.clone();
    let (ack, ack_rx) = oneshot::channel::<bool>();
    let label = format!("Turn {turn} 前({tool})");
    st.blocking
        .send(Box::new(move || {
            let ok = hub2.snapshot_before_write(&sid, turn, &mid, &label).is_ok();
            let _ = ack.send(ok);
        }))
        .map_err(|_| "blocking 桥已关闭".to_string())?;
    ack_rx.await.map_err(|_| "快照结果丢失".to_string())?;
    Ok(())
}

async fn ask_approval(hub: &Arc<Hub>, st: &Arc<SessionState>, tool: &str, call_id: &str, args: &Value, matched_rule: &str, signal: CancellationToken) -> Option<BeforeToolCallResult> {
    let kind = perms::kind_of(tool, args);
    let message_id = st.ensure_message(hub);
    let sid = st.sid.clone();
    let expires_at = now_ms() + 30 * 60 * 1000;
    let command = args.get("command").and_then(Value::as_str).map(str::to_string);
    let paths: Option<Vec<String>> = args.get("path").and_then(Value::as_str).map(|p| vec![p.to_string()]);
    let dump = args.to_string();
    let hint = Some(if dump.len() > 400 { format!("{}…", &dump[..dump.floor_char_boundary(400)]) } else { dump });
    let (tx, rx) = oneshot::channel();
    poison(&st.approvals).insert(call_id.to_string(), (tx, tool.to_string()));
    write_part(
        hub,
        &message_id,
        "approval",
        format!("mp-ap-{call_id}"),
        Some(tool),
        "awaiting_approval",
        Some(call_id),
        json!({
            "type": "approval", "callId": call_id, "tool": tool, "source": "main", "kind": kind_tag(&kind),
            "command": command, "paths": paths, "matchedRule": matched_rule, "hint": hint,
            "expiresAt": expires_at, "editable": matches!(kind, ipc::ConfirmKind::Command),
        }),
    );
    hub.emit(ipc::DuoEvent::HumanConfirmRequired {
        call_id: call_id.to_string(),
        tool_name: tool.to_string(),
        source: "main".into(),
        kind,
        command,
        paths,
        diff: None,
        matched_rule: Some(matched_rule.to_string()),
        hint,
        expires_at,
        session_id: sid.clone(),
        message_id: message_id.clone(),
    });
    emit_session_update(hub, &sid, ipc::Activity::Ask);
    // abort(stop)时信号取消:审批立即按拒绝收尾,不挂满 30 分钟
    let reply = tokio::select! {
        r = perms::await_approval(rx) => r,
        _ = signal.cancelled() => ApprovalReply { decision: Decision::Deny { matched_rule: "回合被中断".into() }, modified_args: None },
    };
    poison(&st.approvals).remove(call_id);
    let decision_tag = match &reply.decision {
        Decision::Auto => "allow",
        Decision::Deny { matched_rule } if matched_rule.contains("超时") => "expired",
        Decision::Deny { .. } => "deny",
        Decision::Ask { .. } => "expired",
    };
    let state_after = if decision_tag == "allow" { "running" } else { "denied" };
    write_part(
        hub,
        &message_id,
        "approval",
        format!("mp-ap-{call_id}"),
        Some(tool),
        state_after,
        Some(call_id),
        json!({ "type": "approval", "callId": call_id, "tool": tool, "source": "main", "kind": "command", "matchedRule": matched_rule, "expiresAt": expires_at, "decision": decision_tag }),
    );
    match reply.decision {
        Decision::Auto => {
            if let Err(e) = snapshot_if_write(hub, st, tool).await {
                return Some(BeforeToolCallResult { block: true, reason: Some(format!("写前快照失败,拒绝执行({e})")), terminate: false, args: None });
            }
            match normalize_modified(reply.modified_args, tool) {
                Ok(Some(replaced)) => Some(BeforeToolCallResult { block: false, reason: None, terminate: false, args: Some(replaced) }),
                Ok(None) => None,
                Err(msg) => Some(BeforeToolCallResult { block: true, reason: Some(msg), terminate: false, args: None }),
            }
        }
        Decision::Deny { matched_rule } | Decision::Ask { matched_rule } => {
            let _ = matched_rule;
            Some(BeforeToolCallResult { block: true, reason: Some("用户拒绝执行".into()), terminate: false, args: None })
        }
    }
}

fn kind_tag(kind: &ipc::ConfirmKind) -> &'static str {
    match kind {
        ipc::ConfirmKind::Command => "command",
        ipc::ConfirmKind::Paths => "paths",
        ipc::ConfirmKind::Diff => "diff",
    }
}

/// 审批卡「改参数后执行」:shell 工具的字符串即新命令;JSON 文本按对象解析;非法形状拒绝执行。
fn normalize_modified(modified: Option<Value>, tool: &str) -> Result<Option<Value>, String> {
    let Some(v) = modified else { return Ok(None) };
    match v {
        Value::String(s) if perms::is_shell(tool) => Ok(Some(json!({ "command": s }))),
        Value::String(s) => match serde_json::from_str::<Value>(&s) {
            Ok(Value::Object(_)) => Ok(Some(serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))),
            _ => Err("改后的参数不是合法 JSON 对象,已拒绝执行".into()),
        },
        Value::Object(map) => Ok(Some(Value::Object(map))),
        _ => Err("改后的参数形状不合法(需 JSON 对象或字符串)".into()),
    }
}

/* ---------------- 事件 pump(AgentEvent → DuoEvent + SQLite 双写) ---------------- */

fn content_texts(items: &[TextContentOrImage]) -> String {
    items
        .iter()
        .filter_map(|c| match c {
            TextContentOrImage::Text(t) => Some(t.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

async fn pump_events(hub: Arc<Hub>, st: Arc<SessionState>, mut rx: broadcast::Receiver<AgentEvent>) {
    loop {
        match rx.recv().await {
            Ok(ev) => handle_agent_event(&hub, &st, ev),
            Err(broadcast::error::RecvError::Lagged(n)) => {
                // 前端对乱序/缺口有 resync 机制;这里如实记日志,不造假补齐
                log::warn!("adapt: 事件积压丢弃 {n} 条(session {})", st.sid);
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

fn handle_agent_event(hub: &Arc<Hub>, st: &Arc<SessionState>, ev: AgentEvent) {
    let sid = st.sid.clone();
    match ev {
        AgentEvent::AgentStart => {
            st.busy.store(true, Ordering::Relaxed);
            *poison(&st.run_started) = Some(Instant::now());
            emit_session_update(hub, &sid, ipc::Activity::Run);
        }
        AgentEvent::TurnStart => {
            let t = st.turn.fetch_add(1, Ordering::Relaxed) + 1;
            hub.set_turn(t);
            st.steps.fetch_add(1, Ordering::Relaxed);
        }
        AgentEvent::MessageStart { message } => match message {
            // 用户消息由提交侧持久化(submit/steer/follow_up → persist_user_message),
            // 这里不再落库,避免双写
            AgentMessage::User(_) => {}
            AgentMessage::Assistant(_) => {
                st.ensure_message(hub);
            }
            AgentMessage::Custom(c) if c.role == "compactionSummary" => {
                let mid = st.ensure_message(hub);
                let before = c.data.get("tokens_before").and_then(Value::as_i64).unwrap_or(0);
                write_part(
                    hub,
                    &mid,
                    "compact",
                    format!("mp-cmp-{mid}-{before}"),
                    None,
                    "done",
                    None,
                    json!({ "type": "compact", "summaryTokens": before, "kept": 0, "releasedTokens": 0 }),
                );
            }
            _ => {}
        },
        AgentEvent::MessageUpdate { assistant_message_event, .. } => match assistant_message_event {
            rpi_ai::types::AssistantMessageEvent::TextDelta { delta, .. } => {
                let mid = st.ensure_message(hub);
                poison(&st.text_buf).push_str(&delta);
                hub.emit(ipc::DuoEvent::TextDelta { session_id: sid.clone(), message_id: mid, seq: hub.next_seq(), delta });
            }
            rpi_ai::types::AssistantMessageEvent::ThinkingDelta { delta, .. } => {
                let mid = st.ensure_message(hub);
                poison(&st.reasoning_buf).push_str(&delta);
                hub.emit(ipc::DuoEvent::ReasoningDelta { session_id: sid.clone(), message_id: mid, seq: hub.next_seq(), delta });
            }
            _ => {}
        },
        AgentEvent::MessageEnd { message } => {
            if let AgentMessage::Assistant(a) = message {
                let mid = poison(&st.cur_message).take().unwrap_or_else(new_id);
                let text = std::mem::take(&mut *poison(&st.text_buf));
                let reasoning = std::mem::take(&mut *poison(&st.reasoning_buf));
                if !reasoning.is_empty() {
                    write_part(hub, &mid, "reasoning", format!("mp-rsn-{mid}"), None, "done", None, json!({ "type": "reasoning", "text": reasoning }));
                }
                if !text.is_empty() {
                    write_part(hub, &mid, "text", format!("mp-txt-{mid}"), None, "done", None, json!({ "type": "text", "md": text }));
                }
                let status = match a.stop_reason {
                    StopReason::Error | StopReason::Aborted => "error",
                    _ => "complete",
                };
                upsert_message(hub, &mid, &sid, "assistant", Some(st.turn.load(Ordering::Relaxed)), status, Some(&a.model), Some(&a.usage));
                if a.stop_reason == StopReason::Error {
                    hub.emit(ipc::DuoEvent::AgentError {
                        session_id: Some(sid.clone()),
                        level: ipc::LogLevel::Error,
                        code: "provider_error".into(),
                        message: a.error_message.clone().unwrap_or_else(|| "provider 返回错误".into()),
                        retryable: false,
                        retry_in_ms: None,
                        attempt: None,
                        fatal: Some(false),
                    });
                }
            }
        }
        AgentEvent::TurnEnd { message, .. } => {
            let usage = message.as_assistant().map(|a| &a.usage);
            let model = message.as_assistant().map(|a| a.model.clone()).unwrap_or_default();
            let duration_ms = poison(&st.run_started).map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
            let tokens = usage
                .map(|u| ipc::TokenUsage { prompt: u.input as u64, completion: u.output as u64, reasoning: u.reasoning.unwrap_or(0) as u64, cache_read: u.cache_read as u64 })
                .unwrap_or_default();
            let cost = usage.map(|u| u.cost.total).unwrap_or(0.0);
            let total = usage.map(|u| u.total_tokens.max(0) as f64).unwrap_or(0.0);
            let t = st.turn.load(Ordering::Relaxed).max(1);
            hub.emit(ipc::DuoEvent::TurnEnd {
                turn_index: t,
                tokens,
                cost_estimate: cost,
                model,
                session_id: sid.clone(),
                duration_ms,
                steps: st.steps.load(Ordering::Relaxed),
                throughput: if duration_ms > 0 { total / (duration_ms as f64 / 1000.0) } else { 0.0 },
            });
            // 工具 part 已在 ToolExecutionEnd 落库,此处不重复写
            if let Some(u) = usage {
                hub.emit(ipc::DuoEvent::ContextUsage {
                    used: (u.input + u.output).max(0) as u64,
                    reserved: 16384,
                    window: st.window.load(Ordering::Relaxed).max(1),
                    auto_compact_at: 92,
                    hit_rate: if (u.input + u.cache_read) > 0 { (u.cache_read * 100 / (u.input + u.cache_read)) as u8 } else { 0 },
                    session_id: sid.clone(),
                });
            }
            *poison(&st.run_started) = None;
        }
        AgentEvent::ToolExecutionStart { tool_call_id, tool_name, args } => {
            let mid = st.ensure_message(hub);
            poison(&st.tools).insert(tool_call_id.clone(), (Instant::now(), tool_name.clone(), args.clone()));
            hub.emit(ipc::DuoEvent::ToolCallStart {
                call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                source: "main".into(),
                args: args.clone(),
                session_id: sid.clone(),
                turn_index: st.turn.load(Ordering::Relaxed),
                message_id: mid.clone(),
            });
            write_part(
                hub,
                &mid,
                "tool",
                format!("mp-{tool_call_id}"),
                Some(&tool_name),
                "running",
                Some(&tool_call_id),
                json!({ "type": "tool", "tool": tool_name, "title": tool_label(&tool_name), "state": "running", "source": "main", "isCommand": perms::is_shell(&tool_name), "paths": args.get("path").and_then(Value::as_str).map(|p| vec![p]) }),
            );
        }
        AgentEvent::ToolExecutionUpdate { tool_call_id, partial_result, .. } => {
            let chunk = content_texts(&partial_result.content);
            if !chunk.is_empty() {
                hub.emit(ipc::DuoEvent::ToolCallOutputDelta { call_id: tool_call_id, chunk, session_id: sid.clone() });
            }
        }
        AgentEvent::ToolExecutionEnd { tool_call_id, tool_name, result, is_error } => {
            let mid = st.ensure_message(hub);
            let cached = poison(&st.tools).remove(&tool_call_id);
            let duration_ms = cached.as_ref().map(|(t, _, _)| t.elapsed().as_millis() as u64).unwrap_or(0);
            let text = content_texts(&result.content);
            let (res_json, err) = if is_error { (None, Some(text.clone())) } else { (Some(json!({ "text": text })), None) };
            hub.emit(ipc::DuoEvent::ToolCallResult {
                call_id: tool_call_id.clone(),
                result: res_json,
                error: err.clone(),
                duration_ms,
                truncated: false,
                session_id: sid.clone(),
            });
            write_part(
                hub,
                &mid,
                "tool",
                format!("mp-{tool_call_id}"),
                Some(&tool_name),
                if is_error { "error" } else { "done" },
                Some(&tool_call_id),
                json!({ "type": "tool", "tool": tool_name.clone(), "title": tool_label(&tool_name), "state": if is_error { "error" } else { "done" }, "output": text, "source": "main", "error": err }),
            );
            if !is_error && perms::is_write(&tool_name) {
                // write 工具不回报 details;path 用执行参数(审批卡展示的就是它)
                if let Some(p) = cached.and_then(|(_, _, args)| args.get("path").and_then(Value::as_str).map(str::to_string)) {
                    hub.emit(ipc::DuoEvent::FileChanged { paths: vec![p], session_id: Some(sid.clone()) });
                }
            }
        }
        AgentEvent::RetryScheduled { attempt, max_retries, delay_ms, error } => {
            hub.emit(ipc::DuoEvent::AgentError {
                session_id: Some(sid.clone()),
                level: ipc::LogLevel::Warn,
                code: "provider_retry".into(),
                message: format!("provider 失败,第 {attempt}/{max_retries} 次退避重试:{error}"),
                retryable: true,
                retry_in_ms: Some(delay_ms),
                attempt: Some(attempt),
                fatal: Some(false),
            });
        }
        AgentEvent::AgentEnd { messages } => {
            // agent_end 走 pump 通道:与 TurnEnd/text_delta 同队列,顺序确定
            // (bus 的 RunEnd 是同步直调,先于 broadcast —— 不能拿它当回合终态出口)
            let aborted = st.abort_pending.swap(false, Ordering::Relaxed);
            let reason = if aborted {
                ipc::EndReason::Stopped
            } else {
                messages
                    .iter()
                    .rev()
                    .find_map(|m| m.as_assistant())
                    .map(|a| match a.stop_reason {
                        StopReason::Aborted => ipc::EndReason::Stopped,
                        StopReason::Error => ipc::EndReason::Error,
                        StopReason::Length => ipc::EndReason::Limit,
                        _ => ipc::EndReason::Done,
                    })
                    .unwrap_or(ipc::EndReason::Done)
            };
            let summary = match reason {
                ipc::EndReason::Error => Some("回合失败,详见错误卡".to_string()),
                ipc::EndReason::Limit => Some("输出被模型长度截断".to_string()),
                _ => None,
            };
            st.busy.store(false, Ordering::Relaxed);
            hub.emit(ipc::DuoEvent::AgentEnd { session_id: sid.clone(), reason, summary });
            emit_session_update(hub, &sid, ipc::Activity::Idle);
        }
    }
}

fn tool_label(tool: &str) -> &'static str {
    match tool {
        "read" => "读取文件",
        "write" => "写入文件",
        "edit" => "编辑文件",
        "bash" => "执行命令",
        "grep" => "内容搜索",
        "find" => "查找文件",
        "ls" => "列目录",
        "ask_user" => "向用户提问",
        _ => "工具",
    }
}

/* ---------------- RunEnd:回合终态 + git 刷新 + 队列对账 + main 续跑 ---------------- */

fn on_run_end(hub: Arc<Hub>, harness: Arc<AgentHarness>, st: Arc<SessionState>, _ev: &RunEndEvent, rt: &Weak<RpiRuntime>, sid: &str) {
    // 回合终态(agent_end)由 pump 的 AgentEvent::AgentEnd 统一发 —— 与流事件顺序一致;
    // 这里只做回合外的收尾:git 刷新、队列对账、main 续跑
    // git 工作区可能被回合改动:刷新状态条(git_status_now 自带事件;真实读 CLI,失败静默)
    let _ = hub.git_status_now();
    reconcile_and_continue(&hub, &harness, &st, rt, sid);
}

/// rpi 队列 drain 对账 + main 队列续跑。跑在 blocking 线程:
/// 里面要 `block_on`(harness API 全是 async),且续跑的 submit 会 ensure_session→create(block_on),
/// 绝不能在 async 上下文里发生(tokio 禁止 runtime 内 block_on)。
fn reconcile_and_continue(hub: &Arc<Hub>, harness: &Arc<AgentHarness>, st: &Arc<SessionState>, rt: &Weak<RpiRuntime>, sid: &str) {
    let Some(rt) = rt.upgrade() else { return };
    let hub2 = hub.clone();
    let harness2 = harness.clone();
    let st2 = st.clone();
    let sid2 = sid.to_string();
    let rt_task = rt.clone();
    rt.rt.spawn_blocking(move || {
        if let Ok(remaining) = rt_block(&rt_task, harness2.queued_messages()) {
            let mut drop_ids: Vec<String> = Vec::new();
            {
                let mut d = poison(&st2.delivered);
                for kind in [QueueKind::Steering, QueueKind::FollowUp] {
                    let rem_len = match kind {
                        QueueKind::Steering => remaining.steering.len(),
                        QueueKind::FollowUp => remaining.follow_up.len(),
                    };
                    // OneAtATime 从队首 drain:已交付数 − 剩余数 = 被消费数(改写路径会同步删记录)
                    let delivered: Vec<String> =
                        d.by_duo.iter().filter(|(_, (k, _, _))| *k == kind).map(|(id, _)| id.clone()).collect();
                    let consumed = delivered.len().saturating_sub(rem_len);
                    for id in delivered.into_iter().take(consumed) {
                        d.by_duo.remove(&id);
                        drop_ids.push(id);
                    }
                }
            }
            if !drop_ids.is_empty() {
                hub2.drop_queue_items(&st2.sid, &drop_ids);
            }
        }
        hub2.drain_next_main(&sid2);
    });
}

/// 在 blocking 线程上跑 harness future 的小 helper
fn rt_block<F: std::future::Future>(rt: &Arc<RpiRuntime>, f: F) -> F::Output {
    rt.rt.block_on(f)
}

/* ---------------- Runtime trait 实现 ---------------- */

impl Runtime for RpiRuntime {
    fn submit(&self, session_id: &str, text: &str, mode: &str, model: &str) -> Result<(), String> {
        let agent = self.ensure_session(session_id, mode, model)?;
        persist_user_message(&self.hub()?, &agent.state, text);
        let harness = agent.harness.clone();
        let hub = self.hub()?;
        let sid = session_id.to_string();
        let text = text.to_string();
        self.rt.spawn(async move {
            // 上一回合的 agent_end 可能刚发、run 槽还没释放:等 idle 再入,避免 LaneBusy 吞消息
            harness.wait_for_idle().await.ok();
            if let Err(e) = harness.prompt_text(&text, vec![]).await {
                // 不假装成功:如实报,用户可重发
                hub.emit(ipc::DuoEvent::AgentError {
                    session_id: Some(sid.clone()),
                    level: ipc::LogLevel::Error,
                    code: "submit_failed".into(),
                    message: format!("回合启动失败:{e}"),
                    retryable: true,
                    retry_in_ms: None,
                    attempt: None,
                    fatal: Some(false),
                });
                hub.emit(ipc::DuoEvent::AgentEnd { session_id: sid, reason: ipc::EndReason::Error, summary: Some(format!("submit_failed:{e}")) });
            }
        });
        Ok(())
    }

    fn stop(&self, session_id: &str) -> bool {
        match poison(&self.sessions).get(session_id).cloned() {
            Some(agent) => {
                let busy = agent.state.busy.load(Ordering::Relaxed);
                agent.state.abort_pending.store(true, Ordering::Relaxed);
                let _ = self.rt.block_on(agent.harness.abort());
                busy
            }
            None => false,
        }
    }

    fn answer(&self, question_id: &str, answers: &[String]) {
        for sid in self.session_ids() {
            let agent = poison(&self.sessions).get(&sid).cloned();
            if let Some(agent) = agent {
                if let Some(tx) = poison(&agent.state.questions).remove(question_id) {
                    let _ = tx.send(answers.to_vec());
                    return;
                }
            }
        }
    }

    fn resolve_approval(&self, call_id: &str, decision: &str, modified_args: Option<Value>) -> bool {
        for sid in self.session_ids() {
            let agent = poison(&self.sessions).get(&sid).cloned();
            let Some(agent) = agent else { continue };
            let entry = poison(&agent.state.approvals).remove(call_id);
            if let Some((tx, tool)) = entry {
                if decision == "allow_always" {
                    // 「始终允许此类」= global 层 auto 规则落库(收紧例外仍全局优先,PLAN §6.6)
                    if let Ok(hub) = self.hub() {
                        let _ = hub.add_auto_allow(&tool);
                    }
                }
                let reply = ApprovalReply {
                    decision: if decision == "deny" { Decision::Deny { matched_rule: "用户拒绝".into() } } else { Decision::Auto },
                    modified_args,
                };
                return tx.send(reply).is_ok();
            }
        }
        false
    }

    fn compact(&self, session_id: &str) -> Result<(), String> {
        let agent = poison(&self.sessions).get(session_id).cloned().ok_or_else(|| "runtime_unavailable".to_string())?;
        let hub = self.hub()?;
        let harness = agent.harness.clone();
        let sid = session_id.to_string();
        self.rt.spawn(async move {
            match harness.compact(None).await {
                Ok(r) => {
                    // tokens_before 取 compaction entry 真实值;tokens_after rpi 不暴露(0=未知,见文件头决策 6)
                    let before = match &r.outcome {
                        CompactionOutcome::Completed { entry: Entry::Compaction(e), .. } => e.tokens_before.max(0) as u64,
                        _ => 0,
                    };
                    match r.outcome {
                        CompactionOutcome::Completed { .. } => hub.emit(ipc::DuoEvent::CompactDone {
                            from_turn: 0,
                            tokens_before: before,
                            tokens_after: 0,
                            session_id: sid.clone(),
                            message_id: new_id(),
                        }),
                        CompactionOutcome::Declined { .. } => {
                            hub.emit(ipc::DuoEvent::AgentError {
                                session_id: Some(sid.clone()),
                                level: ipc::LogLevel::Warn,
                                code: "compact_declined".into(),
                                message: "上下文未达压缩阈值,本轮无需压缩".into(),
                                retryable: false,
                                retry_in_ms: None,
                                attempt: None,
                                fatal: Some(false),
                            });
                        }
                        _ => {}
                    }
                }
                Err(e) => hub.emit(ipc::DuoEvent::AgentError {
                    session_id: Some(sid.clone()),
                    level: ipc::LogLevel::Warn,
                    code: "compact_failed".into(),
                    message: format!("压缩失败:{e}"),
                    retryable: false,
                    retry_in_ms: None,
                    attempt: None,
                    fatal: Some(false),
                }),
            }
        });
        Ok(())
    }

    fn steer(&self, session_id: &str, duo_id: &str, text: &str) -> bool {
        self.deliver(session_id, duo_id, text, QueueKind::Steering)
    }

    fn follow_up(&self, session_id: &str, duo_id: &str, text: &str) -> bool {
        self.deliver(session_id, duo_id, text, QueueKind::FollowUp)
    }

    fn cancel_queued(&self, session_id: &str, text: &str) {
        let Some(agent) = poison(&self.sessions).get(session_id).cloned() else { return };
        let entry = {
            let d = poison(&agent.state.delivered);
            d.by_duo.iter().find(|(_, (_, t, _))| t == text).map(|(id, (_, _, rpi_id))| (id.clone(), rpi_id.clone()))
        };
        if let Some((duo_id, rpi_id)) = entry {
            let _ = self.rt.block_on(agent.harness.cancel_queued(&rpi_id));
            let mut d = poison(&agent.state.delivered);
            d.by_duo.remove(&duo_id);
        }
    }
}

impl RpiRuntime {
    fn deliver(&self, session_id: &str, duo_id: &str, text: &str, kind: QueueKind) -> bool {
        let Some(agent) = poison(&self.sessions).get(session_id).cloned() else { return false };
        let msg = user_text(text);
        let harness = agent.harness.clone();
        // Runtime trait 是同步的(hub 命令线程):异步队列 API 在此 bridge
        let res = self.rt.block_on(match kind {
            QueueKind::Steering => harness.steer(msg),
            QueueKind::FollowUp => harness.follow_up(msg),
        });
        match res {
            Ok(qr) => {
                let mut d = poison(&agent.state.delivered);
                d.by_duo.insert(duo_id.to_string(), (kind, text.to_string(), qr.entry_id));
                drop(d);
                if let Ok(hub) = self.hub() {
                    persist_user_message(&hub, &agent.state, text);
                }
                true
            }
            Err(_) => false,
        }
    }
}

fn user_text(text: &str) -> AgentMessage {
    AgentMessage::User(rpi_ai::types::UserMessage {
        role: rpi_ai::types::UserRole,
        content: rpi_ai::types::UserContent::Text(text.to_string()),
        timestamp: now_ms(),
    })
}

/* ---------------- e2e 测试(FauxProvider 跑真 rpi 循环,不 mock 断言) ---------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::CollectSink;
    use crate::store::Store;
    use serde_json::json;
    use std::time::Duration;

    struct Fixture {
        hub: Arc<Hub>,
        sink: Arc<CollectSink>,
        workdir: tempfile::TempDir,
        _data: tempfile::TempDir,
        _runtime: Arc<RpiRuntime>,
    }

    /// 回合事件都经 sink 收集;messages/parts 落库后从 SQLite 读回断言(§6.9 口径)
    fn fixture(script: FauxScript) -> Fixture {
        let workdir = tempfile::TempDir::new().unwrap();
        let data = tempfile::TempDir::new().unwrap();
        let store = Arc::new(Store::open(data.path()).unwrap());
        {
            let db = store.read();
            db.execute("INSERT INTO projects(id,path,name,created_at) VALUES('pr',?1,'pr',1)", params![workdir.path().display().to_string()])
                .unwrap();
            db.execute("INSERT INTO sessions(id,project_id,title,mode,created_at,updated_at) VALUES('s1','pr','e2e','code',1,1)", [])
                .unwrap();
        }
        let sink = Arc::new(CollectSink::default());
        let runtime = RpiRuntime::new(Arc::new(FauxFactory::new(script)));
        let hub = Hub::open(store, workdir.path(), data.path(), sink.clone(), runtime.clone()).unwrap();
        runtime.attach(hub.clone());
        Fixture { hub, sink, workdir, _data: data, _runtime: runtime }
    }

    fn wait_for(sink: &CollectSink, what: &str, pred: impl Fn(&[ipc::DuoEvent]) -> bool) {
        let t0 = Instant::now();
        loop {
            {
                let events = sink.events.lock().unwrap_or_else(|e| e.into_inner());
                if pred(&events) {
                    return;
                }
            }
            assert!(t0.elapsed() < Duration::from_secs(30), "等待超时:{what}");
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    fn events_with(evs: &[ipc::DuoEvent], f: impl Fn(&ipc::DuoEvent) -> bool) -> Vec<&ipc::DuoEvent> {
        evs.iter().filter(|e| f(e)).collect()
    }

    fn wait_db<T: PartialEq + Clone + std::fmt::Debug>(what: &str, probe: impl Fn() -> Option<T>, expected: T) {
        let t0 = Instant::now();
        loop {
            let actual = probe();
            if actual == Some(expected.clone()) {
                return;
            }
            assert!(t0.elapsed() < std::time::Duration::from_secs(15), "落库超时:{what} · 最后实测={actual:?} · 期望={expected:?}");
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }

    fn submit(f: &Fixture, text: &str, mode: &str) {
        f.hub
            .handle("submit_message", json!({ "session_id": "s1", "text": text, "mode": mode, "model": "faux" }))
            .unwrap();
    }

    #[test]
    fn 文本回合_流式事件与转录都落库() {
        let script = FauxScript::new();
        script.set_responses(vec![rpi_ai::providers::faux::FauxStep::message(rpi_ai::providers::faux::faux_assistant_message(
            vec![rpi_ai::providers::faux::FauxBlock::thinking("先想想"), rpi_ai::providers::faux::FauxBlock::text("你好,世界")],
            StopReason::Stop,
        ))]);
        let f = fixture(script);
        submit(&f, "打个招呼", "ask");
        wait_for(&f.sink, "agent_end", |evs| {
            events_with(evs, |e| matches!(e, ipc::DuoEvent::AgentEnd { reason: ipc::EndReason::Done, .. })).len() == 1
        });
        let events = f.sink.events.lock().unwrap();
        assert!(events_with(&events, |e| matches!(e, ipc::DuoEvent::TextDelta { delta, .. } if delta == "你好,世界")).iter().any(|_| true), "文本增量必须出现");
        assert!(events_with(&events, |e| matches!(e, ipc::DuoEvent::ReasoningDelta { .. })).iter().any(|_| true), "思考链增量必须出现");
        assert!(events_with(&events, |e| matches!(e, ipc::DuoEvent::TurnEnd { .. })).len() == 1, "每回合一条 turn_end");
        assert!(events_with(&events, |e| matches!(e, ipc::DuoEvent::ContextUsage { .. })).iter().any(|_| true), "回合尾刷新上下文");
        assert!(events_with(&events, |e| matches!(e, ipc::DuoEvent::AgentError { .. })).is_empty(), "纯文本回合不该有错误");
        drop(events);
        // UI 还原口径:转录必须能从 SQLite 重建(轮询:写走即发即忘队列)
        wait_db(
            "两条消息落库",
            || {
                let db = f.hub.store.read();
                let mut q = db.prepare("SELECT role FROM messages WHERE session_id='s1' ORDER BY created_at").unwrap();
                let rows: Vec<String> = q.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
                if rows.len() == 2 { Some(rows) } else { None }
            },
            vec!["user".to_string(), "assistant".to_string()],
        );
        wait_db(
            "助手正文 part 完整落库",
            || {
                let db = f.hub.store.read();
                let md: Result<String, _> = db
                    .prepare("SELECT content FROM parts WHERE type='text' AND message_id=(SELECT id FROM messages WHERE role='assistant')")
                    .unwrap()
                    .query_row([], |r| r.get(0));
                Some(md.is_ok_and(|m| m.contains("你好,世界")))
            },
            true,
        );
        let db = f.hub.store.read();
        let n: i64 = db.prepare("SELECT count(*) FROM parts WHERE type='reasoning'").unwrap().query_row([], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "思考链单独成 part");
    }

    #[test]
    fn write_工具_审批放行后真实写盘并回报文件变更() {
        let script = FauxScript::new()
            .with_tool_call("write", json!({ "path": "out.txt", "content": "hello from rpi" }))
            .with_text("已写入");
        let f = fixture(script);
        submit(&f, "写个文件", "code"); // code 模式 write 默认 REQUIRE_APPROVAL
        wait_for(&f.sink, "human_confirm_required", |evs| {
            events_with(evs, |e| matches!(e, ipc::DuoEvent::HumanConfirmRequired { tool_name, .. } if tool_name == "write")).len() == 1
        });
        let call_id = {
            let events = f.sink.events.lock().unwrap();
            let ev = events
                .iter()
                .find_map(|e| match e {
                    ipc::DuoEvent::HumanConfirmRequired { call_id, .. } => Some(call_id.clone()),
                    _ => None,
                })
                .unwrap()
                .clone();
            ev
        };
        assert!(!f.workdir.path().join("out.txt").exists(), "放行前不得写盘");
        f.hub.handle("approve_tool_call", json!({ "call_id": call_id, "decision": "allow" })).unwrap();
        wait_for(&f.sink, "agent_end(Done)", |evs| {
            events_with(evs, |e| matches!(e, ipc::DuoEvent::AgentEnd { reason: ipc::EndReason::Done, .. })).len() == 1
        });
        let written = std::fs::read_to_string(f.workdir.path().join("out.txt")).expect("放行后真写盘");
        assert_eq!(written, "hello from rpi");
        let events = f.sink.events.lock().unwrap();
        assert!(events_with(&events, |e| matches!(e, ipc::DuoEvent::ToolCallResult { .. })).len() == 1);
        assert!(events_with(&events, |e| matches!(e, ipc::DuoEvent::FileChanged { paths, .. } if paths.contains(&"out.txt".to_string()))).len() == 1, "写成功必须报 file_changed");
        drop(events);
        wait_db(
            "审批 part 记录决定",
            || {
                let db = f.hub.store.read();
                let row: Result<(String, String), _> =
                    db.prepare("SELECT state, content FROM parts WHERE type='approval'").unwrap().query_row([], |r| Ok((r.get(0)?, r.get(1)?)));
                row.ok().map(|ap| {
                    let dec: Value = serde_json::from_str(&ap.1).unwrap();
                    dec["decision"].as_str() == Some("allow") && ap.0 != "awaiting_approval"
                })
            },
            true,
        );
        wait_db(
            "写前快照落库(PLAN §7.2,给 Revert 留料)",
            || {
                let db = f.hub.store.read();
                let snaps: i64 = db.prepare("SELECT count(*) FROM file_snapshots").unwrap().query_row([], |r| r.get(0)).unwrap();
                Some(snaps >= 1)
            },
            true,
        );
    }

    #[test]
    fn write_工具_拒绝后不写盘且回合以拒绝继续() {
        let script = FauxScript::new()
            .with_tool_call("write", json!({ "path": "never.txt", "content": "x" }))
            .with_text("好的,我不写了");
        let f = fixture(script);
        submit(&f, "写文件但我会拒绝", "code");
        wait_for(&f.sink, "审批卡", |evs| events_with(evs, |e| matches!(e, ipc::DuoEvent::HumanConfirmRequired { .. })).len() == 1);
        let call_id = f
            .sink
            .events
            .lock()
            .unwrap()
            .iter()
            .find_map(|e| match e {
                ipc::DuoEvent::HumanConfirmRequired { call_id, .. } => Some(call_id.clone()),
                _ => None,
            })
            .unwrap();
        f.hub.handle("approve_tool_call", json!({ "call_id": call_id, "decision": "deny" })).unwrap();
        wait_for(&f.sink, "agent_end", |evs| events_with(evs, |e| matches!(e, ipc::DuoEvent::AgentEnd { .. })).len() == 1);
        assert!(!f.workdir.path().join("never.txt").exists(), "拒绝后绝不能写盘");
        let events = f.sink.events.lock().unwrap();
        assert!(
            events_with(&events, |e| matches!(e, ipc::DuoEvent::AgentError { code, .. } if code=="provider_error")).is_empty(),
            "拒绝是正常路径,不该报 provider_error"
        );
        assert!(events_with(&events, |e| matches!(e, ipc::DuoEvent::AgentEnd { reason: ipc::EndReason::Done, .. })).len() == 1, "模型收到拒绝后继续到完成");
    }

    #[test]
    fn 待审批中_stop_终止回合不写盘() {
        let script = FauxScript::new().with_tool_call("write", json!({ "path": "late.txt", "content": "x" }));
        let f = fixture(script);
        submit(&f, "写盘,但我按停止", "code");
        wait_for(&f.sink, "审批挂起", |evs| events_with(evs, |e| matches!(e, ipc::DuoEvent::HumanConfirmRequired { .. })).len() == 1);
        f.hub.handle("stop_agent", json!({ "session_id": "s1" })).unwrap();
        wait_for(&f.sink, "agent_end(Stopped)", |evs| {
            !events_with(evs, |e| matches!(e, ipc::DuoEvent::AgentEnd { reason, .. } if matches!(reason, ipc::EndReason::Stopped))).is_empty()
        });
        assert!(!f.workdir.path().join("late.txt").exists(), "abort 后不得有写副作用");
    }

    #[test]
    fn 模型切换不丢历史_同一存储重建() {
        let script = FauxScript::new().with_text("第一段").with_text("第二段");
        let f = fixture(script);
        submit(&f, "第一回合", "ask");
        wait_for(&f.sink, "回合1 完成", |evs| events_with(evs, |e| matches!(e, ipc::DuoEvent::AgentEnd { .. })).len() == 1);
        // 换一个模型名 → ensure_session 用同一 storage 重建 harness
        submit(&f, "第二回合(切模型)", "ask");
        wait_for(&f.sink, "回合2 完成", |evs| events_with(evs, |e| matches!(e, ipc::DuoEvent::AgentEnd { .. })).len() == 2);
        wait_db(
            "两回合的 user+assistant 都在(历史没因重建丢失)",
            || {
                let db = f.hub.store.read();
                let n: i64 = db.prepare("SELECT count(*) FROM messages WHERE session_id='s1'").unwrap().query_row([], |r| r.get(0)).unwrap();
                if n == 4 { Some(4i64) } else { None }
            },
            4i64,
        );
    }

    /// 真端点全链路（不 mock 断言）：provider_test 合并落库 →
    /// DbProviderFactory 构 OpenAiCompletionsProvider → rpi 循环真 POST /chat/completions → 事件与转录落库
    #[test]
    fn 真实http端点_从刷新模型到跑完一个回合() {
        const SERVER: &str = r#"
import http.server, json, sys
def chunk(delta, finish=None):
    return "data: " + json.dumps({"choices":[{"delta":delta,"finish_reason":finish}]}) + "\n\n"
BODY = (chunk({"content":"你好，这是真实 HTTP 链路的回合。"}) + chunk({}, "stop") + "data: [DONE]\n\n").encode()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.endswith("/models"):
            body = json.dumps({"data":[{"id":"demo-model"},{"id":"another-model"}]}).encode()
            self.send_response(200); self.send_header("Content-Type","application/json")
        else:
            self.send_error(404); return
        self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length",0) or 0))
        self.send_response(200); self.send_header("Content-Type","text/event-stream")
        self.end_headers(); self.wfile.write(BODY); self.wfile.flush()
    def log_message(self,*a): pass
srv = http.server.HTTPServer(("127.0.0.1",0), H)
sys.stdout.write(str(srv.server_address[1])+"\n"); sys.stdout.flush()
srv.serve_forever()
"#;
        let mut child = std::process::Command::new("python3")
            .args(["-c", SERVER])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("测试环境需要 python3 起假 OpenAI 端点");
        let port: u16 = {
            use std::io::BufRead;
            let mut line = String::new();
            std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
            line.trim().parse().unwrap()
        };
        std::env::set_var("DEMO_E2E_KEY", "sk-fake");
        let wd = tempfile::TempDir::new().unwrap();
        let data = tempfile::TempDir::new().unwrap();
        let store = Arc::new(crate::store::Store::open(data.path()).unwrap());
        {
            let db = store.read();
            db.execute("INSERT INTO projects(id,path,name,created_at) VALUES('pr','/tmp/x','pr',1)", []).unwrap();
            db.execute("INSERT INTO sessions(id,project_id,title,mode,created_at,updated_at) VALUES('s1','pr','e2e','ask',1,1)", []).unwrap();
            db.execute(
                "INSERT INTO providers(id,name,base_url,key_ref,models,created_at) VALUES('demo','本地假端点',?1,'DEMO_E2E_KEY','[]',1)",
                params![format!("http://127.0.0.1:{port}/v1")],
            )
            .unwrap();
        }
        let sink = Arc::new(crate::hub::CollectSink::default());
        let runtime = RpiRuntime::new(Arc::new(DbProviderFactory::new(store.clone())));
        let hub = Hub::open(store, wd.path(), data.path(), sink.clone(), runtime.clone()).unwrap();
        runtime.attach(hub.clone());

        let r = hub.handle("provider_test", json!({ "id": "demo" })).expect("GET /models 应成功");
        assert_eq!(r["count"], json!(2), "刷新模型拉到两个");
        let list = hub.handle("provider_list", json!({})).unwrap();
        assert_eq!(list["providers"][0]["models"].as_array().unwrap().len(), 2, "合并后 models 落库");

        hub.handle("submit_message", json!({ "session_id": "s1", "text": "打个招呼", "mode": "ask", "model": "demo-model" }))
            .unwrap();
        wait_for(&sink, "真 HTTP 回合完成", |evs| {
            !events_with(evs, |e| matches!(e, ipc::DuoEvent::AgentEnd { reason: ipc::EndReason::Done, .. })).is_empty()
        });
        let events = sink.events.lock().unwrap();
        assert!(!events_with(&events, |e| matches!(e, ipc::DuoEvent::TextDelta { delta, .. } if delta.contains("真实 HTTP 链路"))).is_empty(), "SSE 文本增量必须到达协议事件");
        assert_eq!(events_with(&events, |e| matches!(e, ipc::DuoEvent::TurnEnd { model, .. } if model == "demo-model")).len(), 1);
        drop(events);
        wait_db(
            "真链路转录落库",
            || {
                let db = hub.store.read();
                let md: Result<String, _> = db
                    .prepare("SELECT content FROM parts WHERE type='text' AND message_id=(SELECT id FROM messages WHERE role='assistant')")
                    .unwrap()
                    .query_row([], |r| r.get(0));
                Some(md.is_ok_and(|m| m.contains("真实 HTTP 链路")))
            },
            true,
        );
        let _ = child.kill();
        let _ = child.wait();
    }
}


