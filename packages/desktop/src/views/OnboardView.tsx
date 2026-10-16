/** 首启 · 配置端点（PLAN §1：无账号、无登录、本地优先） */
import { useState } from "react";
import { t, useLocale, setLocale } from "../i18n";
import { Icon, type IconName } from "@duo/ui";
import { ENDPOINTS, PROJECTS } from "../data/fixtures";
import { SKINS } from "@duo/ui";
import { actions, toast, useApp } from "../state/app";

export function OnboardView(): JSX.Element {
  const app = useApp();
  const lang = useLocale();
  const [defaultMode, setDefaultMode] = useState("Ask");

  return (
    <div className="page" style={{ display: "grid", placeItems: "center" }}>
      <div style={{ width: "min(600px,100%)" }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <img
            src="/logo.png"
            alt=""
            style={{
              width: 84,
              height: 84,
              objectFit: "contain",
              mixBlendMode: "screen" as never,
              filter: "drop-shadow(0 12px 30px var(--surface-brand-weak))",
            }}
          />
          <h2 style={{ fontSize: "var(--fs-22)", margin: "10px 0 4px", color: "var(--text-strong)" }}>{t("配置你的模型端点")}</h2>
          <p style={{ color: "var(--text-weak)", fontSize: "var(--fs-13)" }}>
            {t("无账号、无登录。填一个 OpenAI 兼容端点即可开始，也可以完全离线跑本地模型。")}
          </p>
        </div>

        <div className="pcard">
          <h4>
            <Icon name="key" size="md" />
            {t("常用端点")}
          </h4>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ENDPOINTS.map(e => (
              <button key={e.name} type="button" className="btn sm" onClick={() => actions.openModal("endpoint", { n: e.name })}>
                <Icon name="cpu" size="sm" />
                {e.name}
              </button>
            ))}
            <button type="button" className="btn sm primary" onClick={() => actions.openModal("endpoint")}>
              <Icon name="plus" size="sm" />
              {t("自定义")}
            </button>
          </div>
          <div className="hint" style={{ fontSize: "var(--fs-11)", color: "var(--text-weaker)", marginTop: 9 }}>
            {t("本地示例：")}
            <code className="mono">http://localhost:11434/v1</code>
            {t("（Ollama）· 密钥可留空")}
          </div>
        </div>

        <div className="pcard">
          <h4>
            <Icon name="palette" size="md" />
            {t("外观与语言")}
          </h4>
          <Row name={t("皮肤")} desc={t("三套内置 · 可扩展 skin.json")}>
            <select className="sel" value={app.skin} onChange={e => actions.setSkin(e.target.value)} aria-label={t("皮肤")}>
              {SKINS.map(s => (
                <option key={s.id} value={s.id}>
                  {t(s.name)}
                </option>
              ))}
            </select>
          </Row>
          <Row name={t("界面语言")}>
            <select
              className="sel"
              value={lang}
              onChange={e => setLocale(e.target.value as "zh" | "en")}
              aria-label={t("界面语言")}>
              <option value="zh">{t("简体中文")}</option>
              <option value="en">English（en）</option>
            </select>
          </Row>
          <Row name={t("默认模式")} desc={t("Ask 最安全；Code 需要审批写操作")}>
            <select className="sel" value={defaultMode} onChange={e => setDefaultMode(e.target.value)} aria-label={t("默认模式")}>
              <option>Ask</option>
              <option>Plan</option>
              <option>Code</option>
            </select>
          </Row>
        </div>

        <div className="pcard">
          <h4>
            <Icon name="folder" size="md" />
            {t("选择工作空间")}
          </h4>
          <Row name={t("最近")} desc={PROJECTS.map(p => p.name).join(" · ")}>
            <button type="button" className="btn sm" onClick={() => actions.openModal("projectnew")}>
              <Icon name="folder-open" size="sm" />
              {t("打开")}
            </button>
          </Row>
          <Row name={t("导入既有本地数据")} desc={t("从其他客户端迁移会话/规则（只读源目录）")}>
            <button type="button" className="btn sm" onClick={() => toast(t("扫描本地数据目录…"))}>
              <Icon name="truck" size="sm" />
              {t("导入")}
            </button>
          </Row>
        </div>

        <div style={{ textAlign: "center" }}>
          <button
            type="button"
            className="btn primary"
            style={{ padding: "9px 22px" }}
            onClick={() => {
              actions.setMode(defaultMode as "Ask" | "Plan" | "Code");
              actions.openScene("welcome");
              toast(t("端点已连接 · 12 个模型可用"));
            }}>
            <Icon name="check" size="sm" />
            {t("开始使用")}
          </button>
          <div style={{ fontSize: "var(--fs-11)", color: "var(--text-weaker)", marginTop: 9 }}>
            {t("数据全部留在本机 · 无遥测上报 · 日志脱敏")}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ name, desc, children }: { name: string; desc?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="srow" style={{ padding: "11px 0" }}>
      <div className="l">
        <div className="n">{name}</div>
        {desc ? <div className="d">{desc}</div> : null}
      </div>
      <div className="c">{children}</div>
    </div>
  );
}

export type { IconName };
