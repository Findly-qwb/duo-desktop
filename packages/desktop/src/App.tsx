import { useEffect, useRef } from "react";
import { t } from "./i18n";
import { IconSprite } from "@duo/ui";
import { actions, appStore, useApp } from "./state/app";
import { Titlebar, Statusbar } from "./shell/Titlebar";
import { Rail } from "./shell/Rail";
import { OsLayer } from "./shell/OsLayer";
import { ScreenMap } from "./shell/ScreenMap";
import { Toasts } from "./shell/Toasts";
import { Dock } from "./panels/Dock";
import { ModalHost } from "./modals/ModalHost";
import { ChatView } from "./views/ChatView";
import { HistoryView } from "./views/HistoryView";
import { SettingsView } from "./views/SettingsView";
import { SkillsView } from "./views/SkillsView";
import { McpView } from "./views/McpView";
import { OnboardView } from "./views/OnboardView";
import { useShortcuts } from "./lib/useShortcuts";
import { client } from "./ipc/client";
import { ensureModelInProviders, useProviders } from "./ipc/providers";
import { findScreen } from "./screens/registry";

export default function App(): JSX.Element {
  const app = useApp();
  const providers = useProviders();

  // 真宿主态：默认模型若不在端点表里（首启/换端点），落到第一个真实模型（model 语义 = id）
  useEffect(() => {
    if (providers) ensureModelInProviders(app.model, id => actions.setModel(id));
  }, [providers, app.model]);

  useEffect(() => {
    const el = document.documentElement;
    el.dataset.skin = app.skin;
    el.dataset.proto = app.protoLayer ? "on" : "off";
    el.style.setProperty("--fscale", (app.fscale / 13).toFixed(3));
  }, [app.skin, app.protoLayer, app.fscale]);

  // 窄窗口断点：<1240 收右栏，<1040 收左栏（只自动收起，不禁止手动展开）
  const lastWidth = useRef(0);
  useEffect(() => {
    const fitShell = (initial: boolean) => {
      const w = window.innerWidth;
      const shrink = initial || w < lastWidth.current;
      lastWidth.current = w;
      if (!shrink) return; // 变宽时不抢用户手动展开的状态
      const s = appStore.get();
      if (w < 1240 && !s.rightCollapsed) actions.toggleRight();
      if (w < 1040 && !s.leftCollapsed) actions.toggleLeft();
    };
    fitShell(true);
    const onResize = () => fitShell(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 首屏按 hash 直达（#s=<屏id>），原型「每屏 hash 可达」的等价能力。
  // 必须走屏目注册表：79 屏里只有约 30 屏是「对话状态」，其余是设置页 / 弹窗 / 面板 / 独立页，
  // 直接 openScene 会把它们全部当成对话屏而渲染出空视图。
  useEffect(() => {
    const openFromHash = () => {
      const id = (location.hash.match(/s=([\w-]+)/) ?? [])[1];
      // openScene / openModal 自己会写 hash；已经在这屏了就别重跑，否则会把刚设好的状态冲掉
      if (!id || id === appStore.get().scene) return;
      const screen = findScreen(id);
      if (screen) screen.run();
      else client.bindScene("chat-stream");
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  // 场景切换 → 装载 runtime 状态（屏 = 同一视图的不同状态）
  useEffect(() => {
    client.bindScene(app.scene);
  }, [app.scene]);

  useShortcuts();

  return (
    <>
      <IconSprite />
      <div className="window" id="window">
        <Titlebar />
        <div className={`shell${app.leftCollapsed ? " nol" : ""}${app.rightCollapsed ? " nor" : ""}`} id="shell">
          {!app.leftCollapsed && <Rail />}
          <main className="center">
            <button
              type="button"
              className="edge-toggle l"
              onClick={actions.toggleLeft}
              title={t("展开左栏")}
              aria-label={t("展开左栏")}>
              <svg className="i sm" aria-hidden="true">
                <use href="#i-chevron-right" />
              </svg>
            </button>
            <button
              type="button"
              className="edge-toggle r"
              onClick={actions.toggleRight}
              title={t("展开右栏")}
              aria-label={t("展开右栏")}>
              <svg className="i sm" style={{ transform: "rotate(180deg)" }} aria-hidden="true">
                <use href="#i-chevron-right" />
              </svg>
            </button>
            <div className="viewwrap">
              <div className={`view${app.view === "chat" ? " show" : ""}${isWelcome(app.scene) ? " welcome" : ""}`} id="v-chat">
                {app.view === "chat" ? <ChatView /> : null}
              </div>
              {app.view === "history" ? (
                <div className="view show" id="v-history">
                  <HistoryView />
                </div>
              ) : null}
              {app.view === "settings" ? (
                <div className="view show" id="v-settings">
                  <SettingsView />
                </div>
              ) : null}
              {app.view === "skills" ? (
                <div className="view show" id="v-skills">
                  <SkillsView />
                </div>
              ) : null}
              {app.view === "mcp" ? (
                <div className="view show" id="v-mcp">
                  <McpView />
                </div>
              ) : null}
              {app.view === "onboard" ? (
                <div className="view show" id="v-onboard">
                  <OnboardView />
                </div>
              ) : null}
            </div>
          </main>
          {!app.rightCollapsed && <Dock />}
        </div>
        <Statusbar />
        <OsLayer />
        <ModalHost />
        <ScreenMap />
        <Toasts />
      </div>
    </>
  );
}

export function isWelcome(scene: string): boolean {
  return scene === "welcome" || scene === "chat-welcome";
}
