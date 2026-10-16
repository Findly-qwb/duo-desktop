/**
 * 场景种子（原型 SCENES 的等价数据化）
 * 屏 ≠ 页面：多数「屏」是同一对话视图的不同状态，用 part 序列描述，
 * 由真实渲染组件消费（而不是硬编码 HTML），保证「实现即原型」。
 */
import type { DiffLine, PartContent } from "../ipc/protocol";
import type { Outcome } from "../ipc/store";
import { ST } from "./fixtures";

export interface ChatMessageSeed {
  id: string;
  role: "user" | "assistant";
  mode?: string;
  model?: string;
  agent?: string;
  time?: string;
  duration?: string;
  turnIndex?: number;
  checkpointOid?: string;
  /** 附件缩略条（图片 Base64 直传视觉模型） */
  attach?: { name: string; src: string }[];
  parts: PartContent[];
}

export interface Scene {
  messages: ChatMessageSeed[];
  busy?: boolean;
  outcome?: Outcome;
  context?: { used: number; reserved: number; window: number; autoCompactAt: number; hitRate: number };
  usage?: { cost: string; tokens: { prompt: number; completion: number; reasoning: number; cacheRead: number }; steps: number };
  /** 顶部横幅（需要关注 / 恢复 / 重载） */
  banner?: { tone: "info" | "warn" | "ok" | "err"; icon: string; text: string };
  /** 输入区状态 */
  composer?: {
    pop?: "slash" | "mention" | "model" | "shield" | "mode" | "variant";
    value?: string;
    images?: boolean;
    dragover?: boolean;
    enhanced?: boolean;
    hint?: string;
  };
  search?: boolean;
  railMarks?: ("cur" | "err" | "")[];
  /** Revert 横幅（回退后提供 Redo / Redo All） */
  revert?: { label: string; files: string; stat: string; detail: string };
  /** 三队列快照（steering / follow-up 排队项） */
  queues?: {
    main: { id: string; text: string }[];
    steering: { id: string; text: string }[];
    follow_up: { id: string; text: string }[];
  };
}

const CTX = { used: 68200, reserved: 24000, window: 200000, autoCompactAt: 92, hitRate: 93 };

const d = (kind: DiffLine["kind"], text: string): DiffLine => ({ kind, text });

/** 通用用户消息（原型 USER_SQLITE） */
const userSqlite = (id = "u1"): ChatMessageSeed => ({
  id,
  role: "user",
  mode: "Code",
  model: "sonnet-4.5",
  time: "09:41",
  checkpointOid: "a10c4f7",
  parts: [
    {
      type: "text",
      md: `<p>给 <span class="chip" data-icon="file" data-open="packages/opencode/src/session/store.ts">packages/opencode/src/session/store.ts</span> 加上 SQLite 持久化，参考 <span class="chip img" data-icon="image">会话截图.png</span> 里的表结构设计。跑一下测试。</p>`,
    },
  ],
});

const assistant = (id: string, parts: PartContent[], extra: Partial<ChatMessageSeed> = {}): ChatMessageSeed => ({
  id,
  role: "assistant",
  model: extra.model ?? "claude-sonnet-4.5",
  ...extra,
  parts,
});

const storeDiff: DiffLine[] = [
  d("hunk", "@@ -15,9 +15,11 @@ export class SessionStore {"),
  d("del", "-  private map = new Map<string, Session>()"),
  d("add", "+  private db: Database"),
  d("add", "+  private stmts: Record<string, Statement>"),
  d("ctx", " "),
  d("ctx", "   constructor(dir: string) {"),
  d("del", "-    this.map = new Map()"),
  d("add", '+    this.db = new Database(join(dir, "duo-desktop.db"))'),
  d("add", "+    this.db.run(PRAGMA_WAL)"),
  d("add", "+    this.migrate()"),
  d("ctx", "   }"),
];

const SQLITE_SRC = `import { Database, Statement } from "bun:sqlite"

const SCHEMA = \`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  title TEXT, cost REAL NOT NULL DEFAULT 0, updated INTEGER
)\`

export class SqliteStore {
  constructor(dir: string) { this.db = new Database(dir + "/duo-desktop.db") }
}`;

const STORE_SRC = `export class SessionStore {
  private map = new Map<string, Session>()
  load(id: string) { return this.map.get(id) }
  save(s: Session) { this.map.set(s.id, s) }
}`;

export const SCENES: Record<string, Scene> = {
  /* --- 0. 欢迎空态 --- */
  welcome: { messages: [] },

  /* --- 1. 流式生成中（三栏全开） --- */
  "chat-stream": {
    context: CTX,
    usage: { cost: "$0.0421", tokens: { prompt: 4800, completion: 2200, reasoning: 800, cacheRead: 61200 }, steps: 9 },
    railMarks: ["cur", "", ""],
    busy: true,
    messages: [
      userSqlite(),
      assistant(
        "a1",
        [
          {
            type: "reasoning",
            text: 'session store 目前是内存 Map。引入 <code class="inline">bun:sqlite</code>，保持接口不变，把 load/save 改为 SQL；迁移时做一次全量落盘。',
            durationMs: 2140,
            collapsed: false,
          },
          {
            type: "text",
            md: `<p>好的。方案：<span class="filelink" data-open="packages/opencode/src/session/store.ts">packages/opencode/src/session/store.ts:18</span> 内把内存 Map 换成 SQLite（<code class="inline">bun:sqlite</code>），表结构对齐截图里的 <code class="inline">sessions / messages / parts</code> 三表。</p>`,
          },
          {
            type: "tool",
            tool: "read",
            title: "Read",
            sub: "session/store.ts",
            state: "done",
            icon: "file",
            meta: { verified: "full" },
            output: STORE_SRC,
          },
          {
            type: "tool",
            tool: "grep",
            title: "Grep",
            sub: '"SessionStore" → 14 处命中',
            state: "done",
            icon: "search",
            output: `packages/opencode/src/session/store.ts:18:export class SessionStore {\npackages/opencode/src/session/index.ts:4:import { SessionStore } from "./store"\npackages/opencode/test/session/store.test.ts:9:const store = new SessionStore()`,
          },
          {
            type: "tool",
            tool: "todo",
            title: "To-dos",
            sub: "2/4",
            state: "running",
            icon: "list-checks",
            todos: [
              { text: "设计 sessions/messages/parts 表结构", state: "done" },
              { text: "实现 SqliteStore（load/save/delete）", state: "done" },
              { text: "迁移脚本：旧 JSON 会话导入", state: "cur", note: "60%" },
              { text: "补充 store 单元测试" },
            ],
          },
          { type: "text", md: `<p>正在写入 <code class="inline">sqlite-store.ts</code>：<span class="cursor"></span></p>` },
        ],
        { duration: "流式中" },
      ),
    ],
  },

  /* --- 2. 读取类工具卡 --- */
  "tool-read": {
    railMarks: ["cur"],
    messages: [
      assistant("a1", [
        { type: "text", md: "<p>先把相关目录摸清楚。</p>" },
        {
          type: "tool",
          tool: "read",
          title: "Read",
          sub: "session/store.ts · 1–128 行",
          state: "done",
          icon: "file",
          meta: { verified: "full" },
          output: STORE_SRC,
        },
        {
          type: "tool",
          tool: "list",
          title: "List",
          sub: "packages/opencode/src/session/",
          state: "done",
          icon: "folder-open",
          output:
            "index.ts  message.ts  session.ts  store.ts  status.ts  summary.ts\nrevert.ts  snapshot/  permission/  todo/  context/  instruction/",
        },
        {
          type: "tool",
          tool: "glob",
          title: "Glob",
          sub: "**/*.test.ts · 42 个文件",
          state: "done",
          icon: "search",
          output: "test/session/store.test.ts\ntest/session/snapshot.test.ts\ntest/tool/tool-define.test.ts\n… 39 more",
        },
        {
          type: "tool",
          tool: "grep",
          title: "Grep",
          sub: "bun:sqlite → 3 处",
          state: "done",
          icon: "search",
          output:
            'packages/opencode/src/storage/db.ts:1:import { Database } from "bun:sqlite"\npackages/opencode/src/storage/db.ts:35:const db = new Database(Global.Path.data + "/duo-desktop.db")',
        },
        {
          type: "tool",
          tool: "read",
          title: "Read",
          sub: "未找到 · legacy/store.ts",
          state: "error",
          icon: "file",
          error: "ENOENT: no such file or directory",
        },
      ]),
    ],
  },

  /* --- 3. Bash 工具卡 --- */
  "tool-bash": {
    railMarks: ["cur", "", ""],
    busy: true,
    messages: [
      userSqlite(),
      assistant("a1", [
        { type: "text", md: "<p>跑一遍 store 单测验证。</p>" },
        {
          type: "tool",
          tool: "bash",
          title: "Running Command",
          sub: "跑 store 单元测试",
          state: "running",
          icon: "terminal",
          isCommand: true,
          output: `bun test v1.3.2 (a2f3b1c)

test/session/sqlite-store.test.ts:
✓ SqliteStore > creates schema on first open
✓ SqliteStore > round-trips session + messages + parts
✓ SqliteStore > deletes session cascade to parts
› SqliteStore > migrates legacy json  …
`,
        },
        {
          type: "tool",
          tool: "bash",
          title: "Command completed",
          sub: "exit 0 · 1.42s",
          state: "done",
          icon: "terminal",
          isCommand: true,
          meta: { verified: "full", durationMs: 1420 },
          output: `bun test ./test/session/sqlite-store.test.ts

 4 pass
 0 fail
 12 expect() calls
Ran 4 tests across 1 file. [1.42s]`,
        },
      ]),
    ],
  },

  /* --- 4. 编辑类工具卡 --- */
  "tool-edit": {
    railMarks: ["cur", "", ""],
    messages: [
      assistant("a1", [
        { type: "text", md: "<p>替换内存 Map 为 SQLite 实现。</p>" },
        {
          type: "tool",
          tool: "edit",
          title: "Edit",
          sub: "session/store.ts",
          state: "done",
          icon: "diff",
          stat: { added: 64, deleted: 12 },
          diff: storeDiff,
          meta: { verified: "full" },
        },
        {
          type: "tool",
          tool: "write",
          title: "Write",
          sub: "session/sqlite-store.ts · 新建 214 行",
          state: "done",
          icon: "file",
          stat: { added: 214, deleted: 0 },
          output: SQLITE_SRC,
        },
        {
          type: "tool",
          tool: "apply_patch",
          title: "Apply Patch",
          sub: "3 个文件 · 会话存储迁移",
          state: "done",
          icon: "diff",
          stat: { added: 278, deleted: 100 },
          paths: [
            "packages/opencode/src/session/store.ts",
            "packages/opencode/src/session/sqlite-store.ts",
            "packages/opencode/test/session/store.test.ts",
            "packages/opencode/src/session/json-store.ts",
          ],
        },
      ]),
    ],
  },

  /* --- 5. 检索类工具卡 --- */
  "tool-web": {
    railMarks: ["cur"],
    messages: [
      assistant("a1", [
        {
          type: "tool",
          tool: "grep",
          title: "WebSearch",
          sub: "bun:sqlite WAL 并发写入 · 6 条结果",
          state: "done",
          icon: "globe",
          output:
            "bun:sqlite WAL mode concurrency|oven.sh · 2026-04-11 · WAL 允许单写多读；跨线程需独占连接。\nSQLite busy_timeout in Bun|bun.com/docs · busy_timeout=5000 覆盖 99% 写冲突场景。\nduo-desktop.db schema design|github.com/duo-Org · sessions/messages/parts 三表 + JSON 列。",
        },
        {
          type: "tool",
          tool: "grep",
          title: "WebFetch",
          sub: "https://bun.com/docs/runtime/sqlite",
          state: "done",
          icon: "download",
          meta: { truncated: true },
          output:
            "Bun SQLite provides a fast, synchronous binding…\n• Database(path, { create: true })\n• .query(sql).all(params)\n• .run() returns { changes, lastInsertRowid }\n\n… 输出已截断（24.3 KB / 上限 32 KB 内）",
        },
      ]),
    ],
  },

  /* --- 6. To-dos --- */
  "tool-todo": {
    railMarks: ["cur"],
    messages: [
      assistant("a1", [
        {
          type: "tool",
          tool: "todo",
          title: "To-dos",
          sub: "3/5 · 目标模式",
          state: "running",
          icon: "list-checks",
          todos: [
            { text: "设计 sessions/messages/parts 表结构", state: "done", note: "0:42" },
            { text: "实现 SqliteStore（load/save/delete）", state: "done", note: "2:18" },
            { text: "迁移脚本：旧 JSON 会话导入", state: "done", note: "1:05" },
            { text: "补充 store 单元测试（并发写用例）", state: "cur", note: "进行中" },
            { text: "更新 README 存储说明与 duo-desktop.db 路径" },
          ],
        },
      ]),
    ],
  },

  /* --- 7. ask_user 内联卡 --- */
  "tool-question": {
    railMarks: ["cur"],
    messages: [
      assistant("a1", [
        {
          type: "question",
          questionId: "q-inline",
          index: 0,
          questions: [
            {
              q: "旧 JSON 会话要自动迁移吗？",
              options: [
                { label: "自动迁移", detail: "首次启动导入并改名 .bak" },
                { label: "只迁移当前项目", detail: "按目录懒迁移" },
              ],
              allowCustom: true,
            },
            {
              q: "迁移失败时？",
              options: [{ label: "中止并保留原文件" }, { label: "跳过坏行继续" }],
              allowCustom: true,
            },
          ],
        },
      ]),
    ],
  },

  /* --- 8. 子任务 / Skill 注入 --- */
  "tool-task": {
    railMarks: ["cur", "", ""],
    messages: [
      assistant(
        "a1",
        [
          { type: "text", md: "<p>把耗时检索放到后台跑，主回合继续推进。</p>" },
          {
            type: "tool",
            tool: "task",
            title: "子任务 · 检索调用点",
            sub: "定位 SessionStore 全部引用",
            state: "running",
            icon: "bot",
            source: "subagent",
            agent: "explore",
            meta: { durationMs: 18200 },
            nested: [
              { type: "tool", tool: "grep", title: "Grep", sub: '"SessionStore" · 14 命中', state: "done", icon: "search" },
              { type: "tool", tool: "read", title: "Read", sub: "session/index.ts:1–62", state: "done", icon: "file" },
              {
                type: "tool",
                tool: "bash",
                title: "Bash",
                sub: "bun run typecheck",
                state: "running",
                icon: "terminal",
                isCommand: true,
              },
              { type: "text", md: '<p>已找到 14 处引用，正在核对类型契约…<span class="cursor"></span></p>' },
            ],
          },
          {
            type: "tool",
            tool: "skill",
            title: "Skill",
            sub: "duocode-merge-minimizer",
            state: "done",
            icon: "sparkle",
            source: "skill",
            output: "读取 .duo/skills/duocode-merge-minimizer/SKILL.md · 决策：duocode_change 标记放在共享文件行内",
          },
        ],
        { agent: "后台子任务" },
      ),
    ],
  },

  /* --- 9. MCP 泛用卡 --- */
  "tool-mcp": {
    railMarks: ["cur"],
    messages: [
      assistant("a1", [
        {
          type: "tool",
          tool: "mcp:context7:resolve-library-id",
          title: "mcp:context7 · resolve-library-id",
          sub: "effect-ts",
          state: "done",
          icon: "zap",
          source: "mcp",
          meta: { durationMs: 800 },
          output: '{ "id": "/effect/EAXM4W8W", "name": "effect", "versions": ["3.x","2.x"] }',
        },
        {
          type: "tool",
          tool: "mcp:context7:query-docs",
          title: "mcp:context7 · query-docs",
          sub: "effect/Database sqlite adapter",
          state: "done",
          icon: "zap",
          source: "mcp",
          output:
            "effect/sql/SQLite — makeDefault 与 layer 组装|relevance 0.82\nMigration 服务：runMigrations 顺序保证|relevance 0.74",
        },
        {
          type: "tool",
          tool: "mcp:linear:create_issue",
          title: "mcp:linear · create_issue",
          state: "error",
          icon: "zap",
          source: "mcp",
          error: "needs_auth：该 MCP 未完成 OAuth 登录，无法调用写操作。",
        },
      ]),
    ],
  },

  /* --- 10. 回合结果条四态 --- */
  "outcome-done": {
    outcome: {
      kind: "done",
      title: "完成",
      detail: "9 steps · 1m 42s · $0.0421 · 42.1 tok/s",
      steps: 9,
      duration: "1m 42s",
      cost: "$0.0421",
      throughput: "42.1 tok/s",
    },
    railMarks: ["cur", "", ""],
    messages: [
      assistant("a1", [
        { type: "text", md: "<p>测试全绿，改动已落盘。共 9 步、3 个文件。</p>" },
        {
          type: "tool",
          tool: "bash",
          title: "Command completed",
          sub: "4 pass · 0 fail",
          state: "done",
          icon: "terminal",
          isCommand: true,
          output: "bun test ./test/session/sqlite-store.test.ts\n 4 pass\n 0 fail",
        },
      ]),
    ],
  },
  "outcome-stop": {
    outcome: { kind: "stopped", title: "已中断（Esc）", detail: "保留已生成内容，可 Revert 或继续" },
    railMarks: ["cur"],
    messages: [assistant("a1", [{ type: "text", md: "<p>正在生成迁移脚本…</p>" }])],
  },
  "outcome-error": {
    outcome: {
      kind: "error",
      title: "失败",
      detail: "SQLite: disk I/O error (SQLITE_IOERR) · 3 steps · $0.0038",
      cost: "$0.0038",
      steps: 3,
    },
    railMarks: ["cur", "err"],
    messages: [assistant("a1", [{ type: "text", md: "<p>执行迁移时出错。</p>" }])],
  },
  "outcome-limit": {
    outcome: { kind: "limit", title: "已达会话花费上限 $5.00", detail: "继续需要显式批准" },
    railMarks: ["cur", "", ""],
    messages: [],
  },

  /* --- 11. 错误卡集合 --- */
  "err-set": {
    context: { used: 192000, reserved: 8000, window: 200000, autoCompactAt: 92, hitRate: 41 },
    railMarks: ["cur", "", "", ""],
    messages: [
      assistant("a1", [
        {
          type: "error",
          code: "401",
          variant: "auth",
          title: "端点返回 401 Unauthorized",
          badge: "Anthropic 兼容端点",
          body: "API key 无效或已轮换。密钥只存本机 keychain，不写入配置与日志。",
          actions: ["update-key", "switch-model"],
        },
        {
          type: "error",
          code: "429",
          variant: "rate",
          title: "端点限流（429）",
          badge: "api.deepseek.com",
          body: "该端点返回 too many requests，runtime 正按指数退避排队重试。",
          progress: 81,
          actions: ["switch-model", "retry-now"],
        },
        {
          type: "error",
          code: "no-provider",
          variant: "provider",
          title: "未配置可用端点",
          badge: "providers",
          body: "还没有任何 OpenAI 兼容端点。填一个 base URL 即可开始；本地 Ollama 可留空密钥。",
          actions: ["add-endpoint", "onboard"],
        },
        {
          type: "error",
          code: "timeout",
          variant: "retry",
          title: "连接超时，正在重试",
          body: "runtime → llm.corp.internal 连接超时（第 2/5 次，退避 4s）。",
          progress: 40,
          retryInMs: 3000,
          badge: "第 2/5 次",
          actions: ["cancel-retry"],
        },
      ]),
    ],
  },

  /* --- 12. 审批 / 提问 / 排队 --- */
  "perm-dock": {
    railMarks: ["cur", "", ""],
    busy: true,
    messages: [
      assistant(
        "a1",
        [
          { type: "text", md: "<p>需要先跑测试验证迁移结果。</p>" },
          {
            type: "approval",
            callId: "call-bash-1",
            tool: "bash",
            source: "bash · 主回合 · 命中 global require_approval",
            kind: "command",
            command: "bun test ./test/session/sqlite-store.test.ts",
            matchedRule: "global bash = require_approval",
            hint: "该命令将修改你的系统。允许一次，或为同类命令放行。",
            expiresAt: Date.now() + 30 * 60 * 1000,
            editable: true,
          },
        ],
        { agent: "explore" },
      ),
    ],
  },
  "perm-edit": {
    railMarks: ["cur", "", ""],
    busy: true,
    messages: [
      {
        id: "a1",
        role: "assistant",
        model: "claude-sonnet-4.5",
        parts: [
          {
            type: "approval",
            callId: "call-edit-1",
            tool: "edit",
            source: "edit · 主代理",
            kind: "diff",
            paths: [
              "packages/opencode/src/session/store.ts",
              "packages/opencode/src/session/sqlite-store.ts（新建）",
              "packages/opencode/src/session/json-store.ts（删除）",
            ],
            diff: storeDiff.slice(0, 4),
            hint: "这些改动会写入你的工作区，允许后可逐个 Revert。",
            matchedRule: "Code 模式默认 write = require_approval",
            expiresAt: Date.now() + 30 * 60 * 1000,
            editable: true,
          },
        ],
      },
    ],
  },
  "q-dock": {
    railMarks: ["cur", "", ""],
    messages: [
      assistant("a1", [
        {
          type: "question",
          questionId: "q-dock",
          index: 0,
          questions: [
            {
              q: "旧 JSON 会话文件要自动迁移进 SQLite 吗？",
              options: [
                { label: "自动迁移", detail: "首次启动时把 .json 会话导入 SQLite，原文件改名 .bak" },
                { label: "只迁移当前项目", detail: "按项目目录懒迁移，其余保留 JSON 双读" },
                { label: "输入自定义答案…", detail: "Type your own answer" },
              ],
              allowCustom: true,
            },
            {
              q: "迁移失败时怎么处理？",
              options: [
                { label: "中止并保留原文件", detail: "回滚整个导入事务" },
                { label: "跳过坏行继续", detail: "记录坏行到 logs 表" },
              ],
              allowCustom: true,
            },
          ],
        },
      ]),
    ],
  },
  queued: {
    railMarks: ["cur", "", ""],
    busy: true,
    queues: {
      main: [],
      steering: [{ id: "q1", text: "顺便把 README 里的存储说明也更新一下" }],
      follow_up: [{ id: "q2", text: "最后把 README 的存储章节也更新" }],
    },
    messages: [
      assistant("a1", [
        { type: "text", md: '<p>收到，我把这两条放进队列，当前回合结束后按顺序执行。<span class="cursor"></span></p>' },
      ]),
    ],
  },

  /* --- 13. Revert / 检查点 --- */
  revert: {
    railMarks: ["cur", "", ""],
    revert: {
      label: "09:41 的消息",
      files: "3 个文件",
      stat: "+214 −36",
      detail: "store.ts +64 −12 · sqlite-store.ts +214 · json-store.ts −88",
    },
    messages: [
      userSqlite(),
      assistant("a1", [
        {
          type: "text",
          md: '<p>上一版实现已回退。这次改为在 <code class="inline">storage/db.ts</code> 复用现有连接，避免双库。</p>',
        },
        {
          type: "tool",
          tool: "edit",
          title: "Edit",
          sub: "session/store.ts",
          state: "done",
          icon: "diff",
          stat: { added: 18, deleted: 4 },
        },
      ]),
    ],
  },

  /* --- 14. 压缩 --- */
  compact: {
    context: { used: 184000, reserved: 8000, window: 200000, autoCompactAt: 92, hitRate: 61 },
    railMarks: ["cur", "", "", ""],
    messages: [
      assistant("a0", [{ type: "compact", summaryTokens: 1842, kept: 12, releasedTokens: 61400, autoCompactAt: 92 }]),
      userSqlite(),
      assistant("a1", [{ type: "text", md: "<p>压缩后继续：迁移脚本已完成，接下来补并发写测试。</p>" }]),
    ],
  },

  /* --- 15. 转录搜索 --- */
  search: {
    search: true,
    railMarks: ["cur", "", ""],
    messages: [
      userSqlite(),
      assistant("a1", [
        {
          type: "text",
          md: `<p>持久化落点选 <code class="inline">Global.Path.data/duo-desktop.db</code>，与 CLI/扩展同库；<mark class="cur">SQLite</mark> WAL 模式支持单写多读。</p>
<div class="tool"><div class="thead"><span class="ti" data-icon="file"></span><span class="tname">Read</span><span class="tsub">storage/db.ts</span><span class="tstat">35 行</span></div>
<div class="tbody"><pre>const db = new Database(Global.Path.data + "/duo-desktop.db")  // <mark>SQLite</mark> WAL</pre></div></div>`,
        },
        { type: "text", md: "<p>迁移脚本按项目目录懒执行，历史 <mark>SQLite</mark> 表结构不变。</p>" },
      ]),
    ],
  },

  /* --- 16. 浮层 --- */
  "pop-slash": { messages: [], composer: { pop: "slash", value: "/" } },
  "pop-mention": { messages: [], composer: { pop: "mention", value: "@sto" } },
  "pop-model": { messages: [], composer: { pop: "model" } },
  "pop-shield": { messages: [], composer: { pop: "shield" } },
  "pop-mode": { messages: [], composer: { pop: "mode" } },
  "pop-variant": { messages: [], composer: { pop: "variant" } },

  /* --- 17. 附件 / 增强 / Goal / 重载 --- */
  attach: { messages: [], composer: { images: true, value: "参考这两张图的表结构" } },
  dragover: { messages: [], composer: { dragover: true } },
  enhance: { messages: [], composer: { value: "给 store 加 sqlite 持久化", enhanced: true } },
  goal: {
    railMarks: ["cur", "", ""],
    banner: {
      tone: "info",
      icon: "target",
      text: "<b>Goal 模式</b>：/goal 让代理跨回合持续推进同一目标，直到验收条件满足。运行中可暂停 / 恢复 / 清除。",
    },
    outcome: { kind: "limit", title: "Goal 运行中 · 4/7 步", detail: "已用 $0.184 · 预计还需 3 步" },
    messages: [
      assistant("a1", [
        {
          type: "tool",
          tool: "todo",
          title: "Goal",
          state: "running",
          icon: "target",
          todos: [
            { text: "目标：SessionStore 迁移到 SQLite 且测试全绿", state: "done" },
            { text: "阶段 1：表结构与读写路径", state: "done" },
            { text: "阶段 2：迁移脚本", state: "done" },
            { text: "阶段 3：并发写测试（4/7 步）", state: "cur" },
            { text: "阶段 4：README 与变更日志" },
          ],
        },
      ]),
    ],
  },
  reload: {
    railMarks: ["cur"],
    banner: {
      tone: "ok",
      icon: "refresh",
      text: "已重载：<b>+2</b> Skills · <b>+1</b> Agent · <b>+3</b> Commands（/reload）。斜杠菜单与 @ 提及即时生效。",
    },
    messages: [
      assistant("a1", [
        { type: "tool", tool: "skill", title: "Skills", sub: "godot-gdscript-patterns · chart", state: "done", icon: "book" },
        { type: "tool", tool: "skill", title: "Agents", sub: "reviewer（自定义）", state: "done", icon: "bot" },
        { type: "tool", tool: "skill", title: "Commands", sub: "/review /memory /commit-msg", state: "done", icon: "workflow" },
      ]),
    ],
  },
};

export type SceneId = keyof typeof SCENES | string;
export { ST };
