/**
 * 弹窗宿主（原型 MODALS 的等价实现）：皮肤管理 / Runtime 诊断 / 用量估算 / 端点 / MCP / Skill /
 * 花费熔断 / 权限例外 / 快捷键 / 工作空间 / panic 恢复 / 通用确认
 */
import { useMemo, useState } from "react";
import { st } from "../i18n";
import { Badge, Icon, Switch, type IconName } from "@duo/ui";
import { MCPS, SKILLS, ST } from "../data/fixtures";
import { refreshProviders, useProviders } from "../ipc/providers";
import { actions, toast, useApp, type ConfirmSpec, type ModalName } from "../state/app";
import { auditContrast, SKINS } from "@duo/ui";
import { contrastLabel } from "../lib/contrast";
import { client } from "../ipc/client";

export function ModalHost(): JSX.Element | null {
  const app = useApp();
  if (!app.modal && !app.confirm) return null;
  return (
    <div
      className={`scrim${app.modal || app.confirm ? " show" : ""}`}
      onClick={e => {
        if (e.target !== e.currentTarget) return;
        actions.closeModal();
        actions.closeConfirm();
      }}>
      <div id="modalHost" style={{ display: "contents" }}>
        {app.confirm ? (
          <ConfirmDialog spec={app.confirm} />
        ) : app.modal ? (
          <Modal name={app.modal.name} arg={app.modal.arg} />
        ) : null}
      </div>
    </div>
  );
}

function ConfirmDialog({ spec }: { spec: ConfirmSpec }): JSX.Element {
  return (
    <div className="modal show" role="dialog" aria-modal="true" aria-label={spec.title}>
      <div className="mhead">
        <Icon name="alert" size="md" />
        <h3>{spec.title}</h3>
        <button type="button" className="iconbtn x" aria-label={st("关闭")} onClick={actions.closeConfirm}>
          <Icon name="x" />
        </button>
      </div>
      <div className="mbody">
        <div style={{ fontSize: "var(--fs-13)", lineHeight: 1.65, color: "var(--text-weak)" }}>{spec.body}</div>
        {spec.extra ? (
          <div
            className="mono"
            style={{ fontSize: "var(--fs-11)", color: "var(--text-weaker)", marginTop: 8, whiteSpace: "pre-wrap" }}>
            {spec.extra}
          </div>
        ) : null}
      </div>
      <div className="mfoot">
        <span className="push">{spec.note}</span>
        <button type="button" className="btn" onClick={actions.closeConfirm}>
          {spec.cancel ?? st("取消")}
        </button>
        <button
          type="button"
          className={`btn ${spec.danger ? "danger" : "primary"}`}
          onClick={() => {
            spec.after?.();
            toast(spec.done ?? st("已完成"), spec.danger ? "warn" : "ok");
            actions.closeConfirm();
          }}>
          {spec.ok ?? st("确认")}
        </button>
      </div>
    </div>
  );
}

function Modal({ name, arg }: { name: ModalName; arg?: Record<string, unknown> }): JSX.Element | null {
  switch (name) {
    case "skin":
      return <SkinModal />;
    case "runtime":
      return <RuntimeModal />;
    case "usage":
      return <UsageModal />;
    case "endpoint":
      return <EndpointModal arg={arg} />;
    case "mcp":
      return <McpModal arg={arg} />;
    case "skill":
      return <SkillModal arg={arg} />;
    case "cost":
      return <CostModal />;
    case "permrules":
      return <PermRulesModal arg={arg} />;
    case "shortcuts":
      return <ShortcutsModal />;
    case "projectnew":
      return <ProjectModal />;
    case "panic":
      return <PanicModal />;
    default:
      return null;
  }
}

/* ---------------- Shell ---------------- */

function Shell({
  icon,
  title,
  sub,
  wide,
  children,
  foot,
}: {
  icon: IconName;
  title: string;
  sub?: string;
  wide?: boolean;
  children: React.ReactNode;
  foot: React.ReactNode;
}): JSX.Element {
  return (
    <div className={`modal show${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="mhead">
        <Icon name={icon} size="md" />
        <h3>{title}</h3>
        {sub ? <span className="sub">{sub}</span> : null}
        <button type="button" className="iconbtn x" aria-label={st("关闭")} onClick={actions.closeModal}>
          <Icon name="x" />
        </button>
      </div>
      <div className="mbody">{children}</div>
      <div className="mfoot">{foot}</div>
    </div>
  );
}

/* ---------------- 皮肤管理 ---------------- */

const SKIN_SWATCH: Record<string, { bg: string; accent: string; fg: string; desc: string }> = {
  "graphite-dark": { bg: "#0c0f14", accent: "#4c6ef5", fg: "#eaf0f9", desc: st("深色 IDE · 蓝墨偏移 · 代码优先") },
  "paper-light": { bg: "#fafafa", accent: "#3b82f6", fg: "#171717", desc: st("极简灰度 + 少量蓝强调（默认浅色）") },
  "nocturne-amber": { bg: "#12100d", accent: "#c9832b", fg: "#f5ead8", desc: st("低光暖色 · 验证强调色可替换") },
};

function SkinModal(): JSX.Element {
  const app = useApp();
  const [follow, setFollow] = useState(app.followSystem);
  const [guard, setGuard] = useState(true);
  const [syntaxFollow, setSyntaxFollow] = useState(true);
  const [density, setDensity] = useState(st("标准"));

  // 对比度守护：读取当前皮肤的真实计算值，而不是写死结论
  const report = useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    return auditContrast(t => cs.getPropertyValue(t).trim());
  }, []);

  return (
    <Shell
      icon="palette"
      title={st("皮肤与主题")}
      sub={st("skin bundle · 可扩展")}
      wide
      foot={<span className="push">{st("皮肤改动写入 ui_state（不污染会话库）")}</span>}>
      <div className="notice info spec">
        <Icon name="info" size="sm" />
        <div>
          {st("皮肤只改 L1/L2 令牌，组件层不得出现硬编码色；切换即时生效，不重启 WebView。默认跟随系统{x}", { x: " " })}
          <code className="mono">prefers-color-scheme</code>。
        </div>
      </div>

      <div className="grid2" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(230px,1fr))" }}>
        {SKINS.map(s => {
          const sw = SKIN_SWATCH[s.id];
          return (
            <div
              key={s.id}
              className="modcard"
              style={{ padding: 0, overflow: "hidden", display: "block" }}
              onClick={() => applyWithGuard(s.id, guard, report)}>
              <div style={{ height: 56, background: sw.bg, position: "relative", padding: 8 }}>
                <div style={{ height: 6, width: "60%", borderRadius: 3, background: sw.accent, opacity: 0.9 }} />
                <div style={{ height: 6, width: "40%", borderRadius: 3, background: sw.fg, opacity: 0.5, marginTop: 6 }} />
                <span
                  style={{
                    position: "absolute",
                    right: 8,
                    bottom: 8,
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    background: sw.accent,
                  }}
                />
              </div>
              <div style={{ padding: 11 }}>
                <h4>
                  {st(s.name)} {app.skin === s.id ? <Badge tone="ok">{st("当前")}</Badge> : null}
                </h4>
                <p style={{ fontSize: "var(--fs-11)", color: "var(--text-weak)", marginTop: 2 }}>{st(sw.desc)}</p>
                <div className="mono" style={{ fontSize: "var(--fs-10)", color: "var(--text-weaker)", marginTop: 6 }}>
                  {s.id} {st("· 对比度{x}", { x: " " })}
                  {report.checked.map(c => `${c.ratio.toFixed(1)}:${c.min.toFixed(1)}${c.ok ? " ✓" : " ⚠"}`).join(" / ")}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="sgroup" style={{ marginTop: 14 }}>
        <div className="gh">
          <Icon name="upload" size="sm" />
          {st("导入 / 编辑皮肤")}
        </div>
        <Row name={st("从 skin.json 导入")} desc={st("~/.config/duo-desktop/skins/<id>/skin.json · 支持 extends 继承")}>
          <button type="button" className="btn sm" onClick={() => toast(st("选择文件（Tauri dialog）"))}>
            <Icon name="folder-open" size="sm" />
            {st("选择")}
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              const missing = ["--text-strong", "--surface-raised-base", "--diff-add-bg"];
              toast(st("已校验：缺 {length} 个必需令牌 → 已用父皮肤补全并警告", { length: missing.length }), "warn");
            }}>
            {st("校验")}
          </button>
        </Row>
        <Row name={st("当前皮肤导出")} desc={st("把覆盖过的令牌导出为 bundle，便于分享")}>
          <button type="button" className="btn sm" onClick={() => toast(st("已导出 skins/current/skin.json"))}>
            <Icon name="download" size="sm" />
            {st("导出")}
          </button>
        </Row>
        <Row name={st("对比度守护")} desc={st("正文 ≥4.5:1、次要 ≥3:1；不达标时阻止保存并提供自动提亮")}>
          <Switch on={guard} onChange={setGuard} label={st("对比度守护")} />
        </Row>
        <Row name={st("语法高亮跟随皮肤")} desc={st("双主题注入 --tk-*")}>
          <Switch on={syntaxFollow} onChange={setSyntaxFollow} label={st("语法高亮跟随皮肤")} />
        </Row>
      </div>

      <div className="sgroup">
        <div className="gh">
          <Icon name="eye" size="sm" />
          {st("实时调节")}
        </div>
        <Row name={st("字号")} desc={st("10–24px，影响所有 --fs-* 令牌")}>
          <input
            type="range"
            className="rng"
            min={10}
            max={24}
            value={app.fscale}
            onChange={e => actions.setScale(Number(e.target.value))}
            aria-label={st("字号")}
          />
          <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-weak)" }}>
            {app.fscale}px
          </span>
        </Row>
        <Row name={st("界面密度")}>
          <select className="sel" value={density} onChange={e => setDensity(e.target.value)} aria-label={st("界面密度")}>
            <option>{st("标准")}</option>
            <option>{st("紧凑")}</option>
          </select>
        </Row>
        <Row name={st("跟随系统主题")} desc={st("关闭后固定使用所选皮肤")}>
          <Switch on={follow} onChange={setFollow} label={st("跟随系统主题")} />
        </Row>
      </div>
    </Shell>
  );
}

/** 守护开启时，对比度不达标的皮肤切换后给出警告与修复动作（不阻止预览） */
function applyWithGuard(id: string, guard: boolean, report: ReturnType<typeof auditContrast>): void {
  actions.setSkin(id);
  if (guard && report.issues.length) {
    toast(
      st("对比度不达标：{x}", {
        x: report.issues.map(i => `${contrastLabel(i.id)} ${i.ratio.toFixed(2)} < ${i.min}`).join(" / "),
      }),
      "warn",
    );
    actions.openModal("skin", { autoBrighten: 1 });
  } else {
    const name = SKINS.find(s => s.id === id)?.name ?? id;
    toast(st("皮肤：{x} · 对比度全部通过 ✓", { x: name }));
  }
}

function Row({ name, desc, children }: { name: string; desc?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="srow">
      <div className="l">
        <div className="n">{name}</div>
        {desc ? <div className="d">{desc}</div> : null}
      </div>
      <div className="c">{children}</div>
    </div>
  );
}

/* ---------------- Runtime 诊断 ---------------- */

function RuntimeModal(): JSX.Element {
  const rt = client.snapshot();
  return (
    <Shell
      icon="cpu"
      title={st("Agent Runtime 诊断")}
      sub={st("同进程 · 无侧车 · 无端口 · {transportKind}", { transportKind: client.transportKind })}
      foot={
        <>
          <span className="push">{st("日志已脱敏（key / 路径打码）· 无遥测上报")}</span>
          <button type="button" className="btn" onClick={() => toast(st("已打开日志目录"))}>
            <Icon name="folder-open" size="sm" />
            {st("日志")}
          </button>
          <button type="button" className="btn" onClick={() => toast(st("已导出诊断包（db schema + 事件计数）"))}>
            <Icon name="download" size="sm" />
            {st("诊断包")}
          </button>
          <button type="button" className="btn primary" onClick={() => toast(st("运行时已软重启，会话保留"))}>
            <Icon name="refresh" size="sm" />
            {st("重启 runtime")}
          </button>
        </>
      }>
      <div className="notice ok">
        <Icon name="check" size="sm" />
        <div>
          <b>{st("运行正常")}</b> {st("· Tokio 多线程 runtime · 主进程 pid 48120 · 内存 62 MB")}
        </div>
      </div>
      <table className="usage-table" style={{ margin: 0 }}>
        <tbody>
          <Tr k={st("版本")} v={`duo-desktop ${rt.runtimeInfo?.app ?? "0.1.0"} · rust 1.94`} />
          <Tr k={st("通信")} v="Tauri IPC（event + command）" />
          <Tr k={st("数据库")} v="~/.local/share/duo-desktop/duo-desktop.db · WAL" />
          <Tr k="schema_version" v={st("{x7}（迁移已应用）", { x7: rt.runtimeInfo?.schema ?? 7 })} />
          <Tr k={st("活动任务")} v={rt.busy ? st("1 Turn 运行中 · 2 后台作业") : st("空闲 · 2 后台作业")} />
          <Tr k={st("子进程")} v={st("3（MCP×2 · shell×1）· 退出即回收")} />
          <Tr k={st("文件扫描")} v={st("{files} 个 · .gitignore 生效 · 上限 50,000", { files: ST.files })} />
          <Tr k={st("MCP 连接")} v={st("{x} 已连接 · 1 需鉴权 · 1 退避重试", { x: ST.mcp.join("/") })} />
          <Tr k={st("git 后端")} v={st("系统 git（CLI）· libgit2 未编译")} />
          <Tr k={st("checkpoint 仓库")} v="~/.local/share/duo-desktop/ckpt/9f2c…" />
          <Tr k={st("崩溃隔离")} v={st("catch_unwind · 任务级失败不崩窗")} />
          <Tr
            k={st("事件计数")}
            v={st("{x0} 条 · 乱序丢弃 {dropped} · resync {resyncRequests}", {
              x0: client.mock?.stats.events ?? 0,
              dropped: rt.dropped,
              resyncRequests: rt.resyncRequests,
            })}
          />
        </tbody>
      </table>
      <div className="sgroup" style={{ marginTop: 12 }}>
        <div className="gh">
          <Icon name="history" size="sm" />
          {st("最近事件")}
        </div>
        <Row name={st("09:41:22 harness task panicked · 已隔离")} desc={st("仅终止该 Turn；可从检查点 a10c4f7 回滚后重试")}>
          <Badge tone="ok">{st("已恢复")}</Badge>
        </Row>
        <Row name={st("09:40:10 mcp:linear 连接失败 · 退避重试 2/5")} desc="stderr: ModuleNotFoundError">
          <Badge tone="err">{st("异常")}</Badge>
        </Row>
      </div>
    </Shell>
  );
}
function Tr({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <tr>
      <td>{k}</td>
      <td>{v}</td>
    </tr>
  );
}

/* ---------------- 用量与费用（估算） ---------------- */

function UsageModal(): JSX.Element {
  const rt = client.snapshot();
  const ctx = rt.context;
  const usedPct = ctx ? ((ctx.used / ctx.window) * 100).toFixed(0) : "34";
  return (
    <Shell
      icon="activity"
      title={st("用量与费用")}
      sub={st("估算值")}
      foot={
        <>
          <button type="button" className="btn" onClick={actions.closeModal}>
            {st("关闭")}
          </button>
          <button type="button" className="btn" onClick={() => actions.openModal("cost")}>
            {st("熔断策略")}
          </button>
        </>
      }>
      <div className="notice warn">
        <Icon name="alert" size="sm" />
        <div>
          {st("本地按字符/近似 tokenizer 统计，")}
          <b>{st("仅为估算，非实际账单")}</b>
          {st("；与服务商计数可能有 5–15% 偏差。")}
        </div>
      </div>
      <div className="ucard">
        <h5>
          <Icon name="card" size="sm" />
          {st("本会话")}
        </h5>
        <div className="big">
          $0.0421 <span style={{ fontSize: "var(--fs-12)", color: "var(--text-weaker)" }}>{st("估算")}</span>
        </div>
        <div className="sub">{st("6 turns · 1m 42s · 上限 $5.00（估算）")}</div>
        <div className="meter">
          <i style={{ width: "0.84%" }} />
        </div>
      </div>
      <div className="ucard">
        <h5>
          <Icon name="archive" size="sm" />
          {st("上下文")}
        </h5>
        <div className="ctxprog" style={{ margin: "0 0 6px" }}>
          <i style={{ width: `${usedPct}%` }} />
          <i style={{ width: "12%" }} />
          <i style={{ width: `${100 - Number(usedPct) - 12}%` }} />
        </div>
        <div
          style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-11)", color: "var(--text-weaker)" }}
          className="mono">
          <span>{st("已用 {x1}K", { x1: ((ctx?.used ?? 68200) / 1000).toFixed(1) })}</span>
          <span>{st("预留 {x1}K", { x1: ((ctx?.reserved ?? 24000) / 1000).toFixed(1) })}</span>
          <span>{st("窗口 {x0}K", { x0: ((ctx?.window ?? 200000) / 1000).toFixed(0) })}</span>
        </div>
        <div className="sub" style={{ marginTop: 8 }}>
          {st("自动压缩阈值 {x92}% · 上次压缩 09:38", { x92: ctx?.autoCompactAt ?? 92 })}
        </div>
        <button
          type="button"
          className="btn sm"
          style={{ width: "100%", marginTop: 8 }}
          onClick={() => {
            client.compact();
            actions.closeModal();
            actions.openScene("compact");
          }}>
          <Icon name="archive" size="sm" />
          {st("立即压缩")}
        </button>
      </div>
      <div className="ucard">
        <h5>
          <Icon name="list" size="sm" />
          {st("Token 细分")}
        </h5>
        <table className="usage-table" style={{ margin: 0 }}>
          <thead>
            <tr>
              <th>{st("模型")}</th>
              <th>{st("输入")}</th>
              <th>{st("缓存读")}</th>
              <th>{st("输出")}</th>
              <th>{st("推理")}</th>
              <th>{st("估算费用")}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>sonnet-4.5</td>
              <td>4.8K</td>
              <td>61.2K</td>
              <td>2.2K</td>
              <td>0.8K</td>
              <td>$0.0381</td>
            </tr>
            <tr>
              <td>gpt-5-mini</td>
              <td>1.1K</td>
              <td>—</td>
              <td>0.3K</td>
              <td>—</td>
              <td>$0.0040</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

/* ---------------- 端点 ---------------- */

function EndpointModal({ arg }: { arg?: Record<string, unknown> }): JSX.Element {
  const providers = useProviders();
  const editing = providers?.find(x => x.id === (arg?.id as string | undefined)) ?? null;
  const [name, setName] = useState(editing?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(editing?.base_url ?? "https://");
  const [keyRef, setKeyRef] = useState(editing?.key_ref ?? "");
  const [transport, setTransport] = useState("chat/completions");
  const [pull, setPull] = useState(false);
  const [pulled, setPulled] = useState<{ ids: string[]; added: number } | null>(null);
  const [keychain, setKeychain] = useState(true);
  const [streamToolDelta, setStreamToolDelta] = useState(true);
  const [timeout, setTimeoutS] = useState(120);
  const [retries, setRetries] = useState(3);
  const [busy, setBusy] = useState(false);

  // 密钥永不落明文：勾选存 keychain 时只落引用名；否则要求 {env:VAR} 形式（钥匙串接线属 T4）
  const effectiveKeyRef = keychain && name.trim() ? `keychain:${name.trim().replace(/\s+/g, "-").toLowerCase()}` : keyRef.trim();

  const save = async (): Promise<void> => {
    if (!name.trim() || !baseUrl.trim()) {
      toast(st("名称与 Base URL 必填"), "err");
      return;
    }
    if (
      effectiveKeyRef &&
      !effectiveKeyRef.startsWith("keychain:") &&
      !effectiveKeyRef.startsWith("{env:") &&
      !/^\w+$/.test(effectiveKeyRef)
    ) {
      toast(st("密钥只存引用：{env:VAR} 或勾选 keychain，绝不写明文"), "err");
      return;
    }
    setBusy(true);
    try {
      await client.invoke("provider_upsert", {
        id: editing?.id,
        name: name.trim(),
        base_url: baseUrl.trim(),
        key_ref: effectiveKeyRef || undefined,
        ...(editing ? {} : { models: [] }),
      });
      void refreshProviders();
      actions.closeModal();
      toast(st("端点已保存"), "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "err");
    } finally {
      setBusy(false);
    }
  };

  // 测试 = provider_test（GET /models + 合并落库，宿主自动保留已有条目字段）
  const testNow = async (): Promise<void> => {
    if (!editing) {
      toast(st("先保存端点再测试连接"), "err");
      return;
    }
    setBusy(true);
    try {
      const r = (await client.invoke("provider_test", { id: editing.id })) as { count: number; model_ids: string[] };
      setPulled({ ids: r.model_ids, added: Math.max(0, r.count - editing.models.length) });
      setPull(true);
      void refreshProviders();
      toast(st("GET /models 成功 · 拉到 {n} 个模型", { n: r.count }), "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "err");
    } finally {
      setBusy(false);
    }
  };

  const del = (): void => {
    if (!editing) return;
    actions.askConfirm({
      title: st("删除端点 {x}？", { x: editing.name }),
      danger: true,
      ok: st("删除"),
      done: st("已删除"),
      body: st("使用该端点模型的会话保留，但会提示重新选择模型。"),
      after: () => {
        void client.invoke("provider_delete", { id: editing.id }).then(() => {
          void refreshProviders();
          actions.closeModal();
        });
      },
    });
  };

  return (
    <Shell
      icon="key"
      title={editing ? st("编辑端点") : st("添加模型端点")}
      sub={st("OpenAI 兼容协议")}
      foot={
        <>
          <span className="push">{st("写入 providers 表 · key 仅存引用")}</span>
          <button type="button" className="btn" onClick={actions.closeModal}>
            {st("取消")}
          </button>
          {editing ? (
            <button type="button" className="btn danger" onClick={del}>
              <Icon name="trash" size="sm" />
              {st("删除")}
            </button>
          ) : null}
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
            {st("保存")}
          </button>
        </>
      }>
      <div className="grid2">
        <Field label={st("名称")} required>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="My Gateway" />
        </Field>
        <Field label="Base URL" required hint={st("需 http(s):// 前缀；本地可留空 key")}>
          <input
            className="mono"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </Field>
      </div>
      <Field label="API Key" hint={st("支持 {env:VAR}；勾选后存入系统 keychain，绝不写入日志")}>
        <input
          type="password"
          value={keychain ? "••••••••" : keyRef}
          disabled={keychain}
          onChange={e => setKeyRef(e.target.value)}
          placeholder={st("留空 = 无需密钥（本地模型）")}
        />
        <label
          style={{
            display: "flex",
            gap: 7,
            alignItems: "center",
            fontSize: "var(--fs-11)",
            color: "var(--text-weak)",
            marginTop: 7,
          }}>
          <input type="checkbox" checked={keychain} onChange={e => setKeychain(e.target.checked)} />
          {st("存进 keychain")}
        </label>
      </Field>

      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 10px" }}>
        <button type="button" className="btn sm primary" disabled={busy} onClick={() => void testNow()}>
          <Icon name="refresh" size="sm" />
          {st("拉取 /models")}
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void testNow()}>
          <Icon name="play" size="sm" />
          {st("测试连接")}
        </button>
        <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-weaker)" }}>
          {editing
            ? st("{models} 模型 · {status}", {
                models: String(editing.models.length),
                status: editing.last_check ? st("已连通") : st("未测"),
              })
            : ""}
        </span>
      </div>

      {pull && pulled ? (
        <div>
          <div className="notice info">
            <Icon name="info" size="sm" />
            <div>
              {st("拉到")}
              <b>{pulled.ids.length}</b> {st("个模型，已自动合并（已存在条目不覆盖，变体字段保留）")}
            </div>
          </div>
          {pulled.ids.map(id => (
            <label className="pullrow" key={id}>
              <input type="checkbox" defaultChecked readOnly />
              <b>{id}</b>
              <span className="m">{pulled.added > 0 && !editing?.models.some(m => m.id === id) ? st("新") : st("已存在")}</span>
            </label>
          ))}
        </div>
      ) : null}

      <div className="sgroup">
        <div className="gh">
          <Icon name="sliders" size="sm" />
          {st("协议细节（可选）")}
        </div>
        <Row name={st("流式工具调用增量")} desc={st("部分网关不回 tool_call delta，关闭后改为整包解析")}>
          <Switch on={streamToolDelta} onChange={setStreamToolDelta} label={st("流式工具调用增量")} />
        </Row>
        <Row name={st("思考链字段")} desc={st("reasoning_content / reasoning / thinking，按端点选择")}>
          <select className="sel" value={transport} onChange={e => setTransport(e.target.value)} aria-label={st("思考链字段")}>
            <option value="chat/completions">reasoning_content</option>
            <option value="messages">thinking</option>
            <option value="none">{st("不解析")}</option>
          </select>
        </Row>
        <Row name={st("请求头")}>
          <div className="addrow">
            <input className="tinp mono" style={{ width: 130 }} placeholder="X-Org" aria-label={st("请求头名")} />
            <input className="tinp mono" style={{ width: 130 }} placeholder="corp-1" aria-label={st("请求头值")} />
            <button type="button" className="btn sm" onClick={() => toast(st("请求头持久化属 T4（keychain 同批接入）"), "warn")}>
              <Icon name="plus" size="sm" />
            </button>
          </div>
        </Row>
        <Row name={st("超时 / 重试")}>
          <input
            className="tinp num"
            value={timeout}
            onChange={e => setTimeoutS(Number(e.target.value))}
            aria-label={st("超时秒")}
          />{" "}
          s
          <span className="mono" style={{ color: "var(--text-weaker)" }}>
            ·
          </span>
          <input
            className="tinp num"
            value={retries}
            onChange={e => setRetries(Number(e.target.value))}
            aria-label={st("重试次数")}
          />{" "}
          {st("次")}
        </Row>
      </div>
    </Shell>
  );
}
function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: 表单控件由 children 传入，包裹式 label 已建立关联，静态分析看不到子节点
    <label className="field">
      <span className="lbl">
        {label} {required ? <span className="req">*</span> : null}
      </span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

/* ---------------- MCP ---------------- */

function McpModal({ arg }: { arg?: Record<string, unknown> }): JSX.Element {
  const m = MCPS.find(x => x.name === (arg?.n as string)) ?? MCPS[0];
  const [transport, setTransport] = useState<string>(arg?.n ? m.transport : "http");
  return (
    <Shell
      icon="zap"
      title={
        m
          ? st(arg?.n ? st("编辑 MCP Server：{name}") : st("添加 MCP Server：{name}"), { name: m.name })
          : st(arg?.n ? st("编辑 MCP Server") : st("添加 MCP Server"))
      }
      foot={
        <>
          <span className="push">
            {st("状态：")}
            <Badge
              tone={
                m.status === "connected" ? "ok" : m.status === "failed" ? "err" : m.status === "needs_auth" ? "warn" : "gray"
              }>
              {m.status}
            </Badge>
          </span>
          <button type="button" className="btn" onClick={actions.closeModal}>
            {st("取消")}
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() =>
              actions.askConfirm({
                title: st("删除 MCP {x}？", { x: m.name }),
                danger: true,
                ok: st("删除"),
                done: st("已删除"),
                body: st("stdio 子进程随之下线；历史 part 引用保留为只读。"),
              })
            }>
            <Icon name="trash" size="sm" />
            {st("删除")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              actions.closeModal();
              toast(st("已保存 · 正在重连并发现工具"));
            }}>
            {st("保存")}
          </button>
        </>
      }>
      <Field
        label={st("传输类型")}
        hint={st("stdio 由 runtime 托管子进程生命周期：登记进程组、超时 kill、异常指数退避重启（上限 5 次）")}>
        <select
          className="sel"
          style={{ width: "100%" }}
          value={transport}
          onChange={e => setTransport(e.target.value)}
          aria-label={st("传输类型")}>
          <option value="http">{st("http（远程）")}</option>
          <option value="sse">{st("sse（远程）")}</option>
          <option value="stdio">{st("stdio（本地命令）")}</option>
        </select>
      </Field>

      {transport !== "stdio" ? (
        <>
          <Field label="URL">
            <input className="mono" defaultValue={m.transport !== "stdio" ? m.endpoint : "https://"} />
          </Field>
          <Field label="Headers" hint={st("鉴权时注入，支持 {env:VAR}")}>
            <div className="addrow">
              <input
                className="tinp mono"
                style={{ flex: 1, width: "auto" }}
                placeholder="Authorization"
                aria-label={st("header 名")}
              />
              <input
                className="tinp mono"
                style={{ flex: 1, width: "auto" }}
                placeholder="Bearer {env:TOKEN}"
                aria-label={st("header 值")}
              />
              <button type="button" className="btn sm" onClick={() => toast(st("已添加 header"))}>
                <Icon name="plus" size="sm" />
              </button>
            </div>
            <div className="taglist" style={{ marginTop: 8 }}>
              <span className="tag">
                Authorization: Bearer {`{env:MCP_TOKEN}`}
                <span
                  className="x"
                  role="button"
                  tabIndex={0}
                  aria-label={st("移除")}
                  onClick={e => (e.currentTarget.closest(".tag") as HTMLElement).remove()}>
                  <Icon name="x" size="sm" />
                </span>
              </span>
            </div>
          </Field>
        </>
      ) : (
        <>
          <Field label="Command">
            <input className="mono" defaultValue="npx" />
          </Field>
          <Field label="Args" hint={st("每行一个")}>
            <textarea defaultValue={"-y\n@upstash/context7-mcp"} />
          </Field>
          <Field label={st("环境变量")}>
            <div className="addrow">
              <input className="tinp mono" style={{ flex: 1, width: "auto" }} placeholder="KEY" aria-label={st("变量名")} />
              <input className="tinp mono" style={{ flex: 1, width: "auto" }} placeholder="VALUE" aria-label={st("变量值")} />
              <button type="button" className="btn sm" onClick={() => toast(st("已添加环境变量"))}>
                <Icon name="plus" size="sm" />
              </button>
            </div>
          </Field>
        </>
      )}

      <Field label={st("该 server 的工具策略")} hint={st("MCP 工具以外部进程权限运行，默认强制审批")}>
        <select className="sel" style={{ width: "100%" }} aria-label={st("工具策略")}>
          <option>{st("require_approval（默认，逐个确认）")}</option>
          <option>{st("auto（自动执行）")}</option>
          <option>{st("deny（禁用）")}</option>
        </select>
      </Field>
    </Shell>
  );
}

/* ---------------- Skill ---------------- */

function SkillModal({ arg }: { arg?: Record<string, unknown> }): JSX.Element {
  const s = arg?.c ? (SKILLS.find(x => x.command === arg.c) ?? null) : null;
  return (
    <Shell
      icon="slash"
      title={s ? st("编辑 Skill：{command}", { command: s.command }) : st("新建 Skill")}
      sub={st("斜杠命令")}
      foot={
        <>
          <span className="push">
            {st("文件：")}
            <code className="mono">{s?.path ?? ".duo/commands/my-skill.md"}</code>
          </span>
          <button type="button" className="btn" onClick={() => toast(st("在编辑器打开源文件"))}>
            <Icon name="external" size="sm" />
            {st("编辑源文件")}
          </button>
          <button type="button" className="btn" onClick={actions.closeModal}>
            {st("取消")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              actions.closeModal();
              toast(st("Skill 已保存 · 待重载"));
            }}>
            {st("保存")}
          </button>
        </>
      }>
      <div className="grid2">
        <Field label={st("命令")} required hint={st("以 / 开头；同 scope 下唯一")}>
          <input className="mono" defaultValue={s?.command ?? "/my-skill"} />
        </Field>
        <Field label={st("名称")}>
          <input defaultValue={s?.name ?? ""} placeholder={st("可读名称")} />
        </Field>
        <Field label={st("作用域")}>
          <select
            className="sel"
            style={{ width: "100%" }}
            defaultValue={s?.scope === "global" ? "global（~/.config/duo-desktop/skills/）" : "project（.duo/commands/）"}
            aria-label={st("作用域")}>
            <option>project（.duo/commands/）</option>
            <option>global（~/.config/duo-desktop/skills/）</option>
          </select>
        </Field>
        <Field label={st("模型 / 变体覆盖")}>
          <div style={{ display: "flex", gap: 6 }}>
            <select className="sel" style={{ flex: 1 }} aria-label={st("模型覆盖")}>
              <option>{st("跟随对话")}</option>
              <option>GPT-5</option>
              <option>Qwen3 Coder 32B</option>
            </select>
            <select className="sel" style={{ width: 96 }} aria-label={st("变体覆盖")}>
              <option>{st("默认")}</option>
              <option>high</option>
            </select>
          </div>
        </Field>
      </div>
      <Field label={st("描述")} hint={st("出现在 / 补全列表里")}>
        <input defaultValue={s?.description ?? ""} placeholder={st("出现在 / 补全列表里")} />
      </Field>
      <Field
        label={st("System prompt（Markdown / 模板）")}
        hint={st("支持 {{参数|默认值}} 占位；输入 /review pr-14906 时按位置注入")}>
        <textarea style={{ minHeight: 150 }} defaultValue={s?.systemPrompt ?? st("评审目标：{{target|uncommitted}}")} />
      </Field>
      <div className="notice info spec">
        <Icon name="info" size="sm" />
        <div>
          {st("保存后需")}
          <code className="mono">/reload</code> {st("生效（或点设置页重载）。Skills 是纯文本注入，不引入外部进程。")}
        </div>
      </div>
    </Shell>
  );
}

/* ---------------- 花费熔断 ---------------- */

function CostModal(): JSX.Element {
  return (
    <Shell
      icon="target"
      title={st("花费与熔断")}
      foot={
        <>
          <button type="button" className="btn" onClick={actions.closeModal}>
            {st("取消")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              actions.closeModal();
              toast(st("熔断策略已保存"));
            }}>
            {st("保存")}
          </button>
        </>
      }>
      <div className="ucard" style={{ marginBottom: 12 }}>
        <h5>{st("本会话（估算）")}</h5>
        <div className="big">
          ${ST.cost} <span style={{ fontSize: "var(--fs-12)", color: "var(--text-weaker)" }}>/ $5.00</span>
        </div>
        <div className="meter">
          <i style={{ width: "0.84%" }} />
        </div>
        <div className="sub">{st("本地估算，非实际账单")}</div>
      </div>
      <Field label={st("会话最大花费（估算）")} hint={st("0 = 不限制（不推荐）；达阈后暂停回合并弹审批")}>
        <input defaultValue="5.00" />
      </Field>
      <Field label={st("达限时行为")}>
        <select className="sel" style={{ width: "100%" }} aria-label={st("达限时行为")}>
          <option>{st("暂停回合并保留上下文")}</option>
          <option>{st("询问后继续")}</option>
          <option>{st("直接中断")}</option>
        </select>
      </Field>
      <Field label={st("最大 Turn 数")} hint={st("防死循环：超限即终止并汇报进度")}>
        <input defaultValue="10" />
      </Field>
      <div className="notice warn">
        <Icon name="alert" size="sm" />
        <div>{st("熔断基于本地 token 估算，可能与服务商实际计数有偏差；如需精确账单请在服务商侧核对。")}</div>
      </div>
    </Shell>
  );
}

/* ---------------- 权限例外 ---------------- */

function PermRulesModal({ arg }: { arg?: Record<string, unknown> }): JSX.Element {
  return (
    <Shell
      icon="shield"
      title={st("权限例外规则")}
      sub={st("bash · 本次及以后")}
      foot={
        <>
          <span className="push">{st("完整策略表在 设置 → 权限与工具")}</span>
          <button type="button" className="btn" onClick={actions.closeModal}>
            {st("完成")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              actions.closeModal();
              actions.setSettingsTab("approve");
            }}>
            <Icon name="sliders" size="sm" />
            {st("全部规则")}
          </button>
        </>
      }>
      {arg?.add ? (
        <div className="notice ok">
          <Icon name="check" size="sm" />
          <div>{st("把这次要执行的命令收成例外，下次不再询问。matcher 可手改。")}</div>
        </div>
      ) : null}
      <div className="sgroup">
        <div className="gh">
          <Icon name="list" size="sm" />
          {st("已有规则（3）")}
        </div>
        <RuleLine matcher="bun test *" desc={st("只读测试命令放行")} policy="allow" />
        <RuleLine matcher="rm -rf *" desc={st("危险删除，永远禁止")} policy="deny" />
        <RuleLine matcher={st("punycode 同形域名检测")} desc={st("审批卡高亮可疑主机")} policy="ask" />
      </div>
      <Field label={st("新增例外")} hint={st("作用域 project: opencode；命中顺序取最严格者生效")}>
        <div className="addrow">
          <input
            className="tinp mono"
            style={{ flex: 1, width: "auto" }}
            defaultValue={arg?.add ? "bun test ./test/session/*" : "matcher：git commit *"}
          />
          <select className="sel" style={{ minWidth: 168 }} aria-label={st("策略")}>
            <option>allow</option>
            <option>require_approval</option>
            <option>deny</option>
          </select>
          <button type="button" className="btn primary" onClick={() => toast(st("已添加例外规则"))}>
            {st("添加")}
          </button>
        </div>
      </Field>
    </Shell>
  );
}

function RuleLine({ matcher, desc, policy }: { matcher: string; desc: string; policy: "allow" | "deny" | "ask" }): JSX.Element {
  const [on, setOn] = useState(true);
  return (
    <div className="perm-rule">
      <div className="pl">
        <div className="n">
          <code className="mono">{matcher}</code>
        </div>
        <div className="d">{desc}</div>
      </div>
      <select className="tri" defaultValue={policy === "ask" ? "require_approval" : policy} aria-label={st("策略")}>
        <option value="allow">allow</option>
        <option value="require_approval">require_approval</option>
        <option value="deny">deny</option>
      </select>
      <Switch on={on} onChange={setOn} label={st("启用")} />
      <button
        type="button"
        className="btn sm danger"
        onClick={() =>
          actions.askConfirm({
            title: st("删除该例外？"),
            danger: true,
            ok: st("删除"),
            done: st("已删除"),
            body: st("例外移除后该 matcher 回落到工具默认策略。"),
          })
        }>
        <Icon name="trash" size="sm" />
      </button>
    </div>
  );
}

/* ---------------- 快捷键 ---------------- */

const SHORTCUT_GROUPS: [IconName, string, [string, string][]][] = [
  [
    "chat",
    st("会话"),
    [
      ["⌘N", st("新会话")],
      ["⌘K", st("命令面板 / 搜索会话")],
      ["⌘O", st("历史会话")],
      ["⌘F", st("转录内搜索")],
      ["⌘⇧E", st("导出 Markdown")],
      ["⌘⇧R", st("回退到上一检查点")],
    ],
  ],
  [
    "terminal",
    st("输入框"),
    [
      ["↵", st("发送")],
      ["⇧↵", st("换行")],
      ["↑ / ↓", st("历史提示词")],
      ["/", st("Skill / 命令补全")],
      ["@", st("文件与上下文提及")],
      ["⇧Tab", st("循环推理变体")],
      ["esc", st("中断生成 / 关闭浮层")],
      ["⌘↵", st("提交问题答案")],
    ],
  ],
  [
    "panel-left",
    st("窗口与布局"),
    [
      ["⌥[", st("折叠/展开左栏")],
      ["⌥]", st("折叠/展开右栏")],
      ["⌘⌥F", st("专注模式（双栏折叠）")],
      ["⌘,", st("设置")],
      ["⌘M", st("最小化到托盘")],
      ["⌘⇧S", st("屏目索引（原型导航）")],
    ],
  ],
  [
    "monitor",
    st("全局（未聚焦时）"),
    [
      ["⌃⌥K", st("快速提问浮层")],
      ["⌥N", st("新会话")],
      ["⌃⇧P", st("审批：允许一次")],
    ],
  ],
];

function ShortcutsModal(): JSX.Element {
  return (
    <Shell icon="keyboard" title={st("快捷键")} wide foot={<span className="push">{st("自定义键位存于 ui_state")}</span>}>
      <div className="grid2">
        {SHORTCUT_GROUPS.map(([icon, name, rows]) => (
          <div className="sgroup" key={name}>
            <div className="gh">
              <Icon name={icon} size="sm" />
              {name}
            </div>
            {rows.map(([k, label]) => (
              <Row key={k} name={label}>
                <span className="kbd">{k}</span>
              </Row>
            ))}
            {name.startsWith(st("全局")) ? (
              <div className="exc">
                <div className="er">
                  <span className="lvl ask">{st("冲突")}</span> <code>⌃⌥K</code> {st("被系统输入法占用")}
                  <button type="button" className="btn xs" style={{ marginLeft: "auto" }} onClick={() => toast(st("已改为 ⌃J"))}>
                    {st("改键")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Shell>
  );
}

/* ---------------- 工作空间 / panic ---------------- */

function ProjectModal(): JSX.Element {
  const [kind, setKind] = useState<"git" | "plain">("git");
  return (
    <Shell
      icon="folder"
      title={st("打开 / 新建工作空间")}
      foot={
        <>
          <button type="button" className="btn" onClick={actions.closeModal}>
            {st("取消")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              actions.closeModal();
              toast(st("已打开 ~/code/payments · 开始后台扫描"));
            }}>
            {st("打开")}
          </button>
        </>
      }>
      <Field label={st("目录")}>
        <div className="addrow">
          <input className="tinp" style={{ flex: 1, width: "auto" }} defaultValue="~/code/payments" />
          <button type="button" className="btn sm" onClick={() => toast(st("调用 Tauri dialog 选择目录"))}>
            <Icon name="folder-open" size="sm" />
            {st("选择")}
          </button>
        </div>
      </Field>
      <div className={`auth-method${kind === "git" ? " on" : ""}`} onClick={() => setKind("git")} role="button" tabIndex={0}>
        <span className="ic">
          <Icon name="branch" />
        </span>
        <div>
          <b>{st("已有 git 仓库")}</b>
          <span>{st("读取 .gitignore · 启用变更审查与检查点")}</span>
        </div>
      </div>
      <div className={`auth-method${kind === "plain" ? " on" : ""}`} onClick={() => setKind("plain")} role="button" tabIndex={0}>
        <span className="ic">
          <Icon name="folder" />
        </span>
        <div>
          <b>{st("普通目录")}</b>
          <span>{st("仅文件树与工具；Revert 退化为文件快照")}</span>
        </div>
      </div>
      <div className="notice info spec">
        <Icon name="info" size="sm" />
        <div>{st("每个工作空间独立记忆窗口几何、折叠态、右栏子视图与默认模型。")}</div>
      </div>
    </Shell>
  );
}

function PanicModal(): JSX.Element {
  const [choice, setChoice] = useState("retry");
  return (
    <Shell
      icon="alert"
      title={st("任务异常终止")}
      foot={
        <>
          <span className="push">{st("panic 不会崩窗：任务级 catch_unwind")}</span>
          <button type="button" className="btn" onClick={actions.closeModal}>
            {st("忽略")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              actions.closeModal();
              if (choice === "retry") client.retryLast();
              else if (choice === "ckpt") client.revertToMessage("u1");
              toast(
                choice === "retry" ? st("已重试本 Turn") : choice === "ckpt" ? st("已回退到检查点 3b8de02") : st("已复制诊断包"),
              );
            }}>
            {choice === "retry" ? st("重试") : choice === "ckpt" ? st("回退检查点") : st("复制诊断包")}
          </button>
        </>
      }>
      <div className="notice err">
        <Icon name="alert" size="sm" />
        <div>
          <b>{st("harness task panicked（已隔离）")}</b>
          <br />
          {st("窗口与其余任务未受影响；当前 Turn 的工具输出未落库。")}
        </div>
      </div>
      <div
        className="mono"
        style={{
          fontSize: "var(--fs-11)",
          background: "var(--cmd-bg)",
          color: "var(--cmd-text)",
          borderRadius: 8,
          padding: "9px 11px",
          overflow: "auto",
        }}>
        {`thread 'harness' panicked at tools/src/grep.rs:214:
internal buffer overflow while truncating
note: run with RUST_BACKTRACE=1`}
      </div>
      <Field label={st("选择恢复方式")}>
        {[
          ["retry", "refresh", st("重试本 Turn"), st("从当前上下文继续（推荐）")],
          ["ckpt", "history", st("回退到检查点 3b8de02"), st("恢复该 Turn 之前的文件状态")],
          ["diag", "copy", st("复制诊断包"), st("含脱敏事件计数与 schema 版本")],
        ].map(([id, icon, title, desc]) => (
          <div
            key={id}
            className={`auth-method${choice === id ? " on" : ""}`}
            onClick={() => setChoice(id)}
            role="button"
            tabIndex={0}>
            <span className="ic">
              <Icon name={icon as IconName} />
            </span>
            <div>
              <b>{title}</b>
              <span>{desc}</span>
            </div>
          </div>
        ))}
      </Field>
    </Shell>
  );
}
