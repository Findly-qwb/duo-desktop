/**
 * 浏览器内确定性 mock runtime（PLAN §6.0 rpi `faux` provider 的等价物）
 * 不接真实端点也能端到端验证：20 事件协议、三队列、审批阻塞（oneshot + 30min 超时 deny）、
 * panic 隔离、压缩、乱序 resync。与 Tauri transport 共用同一契约，UI 不区分来源。
 */
import { ENDPOINTS, MODELS } from "../data/fixtures";
import { SCHEMA_VERSION } from "./protocol";
import type { DuoEvents, EventName, Part, QuestionItem } from "./protocol";
import type { Transport } from "./transport";
import type { ProviderModelEntry, ProviderRow } from "./providers";

type Handler = (name: EventName, payload: DuoEvents[EventName]) => void;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let seqCounter = 0;
const nextSeq = () => ++seqCounter;
let partCounter = 0;

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

export class MockRuntime implements Transport {
  readonly kind = "mock" as const;
  private handlers = new Set<Handler>();
  private approvals = new Map<string, (d: "allow" | "deny" | "allow_always") => void>();
  private questions = new Map<string, (a: string[]) => void>();
  private sessionId = "s1";
  private turnIndex = 6;
  private cancelled = false;
  private sceneName = "chat-stream";
  stats = { events: 0 };

  /** 与宿主 provider_list 同形的内存表（浏览器验收路径也走命令流，不读 fixtures 常量） */
  private providers: ProviderRow[] = ENDPOINTS.map((e, i) => {
    const models: ProviderModelEntry[] = MODELS.flatMap(g => g.items.filter(m => m.provider === e.name)).map(m => ({
      id: m.id,
      name: m.name,
      inputPrice: m.inputPrice,
      outputPrice: m.outputPrice,
      contextWindow: 200000,
      reasoning: m.reasoning,
      vision: m.vision,
      desc: m.desc,
      bench: m.bench,
    }));
    return {
      id: `ep-${i}`,
      name: e.name,
      base_url: e.url,
      key_ref: e.key,
      models,
      last_check: e.status === "ok" ? Date.now() - 3600_000 : null,
    };
  });

  onAny(h: Handler): () => void {
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }

  private emit<N extends EventName>(name: N, payload: DuoEvents[N]): void {
    this.stats.events++;
    for (const h of [...this.handlers]) h(name, payload);
  }

  private part(messageId: string, content: Part["content"], extra: Partial<Part> = {}): Part {
    const now = Date.now();
    return {
      id: extra.id ?? `mp-${++partCounter}`,
      messageId,
      seq: extra.seq ?? ++partCounter,
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

  seedScene(name: string): void {
    this.sceneName = name;
    this.cancelled = false;
    this.approvals.clear();
  }

  boot(): void {
    this.emit("ready", { app_version: "0.1.0", runtime_version: "mock-deterministic", schema_version: SCHEMA_VERSION });
    this.emit("git_status_changed", {
      branch: "dev",
      ahead: 1,
      behind: 0,
      files: [
        { path: "packages/opencode/src/session/store.ts", status: "M", added: 64, deleted: 12 },
        { path: "packages/opencode/src/session/sqlite-store.ts", status: "A", added: 214, deleted: 0 },
        { path: "packages/opencode/test/session/store.test.ts", status: "M", added: 42, deleted: 3 },
        { path: "packages/opencode/src/session/json-store.ts", status: "D", added: 0, deleted: 88 },
      ],
    });
    this.emit("context_usage", {
      used: 68200,
      reserved: 24000,
      window: 200000,
      auto_compact_at: 92,
      hit_rate: 93,
      session_id: this.sessionId,
    });
    this.emit("scan_progress", { project: "opencode", scanned: 12480, total: 19500, phase: "walk" });
  }

  /* ---------------- 命令入口 ---------------- */

  async invoke<N extends keyof import("./protocol").Commands>(name: N, args: import("./protocol").Commands[N]): Promise<unknown> {
    switch (name) {
      case "submit_message":
        void this.runTurn(
          String((args as never as { text: string }).text),
          String((args as never as { mode: string }).mode),
          String((args as never as { model: string }).model),
        );
        return { ok: true };
      case "submit_steering":
        this.enqueue("steering", (args as never as { text: string }).text);
        return { ok: true };
      case "queue_action": {
        const { id, op } = args as never as { id: string; op: "edit" | "delete" | "promote" };
        this.mutateQueue(id, op);
        return { ok: true };
      }
      case "approve_tool_call": {
        const { call_id, decision } = args as never as { call_id: string; decision: "allow" | "deny" | "allow_always" };
        const res = this.approvals.get(call_id);
        if (res) {
          this.approvals.delete(call_id);
          res(decision);
        }
        return { ok: true };
      }
      case "answer_question": {
        const { question_id, answers } = args as never as { question_id: string; answers: string[] };
        const res = this.questions.get(question_id);
        if (res) {
          this.questions.delete(question_id);
          res(answers);
        }
        return { ok: true };
      }
      case "stop_agent":
        this.cancelled = true;
        for (const [, res] of this.approvals) res("deny");
        this.approvals.clear();
        this.emit("agent_end", { session_id: this.sessionId, reason: "stopped", summary: "已中断（Esc）· 保留已生成内容" });
        return { ok: true };
      case "compact_now":
        this.emit("compact_done", {
          session_id: this.sessionId,
          from_turn: this.turnIndex,
          tokens_before: 184000,
          tokens_after: 1842,
          message_id: `msg-compact-${nextSeq()}`,
        });
        return { ok: true };
      case "resync":
        return { ok: true, replayed: this.sceneName, since: (args as never as { since_seq: number }).since_seq };
      case "session_load":
        return { ok: true, messages: [] };
      case "provider_test": {
        const id = String((args as never as { id: string }).id);
        const p = this.providers.find(x => x.id === id || x.name === id);
        if (!p) throw new Error(`端点不存在：${id}`);
        p.last_check = Date.now();
        const ids = p.models.map(m => m.id);
        return { ok: true, latency_ms: 640, model_ids: ids, count: ids.length, total: ids.length };
      }
      case "provider_list":
        return { providers: this.providers };
      case "provider_upsert": {
        const a = args as never as {
          id?: string;
          name: string;
          base_url: string;
          key_ref?: string;
          models?: ProviderModelEntry[];
        };
        const found = this.providers.find(x => x.id === a.id || x.name === a.name);
        if (found) {
          found.name = a.name;
          found.base_url = a.base_url;
          if (a.key_ref !== undefined) found.key_ref = a.key_ref;
          return { id: found.id, key_ref: found.key_ref };
        }
        const row: ProviderRow = {
          id: a.id ?? `ep-${this.providers.length}`,
          name: a.name,
          base_url: a.base_url,
          key_ref: a.key_ref ?? null,
          models: a.models ?? [],
          last_check: null,
        };
        this.providers.push(row);
        return { id: row.id, key_ref: row.key_ref };
      }
      case "provider_delete": {
        const id = String((args as never as { id: string }).id);
        this.providers = this.providers.filter(x => x.id !== id && x.name !== id);
        return { ok: true };
      }
      case "mcp_retry": {
        const server = String((args as never as { id: string }).id ?? "linear");
        this.emit("mcp_status", { server, status: "connecting", tools: 0 });
        setTimeout(() => this.emit("mcp_status", { server, status: "connected", tools: 6 }), 1400);
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }

  /* ---------------- 三队列（main / steering / follow-up） ---------------- */

  private queues = {
    main: [] as { id: string; text: string }[],
    steering: [] as { id: string; text: string }[],
    follow_up: [] as { id: string; text: string }[],
  };

  private enqueue(which: "main" | "steering" | "follow_up", text: string): void {
    this.queues[which].push({ id: `q${nextSeq()}`, text });
    this.emit("queue_state", { session_id: this.sessionId, ...this.queues });
  }

  private mutateQueue(id: string, op: "edit" | "delete" | "promote"): void {
    for (const key of ["main", "steering", "follow_up"] as const) {
      const i = this.queues[key].findIndex(x => x.id === id);
      if (i < 0) continue;
      if (op === "delete") this.queues[key].splice(i, 1);
      else if (op === "promote" && key !== "steering") {
        const [item] = this.queues[key].splice(i, 1);
        this.queues.steering.unshift(item);
      } else if (op === "edit") {
        // 取回输入框：只回发状态，不改动队列内容
        this.queues[key][i] = { ...this.queues[key][i] };
      }
    }
    this.emit("queue_state", { session_id: this.sessionId, ...this.queues });
  }

  /* ---------------- 单轮 Turn（PLAN §6.2 九步） ---------------- */

  private async runTurn(text: string, mode: string, model: string): Promise<void> {
    this.cancelled = false;
    const mid = `msg-${nextSeq()}`;
    this.turnIndex++;
    this.emit("session_updated", { session_id: this.sessionId, updated_at: Date.now(), activity: "run" });

    /* 演示指令：逐条验收专用事件路径 */
    if (text.startsWith("/panic")) {
      this.emit("agent_error", {
        level: "error",
        code: "PANIC",
        message: "harness task panicked（已隔离）",
        retryable: false,
        fatal: true,
        session_id: this.sessionId,
      });
      this.emit("agent_end", { session_id: this.sessionId, reason: "panic" });
      return;
    }
    if (text.startsWith("/limit")) {
      this.emit("agent_end", { session_id: this.sessionId, reason: "limit", summary: "已达会话花费上限 $5.00" });
      return;
    }
    if (text.startsWith("/err401")) {
      this.emit("agent_error", {
        level: "error",
        code: "401",
        message: "端点返回 401 Unauthorized",
        retryable: false,
        session_id: this.sessionId,
      });
      this.emit("agent_end", { session_id: this.sessionId, reason: "error", summary: "SQLITE_IOERR" });
      return;
    }
    if (text.startsWith("/outoforder")) {
      // Spike③ 验收：seq 必须按 session+turn+seq 单调；回退的那条要被丢弃并触发 resync
      this.emit("text_delta", { session_id: this.sessionId, message_id: mid, seq: 90000, delta: "有序的一条。" });
      this.emit("text_delta", { session_id: this.sessionId, message_id: mid, seq: 5, delta: "这条应当被丢弃（seq 回退）" });
      this.emit("text_delta", { session_id: this.sessionId, message_id: mid, seq: 90001, delta: "乱序之后仍继续。" });
      return;
    }
    if (text.startsWith("/ask")) {
      await this.askQuestion([
        {
          q: "旧 JSON 会话文件要自动迁移进 SQLite 吗？",
          options: [
            { label: "自动迁移", detail: "首次启动导入并改名 .bak" },
            { label: "只迁移当前项目", detail: "按目录懒迁移" },
          ],
          allowCustom: true,
        },
      ]);
      return;
    }

    const alive = async (ms: number) => {
      if (this.cancelled) return false;
      await sleep(ms);
      return !this.cancelled;
    };

    // 2/3. 组装上下文 → 流式产出
    if (!(await alive(260))) return this.finish(model);
    this.emit("reasoning_delta", {
      session_id: this.sessionId,
      message_id: mid,
      seq: nextSeq(),
      delta: `解析需求（${mode} 模式）→ 定位 store.ts → 设计 sessions/messages/parts 三表 → 保持接口签名不变。`,
    });
    for (const chunk of ["先看现有实现。", "确认引用面后，", "再改写入路径。"]) {
      if (!(await alive(240))) return this.finish(model);
      this.emit("text_delta", { session_id: this.sessionId, message_id: mid, seq: nextSeq(), delta: chunk });
    }

    // 4. 工具阶段（只读并发 → 顺序演示）
    await this.readTool(mid, "grep", '"SessionStore" → 14 命中', [
      "packages/opencode/src/session/store.ts:18:export class SessionStore {",
      'packages/opencode/src/session/index.ts:4:import { SessionStore } from "./store"',
    ]);
    if (!(await alive(180))) return this.finish(model);
    await this.readTool(mid, "read", "session/store.ts · 128 行", [
      "export class SessionStore {",
      "  private map = new Map<string, Session>()",
      "  load(id: string) { return this.map.get(id) }",
      "}",
    ]);
    if (!(await alive(220))) return this.finish(model);

    // 6. 写类工具：执行前打 checkpoint（file_changed 由宿主发）
    const editCall = `call-edit-${nextSeq()}`;
    this.emit("tool_call_start", {
      call_id: editCall,
      tool_name: "edit",
      source: "main",
      args: { path: "packages/opencode/src/session/store.ts" },
      session_id: this.sessionId,
      turn_index: this.turnIndex,
      message_id: mid,
    });
    this.emit("file_changed", { paths: ["packages/opencode/src/session/store.ts"], session_id: this.sessionId });
    await sleep(300);
    this.emit("message_part_upserted", {
      session_id: this.sessionId,
      part: this.part(
        mid,
        {
          type: "tool",
          tool: "edit",
          title: "Edit",
          sub: "session/store.ts",
          state: "done",
          icon: "diff",
          stat: { added: 64, deleted: 12 },
          meta: { verified: "single-site", durationMs: 300 },
        },
        { callId: editCall, toolName: "edit", state: "done" },
      ),
    });

    // 5. 权限引擎插入点：阻塞在工具执行前
    if (!(await alive(300))) return this.finish(model);
    const bashCall = `call-bash-${nextSeq()}`;
    const command = "bun test ./test/session/sqlite-store.test.ts";
    this.emit("tool_call_start", {
      call_id: bashCall,
      tool_name: "bash",
      source: "main",
      args: { command },
      session_id: this.sessionId,
      turn_index: this.turnIndex,
      message_id: mid,
    });
    const decision = await this.askApproval(bashCall, mid, command);
    if (this.cancelled) return this.finish(model);
    if (decision === "deny") {
      this.emit("message_part_upserted", {
        session_id: this.sessionId,
        part: this.part(
          mid,
          {
            type: "tool",
            tool: "bash",
            title: "Bash",
            sub: command,
            state: "denied",
            icon: "terminal",
            error: "用户拒绝执行",
            isCommand: true,
          },
          { callId: bashCall, toolName: "bash", state: "denied" },
        ),
      });
      this.emit("agent_end", { session_id: this.sessionId, reason: "stopped", summary: "已拒绝 · 代理收到 deny，回合终止" });
      return;
    }

    const lines = [
      "bun test v1.3.2 (a2f3b1c)",
      "",
      "test/session/sqlite-store.test.ts:",
      "✓ SqliteStore > creates schema on first open",
      "✓ SqliteStore > round-trips session + messages + parts",
      "✓ SqliteStore > deletes session cascade to parts",
      "✓ SqliteStore > migrates legacy json",
      "",
      " 4 pass",
      " 0 fail",
      "Ran 4 tests across 1 file. [1.42s]",
    ];
    for (const line of lines) {
      if (this.cancelled) return this.finish(model);
      await sleep(90);
      this.emit("tool_call_output_delta", { call_id: bashCall, chunk: `${line}\n`, session_id: this.sessionId });
    }
    this.emit("tool_call_result", {
      call_id: bashCall,
      result: { pass: 4, fail: 0 },
      duration_ms: 1420,
      truncated: false,
      session_id: this.sessionId,
    });

    // 7/8. 结果追加历史 + token 与费用估算
    if (!(await alive(280))) return this.finish(model);
    this.emit("text_delta", {
      session_id: this.sessionId,
      message_id: mid,
      seq: nextSeq(),
      delta: "迁移完成：单测全绿，旧 JSON 会话首次启动自动导入并改名 .bak。",
    });
    this.emit("turn_end", {
      turn_index: this.turnIndex,
      tokens: { prompt: 4800, completion: 2100, reasoning: 640, cache_read: 61200 },
      cost_estimate: 0.0212,
      model,
      session_id: this.sessionId,
      duration_ms: 51000,
      steps: 6,
      throughput: 44.8,
    });
    this.emit("context_usage", {
      used: 71400,
      reserved: 24000,
      window: 200000,
      auto_compact_at: 92,
      hit_rate: 93,
      session_id: this.sessionId,
    });
    if (!(await alive(200))) return this.finish(model);
    this.emit("agent_end", { session_id: this.sessionId, reason: "done", summary: "完成" });
  }

  private finish(model: string): void {
    if (!this.cancelled) return;
    this.emit("turn_end", {
      turn_index: this.turnIndex,
      tokens: { prompt: 1200, completion: 320, reasoning: 0, cache_read: 0 },
      cost_estimate: 0.0031,
      model,
      session_id: this.sessionId,
      duration_ms: 8000,
      steps: 2,
      throughput: 39.2,
    });
    this.emit("agent_end", { session_id: this.sessionId, reason: "stopped", summary: "已中断（Esc）· 保留已生成内容" });
  }

  private async readTool(mid: string, toolName: string, sub: string, lines: string[]): Promise<void> {
    void sub; // 只读工具的输出即 sub 的上下文，无需再挂一份
    const callId = `call-${toolName}-${nextSeq()}`;
    this.emit("tool_call_start", {
      call_id: callId,
      tool_name: toolName,
      source: "main",
      args: {},
      session_id: this.sessionId,
      turn_index: this.turnIndex,
      message_id: mid,
    });
    for (const l of lines) {
      await sleep(45);
      this.emit("tool_call_output_delta", { call_id: callId, chunk: `${l}\n`, session_id: this.sessionId });
    }
    await sleep(120);
    this.emit("tool_call_result", {
      call_id: callId,
      result: { lines: lines.length },
      duration_ms: 200,
      truncated: false,
      session_id: this.sessionId,
    });
  }

  /** 审批阻塞：oneshot + 30 分钟超时自动 deny（PLAN §3.3） */
  private askApproval(callId: string, messageId: string, command: string): Promise<"allow" | "deny" | "allow_always"> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.approvals.delete(callId);
        resolve("deny");
      }, APPROVAL_TIMEOUT_MS);
      this.approvals.set(callId, d => {
        clearTimeout(timer);
        resolve(d);
      });
      this.emit("human_confirm_required", {
        call_id: callId,
        tool_name: "bash",
        source: "bash · 主回合 · 命中 global require_approval",
        kind: "command",
        command,
        matched_rule: "global bash = require_approval",
        hint: "该命令将修改你的系统。允许一次，或为同类命令放行。",
        expires_at: Date.now() + APPROVAL_TIMEOUT_MS,
        session_id: this.sessionId,
        message_id: messageId,
      });
      this.emit("session_updated", { session_id: this.sessionId, updated_at: Date.now(), activity: "ask" });
    });
  }

  askQuestion(questions: QuestionItem[]): Promise<string[]> {
    const qid = `q-${nextSeq()}`;
    const mid = `msg-${nextSeq()}`;
    return new Promise(resolve => {
      this.questions.set(qid, a => resolve(a));
      this.emit("question_required", { question_id: qid, session_id: this.sessionId, message_id: mid, questions });
    });
  }
}
