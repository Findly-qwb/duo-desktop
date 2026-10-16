/**
 * IPC 客户端：runtime 单例 + React 订阅钩子（PLAN §5.5）
 * UI 唯一的动作入口；transport 可换（tauri / mock），组件不感知来源。
 */
import { t } from "../i18n";
import { useSyncExternalStore } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { MockRuntime } from "./mockRuntime";
import { RuntimeStore, type Outcome } from "./store";
import { SCENES } from "../data/scenes";
import { SKILLS, type SessionRow } from "../data/fixtures";
import { appState, toast } from "../state/app";
import { groupSessions, mapDbMessage, type DbMessage, type SessionDbRow } from "./hydrate";
import type { CommandName, Commands } from "./protocol";
import type { Transport } from "./transport";
import { createTauriTransport, isTauri } from "./transport";

const transport: Transport = isTauri() ? createTauriTransport() : createMock();
export const runtime = new RuntimeStore(transport);
const detach = runtime.attach();
export const disposeRuntime = (): void => detach();

const SKILL_COMMANDS = SKILLS.map(s => s.command);
let currentSceneId = "chat-stream";

function createMock(): MockRuntime {
  const mock = new MockRuntime();
  queueMicrotask(() => mock.boot());
  return mock;
}

/** session_load → 运行时消息（宿主 SQLite 是唯一重建来源，PLAN §6.9） */
async function loadSessionMessages(sessionId: string): Promise<ReturnType<typeof mapDbMessage>[]> {
  const r = (await transport.invoke("session_load", { session_id: sessionId, limit: 200 })) as { messages: DbMessage[] };
  return (r.messages ?? []).map(mapDbMessage);
}

export function sceneOf(id: string) {
  return SCENES[sceneAlias(id)] ?? SCENES["chat-stream"];
}
function sceneAlias(id: string): string {
  return id === "chat-welcome" ? "welcome" : id;
}

function shortModel(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const client = {
  get transportKind(): "tauri" | "mock" {
    return transport.kind;
  },
  get mock(): MockRuntime | null {
    return transport.kind === "mock" ? (transport as MockRuntime) : null;
  },
  snapshot() {
    return runtime.get();
  },
  currentScene(): string {
    return currentSceneId;
  },
  bindScene(id: string): void {
    currentSceneId = id;
    // 真宿主态：消息流只来自 SQLite 水化 + 实时事件，演示场景不得覆盖（PLAN §6.9）
    if (transport.kind !== "mock") return;
    const scene = sceneOf(id);
    runtime.loadScene(scene.messages, {
      busy: scene.busy,
      context: scene.context ?? null,
      outcome: scene.outcome ?? null,
      revert: scene.revert ?? null,
      queues: scene.queues,
    });
    client.mock?.seedScene(sceneAlias(id));
  },
  /** 用户消息先落本地消息流，再入 main 队列（PLAN §6.1） */
  sendUserMessage(text: string, attachments: { name: string }[] = []): void {
    const busy = runtime.get().busy;
    if (busy) {
      void transport.invoke("submit_steering", { session_id: runtime.get().sessionId, text });
      return;
    }
    runtime.appendUserMessage({
      id: `u-${Date.now()}`,
      role: "user",
      mode: appState().mode,
      model: shortModel(appState().model),
      time: t("现在"),
      parts: [{ type: "text", md: `<p>${escapeHtml(text)}</p>` }],
    });
    void transport.invoke("submit_message", {
      session_id: runtime.get().sessionId,
      text,
      mode: appState().mode.toLowerCase() as never,
      model: appState().model,
      attachments: attachments.map(a => a.name),
    });
  },
  stop(): void {
    void transport.invoke("stop_agent", { session_id: runtime.get().sessionId });
  },
  retryLast(): void {
    void transport.invoke("submit_message", {
      session_id: runtime.get().sessionId,
      text: "/retry",
      mode: appState().mode.toLowerCase() as never,
      model: appState().model,
    });
    toast(t("已按当前上下文重试本 Turn"));
  },
  setOutcome(o: Outcome | null): void {
    runtime.setOutcome(o);
  },
  setBusy(b: boolean): void {
    runtime.setBusy(b);
  },
  approve(callId: string, decision: "allow" | "deny" | "allow_always", modifiedArgs?: string): void {
    runtime.resolveApproval(callId, decision, modifiedArgs);
    void transport.invoke("approve_tool_call", { call_id: callId, decision, modified_args: modifiedArgs });
  },
  answer(questionId: string, answers: string[]): void {
    void transport.invoke("answer_question", { question_id: questionId, answers });
  },
  queueAction(id: string, op: "edit" | "delete" | "promote"): void {
    void transport.invoke("queue_action", { id, op });
  },
  compact(): void {
    void transport.invoke("compact_now", { session_id: runtime.get().sessionId });
  },
  revertToMessage(messageId: string): void {
    void transport.invoke("revert_to_message", { session_id: runtime.get().sessionId, message_id: messageId });
    runtime.setRevert({
      label: t("本条消息"),
      files: t("3 个文件"),
      stat: "+214 −36",
      detail: "store.ts +64 −12 · sqlite-store.ts +214 · json-store.ts −88",
    });
  },
  redoStep(): void {
    void transport.invoke("redo_step", { session_id: runtime.get().sessionId, message_id: "" });
    runtime.setRevert(null);
  },
  renameSession(title: string): void {
    void transport.invoke("session_rename", { session_id: runtime.get().sessionId, title });
    runtime.setTitle(title);
    void refreshSessions();
  },
  /** 切会话：清空回合态后从 SQLite 重建转录（§6.9 唯一来源） */
  async switchSession(id: string, title = ""): Promise<void> {
    runtime.setSession(id, title);
    if (transport.kind === "tauri") runtime.hydrate(await loadSessionMessages(id));
  },
  /** 新会话：宿主 session_create（project 空 → 宿主工作区） */
  async newSession(): Promise<void> {
    if (transport.kind !== "tauri") return;
    const r = (await transport.invoke("session_create", { project_id: "", title: "" })) as { id: string; title: string };
    await client.switchSession(r.id, r.title);
    await refreshSessions();
  },
  async deleteSession(id: string): Promise<void> {
    await transport.invoke("session_delete", { session_id: id });
    if (runtime.get().sessionId === id) {
      const next = sessionGroupsCache.flatMap(g => g.items).find(s => s.id !== id);
      if (next) await client.switchSession(next.id, next.title);
    }
    await refreshSessions();
  },
  isSkill(cmd: string): boolean {
    return SKILL_COMMANDS.includes(cmd);
  },
  /** 标题栏红绿灯：tauri 态走外壳的窗口命令；浏览器 mock 无窗口控制权，no-op */
  window: {
    get enabled(): boolean {
      return transport.kind === "tauri";
    },
    minimize(): Promise<unknown> {
      return transport.kind === "tauri" ? tauriInvoke("duo_window_minimize") : Promise.resolve(null);
    },
    toggleMaximize(): Promise<unknown> {
      return transport.kind === "tauri" ? tauriInvoke("duo_window_toggle_maximize") : Promise.resolve(null);
    },
    close(): Promise<unknown> {
      return transport.kind === "tauri" ? tauriInvoke("duo_window_close") : Promise.resolve(null);
    },
  },
  invoke<N extends CommandName>(name: N, args: Commands[N]): Promise<unknown> {
    return transport.invoke(name, args);
  },
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------------- 会话列表（tauri 态：宿主 SQLite 是唯一来源） ---------------- */

let sessionGroupsCache: { group: string; items: SessionRow[] }[] = [];
const sessSubs = new Set<() => void>();

export async function refreshSessions(query = ""): Promise<void> {
  if (transport.kind !== "tauri") return;
  try {
    const r = (await transport.invoke("session_list", { query })) as { sessions: SessionDbRow[] };
    sessionGroupsCache = groupSessions(r.sessions ?? []);
  } catch {
    /* 失败保留旧缓存，不闪空列表 */
  }
  for (const f of [...sessSubs]) f();
}

export function useSessionGroups(): { group: string; items: SessionRow[] }[] {
  return useSyncExternalStore(
    cb => {
      sessSubs.add(cb);
      void refreshSessions();
      return () => {
        sessSubs.delete(cb);
      };
    },
    () => sessionGroupsCache,
    () => sessionGroupsCache,
  );
}

/** 启动：有会话进第一个并水化转录；没有就建一个（仅 tauri 态） */
async function bootSessions(): Promise<void> {
  if (transport.kind !== "tauri") return;
  await refreshSessions();
  const first = sessionGroupsCache.flatMap(g => g.items)[0];
  if (first) {
    runtime.setSession(first.id, first.title);
    runtime.hydrate(await loadSessionMessages(first.id));
  } else {
    await client.newSession();
  }
}
void bootSessions();

export function useRuntime() {
  return useSyncExternalStore(runtime.subscribe, runtime.get, runtime.get);
}
