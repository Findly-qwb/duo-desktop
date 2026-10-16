import { t } from "../i18n";
/**
 * IPC 协议类型（PLAN §9 / §10）—— 前端侧唯一协议来源。
 * Rust 侧 ipc.rs 为权威，经 ts-rs 生成；本文件手写以先冻结契约（MVP0 验收：无未定义事件/字段）。
 */

/* ---------- 协议版本（PLAN §9 末：不匹配即提示「请重启应用」，避免半新半旧） ---------- */

/** 与 Rust 侧 ipc.rs 的 SCHEMA_VERSION 同步，由 protocol-parity 测试把守 */
export const SCHEMA_VERSION = 8;
export const APP_VERSION = "0.1.0";
/** rpi 接入后由 build 注入 vendored commit 短 hash */
export const RUNTIME_VERSION = t("host-core (rpi 未接入)");

/* ---------- 会话 / 消息 / part（对应 SQLite schema） ---------- */

export type SessionMode = "ask" | "plan" | "code";
export type SessionStatus = "idle" | "running" | "awaiting_input" | "awaiting_approval" | "error";
export type MessageRole = "user" | "assistant" | "system";
export type PartType = "text" | "reasoning" | "tool" | "question" | "approval" | "compact" | "error";
export type ToolState = "pending" | "running" | "awaiting_approval" | "done" | "error" | "denied";

export interface Session {
  id: string;
  projectId: string;
  title: string;
  mode: SessionMode;
  model?: string;
  variant?: string;
  providerId?: string;
  status: SessionStatus;
  totalTokens: number;
  costEstimate: number;
  pinned: boolean;
  deletedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  turnIndex?: number | null;
  status: "streaming" | "complete" | "interrupted" | "error";
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  costEstimate?: number;
  model?: string;
  createdAt: number;
}

export interface DiffStat {
  added: number;
  deleted: number;
}

export interface TodoItem {
  text: string;
  state?: "done" | "cur" | "open";
  /** 分段耗时或进度文案 */
  note?: string;
}

export interface QuestionItem {
  q: string;
  options: { label: string; detail?: string }[];
  allowCustom: boolean;
}

export type DiffLineKind = "add" | "del" | "hunk" | "ctx";
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  gutter?: string;
}

export interface ToolResultMeta {
  /** 可信度措辞（PLAN §5.2：措辞分级当可信度用） */
  verified?: "full" | "single-site" | "unverified";
  truncated?: boolean;
  durationMs?: number;
}

/** part.content 的判别联合；落库为 JSON（PLAN §10 parts.content） */
export type PartContent =
  | { type: "text"; md: string }
  | { type: "reasoning"; text: string; durationMs?: number; collapsed?: boolean }
  | {
      type: "tool";
      tool: string;
      title: string;
      sub?: string;
      state: ToolState;
      icon?: string;
      /** 输出：纯文本或高亮行 */
      output?: string;
      outputLang?: string;
      /** 是否为 shell 命令块（$ 前缀样式） */
      isCommand?: boolean;
      stat?: DiffStat;
      diff?: DiffLine[];
      todos?: TodoItem[];
      paths?: string[];
      meta?: ToolResultMeta;
      nested?: PartContent[];
      /** 失败态文案 */
      error?: string;
      source?: "main" | "subagent" | "mcp" | "skill";
      agent?: string;
    }
  | {
      type: "question";
      questionId: string;
      questions: QuestionItem[];
      index: number;
      answered?: string[] /** false = 内联在消息流里的 ask_user 工具卡 */;
      dock?: boolean;
    }
  | {
      type: "approval";
      callId: string;
      tool: string;
      source: string;
      kind: "command" | "paths" | "diff";
      command?: string;
      paths?: string[];
      diff?: DiffLine[];
      matchedRule?: string;
      hint?: string;
      expiresAt: number;
      decision?: "allow" | "deny" | "allow_always" | "expired";
      /** 改参数后执行：允许用户编辑命令/路径再放行 */
      editable?: boolean;
      modifiedArgs?: string;
    }
  | { type: "compact"; summaryTokens: number; kept: number; releasedTokens: number; autoCompactAt?: number }
  | {
      type: "error";
      code: string;
      variant: "auth" | "rate" | "provider" | "retry" | "fatal";
      title: string;
      body: string;
      badge?: string;
      progress?: number;
      retryInMs?: number;
      actions?: ("update-key" | "switch-model" | "add-endpoint" | "onboard" | "retry-now" | "cancel-retry")[];
    };

export interface Part {
  id: string;
  messageId: string;
  seq: number;
  type: PartType;
  toolName?: string | null;
  toolSource?: string | null;
  callId?: string | null;
  state?: ToolState | null;
  content: PartContent;
  createdAt: number;
  updatedAt: number;
}

/* ---------- Rust → 前端事件（PLAN §9.1，20 个） ---------- */

export interface TokenUsage {
  prompt: number;
  completion: number;
  reasoning: number;
  cache_read: number;
}

export interface DuoEvents {
  ready: { app_version: string; runtime_version: string; schema_version: number };
  text_delta: { session_id: string; message_id: string; seq: number; delta: string };
  reasoning_delta: { session_id: string; message_id: string; seq: number; delta: string };
  message_part_upserted: { session_id: string; part: Part };
  tool_call_start: {
    call_id: string;
    tool_name: string;
    source: string;
    args: unknown;
    session_id: string;
    turn_index: number;
    message_id: string;
  };
  tool_call_output_delta: { call_id: string; chunk: string; session_id: string };
  tool_call_result: {
    call_id: string;
    result?: unknown;
    error?: string;
    duration_ms: number;
    truncated: boolean;
    session_id: string;
  };
  human_confirm_required: {
    call_id: string;
    tool_name: string;
    source: string;
    kind: "command" | "paths" | "diff";
    command?: string;
    paths?: string[];
    diff?: DiffLine[];
    matched_rule?: string;
    hint?: string;
    expires_at: number;
    session_id: string;
    message_id: string;
  };
  question_required: { question_id: string; session_id: string; message_id: string; questions: QuestionItem[] };
  turn_end: {
    turn_index: number;
    tokens: TokenUsage;
    cost_estimate: number;
    model: string;
    session_id: string;
    duration_ms: number;
    steps: number;
    throughput: number;
  };
  context_usage: {
    used: number;
    reserved: number;
    window: number;
    auto_compact_at: number;
    hit_rate: number;
    session_id: string;
  };
  agent_end: { reason: "done" | "stopped" | "limit" | "error" | "panic"; summary?: string; session_id: string };
  agent_error: {
    level: "warn" | "error";
    code: string;
    message: string;
    retryable: boolean;
    retry_in_ms?: number;
    attempt?: number;
    fatal?: boolean;
    session_id?: string;
  };
  compact_done: { from_turn: number; tokens_before: number; tokens_after: number; session_id: string; message_id: string };
  file_changed: { paths: string[]; session_id?: string };
  git_status_changed: {
    branch: string;
    ahead: number;
    behind: number;
    files: { path: string; status: "M" | "A" | "D" | "U"; added: number; deleted: number }[];
  };
  scan_progress: { project: string; scanned: number; total: number; phase: string };
  mcp_status: {
    server: string;
    status: "connecting" | "connected" | "needs_auth" | "failed" | "disabled";
    tools: number;
    error?: string;
  };
  session_updated: { session_id: string; title?: string; updated_at: number; activity: "idle" | "run" | "ask" | "err" };
  queue_state: { main: QueuedItem[]; steering: QueuedItem[]; follow_up: QueuedItem[]; session_id: string };
}

export type EventName = keyof DuoEvents;
export interface QueuedItem {
  id: string;
  text: string;
}

export interface DomainEvent<N extends EventName = EventName> {
  name: N;
  payload: DuoEvents[N];
  /** 排序游标：session_id + turn_index + seq（PLAN §9.2 resync 语义） */
  turnIndex: number;
  seq: number;
  ts: number;
}

/* ---------- 前端 → Rust 命令（PLAN §9.2） ---------- */

export interface Commands {
  submit_message: {
    session_id: string;
    text: string;
    attachments?: string[];
    context_refs?: string[];
    mode: SessionMode;
    model: string;
  };
  submit_steering: { session_id: string; text: string };
  queue_action: { id: string; op: "edit" | "delete" | "promote" };
  approve_tool_call: { call_id: string; decision: "allow" | "deny" | "allow_always"; modified_args?: unknown; reason?: string };
  answer_question: { question_id: string; answers: string[] };
  submit_frontend_result: { call_id: string; result: unknown };
  stop_agent: { session_id: string };
  session_list: { project_id?: string; query?: string; limit?: number };
  /** project_id 省略 = 宿主当前工作区（单项目桌面） */
  session_create: { project_id?: string; title?: string; mode?: SessionMode };
  session_rename: { session_id: string; title: string };
  session_delete: { session_id: string };
  session_restore: { session_id: string };
  session_fork: { session_id: string; message_id?: string };
  session_export: { session_id: string };
  session_load: { session_id: string; before?: number; limit?: number };
  revert_to_message: { session_id: string; message_id: string };
  redo_step: { session_id: string; message_id: string };
  permission_set: {
    scope: "global" | "project" | "session" | "agent";
    scope_ref?: string;
    tool: string;
    policy: "deny" | "require_approval" | "auto";
    matcher?: unknown;
    exceptions?: unknown[];
  };
  mcp_upsert: { id?: string; name: string; transport: string; config: unknown; enabled: boolean };
  mcp_delete: { id: string };
  mcp_toggle: { id: string; enabled: boolean };
  mcp_retry: { id: string };
  skill_upsert: {
    id?: string;
    command: string;
    name?: string;
    description?: string;
    system_prompt: string;
    scope: string;
    path?: string;
    model?: string;
    variant?: string;
    enabled: boolean;
  };
  skill_delete: { id: string };
  skill_toggle: { id: string; enabled: boolean };
  /** key 只进系统钥匙串/环境引用，IPC 从不传明文 —— 字段为引用名（{env:NAME} / keychain:<acct>） */
  provider_upsert: { id?: string; name: string; base_url: string; key_ref?: string; models?: unknown[] };
  provider_delete: { id: string };
  provider_test: { id: string };
  provider_list: Record<string, never>;
  fs_scan: { project_id: string };
  fs_tree: { project_id: string; path?: string };
  fs_preview: { project_id: string; path: string };
  fs_search: { project_id: string; query: string };
  git_status: { project_id: string };
  git_diff: { project_id: string; path?: string };
  git_stage: { project_id: string; paths: string[] };
  git_unstage: { project_id: string; paths: string[] };
  git_commit: { project_id: string; message: string };
  git_push: { project_id: string };
  git_generate_message: { project_id: string };
  terminal_open: { project_id: string; cols: number; rows: number };
  terminal_write: { id: string; data: string };
  terminal_resize: { id: string; cols: number; rows: number };
  terminal_close: { id: string };
  compact_now: { session_id: string };
  set_mode: { session_id: string; mode: SessionMode };
  set_model: { session_id: string; model: string; variant?: string };
  settings_get: { key?: string };
  settings_set: { key: string; value: unknown };
  skin_list: Record<string, never>;
  skin_apply: { id: string };
  skin_import: { path: string };
  resync: { session_id: string; turn_index: number; since_seq: number };
}

export type CommandName = keyof Commands;

/* ---------- 权限引擎（PLAN §6.6） ---------- */

export type Policy = "deny" | "require_approval" | "auto";
export interface PermissionRule {
  id: string;
  scope: "global" | "project" | "session" | "agent";
  scopeRef?: string;
  tool: string;
  policy: Policy;
  matcher?: { path?: string; command?: string; host?: string };
  exceptions?: { matcher: { path?: string; command?: string }; policy: Policy }[];
}

/** 模式默认策略（PLAN §6.6） */
export const MODE_DEFAULT_POLICY: Record<SessionMode, { write: Policy; shell: Policy }> = {
  ask: { write: "deny", shell: "deny" },
  plan: { write: "deny", shell: "auto" },
  code: { write: "require_approval", shell: "require_approval" },
};

/** 分层解析取最严格者生效 */
const STRICTNESS: Record<Policy, number> = { auto: 0, require_approval: 1, deny: 2 };
export function strictest(a: Policy, b: Policy): Policy {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

export function resolvePolicy(layers: Policy[]): Policy {
  return layers.reduce<Policy>((acc, p) => strictest(acc, p), "auto");
}
