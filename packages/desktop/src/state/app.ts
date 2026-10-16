/**
 * 应用外壳状态（视图路由 / 折叠态 / 皮肤 / 弹层 / toast）
 * 持久化：浏览器侧 localStorage；Tauri 侧同一组键写 ui_state 表（PLAN §10）。
 */
import { st } from "../i18n";
import { createStore, useStore } from "./createStore";

export type ViewName = "chat" | "history" | "settings" | "skills" | "mcp" | "onboard";
export type DockModule = "tree" | "terminal" | "review" | "tasks" | null;
export type ModalName =
  | "skin"
  | "runtime"
  | "usage"
  | "endpoint"
  | "mcp"
  | "skill"
  | "cost"
  | "permrules"
  | "shortcuts"
  | "projectnew"
  | "panic"
  | null;

export interface ToastMsg {
  id: number;
  text: string;
  kind: "info" | "ok" | "warn" | "err";
  undo?: { label: string; run: () => void };
}

export interface ConfirmSpec {
  title: string;
  body: string;
  extra?: string;
  ok?: string;
  cancel?: string;
  danger?: boolean;
  note?: string;
  done?: string;
  /** 确认后追加动作（例如恢复草稿 / 续跑 Turn） */
  after?: () => void;
}

export interface AppState {
  view: ViewName;
  scene: string;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  skin: string;
  followSystem: boolean;
  fscale: number;
  protoLayer: boolean;
  dock: DockModule;
  modal: { name: ModalName; arg?: Record<string, unknown> } | null;
  confirm: ConfirmSpec | null;
  palette: boolean;
  screenMap: boolean;
  osLayer: "none" | "tray" | "update";
  notif: { title: string; body: string } | null;
  toasts: ToastMsg[];
  settingsTab: string;
  mode: "Ask" | "Plan" | "Code";
  variant: string;
  model: string;
  project: string;
}

const LS = {
  skin: "duo.skin",
  scale: "duo.scale",
  proto: "duo.proto",
  left: "duo.ui.left",
  right: "duo.ui.right",
  follow: "duo.followSystem",
};

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 无痕模式下忽略 */
  }
}

export const appStore = createStore<AppState>({
  view: "chat",
  scene: "chat-stream",
  leftCollapsed: read(LS.left, "0") === "1",
  rightCollapsed: read(LS.right, "0") === "1",
  skin: read(LS.skin, "graphite-dark"),
  followSystem: read(LS.follow, "1") === "1",
  fscale: Number(read(LS.scale, "13")) || 13,
  protoLayer: read(LS.proto, "on") === "on",
  dock: null,
  modal: null,
  confirm: null,
  palette: false,
  screenMap: false,
  osLayer: "none",
  notif: null,
  toasts: [],
  settingsTab: "display",
  mode: "Code",
  variant: st("默认"),
  model: "claude-sonnet-4.5", // 语义 = 模型 id（宿主按 id 匹配端点 models 表）
  project: "opencode",
});

export function useApp(): AppState {
  return useStore(appStore);
}

/** 非 React 环境（快捷键、命令面板）读取当前状态 */
export function appState(): AppState {
  return appStore.get();
}

let toastSeq = 0;

/* ---------- 动作（唯一改状态入口，便于快捷键与命令面板复用） ---------- */

export const actions = {
  go(view: ViewName): void {
    // 右栏只在对话视图常驻（原型 v2-lite：其他视图让出宽度；⌥] 仍可展开）
    appStore.set(view === "chat" ? { view } : { view, rightCollapsed: true });
  },
  openScene(scene: string): void {
    const structural =
      scene.startsWith("shell-") || scene.startsWith("panel") || scene.startsWith("set-") || scene.startsWith("skin-");
    const s = appStore.get();
    appStore.set({
      view: "chat",
      scene,
      modal: null,
      confirm: null,
      palette: false,
      screenMap: false,
      osLayer: "none",
      notif: null,
      // 非结构屏恢复默认展开态（窄窗口按断点收起）
      ...(structural
        ? {}
        : {
            leftCollapsed: window.innerWidth < 1040 ? true : s.leftCollapsed,
            rightCollapsed: window.innerWidth < 1240,
          }),
    });
    location.hash = `s=${scene}`;
  },
  toggleLeft(): void {
    const v = !appStore.get().leftCollapsed;
    write(LS.left, v ? "1" : "0");
    appStore.set({ leftCollapsed: v });
  },
  toggleRight(): void {
    const v = !appStore.get().rightCollapsed;
    write(LS.right, v ? "1" : "0");
    appStore.set({ rightCollapsed: v });
  },
  toggleFocus(): void {
    const bothCollapsed = appStore.get().leftCollapsed && appStore.get().rightCollapsed;
    write(LS.left, bothCollapsed ? "0" : "1");
    write(LS.right, bothCollapsed ? "0" : "1");
    appStore.set({ leftCollapsed: !bothCollapsed, rightCollapsed: !bothCollapsed });
  },
  openDock(mod: DockModule): void {
    appStore.set({ dock: mod, rightCollapsed: false, view: "chat" });
  },
  openModal(name: ModalName, arg?: Record<string, unknown>): void {
    appStore.set({ modal: name ? { name, arg } : null });
    // 弹窗屏也要 hash 可达（原型「每屏 hash 可分享」）
    if (name) location.hash = `s=${name}`;
  },
  closeModal(): void {
    appStore.set({ modal: null });
  },
  askConfirm(spec: ConfirmSpec): void {
    appStore.set({ confirm: spec });
  },
  closeConfirm(): void {
    appStore.set({ confirm: null });
  },
  setSkin(id: string): void {
    write(LS.skin, id);
    appStore.set({ skin: id });
  },
  setFollowSystem(v: boolean): void {
    write(LS.follow, v ? "1" : "0");
    appStore.set({ followSystem: v });
  },
  setScale(n: number): void {
    write(LS.scale, String(n));
    appStore.set({ fscale: n });
  },
  toggleProto(force?: boolean): void {
    const v = force ?? !appStore.get().protoLayer;
    write(LS.proto, v ? "on" : "off");
    appStore.set({ protoLayer: v });
    toast(v ? st("原型层已开：规格说明与 scene 标记可见") : st("原型层已关：只剩产品 UI"));
  },
  setPalette(v: boolean): void {
    appStore.set({ palette: v, screenMap: false, osLayer: "none" });
  },
  setScreenMap(v: boolean): void {
    appStore.set({ screenMap: v, palette: false, osLayer: "none" });
  },
  setOsLayer(v: AppState["osLayer"]): void {
    appStore.set({ osLayer: v, palette: false });
  },
  showNotif(title: string, body: string): void {
    appStore.set({ notif: { title, body } });
  },
  setSettingsTab(tab: string): void {
    appStore.set({ settingsTab: tab, view: "settings" });
  },
  setModel(model: string): void {
    appStore.set({ model });
  },
  setMode(mode: AppState["mode"]): void {
    appStore.set({ mode });
  },
  setVariant(variant: string): void {
    appStore.set({ variant });
  },
  setProject(project: string): void {
    appStore.set({ project });
  },
  /** Esc 分层关闭：浮层 → 通知/系统层 */
  closeOverlays(): void {
    appStore.set({ osLayer: "none", notif: null, palette: false, screenMap: false, confirm: null });
  },
  toast(text: string, kind: ToastMsg["kind"] = "ok", undo?: ToastMsg["undo"]): number {
    const id = ++toastSeq;
    appStore.set({ toasts: [...appStore.get().toasts, { id, text, kind, undo }] });
    window.setTimeout(() => actions.dismissToast(id), undo ? 10000 : 3200);
    return id;
  },
  dismissToast(id: number): void {
    appStore.set({ toasts: appStore.get().toasts.filter(t => t.id !== id) });
  },
};

export function toast(text: string, kind?: ToastMsg["kind"], undo?: ToastMsg["undo"]): number {
  return actions.toast(text, kind, undo);
}
