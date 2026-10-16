/**
 * Transport：Tauri 原生 IPC（生产）与浏览器内 mock runtime（开发/验收）二选一。
 * PLAN §3.2：只走 Tauri IPC（event + command），不起 HTTP、不开端口、不做鉴权层。
 */
import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { CommandName, Commands, DuoEvents, EventName } from "./protocol";

/** 外壳（bin/duo.rs）只注册一条 duo_invoke：52 命令都走 { cmd, args } 信封（T1） */
export const DUO_INVOKE_CMD = "duo_invoke";
export const DUO_EVENT_CHANNEL = "duo://event";

/** Rust `ipc::Envelope` 的 JSON 形状（serde 默认 snake_case） */
export interface DuoEnvelope {
  name: EventName;
  payload: DuoEvents[EventName];
  turn_index: number;
  seq: number;
  ts: number;
}

export interface Transport {
  readonly kind: "tauri" | "mock";
  onAny(handler: (name: EventName, payload: DuoEvents[EventName]) => void): () => void;
  invoke<N extends CommandName>(name: N, args: Commands[N]): Promise<unknown>;
}

/** Tauri 注入的内部对象存在即为原生容器；否则跑浏览器内确定性 runtime */
export function isTauri(): boolean {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __DUO_MOCK__?: boolean };
  return !!w.__TAURI_INTERNALS__ && !w.__DUO_MOCK__;
}

export const EVENT_NAMES: EventName[] = [
  "ready",
  "text_delta",
  "reasoning_delta",
  "message_part_upserted",
  "tool_call_start",
  "tool_call_output_delta",
  "tool_call_result",
  "human_confirm_required",
  "question_required",
  "turn_end",
  "context_usage",
  "agent_end",
  "agent_error",
  "compact_done",
  "file_changed",
  "git_status_changed",
  "scan_progress",
  "mcp_status",
  "session_updated",
  "queue_state",
];

/** 注入点：生产用 @tauri-apps/api，测试给 fake 记录调用形状（T1 防漂移用例） */
export type RawInvoke = (cmd: string, args?: InvokeArgs) => Promise<unknown>;
export type RawListen = (event: string, cb: (e: { payload: DuoEnvelope }) => void) => Promise<() => void>;

/**
 * 真 Tauri 通道（T1）：
 * - 命令：全部经外壳唯一的 `duo_invoke`，args 原样透传进信封，前端不添加宿主不认的字段；
 * - 事件：监听 `duo://event`，把 Rust Envelope 的 (name, payload) 交给上层游标逻辑。
 */
export function createTauriTransport(rawInvoke: RawInvoke = tauriInvoke, rawListen: RawListen = tauriListen): Transport {
  return {
    kind: "tauri",
    onAny(handler) {
      let disposed = false;
      let unlisten: (() => void) | undefined;
      void rawListen(DUO_EVENT_CHANNEL, e => {
        if (disposed) return;
        const env = e.payload;
        handler(env.name, env.payload);
      }).then(fn => {
        if (disposed) fn();
        else unlisten = fn;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    invoke<N extends CommandName>(name: N, args: Commands[N]): Promise<unknown> {
      return rawInvoke(DUO_INVOKE_CMD, { cmd: name, args });
    },
  };
}
