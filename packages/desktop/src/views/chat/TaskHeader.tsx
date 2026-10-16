/** 顶部 TaskHeader：可重命名标题 + 上下文胶囊 + 会话动作菜单 + 活动/用量时间线 */
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { Icon } from "@duo/ui";
import { actions, toast } from "../../state/app";
import { client } from "../../ipc/client";
import type { RuntimeState } from "../../ipc/store";

const BARS: [number, string][] = [
  [12, ""],
  [20, "tool"],
  [26, "tool"],
  [9, ""],
  [18, "tool"],
  [14, "err"],
  [30, "tool"],
  [16, ""],
  [22, "tool"],
  [11, "think"],
];

export function TaskHeader({
  title,
  state,
  withTimeline,
}: {
  title: string;
  state: RuntimeState;
  withTimeline?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState(title);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = () => setMenu(false);
    window.addEventListener("click", onDoc);
    return () => window.removeEventListener("click", onDoc);
  }, []);
  useEffect(() => setDraft(title), [title]);

  const ctx = state.context ? Math.round(((state.context.used + state.context.reserved) / state.context.window) * 100) : 34;

  return (
    <div className="taskhead" ref={wrap}>
      <div className="th-row">
        <input
          className="th-title"
          value={draft}
          aria-label={t("会话标题（可重命名）")}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() === title) return;
            client.renameSession(draft.trim());
            toast(t("已重命名（写 sessions.title）"));
          }}
          onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <div className="th-meta">
          <button
            type="button"
            className="pill"
            title={t("上下文占用 {ctx}% · 点击展开活动与用量", { ctx: ctx })}
            onClick={() => setOpen(v => !v)}>
            <span className="ctxbar">
              <i className={ctx > 85 ? "crit" : ctx > 70 ? "warn" : ""} style={{ width: `${ctx}%` }} />
            </span>
            <b>{ctx}%</b>
          </button>
          <button
            type="button"
            className="iconbtn"
            title={t("会话动作")}
            aria-label={t("会话动作")}
            onClick={e => {
              e.stopPropagation();
              setMenu(v => !v);
            }}>
            <Icon name="dots" />
          </button>
        </div>
      </div>

      {menu ? (
        <div className="menu show" role="menu" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              actions.openScene("welcome");
              toast(t("新会话 · 草稿按会话隔离保存"));
            }}>
            <Icon name="plus" size="sm" />
            {t("新会话")}
            <span className="kbd">⌘N</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              toast(t("已从此处 Fork 新会话"));
            }}>
            <Icon name="fork" size="sm" />
            {t("Fork 当前会话")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              actions.openDock("tree");
            }}>
            <Icon name="folder-open" size="sm" />
            {t("文件树")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              actions.openDock("review");
            }}>
            <Icon name="diff" size="sm" />
            {t("变更审查")}
            <span className="push mono" style={{ color: "var(--text-weaker)" }}>
              +{state.gitStatus?.files.reduce((n, f) => n + f.added, 0) ?? 278} −
              {state.gitStatus?.files.reduce((n, f) => n + f.deleted, 0) ?? 100}
            </span>
          </button>
          <div className="sep" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              client.compact();
              toast(t("已请求压缩上下文"));
            }}>
            <Icon name="archive" size="sm" />
            {t("压缩上下文")}
            <span className="kbd">/compact</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              actions.openScene("search");
            }}>
            <Icon name="search" size="sm" />
            {t("转录内搜索")}
            <span className="kbd">⌘F</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              actions.openModal("usage");
            }}>
            <Icon name="activity" size="sm" />
            {t("用量与费用")}
            <span className="kbd">$0.0421</span>
          </button>
        </div>
      ) : null}

      {withTimeline ? (
        <div className={`timeline${open ? " open" : ""}`}>
          <div className="tl-bars" title={t("回合活动条：点击定位到对应消息")}>
            {BARS.map((b, i) => (
              <button
                key={i}
                type="button"
                className={b[1]}
                style={{ height: b[0], border: "none" }}
                aria-label={t("第 {x1} 个事件", { x1: i + 1 })}
                onClick={() => toast(t("定位到第 {x1} 个事件", { x1: i + 1 }))}
              />
            ))}
          </div>
          <div className="ctxprog" title={t("已用上下文 / 输出预留 / 剩余")}>
            <i style={{ width: "34%" }} />
            <i style={{ width: "12%" }} />
            <i style={{ width: "54%" }} />
          </div>
          <div className="tl-legend">
            <span>
              {t("输入")}
              <b>66.0K</b>
              {t("（缓存读 61.2K · 命中")}
              <b>93%</b>）
            </span>
            <span>
              {t("输出")}
              <b>2.2K</b>
            </span>
            <span>
              {t("推理")}
              <b>0.8K</b>
            </span>
            <span style={{ marginLeft: "auto" }} className="mono">
              claude-sonnet-4.5 · 9 steps · <b>$0.0421</b>
            </span>
            <button type="button" className="btn sm" onClick={() => actions.openModal("usage")}>
              {t("完整用量 →")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
