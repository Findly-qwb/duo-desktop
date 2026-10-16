/** MCP 页（PLAN §8）：三协议 · 状态机 · Sign in / 重试 / 删除 · 全局策略 */
import { useMemo } from "react";
import { t } from "../i18n";
import { Badge, Icon, Switch } from "@duo/ui";
import { MCPS } from "../data/fixtures";
import { actions, toast } from "../state/app";
import { client } from "../ipc/client";

export function McpView(): JSX.Element {
  const rows = useMemo(() => MCPS, []);
  const cnt = (k: string) => rows.filter(m => m.status === k).length;

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <h2>MCP Servers</h2>
        <span className="lead" style={{ margin: 0 }}>
          {t("stdio / sse / http 三协议 · 工具接入权限引擎")}
        </span>
        <button type="button" className="btn primary" style={{ marginLeft: "auto" }} onClick={() => actions.openModal("mcp")}>
          <Icon name="plus" size="sm" />
          {t("添加 Server")}
        </button>
      </div>
      <div className="lead" style={{ marginTop: 8 }}>
        <Badge tone="ok">{cnt("connected")} connected</Badge> <Badge tone="warn">{cnt("needs_auth")} needs auth</Badge>{" "}
        <Badge tone="err">{cnt("failed")} failed</Badge> <Badge tone="gray">{cnt("disabled")} disabled</Badge>
      </div>

      <div className="sgroup">
        <div className="gh">
          <Icon name="zap" size="sm" />
          {t("列表")}
        </div>
        {rows.map(m => {
          const tone =
            m.status === "connected" ? "ok" : m.status === "failed" ? "err" : m.status === "needs_auth" ? "warn" : "gray";
          return (
            <div className={`srow${m.enabled ? "" : " disabled"}`} key={m.name}>
              <div className="l">
                <div className="n">
                  {m.name} {<Badge tone="gray">{m.transport}</Badge>} {<Badge tone={tone}>{m.status.replace("_", " ")}</Badge>}
                </div>
                <div className="d mono" style={{ fontSize: "var(--fs-11)" }}>
                  {m.endpoint}
                </div>
              </div>
              <div className="c">
                <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-weaker)" }}>
                  {m.tools} tools
                </span>
                {m.status === "needs_auth" ? (
                  <button type="button" className="btn sm primary" onClick={() => toast(t("已打开授权页（系统浏览器）"))}>
                    <Icon name="key" size="sm" />
                    Sign in
                  </button>
                ) : null}
                {m.status === "failed" ? (
                  <>
                    <button type="button" className="btn sm" onClick={() => toast(m.error ?? t("已复制 stderr"))}>
                      <Icon name="copy" size="sm" />
                      {t("日志")}
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        void client.invoke("mcp_retry", { id: m.name });
                        toast(t("重试连接中（退避 2/5）"));
                      }}>
                      <Icon name="refresh" size="sm" />
                      {t("重试")}
                    </button>
                  </>
                ) : null}
                <button type="button" className="btn sm" onClick={() => actions.openModal("mcp", { n: m.name })}>
                  <Icon name="pencil" size="sm" />
                  {t("编辑")}
                </button>
                <Switch
                  on={m.enabled}
                  onChange={() => toast(m.enabled ? t("{name} 已停用", { name: m.name }) : t("{name} 已启用", { name: m.name }))}
                  label={t("启用 {x}", { x: m.name })}
                />
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() =>
                    actions.askConfirm({
                      title: t("删除 MCP {x}？", { x: m.name }),
                      danger: true,
                      ok: t("删除"),
                      done: t("已删除"),
                      body: t("stdio 子进程随之下线；历史 part 引用保留为只读。"),
                    })
                  }>
                  <Icon name="trash" size="sm" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="sgroup">
        <div className="gh">
          <Icon name="sliders" size="sm" />
          {t("全局策略")}
        </div>
        <div className="srow">
          <div className="l">
            <div className="n">{t("MCP 工具默认策略")}</div>
            <div className="d">{t("外部进程以你的权限运行，默认逐个确认")}</div>
          </div>
          <div className="c">
            <select className="sel" aria-label={t("MCP 默认策略")}>
              <option>require_approval</option>
              <option>auto</option>
              <option>deny</option>
            </select>
          </div>
        </div>
        <div className="srow">
          <div className="l">
            <div className="n">{t("调用超时")}</div>
          </div>
          <div className="c">
            <input className="tinp num" defaultValue={60} aria-label={t("调用超时")} /> s
          </div>
        </div>
        <div className="srow">
          <div className="l">
            <div className="n">{t("输出截断阈值")}</div>
            <div className="d">{t("超出后落盘并给出路径引用，避免污染上下文")}</div>
          </div>
          <div className="c">
            <input className="tinp num" defaultValue={32} aria-label={t("输出截断阈值")} /> KB
          </div>
        </div>
        <div className="srow">
          <div className="l">
            <div className="n">{t("子进程回收")}</div>
            <div className="d">{t("应用退出 / server 停用时 kill 进程组（含孙进程）")}</div>
          </div>
          <div className="c">
            <Badge tone="ok">{t("强制")}</Badge>
          </div>
        </div>
      </div>

      <div className="notice info spec">
        <Icon name="info" size="sm" />
        <div>
          {t("工具以")}
          <code className="mono">mcp:&lt;server&gt;:&lt;tool&gt;</code>{" "}
          {t("注册，可在权限页单独设策。无市场与一键安装（本地优先），配置来自 duo 配置文件或本页面。")}
        </div>
      </div>
    </div>
  );
}
