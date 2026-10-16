/** 历史会话页（PLAN §11 M2）：本地 SQLite · 工作空间过滤 · FTS 搜索 · 行内操作 */
import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n";
import { Icon, IconBtn } from "@duo/ui";
import { PROJECTS, SESSION_GROUPS, ST } from "../data/fixtures";
import { actions, toast, useApp } from "../state/app";
import { client, refreshSessions, useSessionGroups } from "../ipc/client";

export function HistoryView(): JSX.Element {
  const app = useApp();
  const [query, setQuery] = useState("");
  const [project, setProject] = useState(t("全部工作空间"));
  const [mode, setMode] = useState(t("全部模式"));
  const [limit, setLimit] = useState(50);
  const isTauri = client.transportKind === "tauri";
  const tauriGroups = useSessionGroups();

  // 真宿主态：搜索词交给宿主（标题 LIKE + FTS5 正文），本地只做模式过滤
  useEffect(() => {
    if (!isTauri) return;
    const h = setTimeout(() => void refreshSessions(query.trim()), 250);
    return () => clearTimeout(h);
  }, [query, isTauri]);

  const groups = useMemo(() => {
    const base = isTauri && tauriGroups.length ? tauriGroups : SESSION_GROUPS;
    const q = query.trim().toLowerCase();
    return base
      .map(g => ({
        ...g,
        items: g.items.filter(
          s =>
            (isTauri || !q || s.title.toLowerCase().includes(q)) &&
            (isTauri || project === t("全部工作空间") || s.project === project) &&
            (mode === t("全部模式") || s.mode === mode),
        ),
      }))
      .filter(g => g.items.length);
  }, [query, project, mode, isTauri, tauriGroups]);

  return (
    <div className="page">
      <h2>{t("历史会话")}</h2>
      <div className="lead">{t("全部数据本地：~/.local/share/duo-desktop/duo-desktop.db（SQLite · WAL）· 无云同步、无账号")}</div>
      <div className="hsearch">
        <input
          type="text"
          placeholder={t("按标题 / 内容全文搜索（FTS5）…")}
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label={t("搜索会话")}
        />
        <select
          className="sel"
          style={{ minWidth: 150 }}
          value={project}
          onChange={e => setProject(e.target.value)}
          aria-label={t("按工作空间过滤")}>
          <option>{t("全部工作空间")}</option>
          {PROJECTS.map(p => (
            <option key={p.id}>{p.name}</option>
          ))}
        </select>
        <select
          className="sel"
          style={{ minWidth: 120 }}
          value={mode}
          onChange={e => setMode(e.target.value)}
          aria-label={t("按模式过滤")}>
          <option>{t("全部模式")}</option>
          <option>Ask</option>
          <option>Plan</option>
          <option>Code</option>
        </select>
        <button
          type="button"
          className="btn"
          onClick={() => toast(t("已导出所选会话为 Markdown（{project}）", { project: app.project }))}>
          <Icon name="download" size="sm" />
          {t("导出")}
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="empty">
          <Icon name="history" size="lg" />
          <h4>{t("没有匹配的会话")}</h4>
          <p>{t("换个关键词，或切回「全部工作空间」。历史只存在本机 SQLite，不会上云。")}</p>
        </div>
      ) : null}

      {groups.map(g => (
        <div key={g.group}>
          <div className="dategroup" style={{ paddingLeft: 2 }}>
            {g.group}
          </div>
          {g.items.map(s => (
            <div
              className="hrow"
              key={s.id}
              onClick={() => {
                if (isTauri) void client.switchSession(s.id, s.title);
                actions.openScene("chat-stream");
              }}>
              <span className={`dot ${s.activity || "idle"}`} role="img" aria-label={LABEL[s.activity || "idle"]} />
              <div style={{ minWidth: 0 }}>
                <div className="t">{s.title}</div>
                <div className="m">
                  <span>{s.project}</span>
                  <span>{s.mode}</span>
                  <span>{s.model}</span>
                  <span>{s.messages} messages</span>
                  <span>{t("{cost} 估算", { cost: s.cost })}</span>
                  <span>{s.diff}</span>
                </div>
              </div>
              <div className="r">
                <span className="mono">{s.when}</span>
                <IconBtn
                  icon="pencil"
                  size="sm"
                  title={t("重命名")}
                  onClick={e => {
                    e.stopPropagation();
                    rename(s.id);
                  }}
                />
                <IconBtn
                  icon="download"
                  size="sm"
                  title={t("导出")}
                  onClick={e => {
                    e.stopPropagation();
                    toast(t("已导出转录.md"));
                  }}
                />
                <IconBtn
                  icon="trash"
                  size="sm"
                  title={t("删除")}
                  onClick={e => {
                    e.stopPropagation();
                    softDelete(s.id, s.title);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      ))}

      {groups.length ? (
        <div style={{ textAlign: "center", padding: 14 }}>
          <button type="button" className="btn sm" onClick={() => setLimit(n => n + 50)}>
            <Icon name="chevron-down" size="sm" />
            {t("加载更早（还有 {limit} 条）", { limit: Math.max(0, 214 - limit) })}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const LABEL: Record<string, string> = { run: t("运行中"), ask: t("需要输入"), err: t("出错"), idle: t("空闲") };

function rename(id: string): void {
  const title = window.prompt(t("会话标题"), t("给 SessionStore 加 SQLite 持久化"));
  if (title?.trim()) {
    void client.invoke("session_rename", { session_id: id, title: title.trim() }).then(() => void refreshSessions());
    toast(t("已重命名（↵ 提交 / esc 取消）"));
  }
}

/** 软删 + 撤销窗口（sessions.deleted_at，30 天后清理） */
function softDelete(id: string, title: string): void {
  actions.askConfirm({
    title: t("删除会话？"),
    danger: true,
    ok: t("删除"),
    done: t("已删除（软删，可撤销 10s）"),
    body: t("sessions.deleted_at 标记，30 天后清理；附件缓存与检查点一并回收。"),
    after: () => {
      void client.deleteSession(id).then(() => {
        toast(t("已删除「{title}」", { title: title }), "warn", {
          label: t("撤销"),
          run: () => {
            void client.invoke("session_restore", { session_id: id }).then(() => void refreshSessions());
            toast(t("已撤销删除"));
          },
        });
      });
    },
  });
  void ST;
}
