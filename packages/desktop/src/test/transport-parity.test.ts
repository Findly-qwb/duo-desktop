/**
 * T1 契约：同一批命令在 mock 与 tauri 两种 transport 下，宿主收到的入参形状必须一致。
 * tauri 侧只允许 `duo_invoke` 一个入口，信封固定为 { cmd, args }，args 原样透传；
 * 前端若在 args 里夹带宿主不认的字段，这里与 fixture 的深比较会直接失败。
 */
import { describe, expect, it } from "vitest";
import {
  createTauriTransport,
  DUO_EVENT_CHANNEL,
  DUO_INVOKE_CMD,
  type DuoEnvelope,
  type RawInvoke,
  type RawListen,
  type Transport,
} from "../ipc/transport";
import { MockRuntime } from "../ipc/mockRuntime";
import type { CommandName, Commands } from "../ipc/protocol";

type Call = { name: CommandName; args: Commands[CommandName] };

const CALLS: Call[] = [
  { name: "submit_message", args: { session_id: "s1", text: "跑一下测试", mode: "code", model: "claude-opus-4-1" } },
  { name: "submit_steering", args: { session_id: "s1", text: "先看 store.ts" } },
  { name: "stop_agent", args: { session_id: "s1" } },
  { name: "approve_tool_call", args: { call_id: "c1", decision: "allow", modified_args: { path: "a.ts" } } },
  { name: "answer_question", args: { question_id: "q1", answers: ["SQLite"] } },
  { name: "queue_action", args: { id: "q1", op: "promote" } },
  { name: "compact_now", args: { session_id: "s1" } },
  { name: "revert_to_message", args: { session_id: "s1", message_id: "m3" } },
  { name: "redo_step", args: { session_id: "s1", message_id: "" } },
  { name: "session_rename", args: { session_id: "s1", title: "重命名" } },
  { name: "resync", args: { session_id: "s1", turn_index: 6, since_seq: 42 } },
  { name: "git_stage", args: { project_id: "p1", paths: ["packages/desktop/src/ipc/client.ts"] } },
  { name: "mcp_retry", args: { id: "linear" } },
];

async function recordTauri(): Promise<{ transport: Transport; calls: Array<{ cmd: string; payload: Record<string, unknown> }> }> {
  const calls: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  const rawInvoke: RawInvoke = (cmd, payload) => {
    calls.push({ cmd, payload: structuredClone((payload ?? {}) as Record<string, unknown>) });
    return Promise.resolve({ ok: true });
  };
  const rawListen: RawListen = () => Promise.resolve(() => {});
  return { transport: createTauriTransport(rawInvoke, rawListen), calls };
}

function recordMock(): { transport: Transport; calls: Array<{ cmd: string; payload: unknown }> } {
  const calls: Array<{ cmd: string; payload: unknown }> = [];
  const mock = new MockRuntime();
  // 只记录形状，不跑 mock 剧本（submit_message / mcp_retry 会留悬挂定时器）
  mock.invoke = ((name: CommandName, args: Commands[CommandName]) => {
    calls.push({ cmd: name, payload: structuredClone(args) });
    return Promise.resolve({ ok: true });
  }) as Transport["invoke"];
  return { transport: mock, calls };
}

describe("transport 入参形状一致性（T1）", () => {
  it("tauri transport 把每条命令包成 duo_invoke({cmd,args})，args 原样透传", async () => {
    const { transport, calls } = await recordTauri();
    for (const c of CALLS) await transport.invoke(c.name, c.args);
    expect(calls).toHaveLength(CALLS.length);
    calls.forEach((sent, i) => {
      expect(sent.cmd).toBe(DUO_INVOKE_CMD);
      expect(Object.keys(sent.payload)).toEqual(["cmd", "args"]);
      expect(sent.payload.cmd).toBe(CALLS[i].name);
      expect(sent.payload.args).toEqual(CALLS[i].args);
    });
  });

  it("同一批命令在 mock 与 tauri 下收到的 args 形状逐条一致", async () => {
    const tauri = await recordTauri();
    const mock = recordMock();
    for (const c of CALLS) {
      await tauri.transport.invoke(c.name, c.args);
      await mock.transport.invoke(c.name, c.args);
    }
    mock.calls.forEach((m, i) => {
      expect(m.cmd).toBe(tauri.calls[i].payload.cmd);
      expect(m.payload).toEqual(tauri.calls[i].payload.args);
    });
  });

  it("tauri 事件：Envelope 拆成 (name, payload) 交给上层，通道名与外壳一致", async () => {
    let fire: ((e: { payload: DuoEnvelope }) => void) | undefined;
    let channel = "";
    const rawListen: RawListen = (event, cb) => {
      channel = event;
      fire = cb;
      return Promise.resolve(() => {});
    };
    const transport = createTauriTransport((_c, _p) => Promise.resolve({ ok: true }), rawListen);
    const got: Array<[string, unknown]> = [];
    const off = transport.onAny((name, payload) => got.push([name, payload]));
    expect(channel).toBe(DUO_EVENT_CHANNEL);
    fire!({
      payload: {
        name: "text_delta",
        payload: { session_id: "s1", message_id: "m1", seq: 3, delta: "有序" } as never,
        turn_index: 6,
        seq: 3,
        ts: 1_720_000_000,
      },
    });
    expect(got).toEqual([["text_delta", { session_id: "s1", message_id: "m1", seq: 3, delta: "有序" }]]);
    off();
    expect(() => fire!({ payload: { name: "ready", payload: {} as never, turn_index: 0, seq: 0, ts: 0 } })).not.toThrow();
    expect(got).toHaveLength(1);
  });
});
