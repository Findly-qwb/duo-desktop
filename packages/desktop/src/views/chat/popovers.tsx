/**
 * 输入区浮层：斜杠命令 / @ 提及 / 模式 / 权限速览 / 推理变体 / 模型选择
 * DOM 对应原型 popWrap / popSlash / popMention / popMode / popShield / popModel / modelPreview。
 */
import { useMemo, useState } from "react";
import { t } from "../../i18n";
import { Badge, Icon, type IconName } from "@duo/ui";
import { MENTIONS, MODELS, MODES, SLASH, VARIANTS, VARIANT_DESC, type ModelInfo } from "../../data/fixtures";
import { modelsToGroups, useProviders } from "../../ipc/providers";
import { useEffect } from "react";
import { actions, toast, useApp } from "../../state/app";

export function Popover({ kind = "pop", children }: { kind?: "pop" | "shieldpop"; children: React.ReactNode }): JSX.Element {
  return (
    <div className={`${kind} show`} role="dialog" aria-modal="false">
      {children}
    </div>
  );
}

interface PopEntry {
  header?: string;
  cmd?: string;
  desc?: string;
  icon?: string;
  scope?: string;
}

function PopList({
  items,
  onPick,
  narrowCmd,
}: {
  items: PopEntry[];
  onPick: (cmd: string) => void;
  narrowCmd?: boolean;
}): JSX.Element {
  const [hl, setHl] = useState(0);
  const flat = items.filter(i => !i.header);
  return (
    <>
      {items.map((x, i) =>
        x.header ? (
          <div className="pop-head" key={`h-${i}`}>
            {x.header}
          </div>
        ) : (
          <div
            key={x.cmd}
            className={`pm-item${flat.findIndex(f => f.cmd === x.cmd) === hl ? " hl" : ""}`}
            role="option"
            tabIndex={0}
            onMouseEnter={() => setHl(flat.findIndex(f => f.cmd === x.cmd))}
            onClick={() => onPick(x.cmd ?? "")}
            onKeyDown={e => e.key === "Enter" && onPick(x.cmd ?? "")}>
            {x.icon ? <Icon name={x.icon as IconName} size="sm" /> : null}
            <span
              className="cmd"
              style={
                narrowCmd && (x.cmd ?? "").length > 22 ? { minWidth: 0, fontWeight: 400, color: "var(--text-base)" } : undefined
              }>
              {x.cmd}
            </span>
            <span className="desc">{x.desc}</span>
            {x.scope ? <span className="g">{x.scope}</span> : null}
          </div>
        ),
      )}
    </>
  );
}

export function SlashPop({ onPick }: { onPick: (cmd: string) => void }): JSX.Element {
  return <PopList items={SLASH} onPick={onPick} />;
}

export function MentionPop({ onPick }: { onPick: (cmd: string) => void }): JSX.Element {
  return <PopList items={MENTIONS} onPick={onPick} narrowCmd />;
}

export function ModePop(): JSX.Element {
  const app = useApp();
  return (
    <>
      <div className="pop-head">{t("交互模式")}</div>
      {MODES.map(m => (
        <div
          key={m.id}
          className={`pm-item${app.mode === m.id ? " hl" : ""}`}
          role="option"
          tabIndex={0}
          onClick={() => {
            actions.setMode(m.id);
            toast(t("{x} 模式已启用", { x: m.id }));
          }}
          onKeyDown={e => e.key === "Enter" && actions.setMode(m.id)}>
          <Icon name={m.icon as IconName} size="sm" />
          <span className="cmd" style={{ minWidth: 64 }}>
            {m.id}
          </span>
          <span className="desc">{m.desc}</span>
          {app.mode === m.id ? <Badge tone="brand">{t("当前")}</Badge> : null}
        </div>
      ))}
      <div className="pop-head">{t("已废弃")}</div>
      <div className="pm-item" style={{ opacity: 0.5 }}>
        <Icon name="bot" size="sm" />
        <span className="cmd" style={{ minWidth: 64 }}>
          Architect
        </span>
        <span className="desc">{t("已由 Plan 替代")}</span>
        <Badge tone="warn">deprecated</Badge>
      </div>
    </>
  );
}

const SHIELD_ROWS: [string, "allow" | "ask" | "deny"][] = [
  [t("读文件 / Glob / Grep / List"), "allow"],
  [t("编辑文件"), "ask"],
  [t("Bash 命令"), "ask"],
  [t("工作区外目录"), "ask"],
  ["WebSearch / WebFetch", "allow"],
  [t("子代理 Task / Skill"), "allow"],
  [t("Doom Loop 检测"), "ask"],
];
const LVL_TEXT: Record<string, string> = { allow: "auto", ask: t("询问"), deny: t("拒绝") };

export function ShieldPop(): JSX.Element {
  return (
    <>
      {SHIELD_ROWS.map(([label, lvl]) => (
        <div className="sh-row" key={label}>
          <span className="lbl">{label}</span>
          <span className={`lvl ${lvl}`}>{LVL_TEXT[lvl]}</span>
          {lvl === "ask" ? (
            <button type="button" className="btn xs" onClick={() => toast(t("已为 bun test * 建立例外规则"))}>
              {t("例外 +")}
            </button>
          ) : null}
        </div>
      ))}
      <div className="sh-foot">
        <span>
          {t("花费熔断（估算）")}
          <b>$5.00</b>
        </span>
        <button type="button" className="btn sm" onClick={() => actions.setSettingsTab("approve")}>
          {t("全部规则 →")}
        </button>
      </div>
    </>
  );
}

export function VariantPop(): JSX.Element {
  const app = useApp();
  return (
    <>
      <div className="pop-head">{t("推理强度变体 · claude-sonnet-4.5")}</div>
      {VARIANTS.map((v, i) => (
        <div
          key={v}
          className={`pm-item${app.variant === v ? " hl" : ""}`}
          role="option"
          tabIndex={0}
          onClick={() => {
            actions.setVariant(v);
            toast(t("推理强度：{v}", { v: v }));
          }}>
          <Icon name="variant" size="sm" />
          <span className="cmd" style={{ minWidth: 64 }}>
            {v}
          </span>
          <span className="desc">{VARIANT_DESC[i]}</span>
          {i > 2 ? <Badge tone="warn">{t("成本 ↑")}</Badge> : null}
        </div>
      ))}
      <div className="sh-foot">
        <span>{t("模型无 variants 时该选择器自动隐藏")}</span>
        <span className="kbd">⇧Tab</span>
      </div>
    </>
  );
}

export function ModelPop(): JSX.Element {
  const app = useApp();
  // 模型列表 = provider_list（宿主 SQLite / mock 同源）；首帧未到先用 fixtures 形状
  const providers = useProviders();
  const modelGroups = useMemo(() => (providers ? modelsToGroups(providers) : MODELS), [providers]);
  const [query, setQuery] = useState("");
  const groups = useMemo(
    () =>
      modelGroups
        .map(g => ({
          ...g,
          items: g.items.filter(m => !query || `${m.name}${m.provider}${m.desc}`.toLowerCase().includes(query.toLowerCase())),
        }))
        .filter(g => g.items.length),
    [query, modelGroups],
  );
  const [preview, setPreview] = useState<ModelInfo>(modelGroups[0]?.items[0] ?? MODELS[0].items[0]);
  const [stars, setStars] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MODELS.flatMap(g => g.items.map(m => [m.id, !!m.starred]))),
  );
  useEffect(() => {
    const first = modelGroups[0]?.items[0];
    if (first && !modelGroups.some(g => g.items.some(m => m.id === preview.id)) && first.id !== preview.id) setPreview(first);
  }, [modelGroups, preview.id]);

  return (
    <div className="modelpop show" role="dialog" aria-label={t("选择模型")}>
      <div className="mp-left">
        <div className="mp-strip">
          <div className="segbar" style={{ margin: 0 }}>
            {MODES.map(m => (
              <button
                key={m.id}
                type="button"
                className={`seg${app.mode === m.id ? " active" : ""}`}
                onClick={() => {
                  actions.setMode(m.id);
                  toast(t("{x} 模式已启用", { x: m.id }));
                }}>
                <Icon name={m.icon as IconName} size="sm" />
                {m.id}
              </button>
            ))}
          </div>
          <span className="vchips">
            {VARIANTS.map(v => (
              <button
                key={v}
                type="button"
                className={`subtab${app.variant === v ? " active" : ""}`}
                onClick={() => {
                  actions.setVariant(v);
                  toast(t("推理强度：{v}", { v: v }));
                }}>
                {v}
              </button>
            ))}
          </span>
          <span className="kbd" style={{ marginLeft: "auto" }}>
            ⇧Tab
          </span>
        </div>
        <div className="mp-search">
          <Icon name="search" />
          <input
            placeholder={t("搜索模型、能力、供应商…")}
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label={t("搜索模型")}
          />
        </div>
        <div className="mp-list">
          {groups.map(g => (
            <div key={g.group}>
              <div className="mp-group">
                {g.group === "收藏" ? <Icon name="star" size="sm" /> : null}
                {g.group}
              </div>
              {g.items.map(m => (
                <div
                  key={m.id}
                  className={`mp-row${app.model === m.id ? " sel" : ""}`}
                  role="option"
                  tabIndex={0}
                  aria-selected={app.model === m.id}
                  onMouseEnter={() => setPreview(m)}
                  onClick={() => {
                    actions.setModel(m.id);
                    toast(t("已切换模型：{x}（按会话记忆选择）", { x: m.name }));
                  }}>
                  <span className="mono" style={{ color: "var(--text-weaker)", fontSize: "var(--fs-11)" }}>
                    {m.provider[0]}
                  </span>
                  <span>{m.name}</span>
                  <span className="tags">
                    {m.free ? (
                      <span className="free">{t("免费")}</span>
                    ) : (
                      <span className="price">
                        {m.inputPrice}/{m.outputPrice}
                      </span>
                    )}
                    {m.reasoning ? <Badge tone="purple">{t("推理")}</Badge> : null}
                    {m.vision ? <Badge tone="brand">{t("视觉")}</Badge> : null}
                    <span
                      className={`star${stars[m.id] ? " on" : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-label={stars[m.id] ? t("取消收藏") : t("收藏")}
                      onClick={e => {
                        e.stopPropagation();
                        setStars(s => ({ ...s, [m.id]: !s[m.id] }));
                        toast(stars[m.id] ? t("已取消收藏") : t("已收藏"));
                      }}>
                      <Icon name="star" size="sm" />
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="mp-right">
        <ModelPreview model={preview} starred={!!stars[preview.id]} />
      </div>
    </div>
  );
}

export function ModelPreview({ model, starred }: { model: ModelInfo; starred?: boolean }): JSX.Element {
  return (
    <>
      <h4>
        {model.name}
        <span className={`star${starred ? " on" : ""}`}>
          <Icon name="star" size="sm" />
        </span>
      </h4>
      <div className="prov">{model.provider}</div>
      <div className="pr">
        <span>{t("输入")}</span>
        <b>{model.inputPrice}</b>
      </div>
      <div className="pr">
        <span>{t("输出")}</span>
        <b>{model.outputPrice}</b>
      </div>
      <div className="pr">
        <span>{t("缓存读")}</span>
        <b>{model.inputPrice === "$3" ? ".30" : "—"}</b>
      </div>
      <div className="pr">
        <span>{t("缓存写")}</span>
        <b>{model.inputPrice === "$3" ? "3.75" : "—"}</b>
      </div>
      <div className="kv">
        <span>{t("上下文")}</span>
        <b>{model.context}</b>
      </div>
      <div className="kv">
        <span>Terminal Bench</span>
        <b>{model.bench ?? "—"}</b>
      </div>
      <div className="cap">
        {model.reasoning ? <Badge tone="purple">reasoning</Badge> : null}
        {model.vision ? <Badge tone="brand">vision</Badge> : null}
        <Badge tone="ok">tool call</Badge>
        {model.free ? <Badge tone="ok">{t("免费")}</Badge> : null}
      </div>
      <div className="desc">{model.desc}</div>
      <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            actions.setModel(model.id);
            toast(t("已设为默认模型"));
          }}>
          {t("设为默认")}
        </button>
        <button type="button" className="btn sm" onClick={() => toast(t("查看供应商页"))}>
          <Icon name="external" size="sm" />
          {t("详情")}
        </button>
      </div>
    </>
  );
}
