/** 自绘标题栏（Tauri decorations=false）：红绿灯 / 品牌 / 面包屑 / 分支胶囊 / 皮肤 / 折叠 / 屏目索引 */
import { Icon, IconBtn } from "@duo/ui";
import { t, useLocale, type Key } from "../i18n";
import { SCREENS } from "../screens/registry";
import { actions, useApp } from "../state/app";
import { client } from "../ipc/client";
import { RUNTIME_VERSION } from "../ipc/protocol";

const CRUMB: Record<string, Key> = {
  chat: "crumb.chat",
  history: "crumb.history",
  settings: "crumb.settings",
  skills: "crumb.skills",
  mcp: "crumb.mcp",
  onboard: "crumb.onboard",
};

export function Titlebar(): JSX.Element {
  useLocale();
  const app = useApp();
  const rt = client.snapshot();
  const changes = rt.gitStatus?.files.length ?? 4;
  // T1：红绿灯只在真宿主下接管窗口（浏览器 mock 无窗口控制权，保持原型纯装饰 DOM）
  const lights = [
    { bg: "#ff5f57", label: t("关闭"), act: () => client.window.close() },
    { bg: "#febc2e", label: t("最小化到托盘"), act: () => client.window.minimize() },
    { bg: "#28c840", label: t("最大化或还原"), act: () => client.window.toggleMaximize() },
  ];

  return (
    <header className="titlebar">
      <div className="lights" title={t("macOS 红绿灯")}>
        {lights.map(l =>
          client.window.enabled ? (
            <i
              key={l.bg}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: 原型 CSS 只认 `.lights i`，真宿主态下红绿灯必须可点；换标签会偏离 prototype.html 的 DOM
              role="button"
              tabIndex={0}
              style={{ background: l.bg }}
              aria-label={l.label}
              onClick={() => void l.act()}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void l.act();
                }
              }}
            />
          ) : (
            <i key={l.bg} style={{ background: l.bg }} />
          ),
        )}
      </div>
      <div className="tb-brand">
        <span className="mark">
          <Icon name="mark" />
        </span>
        <span className="tb-title">duo</span>
      </div>
      <div className="tb-crumb">
        <b>{t(CRUMB[app.view] ?? "crumb.chat")}</b>
        <span>·</span>
        <span className="mono">{app.project}</span>
      </div>
      <div className="tb-right">
        <button
          type="button"
          className="pill"
          title={t("tb.review", { branch: "dev" })}
          onClick={() => actions.openDock("review")}>
          <Icon name="branch" size="sm" />
          <span className="mono">dev</span>
          <span className="badge gray">{changes}</span>
        </button>
        <span className="tb-sep" />
        <IconBtn icon="palette" title={t("tb.skin")} onClick={() => actions.openModal("skin")} />
        <IconBtn icon="panel-left" title={t("tb.left")} active={app.leftCollapsed} onClick={actions.toggleLeft} />
        <IconBtn icon="panel-right" title={t("tb.right")} active={app.rightCollapsed} onClick={actions.toggleRight} />
        <IconBtn icon="layout" title={t("tb.screens")} onClick={() => actions.setScreenMap(true)} />
      </div>
    </header>
  );
}

/** 状态栏：runtime / git / 费用估算 / 待审批 ——「需要关注」只在这里主动找人（PLAN §5.2） */
export function Statusbar(): JSX.Element {
  useLocale();
  const app = useApp();
  const rt = client.snapshot();
  const pending = rt.pendingApprovals.length;
  const ctx = rt.context ? Math.round((rt.context.used / rt.context.window) * 100) : 34;

  return (
    <footer className="statusbar">
      <button type="button" className="sb act" title={t("sb.runtimeTip")} onClick={() => actions.openModal("runtime")}>
        <span className={`dot ${rt.busy ? "run" : "idle"}`} role="img" aria-label={rt.busy ? t("运行中") : t("空闲")} />
        {t("sb.runtime", {
          kind: client.transportKind === "tauri" ? (rt.runtimeInfo?.runtime ?? RUNTIME_VERSION) : "mock (browser)",
        })}
      </button>
      <button
        type="button"
        className="sb"
        title={t("sb.gitTip", { branch: "dev", ahead: 1, behind: 0, n: rt.gitStatus?.files.length ?? 4 })}
        onClick={() => actions.openDock("review")}>
        <Icon name="branch" size="sm" />
        dev ↑1 ↓0 · <span>{t("sb.changes", { n: rt.gitStatus?.files.length ?? 4 })}</span>
      </button>
      <button type="button" className="sb" title={t("sb.costTip")} onClick={() => actions.openModal("usage")}>
        <Icon name="activity" size="sm" />
        $0.0421 · ctx {ctx}%
      </button>
      <button
        type="button"
        className={`sb${pending ? " act" : ""}`}
        title={t("sb.pendingTip", { n: pending })}
        onClick={() => actions.openScene("perm-dock")}>
        <Icon name="shield" size="sm" />
        {t("sb.pending", { n: pending || 1 })}
      </button>
      {app.dock ? (
        <button type="button" className="sb" onClick={() => actions.openDock(app.dock)}>
          <Icon name="layers" size="sm" />
          {t("sb.panel")} · {t(DOCK_LABEL[app.dock])}
        </button>
      ) : null}
      <span className="push" />
      <button type="button" className="sb proto-only" title={t("tb.screens")} onClick={() => actions.setScreenMap(true)}>
        <Icon name="layout" size="sm" />
        {t("sb.screens")} <b style={{ color: "var(--text-weak)" }}>{SCREEN_COUNT}</b>
      </button>
      <button type="button" className="sb" title="⌘⇧P" onClick={() => actions.toggleProto()}>
        <Icon name="eye" size="sm" />
        {app.protoLayer ? t("sb.protoOn") : t("sb.protoOff")}
      </button>
    </footer>
  );
}

const DOCK_LABEL: Record<string, Key> = {
  tree: "dock.tree",
  terminal: "dock.terminal",
  review: "dock.review",
  tasks: "dock.tasks",
};
const SCREEN_COUNT = SCREENS.length;
