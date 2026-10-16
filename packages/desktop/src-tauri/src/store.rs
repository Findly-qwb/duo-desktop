//! SQLite 持久化（PLAN §10）——桌面侧唯一事实来源。
//! 约束：
//! - WAL + foreign_keys=ON + user_version 迁移；迁移前复制 db 到 backup/
//! - 写只允许在单一 writer task（mpsc 串行化）；`parts` 与 `parts_fts` 必须同事务写入
//! - 读走连接池，禁止在事件循环里做同步 IO

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags, params};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

pub const SCHEMA_VERSION: i64 = 7;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("迁移失败 user_version={from}->{to}: {source}")]
    Migration { from: i64, to: i64, source: rusqlite::Error },
    #[error("db 来自更新版本（user_version={from} > 本程序 {to}），请升级应用")]
    TooNew { from: i64, to: i64 },
    #[error("writer task 已退出")]
    Closed,
    #[error("io: {0}")]
    Io(String),
}

type Job = Box<dyn FnOnce(&Connection) -> Result<(), rusqlite::Error> + Send + 'static>;

/// 单写者：所有写请求经此队列串行落库，避免 SQLITE_BUSY 与 FTS 双写竞态
pub struct Writer {
    tx: mpsc::UnboundedSender<Job>,
}

impl Writer {
    pub async fn submit<F, T>(&self, f: F) -> Result<T, StoreError>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error> + Send + 'static,
        T: Send + 'static,
    {
        let (res_tx, res_rx) = oneshot::channel();
        let job: Job = Box::new(move |conn| {
            let out = f(conn);
            let _ = res_tx.send(out);
            Ok(())
        });
        self.tx.send(job).map_err(|_| StoreError::Closed)?;
        Ok(res_rx.await.map_err(|_| StoreError::Closed)??)
    }

    /// 同步入口：宿主命令层（hub）跑在 blocking 线程上，仍然排到同一个 writer 队列，
    /// 单写者不变量不因调用方是同步的而破。
    pub fn submit_blocking<F, T>(&self, f: F) -> Result<T, StoreError>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error> + Send + 'static,
        T: Send + 'static,
    {
        let (res_tx, res_rx) = oneshot::channel();
        let job: Job = Box::new(move |conn| {
            let out = f(conn);
            let _ = res_tx.send(out);
            Ok(())
        });
        self.tx.send(job).map_err(|_| StoreError::Closed)?;
        Ok(res_rx.blocking_recv().map_err(|_| StoreError::Closed)??)
    }

    /// 双兼容入口：调用方可能处在 async 上下文(adapt 的事件 pump 在 runtime 任务里)——
    /// 那里 `blocking_recv` 会 panic,所以给 async 侧一个 await 结果的变体,单写者不变量相同。
    pub async fn submit_await<F, T>(&self, f: F) -> Result<T, StoreError>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error> + Send + 'static,
        T: Send + 'static,
    {
        let (res_tx, res_rx) = oneshot::channel();
        let job: Job = Box::new(move |conn| {
            let out = f(conn);
            let _ = res_tx.send(out);
            Ok(())
        });
        self.tx.send(job).map_err(|_| StoreError::Closed)?;
        Ok(res_rx.await.map_err(|_| StoreError::Closed)??)
    }

    /// 即发即忘：事件 pump 里的持久化用。单写者队列保证顺序(同会话的 part 先于后续事件落库),
    /// 结果错误由 writer 任务自己记日志,不阻塞事件流。
    pub fn submit_fire<F>(&self, f: F)
    where
        F: FnOnce(&Connection) -> Result<(), rusqlite::Error> + Send + 'static,
    {
        let job: Job = Box::new(f);
        if self.tx.send(job).is_err() {
            log::error!("db writer 已退出,写请求被丢弃");
        }
    }
}

/// 读连接 + 写队列。`Connection` 不是 Sync，故本类型不实现 Clone：
/// 需要跨任务共享时由上层包一层 `Arc<Store>`，读走 `&Connection`。
/// 读连接 + 写队列。
/// `Connection` 不是 Sync，所以读连接包在 `Mutex` 里：这样 `Arc<Store>`（以及持有它的
/// `Arc<Hub>`）才是 Send+Sync，能作为 Tauri 的托管状态跨线程共享。
pub struct Store {
    read: Mutex<Connection>,
    pub writer: Arc<Writer>,
    pub path: PathBuf,
}

impl Store {
    /// 打开（或创建）数据库并跑迁移
    pub fn open(dir: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(dir).map_err(|e| StoreError::Io(e.to_string()))?;
        let path = dir.join("duo-desktop.db");

        if path.exists() {
            let version = current_version(&path)?;
            if version < SCHEMA_VERSION {
                backup(&path, &dir.join("backup"))?;
            }
        }

        let read = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE)?;
        apply_pragmas(&read)?;
        migrate(&read)?;

        let write_path = path.clone();
        let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
        std::thread::Builder::new()
            .name("duo-db-writer".into())
            .spawn(move || {
                // writer 独占连接：WAL 下允许单写多读
                let Ok(conn) = Connection::open(write_path) else { log::error!("writer 连接打不开，写队列停摆"); return; };
                apply_pragmas(&conn).ok();
                while let Some(job) = rx.blocking_recv() {
                    if let Err(e) = job(&conn) {
                        log::error!("db writer: {e}");
                    }
                }
            })
            .map_err(|e| StoreError::Io(e.to_string()))?;

        Ok(Self { read: Mutex::new(read), writer: Arc::new(Writer { tx }), path })
    }

    /// 读连接（短锁；写一律走 writer 队列）
    pub fn read(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.read.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn apply_pragmas(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    Ok(())
}

fn current_version(path: &Path) -> Result<i64, StoreError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?)
}

/// 迁移前先复制整库（含 -wal / -shm）
fn backup(path: &Path, into: &Path) -> Result<(), StoreError> {
    std::fs::create_dir_all(into).ok();
    let stamp = chrono_lite_stamp();
    let dst = into.join(format!("duo-desktop.{stamp}.db"));
    std::fs::copy(path, &dst).map_err(|e| StoreError::Io(e.to_string()))?;
    for ext in ["-wal", "-shm"] {
        let src = PathBuf::from(format!("{}{ext}", path.display()));
        if src.exists() {
            std::fs::copy(&src, into.join(format!("duo-desktop.{stamp}.db{ext}"))).ok();
        }
    }
    Ok(())
}

fn chrono_lite_stamp() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    now.to_string()
}

/// user_version 递增 + 事务内 ALTER
pub fn migrate(conn: &Connection) -> Result<(), StoreError> {
    let from = conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?;
    if from > SCHEMA_VERSION {
        return Err(StoreError::TooNew { from, to: SCHEMA_VERSION });
    }
    if from == SCHEMA_VERSION {
        return Ok(());
    }

    conn.execute_batch(SCHEMA_SQL).map_err(|e| StoreError::Migration { from, to: SCHEMA_VERSION, source: e })?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

/// 与 PLAN §10 逐表对应；`parts_fts` 与 `parts` 必须同事务写
pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  is_git INTEGER DEFAULT 0, last_opened INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'ask',
  model TEXT, variant TEXT, provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  total_tokens INTEGER DEFAULT 0, cost_estimate REAL DEFAULT 0,
  pinned INTEGER DEFAULT 0, deleted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project_updated ON sessions(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, turn_index INTEGER, status TEXT DEFAULT 'complete',
  prompt_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER,
  cache_read_tokens INTEGER, cost_estimate REAL, model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE TABLE IF NOT EXISTS parts (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, type TEXT NOT NULL,
  tool_name TEXT, tool_source TEXT, call_id TEXT, state TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_parts_msg_seq ON parts(message_id, seq);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  part_id TEXT, kind TEXT NOT NULL,
  name TEXT NOT NULL, mime TEXT, bytes INTEGER, path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  queue_state TEXT NOT NULL, last_turn INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS file_snapshots (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL, message_id TEXT, ckpt_oid TEXT NOT NULL,
  files TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON file_snapshots(session_id, turn_index);
CREATE TABLE IF NOT EXISTS tool_permissions (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_ref TEXT,
  tool TEXT NOT NULL, policy TEXT NOT NULL,
  matcher TEXT, exceptions TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_unique ON tool_permissions(scope, IFNULL(scope_ref,''), tool);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL,
  config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT DEFAULT 'disabled', tools INTEGER DEFAULT 0, last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, command TEXT NOT NULL, name TEXT, description TEXT,
  system_prompt TEXT NOT NULL, model TEXT, variant TEXT,
  scope TEXT NOT NULL DEFAULT 'global',
  path TEXT, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
);
-- PLAN §10 原文把 IFNULL(...) 写进表级 UNIQUE，SQLite 会拒绝表达式；
-- 唯一性改用函数索引（CREATE UNIQUE INDEX 允许表达式），语义等价。
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_unique ON skills(command, scope, IFNULL(path,''));
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  key_ref TEXT, models TEXT, last_check INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ui_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  session_id TEXT PRIMARY KEY, text TEXT, attachments TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, level TEXT, event TEXT, payload TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(content, part_id UNINDEXED, tokenize='unicode61');
"#;

/// part + FTS 同事务写入（PLAN §10 [v2.1]：拆到不同 writer 会在 WAL 上争用）
pub fn upsert_part(conn: &Connection, p: &crate::ipc::Part) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO parts(id,message_id,seq,type,tool_name,tool_source,call_id,state,content,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, content=excluded.content, updated_at=excluded.updated_at",
        params![p.id, p.message_id, p.seq, p.r#type, p.tool_name, p.tool_source, p.call_id, p.state, p.content.to_string(), p.created_at, p.updated_at],
    )?;
    let plain = p.content.get("md").or_else(|| p.content.get("text")).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    tx.execute("DELETE FROM parts_fts WHERE part_id = ?1", params![p.id])?;
    if !plain.is_empty() {
        tx.execute("INSERT INTO parts_fts(content, part_id) VALUES(?1, ?2)", params![plain, p.id])?;
    }
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 迁移幂等且外键生效() {
        let dir = std::env::temp_dir().join(format!("duo-db-{}", std::process::id()));
        let store = Store::open(&dir).expect("open");
        let v: i64 = store.read().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        // 重复迁移不应报错
        migrate(&store.read()).unwrap();
        // foreign_keys 生效：无 project 的 session 必须被拒
        let e = store
            .read()
            .execute("INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES('s','nope','t',1,1)", []);
        assert!(e.is_err(), "外键必须生效");
    }

    #[test]
    fn fts_与_parts_同事务() {
        let dir = std::env::temp_dir().join(format!("duo-db-ft-{}", std::process::id()));
        let store = Store::open(&dir).unwrap();
        // 先建 project / session，再挂 message：外键是真的，测试数据也必须满足它
        store.read().execute("INSERT INTO projects(id,path,name,created_at) VALUES('pr','/tmp/pr','pr',1)", []).unwrap();
        store.read().execute("INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES('s','pr','t',1,1)", []).unwrap();
        store.read().execute("INSERT INTO messages(id,session_id,role,created_at) VALUES('m','s','assistant',1)", []).unwrap();
        let part = crate::ipc::Part {
            id: "p1".into(),
            message_id: "m".into(),
            seq: 0,
            r#type: "text".into(),
            tool_name: None,
            tool_source: None,
            call_id: None,
            state: None,
            content: serde_json::json!({ "type": "text", "md": "SQLite WAL 单写多读" }),
            created_at: 1,
            updated_at: 1,
        };
        upsert_part(&store.read(), &part).unwrap();
        let hits: i64 = store
            .read()
            .query_row("SELECT count(*) FROM parts_fts WHERE parts_fts MATCH 'WAL'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hits, 1);
    }

    #[test]
    fn 多会话并发写单writer无冲突且全文索引行数一致() {
        // T4：todos 里「单 writer 队列的真实并发压测（多会话同时写 + FTS 同事务）」
        // 8 个线程各为自己的会话连续写 part（upsert_part 内部同事务写 parts + parts_fts）
        // 并更新 sessions.updated_at。所有写经同一 mpsc 串行：任何 SQLITE_BUSY / database is locked
        // 都会让 submit_blocking 返回 Err，这里 unwrap 即失败。
        use std::sync::Arc;
        let dir = std::env::temp_dir().join(format!("duo-db-load-{}", std::process::id()));
        let store = Arc::new(Store::open(&dir).unwrap());
        const SESSIONS: usize = 8;
        const MSGS_PER: usize = 25;
        {
            let db = store.read();
            db.execute("INSERT INTO projects(id,path,name,created_at) VALUES('pr','/tmp/pr','pr',1)", []).unwrap();
            for i in 0..SESSIONS {
                db.execute(
                    "INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES(?1,'pr',?2,1,1)",
                    params![format!("s{i}"), format!("会话{i}")],
                )
                .unwrap();
                db.execute("INSERT INTO messages(id,session_id,role,created_at) VALUES(?1,?2,'assistant',1)", params![format!("m{i}"), format!("s{i}")]).unwrap();
            }
        }
        // WAL 读写并行：写入期间另一线程持续读计数，读侧不得报错
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let store = store.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut saw = 0usize;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let n: i64 = store.read().query_row("SELECT count(*) FROM parts", [], |r| r.get(0)).unwrap();
                    if n > 0 {
                        saw += 1;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                saw
            })
        };
        let writers: Vec<_> = (0..SESSIONS)
            .map(|i| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for j in 0..MSGS_PER {
                        let part = crate::ipc::Part {
                            id: format!("p{i}-{j}"),
                            message_id: format!("m{i}"),
                            seq: j as i64,
                            r#type: "text".into(),
                            tool_name: None,
                            tool_source: None,
                            call_id: None,
                            state: None,
                            content: serde_json::json!({ "type": "text", "md": format!("并发压测关键词 s{i} 第{j}条") }),
                            created_at: 1,
                            updated_at: 1,
                        };
                        store
                            .writer
                            .submit_blocking(move |conn| {
                                upsert_part(conn, &part)?;
                                conn.execute("UPDATE sessions SET updated_at = updated_at + 1 WHERE id = ?1", params![format!("s{i}")])?;
                                Ok(())
                            })
                            .unwrap_or_else(|e| panic!("并发写出现冲突 {i}/{j}: {e}"));
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let reads_during_write = reader.join().unwrap();
        let expected = (SESSIONS * MSGS_PER) as i64;
        let db = store.read();
        let parts: i64 = db.query_row("SELECT count(*) FROM parts", [], |r| r.get(0)).unwrap();
        let fts: i64 = db.query_row("SELECT count(*) FROM parts_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(parts, expected, "parts 行数必须全量落库");
        assert_eq!(fts, expected, "FTS 必须与 parts 同事务成对出现");
        for i in 0..SESSIONS {
            let hits: i64 = db
                .query_row("SELECT count(*) FROM parts_fts WHERE parts_fts MATCH ?1", params![format!("s{i}")], |r| r.get(0))
                .unwrap();
            assert_eq!(hits, MSGS_PER as i64, "每会话关键词检索必须全命中");
            let bumps: i64 = db.query_row("SELECT updated_at FROM sessions WHERE id = ?1", params![format!("s{i}")], |r| r.get(0)).unwrap();
            assert_eq!(bumps, 1 + MSGS_PER as i64, "每会话的 updated_at 更新计数不能丢写");
        }
        assert!(reads_during_write > 0, "写入期间读侧必须能看到中间状态（WAL 读写并行）");
    }
}
