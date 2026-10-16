/** Skills 页（PLAN §11 M5）：扫描目录 · 作用域 · 启停 · 重载 · 编辑弹窗 */
import { useState } from "react";
import { t } from "../i18n";
import { Badge, Icon, Switch } from "@duo/ui";
import { SKILLS, type SkillRow } from "../data/fixtures";
import { actions, toast } from "../state/app";
import { client } from "../ipc/client";

export function SkillsView(): JSX.Element {
  const [rows, setRows] = useState<SkillRow[]>(SKILLS);

  const toggle = (cmd: string, on: boolean): void => {
    setRows(list => list.map(r => (r.command === cmd ? { ...r, enabled: on } : r)));
    void client.invoke("skill_toggle", { id: cmd, enabled: on });
    toast(on ? t("{cmd} 已启用", { cmd }) : t("{cmd} 已停用", { cmd }));
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <h2>Skills</h2>
        <span className="lead" style={{ margin: 0 }}>
          {t("自定义斜杠命令 · 纯文本注入，不引入外部进程")}
        </span>
        <button type="button" className="btn primary" style={{ marginLeft: "auto" }} onClick={() => actions.openModal("skill")}>
          <Icon name="plus" size="sm" />
          {t("新建 Skill")}
        </button>
      </div>
      <div className="lead" style={{ marginTop: 8 }}>
        {t("输入")}
        <code className="mono">/</code> {t("即触发补全；改动后需")}
        <code className="mono">/reload</code> {t("生效")}
      </div>

      <div className="sgroup">
        <div className="gh">
          <Icon name="slash" size="sm" />
          {t("已加载（{length}）", { length: rows.length })}
          <span className="act">
            <button type="button" className="btn xs" onClick={() => actions.openScene("reload")}>
              <Icon name="refresh" size="sm" />
              {t("重载")}
            </button>
          </span>
        </div>
        {rows.map(s => (
          <div className={`srow${s.enabled ? "" : " disabled"}`} key={s.command}>
            <div className="l">
              <div className="n">
                <span className="mono">{s.command}</span> {s.name}{" "}
                {s.scope === "global" ? <Badge tone="brand">global</Badge> : <Badge tone="ok">project</Badge>}
              </div>
              <div className="d">
                {s.description} · <span className="mono">{s.path}</span> {t("· 模型 {model}", { model: s.model })}
                {s.variant !== "默认" ? ` · ${s.variant}` : ""}
              </div>
            </div>
            <div className="c">
              <Switch on={s.enabled} onChange={v => toggle(s.command, v)} label={t("启用 {command}", { command: s.command })} />
              <button type="button" className="btn sm" onClick={() => actions.openModal("skill", { c: s.command })}>
                <Icon name="pencil" size="sm" />
                {t("编辑")}
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  actions.openScene("chat-stream");
                  client.sendUserMessage(`${s.command} `);
                }}>
                <Icon name="play" size="sm" />
                {t("运行")}
              </button>
              <button
                type="button"
                className="btn sm danger"
                onClick={() =>
                  actions.askConfirm({
                    title: t("删除 {command}？", { command: s.command }),
                    danger: true,
                    ok: t("删除"),
                    done: t("已删除源文件引用"),
                    body: t("仅移除记录；磁盘上的 .md 文件保留，可自行归档。"),
                  })
                }>
                <Icon name="trash" size="sm" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="sgroup">
        <div className="gh">
          <Icon name="folder" size="sm" />
          {t("扫描目录")}
        </div>
        <ScanRow scope="project" glob=".duo/commands/*.md" count={2} />
        <ScanRow scope="global" glob="~/.config/duo-desktop/skills/*.md" count={2} />
        <div className="srow">
          <div className="l">
            <div className="n">{t("discovered 但跳过")}</div>
            <div className="d">{t("1 项：frontmatter 缺少 description")}</div>
          </div>
          <div className="c">
            <button
              type="button"
              className="btn sm"
              onClick={() => toast(t("展开明细：no-description.md 需要 frontmatter.description"))}>
              <Icon name="eye" size="sm" />
              {t("查看")}
            </button>
          </div>
        </div>
      </div>

      <div className="notice info spec">
        <Icon name="info" size="sm" />
        <div>
          {t("Skill 支持")}
          <code className="mono">{t("{{参数|默认值}}")}</code> {t("占位与模型/变体覆盖；不做市场与远程拉取（本地优先）。")}
        </div>
      </div>
    </div>
  );
}

function ScanRow({ scope, glob, count }: { scope: string; glob: string; count: number }): JSX.Element {
  return (
    <div className="srow">
      <div className="l">
        <div className="n">{scope}</div>
        <div className="d mono">{glob}</div>
      </div>
      <div className="c">
        <Badge tone="gray">
          {count} {t("项")}
        </Badge>
        <button type="button" className="btn sm" onClick={() => toast(t("在编辑器打开"))}>
          <Icon name="external" size="sm" />
        </button>
      </div>
    </div>
  );
}
