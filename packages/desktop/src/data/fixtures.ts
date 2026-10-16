/**
 * 原型内的演示数据（fixture）。
 * 真实运行时由 Rust 经 IPC 下发（PLAN §9）；浏览器 mock transport 复用同一份形状，
 * 保证 UI 与协议在两种 transport 下行为一致。
 */

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  inputPrice: string;
  outputPrice: string;
  context: string;
  reasoning: boolean;
  vision: boolean;
  starred?: boolean;
  free?: boolean;
  bench?: string;
  desc: string;
}
export interface ModelGroup {
  group: string;
  items: ModelInfo[];
}

export const MODELS: ModelGroup[] = [
  {
    group: "收藏",
    items: [
      {
        id: "claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        provider: "Anthropic 兼容端点",
        inputPrice: "$3",
        outputPrice: "$15",
        context: "200K",
        reasoning: true,
        vision: true,
        starred: true,
        bench: "68.4",
        desc: "编码与推理均衡，工具调用稳定，长会话表现好。",
      },
    ],
  },
  {
    group: "推荐",
    items: [
      {
        id: "gpt-5",
        name: "GPT-5",
        provider: "OpenAI 兼容端点",
        inputPrice: "$1.25",
        outputPrice: "$10",
        context: "400K",
        reasoning: true,
        vision: true,
        bench: "72.1",
        desc: "长上下文与视觉，适合跨文件重构。",
      },
      {
        id: "deepseek-v3.2",
        name: "DeepSeek V3.2",
        provider: "api.deepseek.com",
        inputPrice: "$0.28",
        outputPrice: "$0.42",
        context: "128K",
        reasoning: true,
        vision: false,
        bench: "52.3",
        desc: "高性价比，中文语料好。",
      },
    ],
  },
  {
    group: "最常用",
    items: [
      {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        provider: "OpenAI 兼容端点",
        inputPrice: "$0.25",
        outputPrice: "$2",
        context: "400K",
        reasoning: false,
        vision: false,
        bench: "54.2",
        desc: "轻量快速，用于标题生成、摘要与提示词增强。",
      },
    ],
  },
  {
    group: "Anthropic 兼容端点",
    items: [
      {
        id: "claude-opus-4.1",
        name: "Claude Opus 4.1",
        provider: "Anthropic",
        inputPrice: "$15",
        outputPrice: "$75",
        context: "200K",
        reasoning: true,
        vision: true,
        bench: "74.5",
        desc: "复杂推理最强档，Plan 模式建议。",
      },
      {
        id: "claude-haiku-4",
        name: "Claude Haiku 4",
        provider: "Anthropic",
        inputPrice: "$0.8",
        outputPrice: "$4",
        context: "200K",
        reasoning: false,
        vision: false,
        bench: "41.0",
        desc: "低延迟，适合补全与内联改写。",
      },
    ],
  },
  {
    group: "本地 · Ollama",
    items: [
      {
        id: "qwen3-coder-32b",
        name: "Qwen3 Coder 32B",
        provider: "localhost:11434",
        inputPrice: "免费",
        outputPrice: "免费",
        context: "128K",
        reasoning: false,
        vision: false,
        free: true,
        bench: "38.4",
        desc: "本地运行，无数据外发；纯离线场景默认。",
      },
      {
        id: "qwen3-30b-think",
        name: "Qwen3 30B Thinking",
        provider: "localhost:11434",
        inputPrice: "免费",
        outputPrice: "免费",
        context: "128K",
        reasoning: true,
        vision: false,
        free: true,
        bench: "35.1",
        desc: "本地推理模型，思考链可见。",
      },
    ],
  },
  {
    group: "自建网关 · vLLM",
    items: [
      {
        id: "internal-sft",
        name: "internal-sft-v2",
        provider: "llm.corp.internal",
        inputPrice: "—",
        outputPrice: "—",
        context: "64K",
        reasoning: false,
        vision: false,
        free: true,
        desc: "企业内网微调模型（OpenAI 兼容）。",
      },
    ],
  },
];

export interface PopItem {
  header?: string;
  cmd?: string;
  desc?: string;
  icon?: string;
  scope?: string;
  kbd?: string;
  hint?: string;
}

export const SLASH: PopItem[] = [
  { header: "动作" },
  { cmd: "/new", desc: "新建会话（清空当前上下文）", icon: "plus" },
  { cmd: "/sessions", desc: "打开历史会话", icon: "history" },
  { cmd: "/models", desc: "选择模型", icon: "cpu" },
  { cmd: "/mode", desc: "切换 Ask / Plan / Code", icon: "compass" },
  { cmd: "/variant", desc: "切换推理强度", icon: "variant" },
  { cmd: "/compact", desc: "压缩当前上下文", icon: "archive" },
  { cmd: "/export", desc: "导出 Markdown 转录", icon: "download" },
  { cmd: "/revert", desc: "回退到上一条检查点", icon: "history" },
  { cmd: "/reload", desc: "重载 Skills / MCP 配置", icon: "refresh" },
  { cmd: "/settings", desc: "打开设置", icon: "sliders" },
  { header: "Skills · 自定义斜杠命令" },
  { cmd: "/review", desc: "代码评审（uncommitted / branch）", scope: "project", icon: "slash" },
  { cmd: "/commit-msg", desc: "生成提交信息", scope: "project", icon: "branch" },
  { cmd: "/migrate-sql", desc: "生成 SQLite 迁移脚本并跑测试", scope: "global", icon: "db" },
  { cmd: "/godot-patterns", desc: "Godot 4 GDScript 模式", scope: "global", icon: "book" },
];

export const MENTIONS: PopItem[] = [
  { header: "上下文条目" },
  { cmd: "@terminal", desc: "附加活动终端输出", icon: "terminal" },
  { cmd: "@git-changes", desc: "附加当前未提交变更", icon: "branch" },
  { cmd: "@past-chats", desc: "搜索并引用历史会话", icon: "chat" },
  { cmd: "@checkpoint", desc: "引用某次文件快照", icon: "history" },
  { cmd: "@…", desc: "浏览工作区外文件", icon: "folder-open" },
  { header: '文件 · 模糊匹配 "sto"' },
  { cmd: "@packages/opencode/src/session/store.ts", desc: "128 行 · 已打开", icon: "file" },
  { cmd: "@packages/opencode/src/session/", desc: "目录 · 12 项", icon: "folder" },
  { cmd: "@packages/opencode/test/session/store.test.ts", desc: "42 行", icon: "file" },
  { cmd: "@README.md", desc: "存储说明段落", icon: "file" },
];

export interface Project {
  id: string;
  name: string;
  path: string;
  sessions: number;
  isGit: boolean;
}
export const PROJECTS: Project[] = [
  { id: "opencode", name: "opencode", path: "~/code/opencode", sessions: 6, isGit: true },
  { id: "cloud-billing", name: "cloud-billing", path: "~/code/cloud-billing", sessions: 2, isGit: true },
  { id: "duocode", name: "duocode", path: "~/code/duocode", sessions: 3, isGit: true },
];

export interface SessionRow {
  id: string;
  title: string;
  when: string;
  activity: "run" | "ask" | "err" | "idle" | "";
  project: string;
  mode: string;
  model: string;
  messages: number;
  cost: string;
  diff: string;
}
export const SESSION_GROUPS: { group: string; items: SessionRow[] }[] = [
  {
    group: "今天",
    items: [
      {
        id: "s1",
        title: "给 SessionStore 加 SQLite 持久化",
        when: "刚刚",
        activity: "run",
        project: "opencode",
        mode: "Code",
        model: "sonnet-4.5",
        messages: 18,
        cost: "0.0421",
        diff: "+278 −100",
      },
      {
        id: "s2",
        title: "重构 diff 渲染性能",
        when: "09:12",
        activity: "ask",
        project: "opencode",
        mode: "Code",
        model: "sonnet-4.5",
        messages: 9,
        cost: "0.0182",
        diff: "+64 −12",
      },
      {
        id: "s3",
        title: "修复 MCP 超时不重试",
        when: "08:47",
        activity: "err",
        project: "opencode",
        mode: "Ask",
        model: "gpt-5-mini",
        messages: 5,
        cost: "0.0038",
        diff: "0",
      },
    ],
  },
  {
    group: "昨天",
    items: [
      {
        id: "s4",
        title: "支付模块设计评审",
        when: "昨天",
        activity: "",
        project: "cloud-billing",
        mode: "Plan",
        model: "opus-4.1",
        messages: 24,
        cost: "0.1210",
        diff: "0",
      },
      {
        id: "s5",
        title: "写 changelog 脚本",
        when: "昨天",
        activity: "",
        project: "duocode",
        mode: "Code",
        model: "sonnet-4.5",
        messages: 7,
        cost: "0.0091",
        diff: "+142 −3",
      },
    ],
  },
  {
    group: "本周",
    items: [
      {
        id: "s6",
        title: "升级 Solid 到 1.9",
        when: "周一",
        activity: "",
        project: "duocode",
        mode: "Code",
        model: "gpt-5",
        messages: 12,
        cost: "0.0333",
        diff: "+88 −51",
      },
      {
        id: "s7",
        title: "离线跑通 Qwen3 工具调用",
        when: "周一",
        activity: "",
        project: "opencode",
        mode: "Ask",
        model: "qwen3-30b-think",
        messages: 6,
        cost: "0.0000",
        diff: "0",
      },
    ],
  },
  {
    group: "更早",
    items: [
      {
        id: "s8",
        title: "本地 SQLite WAL 并发写排查",
        when: "8月21日",
        activity: "",
        project: "opencode",
        mode: "Code",
        model: "sonnet-4.5",
        messages: 31,
        cost: "0.0772",
        diff: "+12 −4",
      },
      {
        id: "s9",
        title: "皮肤系统 token 拆分",
        when: "8月18日",
        activity: "",
        project: "duocode",
        mode: "Plan",
        model: "sonnet-4.5",
        messages: 14,
        cost: "0.0215",
        diff: "+301 −288",
      },
    ],
  },
];

export interface TreeNode {
  name: string;
  depth: number;
  dir?: boolean;
  open?: boolean;
  lines?: string;
  selected?: boolean;
}
export const FILES: TreeNode[] = [
  { name: "packages/opencode/src", depth: 1, dir: true, open: true },
  { name: "session", depth: 2, dir: true, open: true },
  { name: "store.ts", depth: 3, selected: true, lines: "128" },
  { name: "sqlite-store.ts", depth: 3, lines: "214" },
  { name: "message-v2.ts", depth: 3, lines: "486" },
  { name: "index.ts", depth: 3, lines: "62" },
  { name: "snapshot", depth: 2, dir: true, lines: "" },
  { name: "permission", depth: 2, dir: true, lines: "" },
  { name: "packages/opencode/test/session", depth: 2, dir: true, lines: "" },
  { name: "duo.json", depth: 1, lines: "312" },
];

export interface GitFile {
  status: "M" | "A" | "D";
  path: string;
  added: number;
  deleted: number;
}
export const GITFILES: GitFile[] = [
  { status: "M", path: "packages/opencode/src/session/store.ts", added: 64, deleted: 12 },
  { status: "A", path: "packages/opencode/src/session/sqlite-store.ts", added: 214, deleted: 0 },
  { status: "M", path: "packages/opencode/test/session/store.test.ts", added: 42, deleted: 3 },
  { status: "D", path: "packages/opencode/src/session/json-store.ts", added: 0, deleted: 88 },
];

export const SNAPSHOTS = [
  { at: "09:44 · Turn 6 前", tool: "write sqlite-store.ts", oid: "7f2a1c9" },
  { at: "09:42 · Turn 4 前", tool: "edit store.ts", oid: "3b8de02" },
  { at: "09:41 · Turn 1 前", tool: "（基线）", oid: "a10c4f7" },
];

export interface McpServer {
  name: string;
  transport: "http" | "stdio" | "sse";
  status: "connected" | "needs_auth" | "failed" | "disabled" | "connecting";
  endpoint: string;
  tools: number;
  enabled: boolean;
  error?: string;
}
export const MCPS: McpServer[] = [
  { name: "context7", transport: "http", status: "connected", endpoint: "https://mcp.context7.com/mcp", tools: 4, enabled: true },
  {
    name: "filesystem",
    transport: "stdio",
    status: "connected",
    endpoint: "npx -y @modelcontextprotocol/server-filesystem ~/code",
    tools: 11,
    enabled: true,
  },
  {
    name: "playwright",
    transport: "stdio",
    status: "connected",
    endpoint: "npx @playwright/mcp@latest",
    tools: 22,
    enabled: true,
  },
  {
    name: "sqlite-mcp",
    transport: "stdio",
    status: "connected",
    endpoint: "uvx mcp-server-sqlite --db-path ./dev.db",
    tools: 6,
    enabled: true,
  },
  {
    name: "github",
    transport: "sse",
    status: "needs_auth",
    endpoint: "https://api.githubcopilot.com/mcp/",
    tools: 0,
    enabled: true,
  },
  {
    name: "linear",
    transport: "stdio",
    status: "failed",
    endpoint: "uvx mcp-server-linear",
    tools: 0,
    enabled: true,
    error: "ModuleNotFoundError: mcp_server_linear",
  },
];

export interface SkillRow {
  command: string;
  name: string;
  description: string;
  scope: "project" | "global";
  path: string;
  model: string;
  variant: string;
  enabled: boolean;
  systemPrompt: string;
}
export const SKILLS: SkillRow[] = [
  {
    command: "/review",
    name: "代码评审",
    description: "uncommitted / branch 两种目标",
    scope: "project",
    path: ".duo/commands/review.md",
    model: "GPT-5",
    variant: "high",
    enabled: true,
    systemPrompt:
      "评审目标：{{target|uncommitted}}\n1) 先列改动清单与影响面\n2) 按 严重度 排序输出发现，附 文件:行号\n3) 给出可执行的修复建议，不直接改文件",
  },
  {
    command: "/commit-msg",
    name: "提交信息",
    description: "按 conventional commits 生成",
    scope: "project",
    path: ".duo/commands/commit-msg.md",
    model: "GPT-5 Mini",
    variant: "默认",
    enabled: true,
    systemPrompt: "读取 git diff --cached，按 conventional commits 生成主题行 ≤72 字符。",
  },
  {
    command: "/migrate-sql",
    name: "SQL 迁移",
    description: "生成迁移脚本并跑测试",
    scope: "global",
    path: "~/.config/duo-desktop/skills/migrate-sql.md",
    model: "跟随对话",
    variant: "默认",
    enabled: true,
    systemPrompt: "生成 user_version 递增迁移，事务内 ALTER，迁移前备份 db。",
  },
  {
    command: "/godot-patterns",
    name: "Godot 模式",
    description: "信号 / 场景 / 状态机",
    scope: "global",
    path: "~/.config/duo-desktop/skills/godot-patterns.md",
    model: "跟随对话",
    variant: "默认",
    enabled: false,
    systemPrompt: "按 Godot 4 GDScript 惯例输出信号与状态机骨架。",
  },
];

export const TERMINALS = [
  { name: "bun test", pid: 48120, state: "running", dir: "~/code/opencode", cmd: "bun test ./test/session/" },
  { name: "dev server", pid: 47903, state: "idle", dir: "~/code/opencode", cmd: "bun run dev --port 5173" },
];

export const TASKS = [
  { name: "目录扫描 opencode", progress: 64, state: "run", detail: "12,480 / 19,500 · .gitignore 生效" },
  { name: "上下文压缩（Turn 7）", progress: 100, state: "done", detail: "摘要 1,842 tokens · 释放 61.4K" },
  { name: "MCP 重连 linear", progress: 33, state: "err", detail: "第 2/5 次退避重试 · ModuleNotFoundError" },
];

export interface Endpoint {
  name: string;
  url: string;
  key: string;
  models: number;
  status: "ok" | "unknown" | "error";
}
export const ENDPOINTS: Endpoint[] = [
  { name: "Anthropic 兼容端点", url: "https://api.anthropic.com/v1", key: "keychain", models: 12, status: "ok" },
  { name: "OpenAI 兼容端点", url: "https://api.openai.com/v1", key: "{env:OPENAI_API_KEY}", models: 6, status: "ok" },
  { name: "DeepSeek", url: "https://api.deepseek.com/v1", key: "keychain", models: 2, status: "ok" },
  { name: "Ollama（本地）", url: "http://localhost:11434/v1", key: "留空", models: 9, status: "ok" },
  { name: "自建网关 vLLM", url: "https://llm.corp.internal/v1", key: "{env:CORP_TOKEN}", models: 3, status: "unknown" },
];

/** 内置工具集（PLAN §6.5：rpi-tools + 桌面补充） */
export const TOOLS: [string, string, "auto" | "require_approval" | "deny"][] = [
  ["read", "读取文件（含截断策略）", "auto"],
  ["list", "列目录", "auto"],
  ["glob", "文件名匹配", "auto"],
  ["grep", "内容检索", "auto"],
  ["write", "新建文件", "require_approval"],
  ["edit", "精确替换", "require_approval"],
  ["apply_patch", "应用补丁", "require_approval"],
  ["bash", "执行 shell 命令", "require_approval"],
  ["todo", "任务清单", "auto"],
  ["ask_user", "向用户提问", "auto"],
  ["git_status", "读取 git 状态", "auto"],
  ["git_diff", "读取 diff", "auto"],
  ["git_commit", "提交", "require_approval"],
  ["git_push", "推送", "require_approval"],
  ["mcp:*", "MCP 工具（按 server 单独设策）", "require_approval"],
];

export const VARIANTS = ["默认", "low", "medium", "high", "xhigh"];
export const VARIANT_DESC = ["沿用模型默认", "更快、更省 token", "均衡", "深度推理，steps +", "最长思考，适合架构决策"];

export const MODES: { id: "Ask" | "Plan" | "Code"; desc: string; icon: string }[] = [
  { id: "Ask", desc: "仅问答，不改文件也不执行命令", icon: "chat" },
  { id: "Plan", desc: "只读探索并产出计划，批准后转 Code", icon: "bulb" },
  { id: "Code", desc: "完整读写与命令执行", icon: "compass" },
];

/** 单点事实源：跨屏共享的计数（避免同屏矛盾） */
export const ST = {
  cost: "0.0421",
  ctx: 34,
  branch: "dev",
  ahead: 1,
  behind: 0,
  diff: { a: GITFILES.reduce((n, f) => n + f.added, 0), d: GITFILES.reduce((n, f) => n + f.deleted, 0) },
  mcp: [MCPS.filter(m => m.status === "connected").length, MCPS.length] as [number, number],
  changes: GITFILES.length,
  files: "12,480",
  tasks: TASKS.length,
  terms: TERMINALS.length,
  pend: 1,
};
