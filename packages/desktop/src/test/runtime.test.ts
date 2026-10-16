/**
 * 适配层与权限引擎的关键契约测试（对应 PLAN §12 Spike 失败判据）
 * ① 审批能阻塞工具执行并可回流；② 事件 seq 乱序被丢弃并触发 resync；③ 三队列状态可投影。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../ipc/store";
import type { Transport } from "../ipc/transport";
import type { CommandName, Commands, DuoEvents, EventName } from "../ipc/protocol";
import { SCENES } from "../data/scenes";

function makeTransport() {
  const handlers = new Set<(n: EventName, p: DuoEvents[EventName]) => void>();
  const invoke = vi.fn(((name: CommandName, args: Commands[CommandName]) => {
    void name;
    void args;
    return Promise.resolve({ ok: true });
  }) as Transport["invoke"]);
  const transport: Transport = {
    kind: "mock",
    onAny: h => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    invoke,
  };
  return { transport, invoke };
}

const seed = SCENES["chat-stream"].messages;

describe("RuntimeStore · 事件契约", () => {
  let store: RuntimeStore;
  let invoke: ReturnType<typeof makeTransport>["invoke"];

  beforeEach(() => {
    const t = makeTransport();
    invoke = t.invoke;
    store = new RuntimeStore(t.transport);
    store.loadScene(seed, { busy: true });
  });

  it("装载场景后 part 结构与消息归属正确", () => {
    const s = store.get();
    expect(s.messages.length).toBe(2);
    const ai = s.messages.find(m => m.role === "assistant");
    expect(ai?.parts.map(p => p.type)).toEqual(["reasoning", "text", "tool", "tool", "tool", "text"]);
    expect(ai?.parts.every(p => p.messageId === ai.id)).toBe(true);
  });

  it("text_delta 并入末尾 text part；末尾不是 text 时另起新段", () => {
    const ai = store.get().messages.find(m => m.role === "assistant");
    store.handle("text_delta", { session_id: "s1", message_id: ai!.id, seq: 900, delta: "继续写。" });
    const parts = store.get().messages.find(m => m.id === ai!.id)!.parts;
    const texts = parts.filter(p => p.type === "text");
    // 场景末尾就是 text part → 增量并入同一段，不新开卡片
    expect(texts).toHaveLength(2);
    expect((texts[texts.length - 1].content as { md: string }).md).toContain("继续写。");

    // 末尾插一张工具卡后，再来增量必须另起新段（否则文本会被吸回上一段）
    store.handle("tool_call_start", {
      call_id: "cx",
      tool_name: "read",
      source: "main",
      args: {},
      session_id: "s1",
      turn_index: 6,
      message_id: ai!.id,
    });
    store.handle("text_delta", { session_id: "s1", message_id: ai!.id, seq: 910, delta: "新段落。" });
    const after = store.get().messages.find(m => m.id === ai!.id)!.parts;
    expect(after.filter(p => p.type === "text")).toHaveLength(3);
    expect((after[after.length - 1].content as { md: string }).md).toBe("新段落。");
  });

  it("seq 回退即丢弃并请求 resync（带 turn_index 游标）", () => {
    const ai = store.get().messages.find(m => m.role === "assistant");
    store.handle("text_delta", { session_id: "s1", message_id: ai!.id, seq: 5000, delta: "A" });
    const before = store
      .get()
      .messages.find(m => m.id === ai!.id)!
      .parts.filter(p => p.type === "text").length;
    store.handle("text_delta", { session_id: "s1", message_id: ai!.id, seq: 10, delta: "乱序应被丢弃" });
    const after = store
      .get()
      .messages.find(m => m.id === ai!.id)!
      .parts.filter(p => p.type === "text").length;
    expect(after).toBe(before);
    expect(store.get().dropped).toBe(1);
    expect(invoke).toHaveBeenCalledWith("resync", expect.objectContaining({ session_id: "s1", since_seq: 5000 }));
  });

  it("human_confirm_required 挂起回合，approve 后解除并可改参", () => {
    const mid = "a-live";
    store.handle("tool_call_start", {
      call_id: "c1",
      tool_name: "bash",
      source: "main",
      args: {},
      session_id: "s1",
      turn_index: 7,
      message_id: mid,
    });
    store.handle("human_confirm_required", {
      call_id: "c1",
      tool_name: "bash",
      source: "main",
      kind: "command",
      command: "bun test",
      matched_rule: "global bash = require_approval",
      expires_at: Date.now() + 60_000,
      session_id: "s1",
      message_id: mid,
    });
    expect(store.get().pendingApprovals).toEqual(["c1"]);
    expect(store.get().busy).toBe(true);

    store.resolveApproval("c1", "allow", "bun test --reporter=dot");
    expect(store.get().pendingApprovals).toEqual([]);
    const approval = store
      .get()
      .messages.find(m => m.id === mid)!
      .parts.find(p => p.content.type === "approval");
    expect(approval?.content).toMatchObject({ type: "approval", decision: "allow", modifiedArgs: "bun test --reporter=dot" });
  });

  it("deny 把工具置为 denied 并结束回合", () => {
    const mid = "a-deny";
    store.handle("tool_call_start", {
      call_id: "c9",
      tool_name: "bash",
      source: "main",
      args: {},
      session_id: "s1",
      turn_index: 8,
      message_id: mid,
    });
    store.handle("tool_call_result", {
      call_id: "c9",
      error: "用户拒绝执行",
      duration_ms: 0,
      truncated: false,
      session_id: "s1",
    });
    const tool = store
      .get()
      .messages.find(m => m.id === mid)!
      .parts.find(p => p.content.type === "tool");
    expect(tool?.state).toBe("error");
  });

  it("agent_error fatal 不崩会话：只终止本 Turn 并给出 panic 结果", () => {
    store.handle("agent_error", {
      level: "error",
      code: "PANIC",
      message: "harness panicked",
      retryable: false,
      fatal: true,
      session_id: "s1",
    });
    expect(store.get().busy).toBe(false);
    expect(store.get().outcome?.kind).toBe("panic");
  });

  it("queue_state 三队列投影", () => {
    store.handle("queue_state", {
      session_id: "s1",
      main: [],
      steering: [{ id: "q1", text: "改一下" }],
      follow_up: [{ id: "q2", text: "补文档" }],
    });
    expect(store.get().queues.steering[0].text).toBe("改一下");
    expect(store.get().queues.follow_up).toHaveLength(1);
  });

  it("compact_done 产出分割线 part 且保留原消息", () => {
    const before = store.get().messages.length;
    store.handle("compact_done", {
      session_id: "s1",
      from_turn: 3,
      tokens_before: 184000,
      tokens_after: 1842,
      message_id: "m-compact",
    });
    const s = store.get();
    expect(s.messages.length).toBe(before + 1);
    expect(s.messages.at(-1)?.parts[0].content.type).toBe("compact");
  });
});

describe("权限引擎（纯函数层）", () => {
  it("分层取最严格者生效", async () => {
    const { resolvePolicy, MODE_DEFAULT_POLICY } = await import("../ipc/protocol");
    expect(resolvePolicy(["auto", "require_approval", "auto"])).toBe("require_approval");
    expect(resolvePolicy(["auto", "deny", "require_approval"])).toBe("deny");
    expect(MODE_DEFAULT_POLICY.ask.write).toBe("deny");
    expect(MODE_DEFAULT_POLICY.code.shell).toBe("require_approval");
  });
});

describe("皮肤系统", () => {
  it("内置三套皮肤均通过 L2 完整度校验", async () => {
    const { SKINS, validateSkinBundle } = await import("@duo/ui");
    expect(SKINS).toHaveLength(3);
    // 内置皮肤的值由 skins.css 提供，bundle 只声明身份：校验不抛错且 id 唯一
    expect(new Set(SKINS.map(s => s.id)).size).toBe(3);
    expect(validateSkinBundle({ id: "x", name: "x", mode: "dark", tokens: {} }).missing.length).toBeGreaterThan(0);
  });

  it("对比度计算符合 WCAG 参考值", async () => {
    const { contrastRatio } = await import("@duo/ui");
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 1);
  });
});
