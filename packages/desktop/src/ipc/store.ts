/**
 * 运行时状态容器（ExternalStore 形状）
 * - 事件按 session_id + turn_index + seq 去重与排序，乱序丢弃并请求 resync（PLAN §5.5）
 * - 跨重启的界面还原只从 SQLite 投影重建（PLAN §6.9 硬约束）
 */
import { t } from "../i18n";
import type { ChatMessageSeed } from "../data/scenes";
import { APP_VERSION, SCHEMA_VERSION, type DuoEvents, type EventName, type Part, type QuestionItem } from "./protocol";
import type { Transport } from "./transport";

export interface RuntimeMessage {
  id: string;
  role: "user" | "assistant";
  mode?: string;
  model?: string;
  agent?: string;
  time?: string;
  duration?: string;
  turnIndex?: number;
  checkpointOid?: string;
  attach?: { name: string; src: string }[];
  parts: Part[];
}

export interface Outcome {
  kind: "done" | "stopped" | "error" | "limit" | "denied" | "panic";
  title: string;
  detail?: string;
  steps?: number;
  duration?: string;
  cost?: string;
  throughput?: string;
}
/** 兼容旧命名 */
export type TurnOutcome = Outcome;

export interface ContextUsage {
  used: number;
  reserved: number;
  window: number;
  autoCompactAt: number;
  hitRate: number;
}

export interface RuntimeState {
  sessionId: string;
  turnIndex: number;
  messages: RuntimeMessage[];
  busy: boolean;
  outcome: Outcome | null;
  queues: {
    main: { id: string; text: string }[];
    steering: { id: string; text: string }[];
    follow_up: { id: string; text: string }[];
  };
  pendingApprovals: string[];
  pendingQuestions: { questionId: string; messageId: string; questions: QuestionItem[] }[];
  context: ContextUsage | null;
  lastSeq: number;
  dropped: number;
  resyncRequests: number;
  gitStatus: {
    branch: string;
    ahead: number;
    behind: number;
    files: { path: string; status: string; added: number; deleted: number }[];
  } | null;
  mcpStatus: Record<string, { status: string; tools: number; error?: string }>;
  scan: { project: string; scanned: number; total: number; phase: string } | null;
  runtimeInfo: { app: string; runtime: string; schema: number } | null;
  /** 非空即「前后端协议不同步」，界面顶部横幅提示重启 */
  protocolMismatch: string | null;
  revert: { label: string; files: string; stat: string; detail: string } | null;
  /** 当前会话标题（宿主 sessions.title；mock 演示态为空，TaskHeader 回退场景文案） */
  sessionTitle: string;
}

const initialState = (): RuntimeState => ({
  sessionId: "s1",
  turnIndex: 6,
  messages: [],
  busy: false,
  outcome: null,
  queues: { main: [], steering: [], follow_up: [] },
  pendingApprovals: [],
  pendingQuestions: [],
  context: null,
  lastSeq: 0,
  dropped: 0,
  resyncRequests: 0,
  gitStatus: null,
  mcpStatus: {},
  scan: null,
  runtimeInfo: null,
  protocolMismatch: null,
  revert: null,
  sessionTitle: "",
});

let _partSeq = 0;

export class RuntimeStore {
  private state: RuntimeState = initialState();
  private listeners = new Set<() => void>();
  private localSeq = 0;

  constructor(private readonly transport: Transport) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  get = (): RuntimeState => this.state;

  private commit(patch: Partial<RuntimeState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /* ---------- 会话水化（真宿主：切换/重建只从 SQLite，PLAN §6.9） ---------- */

  /** 切会话：清空回合态（游标 lastSeq 是宿主全局 seq，不重置，乱序判断继续有效） */
  setSession(id: string, title = ""): void {
    this.commit({
      sessionId: id,
      sessionTitle: title,
      turnIndex: 0,
      messages: [],
      busy: false,
      outcome: null,
      queues: { main: [], steering: [], follow_up: [] },
      pendingApprovals: [],
      pendingQuestions: [],
      context: null,
      revert: null,
    });
  }

  /** session_load 结果整体注入（重启/切会话重建转录） */
  hydrate(messages: RuntimeMessage[]): void {
    this.commit({ messages });
  }

  setTitle(title: string): void {
    this.commit({ sessionTitle: title });
  }

  /* ---------- 场景装载 ---------- */

  loadScene(
    seeds: ChatMessageSeed[],
    meta: {
      busy?: boolean;
      context?: ContextUsage | null;
      outcome?: Outcome | null;
      revert?: RuntimeState["revert"];
      queues?: {
        main: { id: string; text: string }[];
        steering: { id: string; text: string }[];
        follow_up: { id: string; text: string }[];
      };
    } = {},
  ): void {
    _partSeq = 0;
    const messages: RuntimeMessage[] = seeds.map(s => ({
      id: s.id,
      role: s.role,
      mode: s.mode,
      model: s.model,
      agent: s.agent,
      time: s.time,
      duration: s.duration,
      turnIndex: s.turnIndex,
      checkpointOid: s.checkpointOid,
      parts: s.parts.map((c, i) => makePart(s.id, i, c)),
    }));
    this.commit({
      messages,
      busy: !!meta.busy,
      outcome: meta.outcome ?? null,
      context: meta.context ?? null,
      queues: meta.queues ?? { main: [], steering: [], follow_up: [] },
      pendingApprovals: messages.flatMap(m =>
        m.parts.filter(p => p.content.type === "approval" && !p.content.decision).map(p => p.callId as string),
      ),
      pendingQuestions: messages.flatMap(m =>
        m.parts
          .filter(p => p.content.type === "question")
          .map(p => ({
            questionId: p.content.type === "question" ? p.content.questionId : "",
            messageId: m.id,
            questions: p.content.type === "question" ? p.content.questions : [],
          })),
      ),
      revert: meta.revert ?? null,
      lastSeq: 0,
      dropped: 0,
    });
  }

  /* ---------- 事件入口 ---------- */

  attach(): () => void {
    return this.transport.onAny((name, payload) => this.handle(name, payload as never));
  }

  /** seq 语义：session_id + turn_index + seq 三元组单调；回退即视为乱序 */
  private ordered(seq: number | undefined): boolean {
    const s = seq ?? ++this.localSeq;
    if (s < this.state.lastSeq) {
      this.commit({ dropped: this.state.dropped + 1, resyncRequests: this.state.resyncRequests + 1 });
      void this.transport.invoke("resync", {
        session_id: this.state.sessionId,
        turn_index: this.state.turnIndex,
        since_seq: this.state.lastSeq,
      });
      return false;
    }
    this.commit({ lastSeq: s });
    return true;
  }

  private message(id: string, create: (mut: (m: RuntimeMessage) => RuntimeMessage) => void): void {
    const exists = this.state.messages.some(m => m.id === id);
    if (!exists) {
      const fresh: RuntimeMessage = { id, role: "assistant", parts: [] };
      this.commit({ messages: [...this.state.messages, fresh] });
    }
    create(m => m);
  }

  private mutateMessage(id: string, fn: (m: RuntimeMessage) => RuntimeMessage): void {
    const has = this.state.messages.some(m => m.id === id);
    if (!has) this.commit({ messages: [...this.state.messages, { id, role: "assistant", parts: [] }] });
    this.commit({ messages: this.state.messages.map(m => (m.id === id ? fn(m) : m)) });
  }

  private findPartByCall(callId: string): { messageId: string; part: Part } | null {
    for (const m of this.state.messages) {
      const p = m.parts.find(x => x.callId === callId && x.content.type === "tool");
      if (p) return { messageId: m.id, part: p };
    }
    return null;
  }

  handle<N extends EventName>(name: N, payload: DuoEvents[N]): void {
    switch (name) {
      case "ready": {
        const p = payload as DuoEvents["ready"];
        this.commit({ runtimeInfo: { app: p.app_version, runtime: p.runtime_version, schema: p.schema_version } });
        // 协议版本不匹配：只提示重启，不做兼容猜测（半新半旧最难查）
        if (p.schema_version !== SCHEMA_VERSION) {
          this.commit({
            protocolMismatch: t("schema {schema_version} ≠ 前端 {SCHEMA_VERSION}，请重启应用", {
              schema_version: p.schema_version,
              SCHEMA_VERSION: SCHEMA_VERSION,
            }),
          });
        } else if (p.app_version !== APP_VERSION) {
          this.commit({
            protocolMismatch: t("前端 {APP_VERSION} / 宿主 {app_version}，请重启应用", {
              APP_VERSION: APP_VERSION,
              app_version: p.app_version,
            }),
          });
        } else {
          this.commit({ protocolMismatch: null });
        }
        return;
      }
      case "text_delta": {
        const p = payload as DuoEvents["text_delta"];
        if (!this.ordered(p.seq)) return;
        this.mutateMessage(p.message_id, m => {
          // 流式追加只认「末尾的 text part」：中间插入过工具卡后必须另起新 part，
          // 否则文本会被吸回上面的段落里（消息顺序错乱）。
          const last = m.parts[m.parts.length - 1];
          if (last && last.type === "text" && last.content.type === "text") {
            return {
              ...m,
              parts: m.parts.map(x =>
                x.id === last.id
                  ? {
                      ...x,
                      content: { type: "text", md: x.content.type === "text" ? x.content.md + p.delta : "" },
                      updatedAt: Date.now(),
                    }
                  : x,
              ),
            };
          }
          return { ...m, parts: [...m.parts, makePart(p.message_id, m.parts.length, { type: "text", md: p.delta })] };
        });
        return;
      }
      case "reasoning_delta": {
        const p = payload as DuoEvents["reasoning_delta"];
        if (!this.ordered(p.seq)) return;
        this.mutateMessage(p.message_id, m => {
          const last = m.parts[m.parts.length - 1];
          if (last && last.type === "reasoning" && last.content.type === "reasoning") {
            return {
              ...m,
              parts: m.parts.map(x =>
                x.id === last.id
                  ? {
                      ...x,
                      content: x.content.type === "reasoning" ? { ...x.content, text: x.content.text + p.delta } : x.content,
                    }
                  : x,
              ),
            };
          }
          return {
            ...m,
            parts: [...m.parts, makePart(p.message_id, m.parts.length, { type: "reasoning", text: p.delta, collapsed: false })],
          };
        });
        return;
      }
      case "message_part_upserted": {
        const p = payload as DuoEvents["message_part_upserted"];
        this.mutateMessage(p.part.messageId, m =>
          m.parts.some(x => x.id === p.part.id)
            ? { ...m, parts: m.parts.map(x => (x.id === p.part.id ? p.part : x)) }
            : { ...m, parts: [...m.parts, p.part] },
        );
        return;
      }
      case "tool_call_start": {
        const p = payload as DuoEvents["tool_call_start"];
        this.commit({ turnIndex: p.turn_index, busy: true });
        this.mutateMessage(p.message_id, m => ({
          ...m,
          turnIndex: p.turn_index,
          parts: [
            ...m.parts,
            makePart(
              p.message_id,
              m.parts.length,
              {
                type: "tool",
                tool: p.tool_name,
                title: toolTitle(p.tool_name),
                state: "running",
                source: p.source === "mcp" ? "mcp" : "main",
                output: "",
              },
              { callId: p.call_id, toolName: p.tool_name, toolSource: p.source, state: "running" },
            ),
          ],
        }));
        return;
      }
      case "tool_call_output_delta": {
        const p = payload as DuoEvents["tool_call_output_delta"];
        const hit = this.findPartByCall(p.call_id);
        if (!hit || hit.part.content.type !== "tool") return;
        this.mutateMessage(hit.messageId, m => ({
          ...m,
          parts: m.parts.map(x =>
            x.id === hit.part.id && x.content.type === "tool"
              ? { ...x, content: { ...x.content, output: (x.content.output ?? "") + p.chunk } }
              : x,
          ),
        }));
        return;
      }
      case "tool_call_result": {
        const p = payload as DuoEvents["tool_call_result"];
        const hit = this.findPartByCall(p.call_id);
        if (!hit || hit.part.content.type !== "tool") return;
        const state = p.error ? "error" : "done";
        this.mutateMessage(hit.messageId, m => ({
          ...m,
          parts: m.parts.map(x =>
            x.id === hit.part.id && x.content.type === "tool"
              ? {
                  ...x,
                  state,
                  content: {
                    ...x.content,
                    state,
                    error: p.error,
                    meta: { durationMs: p.duration_ms, truncated: p.truncated, verified: p.truncated ? "single-site" : "full" },
                  },
                }
              : x,
          ),
        }));
        return;
      }
      case "human_confirm_required": {
        const p = payload as DuoEvents["human_confirm_required"];
        this.mutateMessage(p.message_id, m => ({
          ...m,
          parts: [
            ...m.parts,
            makePart(
              p.message_id,
              m.parts.length,
              {
                type: "approval",
                callId: p.call_id,
                tool: p.tool_name,
                source: p.source,
                kind: p.kind,
                command: p.command,
                paths: p.paths,
                diff: p.diff,
                matchedRule: p.matched_rule,
                hint: p.hint,
                expiresAt: p.expires_at,
                editable: true,
              },
              { callId: p.call_id, toolName: p.tool_name, state: "awaiting_approval" },
            ),
          ],
        }));
        this.commit({ pendingApprovals: [...this.state.pendingApprovals, p.call_id], busy: true });
        return;
      }
      case "question_required": {
        const p = payload as DuoEvents["question_required"];
        this.mutateMessage(p.message_id, m => ({
          ...m,
          parts: [
            ...m.parts,
            makePart(p.message_id, m.parts.length, {
              type: "question",
              questionId: p.question_id,
              questions: p.questions,
              index: 0,
            }),
          ],
        }));
        this.commit({
          pendingQuestions: [
            ...this.state.pendingQuestions,
            { questionId: p.question_id, messageId: p.message_id, questions: p.questions },
          ],
        });
        return;
      }
      case "turn_end": {
        const p = payload as DuoEvents["turn_end"];
        this.commit({ turnIndex: p.turn_index });
        this.mutateMessage(this.lastAssistantId(), m => ({ ...m, duration: `${p.duration_ms}ms`, model: p.model }));
        return;
      }
      case "context_usage": {
        const p = payload as DuoEvents["context_usage"];
        this.commit({
          context: {
            used: p.used,
            reserved: p.reserved,
            window: p.window,
            autoCompactAt: p.auto_compact_at,
            hitRate: p.hit_rate,
          },
        });
        return;
      }
      case "agent_end": {
        const p = payload as DuoEvents["agent_end"];
        const outcome: Outcome =
          p.reason === "done"
            ? { kind: "done", title: "", detail: "6 steps · 0m 51s · $0.0212 (est.) · 44.8 tok/s", steps: 6 }
            : p.reason === "stopped"
              ? { kind: "stopped", title: "", detail: p.summary ?? "" }
              : p.reason === "limit"
                ? { kind: "limit", title: "", detail: p.summary ?? "$5.00" }
                : p.reason === "panic"
                  ? {
                      kind: "panic",
                      title: t("任务异常终止（已隔离）"),
                      detail: t("窗口与其余任务未受影响；当前 Turn 的工具输出未落库"),
                    }
                  : { kind: "error", title: "", detail: `${p.summary ?? "agent_error"} · 3 steps · $0.0038`, steps: 3 };
        this.commit({ busy: false, outcome, pendingApprovals: p.reason === "stopped" ? [] : this.state.pendingApprovals });
        return;
      }
      case "agent_error": {
        const p = payload as DuoEvents["agent_error"];
        const mid = `${this.state.sessionId}:err:${Date.now()}`;
        this.mutateMessage(mid, m => ({
          ...m,
          parts: [
            makePart(mid, 0, {
              type: "error",
              code: p.code,
              variant: p.code.startsWith("401") ? "auth" : p.code.startsWith("429") ? "rate" : p.retryable ? "retry" : "provider",
              title: p.message,
              body: p.fatal
                ? t("任务级 catch_unwind 已隔离：窗口与其余任务未受影响，当前 Turn 的工具输出未落库。")
                : t("runtime 正按指数退避排队重试。"),
              retryInMs: p.retry_in_ms,
              badge: p.attempt ? t("第 {attempt}/5 次", { attempt: p.attempt }) : undefined,
              actions: p.fatal ? undefined : ["retry-now", "cancel-retry"],
            }),
          ],
        }));
        if (p.fatal)
          this.commit({ busy: false, outcome: { kind: "panic", title: p.message, detail: t("窗口与其余任务未受影响") } });
        return;
      }
      case "compact_done": {
        const p = payload as DuoEvents["compact_done"];
        this.mutateMessage(p.message_id, m => ({
          ...m,
          parts: [
            ...m.parts,
            makePart(p.message_id, m.parts.length, {
              type: "compact",
              summaryTokens: p.tokens_after,
              kept: 12,
              releasedTokens: p.tokens_before - p.tokens_after,
              autoCompactAt: 92,
            }),
          ],
        }));
        return;
      }
      case "queue_state": {
        const p = payload as DuoEvents["queue_state"];
        this.commit({ queues: { main: p.main, steering: p.steering, follow_up: p.follow_up } });
        return;
      }
      case "git_status_changed": {
        const p = payload as DuoEvents["git_status_changed"];
        this.commit({ gitStatus: p });
        return;
      }
      case "mcp_status": {
        const p = payload as DuoEvents["mcp_status"];
        this.commit({ mcpStatus: { ...this.state.mcpStatus, [p.server]: { status: p.status, tools: p.tools, error: p.error } } });
        return;
      }
      case "scan_progress": {
        const p = payload as DuoEvents["scan_progress"];
        this.commit({ scan: p });
        return;
      }
      case "file_changed":
      case "session_updated":
        return;
    }
  }

  private lastAssistantId(): string {
    const list = this.state.messages.filter(m => m.role === "assistant");
    return list[list.length - 1]?.id ?? "a-last";
  }

  /* ---------- 本地动作 ---------- */

  setOutcome(o: Outcome | null): void {
    this.commit({ outcome: o, busy: o?.kind === "done" || o?.kind === "stopped" ? false : this.state.busy });
  }
  setBusy(b: boolean): void {
    this.commit({ busy: b });
  }
  setRevert(r: RuntimeState["revert"]): void {
    this.commit({ revert: r });
  }
  appendUserMessage(seed: ChatMessageSeed): void {
    this.mutateMessage(seed.id, m => ({
      ...m,
      role: "user",
      mode: seed.mode,
      model: seed.model,
      time: seed.time,
      parts: seed.parts.map((c, i) => makePart(seed.id, i, c)),
    }));
    this.commit({ outcome: null, messages: [...this.state.messages] });
  }
  resolveApproval(callId: string, decision: "allow" | "deny" | "allow_always", modifiedArgs?: string): void {
    this.commit({ pendingApprovals: this.state.pendingApprovals.filter(c => c !== callId) });
    for (const m of this.state.messages) {
      const p = m.parts.find(x => x.callId === callId && x.content.type === "approval");
      if (p && p.content.type === "approval") {
        this.mutateMessage(m.id, mm => ({
          ...mm,
          parts: mm.parts.map(x => (x.id === p.id ? { ...x, content: { ...x.content, decision, modifiedArgs } } : x)),
        }));
      }
    }
  }
}

export function makePart(messageId: string, seq: number, content: Part["content"], extra: Partial<Part> = {}): Part {
  const now = Date.now();
  return {
    id: extra.id ?? `part-${messageId}-${seq}-${now}`,
    messageId,
    seq,
    type: content.type,
    toolName: extra.toolName ?? (content.type === "tool" ? content.tool : null),
    toolSource: extra.toolSource ?? null,
    callId: extra.callId ?? null,
    state: extra.state ?? null,
    content,
    createdAt: now,
    updatedAt: now,
  };
}

export function toolTitle(name: string): string {
  const map: Record<string, string> = {
    read: "Read",
    list: "List",
    glob: "Glob",
    grep: "Grep",
    bash: "Running Command",
    write: "Write",
    edit: "Edit",
    apply_patch: "Apply Patch",
    todo: "To-dos",
    ask_user: "Question",
    task: t("子任务"),
    skill: "Skill",
  };
  return map[name] ?? name;
}
