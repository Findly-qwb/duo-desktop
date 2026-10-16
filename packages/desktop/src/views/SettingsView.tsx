/**
 * 设置中心（PLAN §11 M6 / 原型 SETTINGS 13 tab）
 * 数据驱动的控件表 + 独立的「权限与审批」页（三态 × 分层作用域 + 例外 + effective 链）
 */
import { useState, type ReactNode } from "react";
import { st, t, useLocale, setLocale, type Key } from "../i18n";
import { Badge, Icon, Switch, type IconName } from "@duo/ui";
import { TOOLS } from "../data/fixtures";
import { actions, toast, useApp } from "../state/app";
import { auditContrast, SKINS } from "@duo/ui";
import { contrastLabel } from "../lib/contrast";
import { client } from "../ipc/client";
import { refreshProviders, useProviders, type ProviderRow } from "../ipc/providers";

type RowSpec = [label: string, desc: string, kind: CtlKind, value?: string, extra?: string];
type CtlKind =
  | "sw"
  | "lang"
  | "sel"
  | "sel2"
  | "txt"
  | "num"
  | "skin"
  | "rng"
  | "tags"
  | "tag"
  | "btn"
  | "ta"
  | "toollist"
  | "ep"
  | "custom"
  | "static";

interface Tab {
  t: string;
  i: IconName;
  lead: string;
  groups?: { name: string; rows: RowSpec[] }[];
}

const SETTINGS: Record<string, Tab> = {
  display: {
    t: "显示与皮肤",
    i: "palette",
    lead: "皮肤 bundle · 字号 · 密度 · 转录渲染",
    groups: [
      {
        name: "皮肤",
        rows: [
          ["当前皮肤", "三套内置 + 导入 skin.json（可扩展）", "skin", "graphite-dark"],
          ["跟随系统主题", "关闭后固定使用所选皮肤", "sw", "1"],
          ["语法高亮跟随皮肤", "双主题注入 --tk-*", "sw", "1"],
          ["对比度守护", "正文 ≥4.5:1、次要 ≥3:1，不达标阻止保存", "sw", "1"],
        ],
      },
      {
        name: "排版",
        rows: [
          ["字号", "10–24px，作用于所有 --fs-* 令牌", "rng", "13"],
          ["界面密度", "标准 / 紧凑", "sel2", "标准|紧凑"],
          ["界面语言", "auto 跟随系统；切换即时生效", "lang", ""],
        ],
      },
      {
        name: "转录",
        rows: [
          ["活动/用量时间线默认展开", "关闭后点上下文进度条才展开", "sw", "0"],
          ["输入区显示快捷键提示行", "", "sw", "1"],
          ["思考块完成后自动折叠", "", "sw", "1"],
          ["Shift+Tab 循环推理变体", "", "sw", "1"],
          ["终端命令卡默认展开", "", "sel2", "折叠|展开"],
          ["代码编辑卡默认展开", "", "sel2", "折叠|展开"],
          ["MCP 工具卡默认展开", "", "sel2", "折叠|展开"],
          ["显示命中的权限规则", "审批卡上展示为什么被拦", "sw", "1"],
        ],
      },
    ],
  },
  models: {
    t: "模型",
    i: "cpu",
    lead: "默认模型与角色模型；端点在「模型端点」页管理",
    groups: [
      {
        name: "默认",
        rows: [
          ["对话模型", "输入框未显式选择时使用", "sel", "Claude Sonnet 4.5"],
          ["小模型", "标题生成 / 摘要 / 提示词增强", "sel", "GPT-5 Mini"],
          ["压缩模型", "/compact 生成摘要", "sel", "（跟随对话模型）"],
        ],
      },
      {
        name: "按模式覆盖",
        rows: [
          ["Ask 模式模型", "仅问答", "sel", "GPT-5 Mini"],
          ["Plan 模式模型", "只读规划", "sel", "Claude Opus 4.1"],
          ["Code 模式模型", "读写与命令", "sel", "Claude Sonnet 4.5"],
        ],
      },
      {
        name: "选择器",
        rows: [
          ["收藏置顶", "选择器里显示收藏分组", "sw", "1"],
          ["按会话记忆模型", "切回会话时恢复上次选择", "sw", "1"],
          ["隐藏未连通端点的模型", "", "sw", "1"],
        ],
      },
    ],
  },
  endpoints: { t: "模型端点", i: "key", lead: "OpenAI 兼容协议；密钥存系统 keychain", groups: [] },
  approve: {
    t: "权限与审批",
    i: "shield-check",
    lead: "三态策略 × 分层作用域（global / project / session / mode），命中最严格者生效",
  },
  tools: {
    t: "工具",
    i: "wrench",
    lead: "内置工具开关、输出截断与沙箱",
    groups: [
      { name: "内置工具", rows: [["工具与默认策略", "逐个设置 auto / require_approval / deny", "toollist"]] },
      {
        name: "输出与截断",
        rows: [
          ["单工具输出上限 KB", "超出落盘并给路径引用", "num", "32"],
          ["单文件注入上限 KB", "加入上下文的文件体积", "num", "256"],
          ["shell 超时 s", "", "num", "120"],
        ],
      },
      {
        name: "沙箱（P1）",
        rows: [
          ["启用命令沙箱", "macOS sandbox-exec / Linux bubblewrap", "sw", "0"],
          ["阻断网络", "默认拒绝出站", "sw", "1"],
          ["允许的主机", "host:port 白名单", "tags", "registry.npmjs.org:443|github.com:443"],
          ["可写路径", "", "tags", "/tmp|./.git"],
        ],
      },
    ],
  },
  context: {
    t: "上下文",
    i: "archive",
    lead: "压缩策略、文件监听与注入预算",
    groups: [
      {
        name: "压缩",
        rows: [
          ["自动压缩", "接近上限时生成摘要分割线", "sw", "1"],
          ["触发阈值 %", "", "num", "92"],
          ["修剪旧工具输出", "压缩时优先丢弃陈旧输出", "sw", "1"],
          ["压缩模型", "默认跟随对话模型", "sel", "（跟随对话模型）"],
        ],
      },
      {
        name: "注入预算",
        rows: [
          ["文件内容注入上限 tokens", "单文件", "num", "8000"],
          ["历史消息窗口", "超出后进入摘要", "num", "200000"],
        ],
      },
      {
        name: "文件监听",
        rows: [
          ["监听工作区变更", "驱动文件树与变更审查刷新", "sw", "1"],
          ["忽略模式", "不扫描的路径", "tags", "node_modules/**|dist/**|.git/**"],
        ],
      },
    ],
  },
  git: {
    t: "Git 与检查点",
    i: "branch",
    lead: "系统 git CLI 后端 · 独立 checkpoint 仓库",
    groups: [
      {
        name: "Git",
        rows: [
          ["后端", "libgit2 未编译以控体积；缺失时提示安装", "sel2", "系统 git CLI|libgit2（可选 feature）"],
          ["提交 / 推送策略", "默认强制审批", "sel2", "require_approval|deny"],
          ["AI 提交信息语言", "", "sel2", "跟随界面|English|日本語"],
          ["自定义提交信息 prompt", "覆盖默认模板", "ta", "用 conventional commits，主题行 ≤72 字符"],
        ],
      },
      {
        name: "检查点 / Revert",
        rows: [
          ["启用文件检查点", "写类工具执行前打快照", "sw", "1"],
          ["checkpoint 仓库", "独立 git-dir，不碰用户 HEAD / index / reflog", "tag", "~/.local/share/duo-desktop/ckpt"],
          ["保留策略", "超期快照清理", "sel2", "30 天|90 天|不自动清理"],
          ["Revert 同时回滚消息", "文件 + 会话一起回退", "sw", "1"],
        ],
      },
    ],
  },
  files: {
    t: "文件与附件",
    i: "folder",
    lead: "扫描预算、忽略规则与附件缓存",
    groups: [
      {
        name: "",
        rows: [
          ["扫描文件数上限", "超出即停止并提示", "num", "50000"],
          ["扫描深度", "", "num", "24"],
          ["解析 .gitignore", "含全局 gitignore 与 .git/info/exclude", "sw", "1"],
          ["附件缓存目录", "", "tag", "~/.local/share/duo-desktop/attachments"],
          ["附件数量上限", "图片 Base64 直传，不入库", "num", "8"],
          ["非图片附件", "自动转为 @mention 引用", "sw", "1"],
        ],
      },
    ],
  },
  mcp: {
    t: "MCP",
    i: "zap",
    lead: "三协议客户端与子进程治理（详见 MCP 页）",
    groups: [
      {
        name: "",
        rows: [
          ["工具默认策略", "外部进程默认逐个确认", "sel2", "require_approval|auto|deny"],
          ["调用超时 ms", "", "num", "60000"],
          ["异常重启上限", "指数退避 1/2/4/8s", "num", "5"],
          ["退出时回收进程组", "防止孙进程泄漏", "sw", "1", "dis"],
        ],
      },
    ],
  },
  skills: {
    t: "Skills",
    i: "slash",
    lead: "斜杠命令扫描目录与重载",
    groups: [
      {
        name: "",
        rows: [
          ["project 目录", "", "tag", ".duo/commands/*.md"],
          ["global 目录", "", "tag", "~/.config/duo-desktop/skills/*.md"],
          ["变更后自动重载", "否则需手动 /reload", "sw", "0"],
        ],
      },
    ],
  },
  notify: {
    t: "通知",
    i: "bell",
    lead: "系统通知与提示音",
    groups: [
      {
        name: "",
        rows: [
          ["回合完成时", "窗口未聚焦才发", "sw", "1"],
          ["需要审批时", "含 MCP / 子任务发起", "sw", "1"],
          ["任务异常终止", "panic / 工具失败", "sw", "1"],
          ["提示音", "", "sel2", "无|Ping|Glass|Hero"],
          ["试听", "", "btn", "▶ 试听"],
          ["发送测试通知", "", "btn", "发送测试"],
          ["静默时段", "", "txt", "23:00 – 07:00"],
        ],
      },
    ],
  },
  about: {
    t: "关于与诊断",
    i: "info",
    lead: "版本、runtime 状态、数据路径与导入导出",
    groups: [
      {
        name: "",
        rows: [
          ["版本", "duo-desktop 0.1.0 · rust 1.94 · Tauri 2", "static", ""],
          ["Agent Runtime", "同进程 · Tokio · 无端口无鉴权", "btn", "诊断"],
          ["数据库", "~/.local/share/duo-desktop/duo-desktop.db（WAL · schema 7）", "btn", "打开目录"],
          ["构建习惯", "lto / codegen-units=1 / strip（不设体积门禁）", "static", "PLAN §13"],
          ["导出设置", "JSON（不含 keychain 密钥）", "btn", "导出…"],
          ["导入设置", "", "btn", "导入…"],
          ["皮肤管理", "", "btn", "打开皮肤页"],
          ["检查更新", "", "btn", "检查更新"],
          ["重置全部设置", "危险操作", "btn", "重置"],
        ],
      },
    ],
  },
  experimental: {
    t: "实验性",
    i: "sparkle",
    lead: "未稳定能力，默认关闭",
    groups: [
      {
        name: "",
        rows: [
          ["内嵌终端（xterm feature）", "会增加包体积，默认不打包", "sw", "0"],
          ["语义代码索引", "embedding + 向量库", "sw", "0"],
          ["多代理编排", "Agent Manager 前身", "sw", "0"],
          ["行内补全 Ghost text", "依赖编辑器语义，桌面受限", "sw", "0"],
          ["拒绝后继续回合", "deny 不中断当前 Turn", "sw", "0"],
          ["沙箱（Seatbelt / bubblewrap）", "P1", "sw", "0"],
        ],
      },
    ],
  },
};

const SETGROUPS: [Key, string[]][] = [
  ["settings.group.appearance", ["display"]],
  ["settings.group.models", ["models", "endpoints"]],
  ["settings.group.capabilities", ["approve", "tools", "context", "git", "files", "mcp", "skills"]],
  ["settings.group.system", ["notify", "about", "experimental"]],
];

const TAB_LABEL: Record<string, Key> = {
  display: "settings.tab.display",
  models: "settings.tab.models",
  endpoints: "settings.tab.endpoints",
  approve: "settings.tab.approve",
  tools: "settings.tab.tools",
  context: "settings.tab.context",
  git: "settings.tab.git",
  files: "settings.tab.files",
  mcp: "settings.tab.mcp",
  skills: "settings.tab.skills",
  notify: "settings.tab.notify",
  about: "settings.tab.about",
  experimental: "settings.tab.experimental",
};

const ReloadBtn = (
  <button type="button" className="btn sm" onClick={() => actions.openScene("reload")}>
    <Icon name="refresh" size="sm" />
    {t("重载 Skills / MCP")}
  </button>
);

const SETACTS: Record<string, ReactNode> = {
  approve: ReloadBtn,
  skills: ReloadBtn,
  mcp: ReloadBtn,
  about: (
    <>
      <button type="button" className="btn sm" onClick={() => toast(st("打开项目配置 .duo/config.json"))}>
        <Icon name="folder" size="sm" />
        {t("项目配置")}
      </button>
      <button type="button" className="btn sm" onClick={() => toast(st("打开全局配置 ~/.config/duo-desktop/config.json"))}>
        <Icon name="monitor" size="sm" />
        {t("全局配置")}
      </button>
    </>
  ),
  display: (
    <button type="button" className="btn sm" onClick={() => actions.openModal("shortcuts")}>
      <Icon name="keyboard" size="sm" />
      {t("快捷键与手势")}
    </button>
  ),
};

export function SettingsView(): JSX.Element {
  useLocale(); // 语言变化时重渲染导航与标题
  const app = useApp();
  const tab = SETTINGS[app.settingsTab] ? app.settingsTab : "display";
  const s = SETTINGS[tab];

  return (
    <div className="settings">
      <div className="set-nav">
        {SETGROUPS.map(([g, keys]) => (
          <div key={g}>
            <div className="grp" style={{ margin: "14px 8px 5px" }}>
              {t(g)}
            </div>
            {keys.map(k => (
              <button key={k} type="button" className={k === tab ? "active" : ""} onClick={() => actions.setSettingsTab(k)}>
                <Icon name={SETTINGS[k].i} size="sm" />
                {t(TAB_LABEL[k])}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="set-body">
        <h3>{st(s.t)}</h3>
        <div className="slead">{st(s.lead)}</div>
        {SETACTS[tab] ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: "var(--s4)" }}>{SETACTS[tab]}</div>
        ) : null}
        {tab === "approve" ? (
          <ApprovePage />
        ) : tab === "endpoints" ? (
          <EndpointsPage />
        ) : (
          (s.groups ?? []).map(g => <Group key={g.name || s.t} tab={tab} name={g.name || s.t} rows={g.rows} />)
        )}
      </div>

      <div className="savebar" id="savebar">
        <span style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--surface-warning-strong)" }}>
          <Icon name="alert-circle" />
          {t("settings.unsaved")}
        </span>
        <span className="sp" />
        <button type="button" className="btn" onClick={() => toast(st("已放弃更改"))}>
          {t("settings.discard")}
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => toast(st("已写入 duo.json（按 global / project 作用域分发）"))}>
          {t("settings.save")}
        </button>
      </div>
    </div>
  );
}

/**
 * SETTINGS 表里存的是「中文原文 = key」；onSpecial 之类的分支判断也读原文，
 * 所以表内不包 t()，只在渲染出去的那一层译 —— 否则英文态下拿译文做 === 比较会静默失效。
 */
function tr(s?: string): string {
  return s ? st(s) : "";
}

function Group({ tab, name, rows }: { tab: string; name: string; rows: RowSpec[] }): JSX.Element {
  return (
    <div className="sgroup">
      <div className="gh">
        {name !== SETTINGS[tab].t ? <Icon name="layers" size="sm" /> : null}
        {tr(name)}
      </div>
      {rows.map(r => (
        <Ctl key={r[0]} row={r} />
      ))}
    </div>
  );
}

function Ctl({ row }: { row: RowSpec }): JSX.Element {
  const locale = useLocale();
  const [label, desc, kind, value, extra] = row;
  const [on, setOn] = useState(value === "1");
  const app = useApp();
  const L = (
    <div className="l">
      <div className="n">{tr(label)}</div>
      {desc ? <div className="d">{tr(desc)}</div> : null}
    </div>
  );
  let c: ReactNode = null;
  switch (kind) {
    case "sw":
      c = (
        <Switch
          on={on}
          disabled={extra === "dis"}
          onChange={v => {
            setOn(v);
            toast(st("已保存"));
          }}
          label={tr(label)}
        />
      );
      break;
    case "lang":
      c = (
        <select
          className="sel"
          value={locale}
          aria-label={t("settings.language")}
          onChange={e => {
            const next = e.target.value as "zh" | "en";
            setLocale(next);
            toast(next === "en" ? "Interface language: English" : st("界面语言：简体中文"));
          }}>
          <option value="zh">{st("简体中文（zh）")}</option>
          <option value="en">{st("English（en）")}</option>
        </select>
      );
      break;
    case "sel":
      c = (
        <select
          className="sel"
          onChange={e => toast(st("已更新：{x}", { x: e.target.value }))}
          aria-label={tr(label)}
          defaultValue={tr(value)}>
          <option>{tr(value)}</option>
          <option>{st("未设置")}</option>
          <option>GPT-5</option>
          <option>DeepSeek V3.2</option>
          <option>{st("Qwen3 Coder 32B（本地）")}</option>
        </select>
      );
      break;
    case "sel2":
      c = (
        <select className="sel" aria-label={tr(label)}>
          {/* 先整串译再按 | 拆：表里存的是「系统 git CLI|libgit2（可选 feature）」这类整串 key，逐片查典会落回中文 */}
          {tr(value)
            .split("|")
            .map(x => (
              <option key={x}>{x}</option>
            ))}
        </select>
      );
      break;
    case "txt":
      c = <input className="tinp" defaultValue={tr(value)} aria-label={tr(label)} />;
      break;
    case "num":
      c = <input className="tinp num" defaultValue={tr(value)} aria-label={tr(label)} />;
      break;
    case "skin":
      c = (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select className="sel" value={app.skin} onChange={e => actions.setSkin(e.target.value)} aria-label={st("皮肤")}>
            {SKINS.map(s => (
              <option key={s.id} value={s.id}>
                {tr(s.name)}
              </option>
            ))}
          </select>
          <button type="button" className="btn sm" onClick={() => actions.openModal("skin")}>
            <Icon name="palette" size="sm" />
            {t("皮肤管理")}
          </button>
        </div>
      );
      break;
    case "rng":
      c = (
        <>
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
        </>
      );
      break;
    case "tags":
      c = <Tags initial={(value ?? "").split("|")} label={tr(label)} />;
      break;
    case "tag":
      c = (
        <div className="mono" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "var(--fs-11)" }}>
          {tr(value)}
        </div>
      );
      break;
    case "btn":
      c = (
        <button type="button" className="btn sm" onClick={() => onSpecial(label, value ?? "")}>
          {tr(value)}
        </button>
      );
      break;
    case "ta":
      c = (
        <textarea
          className="tinp"
          style={{ width: 320, minHeight: 56, fontFamily: "var(--f-mono)", fontSize: "var(--fs-11)" }}
          defaultValue={tr(value)}
          aria-label={tr(label)}
        />
      );
      break;
    case "toollist":
      c = (
        <button type="button" className="btn sm" onClick={() => actions.setSettingsTab("approve")}>
          <Icon name="shield" size="sm" />
          {t("打开策略表")}
        </button>
      );
      break;
    case "custom":
      c = (
        <button type="button" className="btn sm primary" onClick={() => actions.openModal("endpoint")}>
          <Icon name="plus" size="sm" />
          {t("添加端点")}
        </button>
      );
      break;
    default:
      c = (
        <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-weak)" }}>
          {tr(value)}
        </span>
      );
  }
  return (
    <div className="srow">
      {L}
      <div className="c">{c}</div>
    </div>
  );
}

function onSpecial(label: string, value: string): void {
  if (label === "Agent Runtime" || value === "诊断") actions.openModal("runtime");
  else if (label === "皮肤管理") actions.openModal("skin");
  else if (label === "检查更新") actions.setOsLayer("update");
  else if (label === "发送测试通知") actions.showNotif(st("回合完成"), st("9 steps · 1m 42s · $0.0421（估算）"));
  else if (label === "重置全部设置")
    actions.askConfirm({
      title: st("重置全部设置？"),
      danger: true,
      ok: st("重置"),
      done: st("已重置"),
      body: st("皮肤、快捷键、权限例外与端点配置回到出厂默认。"),
    });
  else toast(st("{label}：已执行", { label: tr(label) }));
}

function Tags({ initial, label }: { initial: string[]; label: string }): JSX.Element {
  const [tags, setTags] = useState(initial);
  return (
    <div className="taglist">
      {tags.map(t => (
        <span className="tag" key={t}>
          {t}
          <span
            className="x"
            role="button"
            tabIndex={0}
            aria-label={st("移除 {t}", { t: t })}
            onClick={() => setTags(list => list.filter(x => x !== t))}>
            <Icon name="x" size="sm" />
          </span>
        </span>
      ))}
      <button
        type="button"
        className="btn sm"
        onClick={() => setTags(list => [...list, st("新模式 {x1}", { x1: list.length + 1 })])}>
        <Icon name="plus" size="sm" />
      </button>
      <span className="sr">{label}</span>
    </div>
  );
}

/* ---------------- 端点页 ---------------- */

function EndpointsPage(): JSX.Element {
  // 端点表经 provider_list 取真数据（宿主 SQLite / mock 同源形状），不再直接渲染 fixtures
  const providers = useProviders();
  const [testing, setTesting] = useState<string | null>(null);
  const rows = providers ?? [];
  const test = async (e: ProviderRow): Promise<void> => {
    setTesting(e.id);
    try {
      const r = (await client.invoke("provider_test", { id: e.id })) as { count: number };
      toast(st("GET /models · {models} 模型", { models: r.count }), "ok");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "err");
    } finally {
      setTesting(null);
      void refreshProviders();
    }
  };
  return (
    <>
      <div className="sgroup">
        <div className="gh">
          <Icon name="key" size="sm" />
          {st("已配置（{length}）", { length: rows.length })}
        </div>
        {rows.map(e => (
          <div className="srow" key={e.id}>
            <div className="l">
              <div className="n">{e.name}</div>
              <div className="d mono">
                {e.base_url} · key: {e.key_ref ?? st("无")}
              </div>
            </div>
            <div className="c">
              <span className="picon" style={{ width: 22, height: 22, fontSize: 10 }}>
                <Icon name="cpu" size="sm" />
              </span>
              {e.last_check ? <Badge tone="ok">{st("已连通")}</Badge> : <Badge tone="gray">{st("未测")}</Badge>}
              <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-weaker)" }}>
                {e.models.length} {st("模型")}
              </span>
              <button type="button" className="btn sm" onClick={() => actions.openModal("endpoint", { id: e.id })}>
                <Icon name="pencil" size="sm" />
                {t("编辑")}
              </button>
              <button type="button" className="btn sm" disabled={testing !== null} onClick={() => void test(e)}>
                {testing === e.id ? st("测试中…") : t("刷新模型")}
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="sgroup">
        <div className="gh">
          <Icon name="plus" size="sm" />
          {t("新增")}
        </div>
        <div className="srow">
          <div className="l">
            <div className="n">{st("添加端点")}</div>
            <div className="d">{st("base URL + key + /models 拉取 + 连通性测试")}</div>
          </div>
          <div className="c">
            <button type="button" className="btn sm primary" onClick={() => actions.openModal("endpoint")}>
              <Icon name="plus" size="sm" />
              {t("添加端点")}
            </button>
          </div>
        </div>
      </div>
      <div className="notice info spec">
        <Icon name="lock" size="sm" />
        <div>{st("密钥只存系统 keychain（providers.key_ref），配置与日志里永远只有引用名。")}</div>
      </div>
    </>
  );
}

/* ---------------- 权限与审批页（PLAN §6.6） ---------------- */

const MODES: [string, string][] = [
  ["Ask", st("仅问答，不改文件也不执行命令")],
  ["Plan", st("只读探索并产出计划，批准后转 Code")],
  ["Code", st("完整读写与命令执行")],
];
const POLICIES = ["auto", "require_approval", "deny"] as const;

function ApprovePage(): JSX.Element {
  const [scope, setScope] = useState("global");
  return (
    <>
      <div className="sgroup">
        <div className="gh">
          <Icon name="compass" size="sm" />
          {t("模式默认策略")}
          <span className="act">
            <button type="button" className="btn xs" onClick={() => toast(st("已恢复模式默认值"))}>
              {t("恢复默认")}
            </button>
          </span>
        </div>
        {MODES.map(([name, desc], i) => (
          <div className="srow" key={name}>
            <div className="l">
              <div className="n">{name}</div>
              <div className="d">{desc}</div>
            </div>
            <div className="c">
              <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-weaker)" }}>
                write
              </span>
              <select
                className="tri"
                defaultValue={i < 2 ? "deny" : "require_approval"}
                aria-label={st("{x} 写策略", { x: name })}>
                {POLICIES.map(p => (
                  <option key={p}>{p}</option>
                ))}
              </select>
              <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-weaker)" }}>
                bash
              </span>
              <select
                className="tri"
                defaultValue={i < 2 ? "deny" : "require_approval"}
                aria-label={st("{x} shell 策略", { x: name })}>
                {POLICIES.map(p => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>

      <div className="sgroup">
        <div className="gh">
          <Icon name="shield" size="sm" />
          {st("工具策略（{scope} 作用域）", { scope: scope })}
          <span className="act">
            <select
              className="sel"
              style={{ minWidth: 130 }}
              value={scope}
              onChange={e => setScope(e.target.value)}
              aria-label={st("作用域")}>
              <option value="global">global</option>
              <option value="project">project: opencode</option>
              <option value="session">{st("session: 当前")}</option>
            </select>
            <button type="button" className="btn xs" onClick={() => toast(st("已导出 effective.json"))}>
              <Icon name="download" size="sm" />
              {t("导出")}
            </button>
          </span>
        </div>
        {TOOLS.map(([tool, desc, def]) => (
          <ToolRule key={tool} tool={tool} desc={desc} def={def} scope={scope} />
        ))}
      </div>

      <div className="sgroup">
        <div className="gh">
          <Icon name="target" size="sm" />
          {t("熔断与守护")}
        </div>
        <div className="srow">
          <div className="l">
            <div className="n">{st("会话最大花费（估算）")}</div>
            <div className="d">{st("达阈暂停回合并弹审批；非实际账单")}</div>
          </div>
          <div className="c">
            <input className="tinp num" defaultValue="5.00" aria-label={st("最大花费")} />
            <button type="button" className="btn sm" onClick={() => actions.openModal("cost")}>
              {t("策略")}
            </button>
          </div>
        </div>
        <div className="srow">
          <div className="l">
            <div className="n">{st("最大 Turn 数")}</div>
            <div className="d">{st("默认 10；防死循环")}</div>
          </div>
          <div className="c">
            <input className="tinp num" defaultValue={10} aria-label={st("最大 Turn 数")} />
          </div>
        </div>
        <div className="srow">
          <div className="l">
            <div className="n">{st("重复工具调用检测")}</div>
            <div className="d">{st("同工具同参数连续 3 次即熔断询问")}</div>
          </div>
          <div className="c">
            <Switch on onChange={() => undefined} label={st("重复检测")} />
          </div>
        </div>
        <div className="srow">
          <div className="l">
            <div className="n">{st("审批超时")}</div>
            <div className="d">{st("无响应自动 deny")}</div>
          </div>
          <div className="c">
            <input className="tinp num" defaultValue={30} aria-label={st("审批超时分钟")} /> min
          </div>
        </div>
      </div>

      <div className="sgroup">
        <div className="gh">
          <Icon name="lock" size="sm" />
          {t("安全默认")}
        </div>
        {[
          [st("端点密钥存系统 keychain"), st("不写入 db / 配置文件 / 日志")],
          [st("无 HTTP 服务、无端口监听"), st("前后端只走 Tauri IPC")],
          [st("无遥测上报"), st("日志仅本地，含脱敏")],
        ].map(([n, d]) => (
          <div className="srow" key={n}>
            <div className="l">
              <div className="n">{n}</div>
              <div className="d">{d}</div>
            </div>
            <div className="c">
              <Badge tone="ok">{st("强制")}</Badge>
            </div>
          </div>
        ))}
        <div className="srow">
          <div className="l">
            <div className="n">{st("punycode 同形域名提示")}</div>
            <div className="d">{st("审批卡高亮可疑主机")}</div>
          </div>
          <div className="c">
            <Switch on onChange={() => undefined} label={st("punycode 提示")} />
          </div>
        </div>
      </div>

      <div className="sgroup">
        <div className="gh">
          <Icon name="eye" size="sm" />
          {t("Effective 规则（只读 · 展示命中链）")}
          <span className="act">
            <button type="button" className="btn xs" onClick={() => toast(st("已复制 JSON"))}>
              <Icon name="copy" size="sm" />
            </button>
          </span>
        </div>
        <table className="usage-table" style={{ margin: 0 }}>
          <thead>
            <tr>
              <th>{st("工具")}</th>
              <th>global</th>
              <th>project</th>
              <th>mode=Code</th>
              <th>session</th>
              <th>{st("生效")}</th>
            </tr>
          </thead>
          <tbody>
            <EffRow
              tool="edit"
              cells={["require_approval", "require_approval", "require_approval", "auto"]}
              eff="require_approval"
              tone="warn"
            />
            <EffRow
              tool="bash"
              cells={["require_approval", "auto", "require_approval", "—"]}
              eff="require_approval"
              tone="warn"
            />
            <EffRow tool="read" cells={["auto", "auto", "auto", "—"]} eff="auto" tone="ok" />
            <EffRow tool="git_push" cells={["require_approval", "deny", "require_approval", "—"]} eff="deny" tone="err" />
          </tbody>
        </table>
      </div>

      <ContrastNote />
    </>
  );
}

function ToolRule({ tool, desc, def, scope }: { tool: string; desc: string; def: string; scope: string }): JSX.Element {
  const [policy, setPolicy] = useState(def);
  const [open, setOpen] = useState(["bash", "edit", "write"].includes(tool));
  const [extra, setExtra] = useState<{ matcher: string; policy: string }[]>(
    tool === "bash"
      ? [
          { matcher: "bun test *", policy: "auto" },
          { matcher: "rm -rf *", policy: "deny" },
        ]
      : [{ matcher: "**/.env", policy: "deny" }],
  );

  return (
    <>
      <div className="perm-rule">
        <div className="pl">
          <div className="n">
            <span className="mono">{tool}</span>
          </div>
          <div className="d">{desc}</div>
        </div>
        <select
          className="tri"
          value={policy}
          aria-label={st("{tool} 策略", { tool: tool })}
          onChange={e => {
            setPolicy(e.target.value);
            void client.invoke("permission_set", {
              scope: scope as never,
              tool,
              policy: e.target.value as never,
              exceptions: [],
            });
            toast(`${tool} → ${e.target.value}`);
          }}>
          {POLICIES.map(p => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <button type="button" className="btn xs" onClick={() => setOpen(v => !v)}>
          <Icon name="plus" size="sm" />
          {t("例外")}
        </button>
      </div>
      {open ? (
        <div className="exc">
          {extra.map(x => (
            <div className="er" key={x.matcher}>
              <span className={`lvl ${x.policy === "auto" ? "allow" : x.policy === "deny" ? "deny" : "ask"}`}>{x.policy}</span>
              <code>{x.matcher}</code>
              <span style={{ color: "var(--text-weaker)" }}>
                {x.policy === "deny" ? st("敏感项即使 auto 也拒绝") : st("放行")}
              </span>
              <span
                style={{ marginLeft: "auto", cursor: "pointer" }}
                role="button"
                tabIndex={0}
                aria-label={st("删除例外")}
                onClick={() => setExtra(list => list.filter(y => y.matcher !== x.matcher))}>
                <Icon name="trash" size="sm" />
              </span>
            </div>
          ))}
          <div className="addrow" style={{ marginTop: 6 }}>
            <input
              className="tinp mono"
              style={{ width: 190 }}
              placeholder="matcher：git commit *"
              aria-label={st("例外 matcher")}
            />
            <select className="tri" aria-label={st("例外策略")}>
              <option>auto</option>
              <option>deny</option>
            </select>
            <button type="button" className="btn xs" onClick={() => toast(st("已添加例外规则（取最严格者生效）"))}>
              <Icon name="plus" size="sm" />
              {t("添加")}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function EffRow({
  tool,
  cells,
  eff,
  tone,
}: {
  tool: string;
  cells: string[];
  eff: string;
  tone: "ok" | "warn" | "err";
}): JSX.Element {
  const color =
    tone === "ok"
      ? "var(--surface-success-strong)"
      : tone === "warn"
        ? "var(--surface-warning-strong)"
        : "var(--surface-critical-strong)";
  return (
    <tr>
      <td>{tool}</td>
      {cells.map((c, i) => (
        <td key={i}>{c}</td>
      ))}
      <td style={{ color }}>{eff}</td>
    </tr>
  );
}

function ContrastNote(): JSX.Element {
  const [report] = useState(() => {
    const cs = getComputedStyle(document.documentElement);
    return auditContrast(t => cs.getPropertyValue(t).trim());
  });
  return (
    <div className={`notice ${report.issues.length ? "warn" : "info"} spec`}>
      <Icon name={report.issues.length ? "alert" : "info"} size="sm" />
      <div>
        {t("当前皮肤对比度：")}
        {report.checked.map(c => ` ${contrastLabel(c.id)} ${c.ratio.toFixed(2)}:1${c.ok ? " ✓" : " ⚠"}`).join(" · ")}。
        {report.issues.length ? st("低于阈值，建议在皮肤管理点「自动提亮」。") : st("全部达标（正文 ≥4.5:1、次要 ≥3:1）。")}
      </div>
    </div>
  );
}
