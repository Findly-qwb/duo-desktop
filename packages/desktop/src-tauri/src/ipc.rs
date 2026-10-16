//! IPC 协议唯一定义处（PLAN §9 / §15）。
//! 前端类型由 ts-rs 生成到 `packages/desktop/src/ipc/generated/`，避免手写漂移。
//! 事件与命令的名字必须与 `src/ipc/protocol.ts` 一致（该文件是本模块的生成产物）。

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: i32 = 8;
/// rpi 接入后由 build.rs 注入 vendored commit 短 hash（PLAN §14：锁 hash，禁 cargo update）
pub const RUNTIME_VERSION: &str = match option_env!("DUO_RPI_REV") {
    Some(r) => r,
    None => "host-core (rpi 未接入)",
};
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Rust → 前端：20 个事件（PLAN §9.1）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DuoEvent {
    Ready {
        app_version: String,
        runtime_version: String,
        schema_version: i32,
    },
    TextDelta { session_id: String, message_id: String, seq: u64, delta: String },
    ReasoningDelta { session_id: String, message_id: String, seq: u64, delta: String },
    MessagePartUpserted { session_id: String, part: Part },
    ToolCallStart {
        call_id: String,
        tool_name: String,
        source: String,
        args: serde_json::Value,
        session_id: String,
        turn_index: u32,
        message_id: String,
    },
    ToolCallOutputDelta { call_id: String, chunk: String, session_id: String },
    ToolCallResult {
        call_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        duration_ms: u64,
        truncated: bool,
        session_id: String,
    },
    HumanConfirmRequired {
        call_id: String,
        tool_name: String,
        source: String,
        kind: ConfirmKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        command: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        paths: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        diff: Option<Vec<DiffLine>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        matched_rule: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
        expires_at: i64,
        session_id: String,
        message_id: String,
    },
    QuestionRequired { question_id: String, session_id: String, message_id: String, questions: Vec<Question> },
    TurnEnd {
        turn_index: u32,
        tokens: TokenUsage,
        cost_estimate: f64,
        model: String,
        session_id: String,
        duration_ms: u64,
        steps: u32,
        throughput: f64,
    },
    ContextUsage {
        used: u64,
        reserved: u64,
        window: u64,
        auto_compact_at: u8,
        hit_rate: u8,
        session_id: String,
    },
    AgentEnd { session_id: String, reason: EndReason, #[serde(skip_serializing_if = "Option::is_none")] summary: Option<String> },
    AgentError {
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        level: LogLevel,
        code: String,
        message: String,
        retryable: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_in_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attempt: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fatal: Option<bool>,
    },
    CompactDone { from_turn: u32, tokens_before: u64, tokens_after: u64, session_id: String, message_id: String },
    FileChanged { paths: Vec<String>, #[serde(skip_serializing_if = "Option::is_none")] session_id: Option<String> },
    GitStatusChanged { branch: String, ahead: u32, behind: u32, files: Vec<GitFile> },
    ScanProgress { project: String, scanned: u64, total: u64, phase: String },
    McpStatus { server: String, status: McpState, tools: u32, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String> },
    SessionUpdated { session_id: String, #[serde(skip_serializing_if = "Option::is_none")] title: Option<String>, updated_at: i64, activity: Activity },
    QueueState { session_id: String, main: Vec<QueuedItem>, steering: Vec<QueuedItem>, follow_up: Vec<QueuedItem> },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    Done,
    Stopped,
    Limit,
    Error,
    /// 任务级 panic 被 catch_unwind 捕获（PLAN §3.3：不崩窗，只终止该 Turn）
    Panic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmKind {
    Command,
    Paths,
    Diff,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpState {
    Connecting,
    Connected,
    NeedsAuth,
    Failed,
    Disabled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    Idle,
    Run,
    Ask,
    Err,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt: u64,
    pub completion: u64,
    pub reasoning: u64,
    pub cache_read: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// add | del | hunk | ctx
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub q: String,
    pub options: Vec<QuestionOption>,
    pub allow_custom: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub status: String,
    pub added: u32,
    pub deleted: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedItem {
    pub id: String,
    pub text: String,
}

/// part 级落库单元（PLAN §10 `parts.content` 存 JSON）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub id: String,
    pub message_id: String,
    pub seq: i64,
    /// text | reasoning | tool | question | approval | compact | error
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    pub content: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 事件投递：seq 语义是 (session_id, turn_index, seq) 三元组，
/// 断流跨 Turn 时单 since_seq 定位不到起点，故 resync 带 turn_index 游标（PLAN §9.2 [v2.1]）。
#[derive(Debug, Clone, Serialize)]
pub struct Envelope {
    pub name: &'static str,
    pub payload: DuoEvent,
    pub turn_index: u32,
    pub seq: u64,
    pub ts: i64,
}

/* ---------------- 命令入参与行类型（前端 → Rust，PLAN §9.2） ---------------- */

use crate::perms::{Exception, Matcher, Policy, Scope};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitMessage {
    pub session_id: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub context_refs: Vec<String>,
    pub mode: String,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveToolCall {
    pub call_id: String,
    /// allow | deny | allow_always
    pub decision: String,
    /// 改参数后执行（保住用户已填参数）
    #[serde(default)]
    pub modified_args: Option<serde_json::Value>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub scope: Scope,
    #[serde(default)]
    pub scope_ref: Option<String>,
    pub tool: String,
    pub policy: Policy,
    #[serde(default)]
    pub matcher: Option<Matcher>,
    #[serde(default)]
    pub exceptions: Vec<Exception>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionRow {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub mode: String,
    pub model: Option<String>,
    pub status: String,
    pub cost_estimate: f64,
    pub total_tokens: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessageRow {
    pub id: String,
    pub role: String,
    pub turn_index: Option<i64>,
    pub status: String,
    pub model: Option<String>,
    pub cost_estimate: Option<f64>,
    pub created_at: i64,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}
