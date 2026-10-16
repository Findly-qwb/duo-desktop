/** 左栏：全局导航 + 工作空间分组 + 最近会话（今天/昨天/本周/更早 + 活动状态点） */
import { useState } from "react";
import { t, useLocale } from "../i18n";
import { Badge, Dot as UiDot, Icon, IconBtn, type DotState } from "@duo/ui";
import { MCPS, PROJECTS, SESSION_GROUPS } from "../data/fixtures";
import { actions, toast, useApp } from "../state/app";
import { client, refreshSessions, useRuntime, useSessionGroups } from "../ipc/client";

export function Rail(): JSX.Element {
  useLocale();
  const app = useApp();
  const rt = useRuntime();
  const [renameId, setRenameId] = useState<string | null>(null);
  const connected = MCPS.filter(m => m.status === "connected").length;
  // 真宿主态：会话列表来自 session_list（SQLite）；mock 演示态保留 fixtures
  const tauriGroups = useSessionGroups();
  const isTauri = client.transportKind === "tauri";
  const groups = isTauri && tauriGroups.length ? tauriGroups : SESSION_GROUPS;

  return (
    <aside className="rail">
      <div className="rail-top">
        <button type="button" className="omni" onClick={() => actions.setPalette(true)}>
          <Icon name="search" />
          {t("rail.search")}
          <span className="kbd">⌘K</span>
        </button>
      </div>

      <nav className="nav">
        <button
          type="button"
          className={`item${app.view === "chat" && app.scene === "welcome" ? " active" : ""}`}
          onClick={() => {
            if (isTauri) {
              // 真宿主：建会话行（sessions 表）并切过去
              void client.newSession().then(() => actions.openScene("chat-stream"));
              return;
            }
            actions.openScene("welcome");
            toast(t("新会话 · 草稿按会话隔离保存"));
          }}>
          <Icon name="plus" />
          {t("nav.newChat")}
        </button>
        <button type="button" className={`item${app.view === "skills" ? " active" : ""}`} onClick={() => actions.go("skills")}>
          <Icon name="slash" />
          {t("nav.skills")}
        </button>
        <button type="button" className={`item${app.view === "mcp" ? " active" : ""}`} onClick={() => actions.go("mcp")}>
          <Icon name="zap" />
          {t("nav.mcp")}
          <Badge tone="ok">
            {connected}/{MCPS.length}
          </Badge>
        </button>
      </nav>

      <div className="grp">
        {t("nav.workspaces")}
        <Icon name="chevron-down" size="sm" />
        <span className="act">
          <IconBtn icon="plus" size="sm" title={t("打开 / 新建工作空间")} onClick={() => actions.openModal("projectnew")} />
        </span>
      </div>
      <div className="nav" style={{ flex: "none" }}>
        {PROJECTS.map(p => (
          <button
            key={p.id}
            type="button"
            className={`item${p.name === app.project ? " active" : ""}`}
            onClick={() => {
              actions.setProject(p.name);
              toast(t("切换工作空间：{x}", { x: p.name }));
            }}>
            <Icon name={p.name === app.project ? "folder-open" : "folder"} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
            <Badge tone="gray">{p.sessions}</Badge>
          </button>
        ))}
        <button
          type="button"
          className="item"
          style={{ color: "var(--text-weaker)" }}
          onClick={() => actions.openModal("projectnew")}>
          <Icon name="plus" />
          {t("nav.openOther")}
        </button>
      </div>

      <div className="grp">
        {t("nav.recent")}
        <span className="act">
          <IconBtn icon="list" size="sm" title={t("nav.allHistory")} onClick={() => actions.go("history")} />
        </span>
      </div>

      <div className="sesslist">
        {groups.map(g => (
          <div key={g.group}>
            <div className="dategroup">{g.group}</div>
            {g.items
              .filter(s => isTauri || s.project === app.project)
              .map(s => (
                <div
                  key={s.id}
                  className={`sess${s.id === (isTauri ? rt.sessionId : "s1") ? " active" : ""}`}
                  onClick={() => {
                    if (isTauri) void client.switchSession(s.id, s.title);
                    actions.openScene("chat-stream");
                  }}>
                  <Dot state={isTauri ? (s.id === rt.sessionId && rt.busy ? "run" : "idle") : s.activity || "idle"} />
                  {renameId === s.id ? (
                    <input
                      className="tinp mono"
                      defaultValue={s.title}
                      onClick={e => e.stopPropagation()}
                      onBlur={e => {
                        const v = e.target.value.trim();
                        setRenameId(null);
                        if (!isTauri || !v || v === s.title) return;
                        if (s.id === rt.sessionId) client.renameSession(v);
                        else
                          void client.invoke("session_rename", { session_id: s.id, title: v }).then(() => void refreshSessions());
                      }}
                      onKeyDown={e => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setRenameId(null);
                      }}
                      style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-12)" }}
                      aria-label={t("重命名会话")}
                    />
                  ) : (
                    <span className="t">{s.title}</span>
                  )}
                  <span className="time">{s.when}</span>
                  <span className="act">
                    <IconBtn
                      icon="pencil"
                      size="sm"
                      title={t("common.rename")}
                      onClick={e => {
                        e.stopPropagation();
                        setRenameId(s.id);
                      }}
                    />
                    <IconBtn
                      icon="download"
                      size="sm"
                      title={t("common.export")}
                      onClick={e => {
                        e.stopPropagation();
                        toast(t("已导出转录.md"));
                      }}
                    />
                    <IconBtn
                      icon="trash"
                      size="sm"
                      title={t("common.delete")}
                      onClick={e => {
                        e.stopPropagation();
                        softDelete(s.id, s.title);
                      }}
                    />
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>

      <div className="rail-foot">
        <button
          type="button"
          className={`item${app.view === "settings" ? " active" : ""}`}
          onClick={() => actions.go("settings")}>
          <Icon name="sliders" />
          {t("nav.settings")}
          <span className="kbd">⌘,</span>
        </button>
      </div>
    </aside>
  );
}

/** 软删 + 撤销窗口（sessions.deleted_at，30 天后清理）；真宿主态删完自动切到下一个会话 */
function softDelete(id: string, title: string): void {
  toast(t("已删除「{title}」", { title: title }), "warn", {
    label: t("撤销"),
    run: () => {
      void client.invoke("session_restore", { session_id: id }).then(() => void refreshSessions());
      toast(t("已撤销删除（deleted_at 置空）"));
    },
  });
  if (client.transportKind === "tauri") void client.deleteSession(id);
  else void client.invoke("session_delete", { session_id: id });
}

function Dot({ state }: { state: string }): JSX.Element {
  // 文案在渲染时现取，切语言不会留下模块加载期算好的旧字符串；@duo/ui 的 Dot 只接 label
  const label: Record<string, string> = { run: t("运行中"), ask: t("需输入"), err: t("错误"), idle: t("空闲") };
  return <UiDot state={(state || "idle") as DotState} label={label[state] ?? t("空闲")} />;
}
