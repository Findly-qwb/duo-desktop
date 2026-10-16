# Duo Desktop 设计方案 v2.1（Tauri + 开源 rpi Agent Runtime + React）



## 1. 产品目标与核心特性

轻量、原生、本地优先的桌面 Agent 客户端。Rust 主进程内嵌入开源 **rpi** Agent Runtime（不再自研），系统 WebView 只做渲染与交互，无 Node 侧车、无本地 HTTP 服务、无账号依赖。UI 极简克制：左右栏可折叠，中间对话区始终是视觉主角。

核心特性（首版范围）：

- 实时流式对话，Markdown 渲染与代码高亮，思考链折叠
- 本地 SQLite 持久化会话，断点恢复（队列状态 + 文件快照）
- 三队列 Agent Harness（main / steering / follow-up），Turn 内批量执行工具（由 `rpi-agent` 提供）
- 细粒度工具权限（DENY / REQUIRE_APPROVAL / AUTO），人工审批卡片支持改参数后执行
- 三种交互模式 Ask / Plan / Code
- 项目文件树感知、文件勾选加入上下文、内嵌预览
- 文件与图片附件，图片 Base64 直传视觉模型（不内置 OCR）
- MCP 客户端（stdio / SSE / HTTP）
- 自定义 Skills（斜杠命令）
- Git 集成：状态 / 暂存 / 提交 / 推送 / AI 提交信息 / 逐消息 Revert-Redo
- Token 用量追踪与**费用估算**（界面明示"仅为估算，非实际账单"）

明确不做：账号与计费、云端同步与分享、市场、多代理编排面板、SSH、内网穿透、语音输入、行内补全、语义索引。

---

## 2. 技术选型总览

| 层级 | 选型 | 理由 |
|---|---|---|
| 桌面容器 | Tauri v2 | Rust 主进程 + 系统 WebView；原生 IPC 事件流，无 HTTP/SSE 服务与额外进程 |
| 前端 | React 19 + TypeScript | 生态与招聘面；组件化；React 19 的 `useActionState`/`useFormStatus` 原生建模审批确认卡 [v2.1] |
| 样式 | Tailwind CSS 4 + Tabler Icons | 原子化 + token 化，皮肤系统成本低；线性图标风格统一 |
| 设计系统（**唯一**）[v2.1] | `@base-ui/react`（headless 原语）+ Tailwind 4 + 自建 `@duo/ui` 包 | 全站仅此一套设计系统（不引 antd / @lobehub/ui）；组件源码自己持有，参照 shadcn / coss 的 Base UI 写法逐个抄进 `@duo/ui`，**不跑 `shadcn init`**；组件收进 `@duo/ui` 并加导入方向门禁（见 §15） |
| 代码质量 [v2.1] | Biome 2.x | 统一 lint/format（不引 ESLint/Prettier），monorepo 多包检查快一个量级 |
| 聊天功能件 [v2.1] | `@assistant-ui/react`（**降级为消息流渲染件，不承载设计系统**） | 流式 Markdown、代码块、工具卡有现成抽象，避免自造消息状态机；但审批卡 / 右键菜单等 Agent 特有交互按其「可能绕开原语、自接管焦点与状态」设计（见 §5.2、§12 Spike②）|
| Agent Runtime | **开源 rpi（`bigfish1913/pi-rust`，MIT）** | 库优先可嵌入：`rpi-agent`（Agent 循环/事件/队列/取消）+ `rpi-ai`（provider 无关流式）+ `rpi-tools`（read/write/edit/bash/grep…）+ `rpi-harness`（会话树/JSONL/压缩/崩溃恢复）；**不自研** |
| 异步运行时 | Tokio | 工具并发、MCP 子进程 IO、LLM 流式解析（与 rpi 一致） |
| 持久化 | SQLite（`rusqlite` bundled） | 桌面侧会话/权限/检查点/配置全本地（rpi 自身的会话树不作为桌面事实来源） |
| LLM 接入 | `rpi-ai` providers（OpenAI 兼容 / Anthropic） | 一套适配 Ollama / vLLM / DeepSeek / 兼容网关；桌面只做端点配置与 keychain |
| 工具扩展 | `rpi-tools` 内置工具 + MCP 客户端 | 工具语义由 rpi 提供；MCP 侧保留最小自研客户端（rpi 扩展走插件 ABI，不覆盖 MCP） |
| Git | 系统 `git` CLI（`std::process`） | 见 §7.1 |
| 多模态 | 图片 Base64 直传 | 不引入 OCR 引擎 |

---

## 3. 整体架构

### 3.1 分层

```
┌────────────────────── WebView（React）──────────────────────┐
│  左栏 220px        中间核心区 flex:1        右栏 280px(可折) │
│  · Logo/产品名     · 顶部：模型/模式/主题   · 能力入口卡片   │
│  · 导航：Skills    · 空态欢迎 + 快捷卡片    · 终端/文件树    │
│    /MCP/新对话     · 消息流/思考链/工具卡   · 变更审查       │
│  · 工作空间分组    · 人工审批卡片           · 后台任务       │
│    最近会话        · 底部输入栏（附件/参数/  · 子视图：文件  │
│  · 会话列表          发送/停止）              预览、终端输出│
├──────────────── IPC 适配层（AssistantRuntime）──────────────┤
│                Tauri 原生 IPC：event 流 + command 调用       │
├───────────────── Rust 主进程（Tokio 异步运行时）────────────┤
│ ★ rpi 嵌入（开源，不自研）                Duo 宿主层        │
│  rpi-agent    Agent 循环/事件/队列/取消   权限引擎（审批拦截）│
│  rpi-ai       provider 无关流式/重试      Git 服务（CLI+ckpt）│
│  rpi-tools    read/write/edit/bash…     FS 服务（扫描/预览） │
│  rpi-harness  会话树/JSONL/压缩/恢复      SQLite 持久化       │
│                                          MCP 客户端（最小自研）│
│                                          IPC 事件/命令适配    │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 设计原则

1. **逻辑下沉**：推理、调度、工具执行、权限判定全在 Rust；前端只渲染与发意图。
2. **原生通信**：只走 Tauri IPC（event + command），不起 HTTP、不开端口、不做鉴权层。
3. **内容为主**：左右栏均可折叠，折叠态按项目记忆。
4. **插件化扩展**：MCP / Skills / 皮肤以数据与配置接入，不改主界面结构。
5. **本地优先**：数据、模型端点、附件缓存全本地；无任何遥测上报（仅本地日志）。

### 3.3 崩溃域与并发边界

同进程换来的最大代价是"一个 panic 崩掉整个窗口"。约束：

- Agent 任务跑在独立 task，外层捕获 panic；panic 只终止该 Turn，发 `agent_error{fatal:true}` 事件，UI 呈现"任务异常终止 + 重试/回滚到检查点"。rpi 的 Agent 循环原生提供崩溃恢复/断点续跑，宿主只需把 panic 转成事件。
- 工具执行（尤其 shell）带超时与 kill；子进程统一登记回收（沿用扩展侧 PTY 泄漏教训）。
- SQLite 写只允许在单一 writer task（`tokio::sync::mpsc` 串行化），读用连接池 + WAL；禁止在事件循环里做同步 IO。
- 审批阻塞用 `oneshot` channel，带 30 分钟超时自动 deny，避免任务永久挂起。

---

## 4. 皮肤系统（可扩展）

三层 token，任何视觉值都不得硬编码到组件。

| 层 | 内容 | 位置 |
|---|---|---|
| L1 原语 | 灰阶 50–900、色相阶梯、语义色（danger/success/warn/info）、字体族、圆角、阴影、间距、动效时长 | `themes/primitives.css`（Tailwind `@theme` 映射） |
| L2 语义 | `--surface-base/raised/float/inset`、`--text-strong/base/weak/weaker`、`--border-base/hover/selected/focus`、`--diff-add/del/hunk`、`--syntax-*`、`--accent` | 由 skin bundle 提供具体值 |
| L3 组件 | `--chat-bubble-bg`、`--tool-card-border`、`--approval-card-accent` 等，只允许引用 L2 | 组件 CSS 只读 L3/L2 |

Skin bundle 规范（`~/.config/duo-desktop/skins/<id>/skin.json`）：

```json
{
  "id": "graphite-dark",
  "name": "石墨深灰",
  "extends": "paper-light",
  "mode": "dark",
  "tokens": { "--surface-base": "#151b24", "--accent": "#3b82f6" },
  "syntax": { "keyword": "#ff7b72", "string": "#a5d6ff" },
  "assets": { "logo": "logo.svg", "welcomeArt": "welcome.svg" }
}
```

规则：

- 内置三套：`paper-light`（方案 4.3 的极简灰度 + 少量 `#3b82f6` 强调）、`graphite-dark`（深色 IDE）、`nocturne-amber`（暖色低光，验证扩展性）。默认跟随系统 `prefers-color-scheme`。
- `extends` 支持继承，缺省 token 回落父皮肤；加载时做**完整度校验**（缺 L2 必需 token 即拒绝加载并提示）。
- **对比度门禁**：加载/保存皮肤时计算 `text-strong / text-weak / text-weaker` 对 `surface-base` 的对比度，低于 4.5:1（正文）/ 3:1（次要）即警告并给"自动提亮"修复动作；`danger`/`warn` 语义色必须同时带图标与文字，不允许仅靠颜色表意。
- **颜色分层两段结构** [v2.1]：`tokens.css`（`:root/.dark` 定义色值）→ `semantic-colors.css`（用 Tailwind `@theme inline` 映射给原子类），组件只写语义名（`bg-destructive/10 text-destructive`），透明度归 variant 管，禁止在组件里写死色值。
- **CI 级颜色策略** [v2.1]：每次改色都跑一张对比度验收表（逐样例 >4.5:1 / 3:1 才算过）；把 `ui-color-policy` 检查接进 `check:ui-boundaries`，**历史散落色名清单只减不增**，从 CI 层面禁止新增硬编码色值（详见 §15）。
- 语法高亮主题随皮肤切换（shiki 双主题 `light/dark` 或 CSS 变量注入）。
- 皮肤切换即时生效（`<html data-skin>` + CSS 变量），不重启、不重建 WebView。

---

## 5. 前端方案

### 5.1 布局

三栏：左 220px（可折叠，折叠后为 48px 图标栏或完全隐藏，二选一由设置控制）、中 flex:1（最小 560px）、右 280px（可折叠）。折叠状态与宽度按项目记忆于 `ui_state`。

- 左栏定位=全局导航 + 会话管理：Logo、一级导航（新对话 / Skills / MCP）、工作空间分组（最近项目 → 该项目的会话）、会话列表（今天/昨天/本周/更早 + 活动状态点）。
- 中间=对话主区：顶部条（模型选择、模式 Ask/Plan/Code、上下文与费用徽章、主题切换、窗口控制）、滚动内容区（空态欢迎 + 快捷卡片 / 消息流 / 思考链 / 工具卡 / 审批卡）、底部固定输入栏。
- 右栏=**本地能力面板**：入口卡片列表（新建终端 / 新建文件树 / 变更审查 / 后台任务），选中后在面板内切换子视图（文件预览、终端输出、diff 视图）。不做 SSH、不做内网穿透。

### 5.2 UI 语言约束（仪表盘化，借 ELENVA）[v2.1]

界面围绕「动作与可信度」生长，而非朴素气泡流，避免退化成聊天框堆叠。三条写进产品硬约束：

1. **过程自动收起**：一轮里几十条思考/工具调用，结束后压成一行「思考 8 次 · 工具 11 次 · 1 个失败」，点开才看细节。
2. **措辞分级当可信度用**：只跑单文件检查显示「仅单点验证」而非「验证通过」；一次没跑直接写「结论未经核对」——把 Agent 可信度做进文案状态机。
3. **「需要关注」是唯一会主动找用户的功能**：被中断、工具报错的会话自动推首页/横幅，其余保持克制，不做无差别推送。

### 5.3 组件清单

| 组件 | 实现 | 说明 |
|---|---|---|
| 聊天消息流 | `@assistant-ui/react` `<Thread/>` + 皮肤主题 | 流式 Markdown、代码高亮、工具卡、思考链折叠 |
| 审批卡片 [v2.1] | 自研（按「可能绕开原语」设计，React 19 `useActionState` 建模） | 执行前拦截、**保住输入焦点与已填参数、改参后放行**（LiveAgent 已证 ContextMenu 类原语在此类契约上挂不进去）；命令/路径/diff 预览 + 同意 / 拒绝 / 改参数后执行 / 始终允许此类 |
| 提问卡片 | 同上 | Agent 反问，多题翻页 + 自定义答案 |
| 文件树 [v2.1] | 自研递归组件 | 懒加载、`.gitignore` 过滤、勾选加入上下文；右键菜单须**保住文本选区/编辑器焦点**（Base UI `ContextMenu.Popup` 默认 `modal + 打开即聚焦`，可能需绕开原语自接管焦点）|
| 文件预览 | shiki（按需语言子集）+ 原生图片 | 大文件截断提示 |
| 斜杠命令 | 输入框监听 | `/` 触发，匹配 Skills + 内置命令 |
| @ 提及 | 输入框监听 | 文件 / 目录 / 终端输出 / git 变更 |
| 右栏面板 | 自研 Tab 容器 | 终端 / 文件树 / 审查 / 后台任务 |
| 终端 | `@xterm/xterm`（可选 feature，默认不打包） | 复用 Rust PTY 服务；默认关闭以控体积 |
| Diff 视图 [v2.1] | `@git-diff-view/react`（0.1.x，不绑设计系统） | 复用 `--diff-*` token；审批卡 diff 预览与右栏变更审查两处共用，不再自研内联/并排 |
| 代码编辑（如需）[v2.1] | `monaco-editor` | 不自研编辑器，按需异步加载 |
| Dialog | 通用组件 | MCP 配置、Skill 编辑、Token 统计、权限设置、全局设置、皮肤管理 |

### 5.5 IPC 适配层

实现 assistant-ui 的 `ExternalStoreRuntime`（**前置验证项，见 §12 Spike**）：

- 订阅 Rust 事件（§9.1），维护消息数组与 part 级状态；`text_delta` / `reasoning_delta` 追加，`tool_call_*` 生成工具 part，`human_confirm_required` 触发 interrupt。
- 暴露 `submitMessage`、`submitSteering`、`approveTool`、`stopAgent`、`loadSession` 等方法转发 `invoke()`。
- 事件按 `session_id` + `turn_index` + `seq` 去重与排序，乱序丢弃并请求 `resync`。

---

## 6. Agent Runtime（采用开源 rpi，不自研）

**决策：不自研 Agent Runtime。** 直接依赖 [rpi（bigfish1913/pi-rust）](https://github.com/bigfish1913/pi-rust)（MIT，Rust 原生、库优先）作为运行时底座，桌面侧只写宿主适配与 Duo 独有能力（权限引擎、checkpoint、SQLite、MCP、IPC）。任何"重写一遍循环"的做法都不在本方案内。

### 6.0 嵌入方式

采用库优先路径，直接依赖以下 crate（同一版本、一起发布）：

| crate | 提供 | 桌面侧用法 |
|---|---|---|
| `rpi-ai` | provider 无关的消息 / 流式 / 工具 schema 类型；Anthropic + OpenAI 兼容 + `faux`（离线确定性）provider | 桌面只负责端点配置、`{env:VAR}`、keychain；测试用 `faux` 离线跑 |
| `rpi-agent` | Agent 循环：`AgentTool`、事件、hooks、队列、取消 | 主运行时；其事件流经适配层转成桌面 IPC 协议 |
| `rpi-tools` | `read`/`write`/`edit`/`bash`（+ `grep`/`find`/`ls`）与 `ExecutionEnv` 执行缝 | 直接复用；MCP 工具经执行缝注入 |
| `rpi-harness` | 会话树、JSONL 持久化、压缩、崩溃恢复、运行循环 | 借其循环与恢复能力；**桌面事实来源仍是自己的 SQLite**（见 §10） |

依赖方向（rpi 侧，单向）：`rpi-telemetry → rpi-ai → rpi-agent → rpi-tools → rpi-harness`。不引入 `rpi-cli` / `rpi-tui` / `rpi-plugin-sdk` / `rpi-extensions`（TUI、插件 ABI、remote server 均不在本产品范围）。

### 6.1 三队列调度（rpi-agent）

| 队列 | 优先级 | 用途 | 消费时机 |
|---|---|---|---|
| `main_queue` | 普通 | 用户初始消息、主体任务 | 每轮 Turn 开始 |
| `steering_queue` | 最高 | 用户中途干预、打断、改指令 | Turn 边界（本轮工具全部结束后）优先注入 |
| `follow_up_queue` | 最低 | 工具衍生的子任务、后置总结 | main/steering 均空时并入 main |

队列模型由 `rpi-agent` 提供；桌面侧另把队列状态快照进 `checkpoints.queue_state`，用于跨重启的界面复原（与 rpi 自身的崩溃恢复互补，不冲突）。

### 6.2 单轮 Turn 流程（rpi 循环 + 桌面插入点）

1. 消费 `steering_queue`，注入高优先级干预。*（rpi）*
2. 组装上下文：历史消息 + 已选文件内容 + 模式 System Prompt + Skills 提示 + 规则文件。*（rpi + 桌面注入 Skills/模式）*
3. 流式调用 LLM，增量产出 `text_delta` / `reasoning_delta`，收集本轮批量工具调用。*（rpi-ai → 适配为桌面 `text_delta`/`reasoning_delta`）*
4. 进入工具阶段：按声明顺序批量执行；只读并发，写与 shell 串行。*（rpi-agent 调度）*
5. **桌面插入点**：每个工具执行前过 Duo 权限引擎（§6.6）；需审批则挂起并发 `human_confirm_required`，等待前端回传（超时 30 分钟自动 deny）。
6. **桌面插入点**：写类工具执行**前**打 checkpoint（§7.2），执行后发 `file_changed`。
7. 结果追加历史；工具可入队 follow_up。*（rpi）*
8. Turn 结束：写 checkpoint、累计 token 与费用估算、发 `turn_end`。*（rpi usage → 桌面落库）*
9. 队列非空进入下一 Turn；全空发 `agent_end`。*（rpi）*

### 6.3 上下文与压缩（rpi-harness）

借用 `rpi-harness` 的会话树与压缩能力；桌面侧只做投影：每轮把 token 占用转成 `context_usage` 事件、压缩完成发 `compact_done`（含压缩分割线 part）。单文件注入上限（默认 256KB / 8K tokens）、附件数量与体积上限、超限明确提示由桌面侧把关。

### 6.4 防死循环（rpi-agent + 桌面阈值）

最大 Turn 数（默认 10，可配）、同名工具+同参数重复检测（连续 3 次熔断询问）、token 熔断、空输出轮次限制、shell 超时（默认 120s）与输出截断；阈值经桌面配置下发。rpi 循环自身亦带循环保护，配置取更严者。

**单 Turn 费用软阈值** [v2.1]：若熔断只在 Turn 边界生效，单次超长输出可能在触发前就烧穿预算；故对单个 Turn 也设软阈值——达到即暂停并询问是否继续，不只在 Turn 边界拦截。

### 6.5 工具集（rpi-tools + 桌面补充）

- 直接复用 `rpi-tools`：`read` `write` `edit` `bash` `grep` `find` `ls`（Windows 另有 `powershell`）。
- 桌面补充：`todo` `ask_user` `apply_patch` `git_status` `git_diff` `git_commit`，以及 MCP 泛用工具（命名 `mcp:<server>:<tool>`）——经 `rpi-tools` 的执行缝注册，权限默认值与输出截断策略由桌面声明。

### 6.6 权限引擎（Duo 独有，插在 rpi 工具执行前）

策略三态：`DENY` / `REQUIRE_APPROVAL` / `AUTO`。分层解析（**取最严格者生效**）：

```
global 默认  →  project 覆盖  →  session 覆盖  →  agent/mode 覆盖
每条规则可带 matcher：path glob（read/write）、command 前缀 glob（bash）、host（mcp http）
例外列表：命中例外即覆盖该工具默认（例：bash AUTO + 例外 `rm -rf *` DENY）
```

模式默认策略：Ask=写与 shell 全 DENY；Plan=写 DENY、shell 只读白名单 AUTO；Code=写与 shell REQUIRE_APPROVAL。
安全默认：API key 存系统 keychain（`keyring` crate），日志与错误信息脱敏；shell 与写文件默认 REQUIRE_APPROVAL；可选沙箱（macOS `sandbox-exec` / Linux `bubblewrap`）作为 P1。punycode/同形域名检测在审批卡上高亮提示。
该引擎是 Duo 相对 rpi 的核心增量：rpi 提供执行缝，Duo 决定"能不能执行、要不要人批"。

### 6.7 LLM 网关（rpi-ai providers + 桌面配置）

provider 由 `rpi-ai` 提供（Anthropic + OpenAI 兼容；测试有 `faux` 离线 provider）。桌面侧：`base_url` + `api_key`（支持 `{env:VAR}`，落 keychain）+ 模型列表（`GET /models` 自动拉取，失败回退手填）+ 端点连通性测试；流式增量、重试/超时策略沿用 rpi-ai，错误分类映射为桌面错误卡（限流/未连接/重试倒计时）。

### 6.8 文件系统服务（Duo 独有）

后台异步扫描 + 增量缓存（`notify`），`.gitignore` 与 watcher 忽略模式解析，目录深度与文件数上限，扫描进度事件 `scan_progress`。提供"加入上下文"接口，把内容作为 part 注入而非塞进 system prompt。rpi 不提供该能力，故保留桌面自研。

### 6.9 适配层（桌面独有，工作量集中处）

把 rpi 的 `AgentEvent` 流映射为桌面 20 事件协议（§9.1）：

- `MessageUpdate` → `text_delta` / `reasoning_delta` / `message_part_upserted`
- `ToolStart` / `ToolEnd` → `tool_call_start` / `tool_call_output_delta` / `tool_call_result`
- `AgentEnd` → `agent_end`；provider 错误 → `agent_error`
- 工具执行前的钩子接权限引擎（§6.6）与 checkpoint（§7.2）；审批结果经 `oneshot` 回流
- 会话事实来源仍是桌面 SQLite：把 rpi 会话树投影进 `messages`/`parts`/`checkpoints`（§10）
- **硬约束** [v2.1]：rpi 的 harness 恢复只用于内存里续跑；任何跨重启的界面还原一律只从 SQLite 重建、再把历史重新灌回 rpi，**rpi 的 JSONL 绝不参与 UI 状态恢复**（避免两套各自恢复导致消息序列/tool 状态与 `parts` 表漂移）。

适配层是本方案唯一需要"手写循环相关代码"的地方，不重写 rpi 的循环本体。

---

## 7. Git 能力与 Revert

### 7.1 后端选择

**走系统 `git` CLI**（macOS/Linux 自带，Windows 缺失时提示安装并降级为文件快照），通过 `--porcelain=v2`、`diff --no-color`、`status -z` 稳定解析；**不编译 `git2`/libgit2**（避免其编译图与原生依赖，保持构建简单）。checkpoint 用 shadow 仓库实现，同样走 CLI。

### 7.2 双通道设计

| 通道 | 目标 | 操作 |
|---|---|---|
| 用户仓库（受控读写） | 状态、diff、分支、暂存、提交、推送、AI 提交信息 | 只读默认 AUTO；`commit`/`push` 走 REQUIRE_APPROVAL，永不自动执行 |
| checkpoint 仓库（隔离） | 逐消息 Revert / Redo | 独立 `--git-dir ~/.local/share/duo-desktop/ckpt/<repo-hash>` + `--work-tree <项目目录>`，用 `git commit-tree` 写快照到 `refs/duo/ckpt`，**不碰用户 HEAD、index、reflog、stash** |

快照时机：每个写类工具执行前。恢复：`git checkout <ckpt> -- <paths>`（按文件粒度），Redo 即回到下一个快照。

**性能** [v2.1]：`commit-tree` 全走 CLI，一次长任务几十次写 = 几十次 git 冷启动 + tree 构建。Spike 阶段附带压测——测「1000+ 文件仓库连续 20 次快照的墙钟开销」；超阈值则对 checkpoint 做去抖/合并，勿等到 MVP4 才暴露。
UI：右栏"变更审查"卡片 + 消息 hover 的 Revert/Fork；Revert 前弹确认，展示将恢复的文件与 ± 统计；Revert 后横幅提供 Redo / Redo All。
`file_snapshots` 表记录 `turn_index`、`commit_oid`、变更文件列表，供逐消息回滚定位。

---

## 8. MCP 客户端

传输：`stdio`（子进程 + JSON-RPC over stdio，进程登记到 ProcessGroup 并在退出/停用时回收）、`sse`、`http`。能力：工具发现与注册到工具引擎（命名 `mcp:<server>:<tool>`）、状态机（connecting / connected / needs_auth / failed / disabled）、启停、编辑、删除确认、工具数展示、失败日志查看与重试。鉴权：header 注入（支持 `{env:VAR}`），`needs_auth` 状态提供"打开授权页"。超时与并发上限可配（默认 60s）。

---

## 9. IPC 协议

### 9.1 Rust → 前端（事件）

| 事件 | 参数 | 触发 |
|---|---|---|
| `ready` | `{app_version, runtime_version, schema_version}` | 启动完成 |
| `text_delta` | `{session_id, message_id, seq, delta}` | LLM 文本增量 |
| `reasoning_delta` | `{session_id, message_id, seq, delta}` | 思考链增量 |
| `message_part_upserted` | `{session_id, part}` | part 状态变化（工具结果落定等） |
| `tool_call_start` | `{call_id, tool_name, source, args, session_id, turn_index}` | 工具开始 |
| `tool_call_output_delta` | `{call_id, chunk}` | bash/MCP 流式输出 |
| `tool_call_result` | `{call_id, result?, error?, duration_ms, truncated}` | 工具结束 |
| `human_confirm_required` | `{call_id, tool_name, source, kind: command\|paths\|diff, command?, paths?, diff?, matched_rule?, expires_at}` | 权限引擎要求审批 |
| `question_required` | `{question_id, session_id, questions:[{q, options[], allow_custom}]}` | Agent 反问 |
| `turn_end` | `{turn_index, tokens:{prompt, completion, reasoning, cache_read}, cost_estimate, model}` | 单轮结束 |
| `context_usage` | `{used, reserved, window, auto_compact_at, hit_rate}` | 上下文占用变化 |
| `agent_end` | `{reason: done\|stopped\|limit\|error\|panic, summary?}` | 队列清空/终止 |
| `agent_error` | `{level, code, message, retryable, retry_in_ms?, attempt?, fatal?}` | 错误与重试 |
| `compact_done` | `{from_turn, tokens_before, tokens_after}` | 压缩完成 |
| `file_changed` | `{paths[], session_id?}` | 工具或外部修改文件 |
| `git_status_changed` | `{branch, ahead, behind, files:[{path, status, added, deleted}]}` | git 状态变化 |
| `scan_progress` | `{project, scanned, total, phase}` | 目录扫描进度 |
| `mcp_status` | `{server, status, tools, error?}` | MCP 状态变化 |
| `session_updated` | `{session_id, title?, updated_at, activity}` | 列表刷新 |
| `queue_state` | `{main, steering, follow_up:[{id, text}]}` | 排队项变化 |

### 9.2 前端 → Rust（命令）

| 命令 | 参数 | 作用 |
|---|---|---|
| `submit_message` | `{session_id, text, attachments?, context_refs?, mode, model}` | 入 main 队列并启动 |
| `submit_steering` | `{session_id, text}` | 入 steering 队列 |
| `queue_action` | `{id, op: edit\|delete\|promote}` | 排队项操作 |
| `approve_tool_call` | `{call_id, decision: allow\|deny\|allow_always, modified_args?, reason?}` | 审批结果（含改参与"始终允许此类"） |
| `answer_question` | `{question_id, answers[]}` | 回答 Agent 反问 |
| `submit_frontend_result` | `{call_id, result}` | 前端 UI 动作结果回传 |
| `stop_agent` | `{session_id}` | 中断当前任务 |
| `session_list/create/rename/delete/fork/export` | 各自参数 | 会话 CRUD（删除为软删 + 撤销窗口） |
| `session_load` | `{session_id, before?, limit}` | 分页加载历史消息 |
| `revert_to_message` / `redo_step` | `{session_id, message_id}` | 检查点回滚 / 重做 |
| `permission_set` | `{scope, tool, policy, matcher?, exceptions[]}` | 权限写入 |
| `mcp_upsert/delete/toggle/retry` | | MCP 管理 |
| `skill_upsert/delete/toggle` | | Skills 管理 |
| `provider_upsert/delete/test` | `{base_url, api_key?, models[]}` | 端点配置与连通性测试 |
| `fs_scan/tree/preview/search` | | 文件服务 |
| `git_status/diff/stage/unstage/commit/push/generate_message` | | Git 面板 |
| `terminal_open/write/resize/close` | | 终端（feature） |
| `compact_now` / `set_mode` / `set_model` | | 会话控制 |
| `settings_get/set` / `skin_list/apply/import` | | 设置与皮肤 |
| `resync` | `{session_id, turn_index, since_seq}` | 事件断流后补齐 [v2.1]：seq 语义是 `session_id+turn_index+seq` 三元组，断流跨 Turn 时单 `since_seq` 定位不到起点，故补 `turn_index` 游标 |

协议版本化：`schema_version` + `runtime_version` 在 `ready` 事件里下发，前端不匹配时提示"请重启应用"，避免半新半旧。

---

## 10. SQLite Schema

WAL、`foreign_keys=ON`、`user_version` 迁移；写集中在单 writer task。**`parts` 与 `parts_fts` 的写必须在同一 writer task 的同一事务内完成** [v2.1]——`parts_fts` 是独立 FTS5 虚拟表，若拆到不同 writer 会在 WAL 上争用。

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  is_git INTEGER DEFAULT 0, last_opened INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'ask',
  model TEXT, variant TEXT, provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',           -- idle|running|awaiting_input|awaiting_approval|error
  total_tokens INTEGER DEFAULT 0, cost_estimate REAL DEFAULT 0,
  pinned INTEGER DEFAULT 0, deleted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_project_updated ON sessions(project_id, updated_at DESC);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, turn_index INTEGER, status TEXT DEFAULT 'complete',
  prompt_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER,
  cache_read_tokens INTEGER, cost_estimate REAL, model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);
CREATE TABLE parts (                          -- part 级定位：工具卡折叠态、逐 part 计费、搜索
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, type TEXT NOT NULL,   -- text|reasoning|tool|question|approval|compact|error
  tool_name TEXT, tool_source TEXT, call_id TEXT, state TEXT,
  content TEXT NOT NULL,                      -- JSON
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_parts_msg_seq ON parts(message_id, seq);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  part_id TEXT, kind TEXT NOT NULL,           -- image|file|context_ref
  name TEXT NOT NULL, mime TEXT, bytes INTEGER, path TEXT NOT NULL,  -- 文件本体在缓存目录，不入库
  created_at INTEGER NOT NULL
);
CREATE TABLE checkpoints (                    -- 队列态（断点续跑）
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  queue_state TEXT NOT NULL, last_turn INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE file_snapshots (                 -- 文件级回滚（Revert/Redo 依赖）
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL, message_id TEXT, ckpt_oid TEXT NOT NULL,
  files TEXT NOT NULL,                        -- JSON [{path,added,deleted}]
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_snapshots_session ON file_snapshots(session_id, turn_index);
CREATE TABLE tool_permissions (               -- 分层：global|project|session|agent
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_ref TEXT,
  tool TEXT NOT NULL, policy TEXT NOT NULL,   -- deny|require_approval|auto
  matcher TEXT,                               -- JSON {path?:glob, command?:glob, host?:glob}
  exceptions TEXT,                            -- JSON [{matcher, policy}]
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_perm_unique ON tool_permissions(scope, IFNULL(scope_ref,''), tool);
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL,
  config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT DEFAULT 'disabled', tools INTEGER DEFAULT 0, last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE skills (
  id TEXT PRIMARY KEY, command TEXT NOT NULL, name TEXT, description TEXT,
  system_prompt TEXT NOT NULL, model TEXT, variant TEXT,
  scope TEXT NOT NULL DEFAULT 'global',       -- global|project|builtin
  path TEXT, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
  UNIQUE(command, scope, IFNULL(path,''))
);
CREATE TABLE providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  key_ref TEXT,                               -- keychain 引用，绝不存明文
  models TEXT, last_check INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE ui_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL  -- 窗口几何/折叠态/右栏子视图/皮肤
);
CREATE TABLE drafts (session_id TEXT PRIMARY KEY, text TEXT, attachments TEXT, updated_at INTEGER);
CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, level TEXT, event TEXT, payload TEXT);
CREATE VIRTUAL TABLE parts_fts USING fts5(content, part_id UNINDEXED, tokenize='unicode61');
```

迁移：`user_version` 递增 + 事务内 `ALTER`；任何迁移前先复制 db 到 `backup/`。附件与 checkpoint 仓库不进数据库，缓存目录 `~/.local/share/duo-desktop/{attachments,ckpt}/`，随项目删除提供清理。

---

## 11. 功能点清单（映射 MVP）

优先级：P0 首版必须 / P1 首版应有 / P2 后续。

**M0 骨架（P0）**：Tauri+Vite+React 工程、三栏可折叠骨架、皮肤系统与三套内置皮肤、i18n（zh/en）、字号滑杆、命令面板 ⌘K（若用 `cmdk` 注意它会拽进 Radix Dialog；守 Base UI 单原语体系则 Dialog 层继续用 `@duo/ui` 自己的）[v2.1]、崩溃域隔离与任务级恢复、托盘与全局快捷键、开机自启（可选）。

**M1 对话核心（P0）**：流式渲染与自动跟随滚动、Markdown + 代码高亮 + 文件路径链接、思考链折叠、工具卡全家（read/list/glob/grep/bash 流式输出/write/edit/apply_patch 内嵌 diff+±/todo/ask_user/mcp 泛用卡）、Turn 结果条（完成/中断/错误/上限）、Ask/Plan/Code 模式切换、模型选择器（按 provider 分组 + 收藏 + 上下文/价格）、斜杠命令补全、@ 提及（文件/目录/终端/git 变更）、附件（图片粘贴拖拽 + 非图片转 @mention）、发送/停止/排队、提示词增强、历史提示词 ↑↓、转录内搜索（FTS + 高亮定位）、消息 hover 复制/Revert/Fork、压缩分割线与手动 /compact、错误卡（限流/未连接/重试倒计时）、费用估算标注。

**M2 会话与持久化（P0）**：SQLite 全量持久化、项目分组与切换、会话列表时间分组 + 活动状态点、行内重命名/导出 Markdown/软删+撤销、Fork 会话、草稿按会话隔离、断点恢复（队列态 + 文件快照）、多窗口与按项目布局记忆。

**M3 权限与安全（P0）**：审批卡（命令高亮/路径列表/diff 预览 + 同意/拒绝/改参/始终允许）、命中规则展示、权限设置页（分层 + matcher + 例外）、模式默认策略、会话最大花费估算熔断、keychain 存 key、日志脱敏、无遥测。

**M4 端点与模型（P0）**：OpenAI 兼容端点配置（base_url + key + `{env:VAR}` + 连通性测试）、`/models` 自动拉取与勾选合并、模型收藏与按会话记忆、角色模型（对话/小模型/压缩）。

**M5 扩展（P1）**：MCP 列表与三协议编辑弹窗、状态机与 Sign in/重试/删除确认、Skills CRUD（含 scope 与文件路径）、热重载。

**M6 本地能力（P1）**：文件树与预览、右栏终端（feature）、变更审查面板（git 状态/diff/暂存/提交/推送/AI 提交信息）、后台任务列表、Revert/Redo、设置全量（显示/模型/权限/工具/MCP/Skills/快捷键/关于）、系统通知与提示音、自动更新、可选沙箱。

**P2**：语义索引、xterm 终端默认启用、沙箱、多代理编排、行内补全、语音。

---

## 12. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| **Spike（3–5 天，先于 MVP1；探针式，每条带失败判据）** [v2.1] | ① 嵌入 rpi 最小回合；② `@assistant-ui/react` `ExternalStoreRuntime` 吃 Tauri 事件流 + 审批卡；③ 适配层：rpi `AgentEvent` → 桌面 20 事件协议；附带 checkpoint `commit-tree` 压测 | **失败判据（不是「能跑 demo」）**：① 审批钩子能插在 rpi **工具执行前阻塞**、`oneshot` 超时后**干净恢复整个 Agent 循环**（挂不进则 §6.6 权限引擎悬空；顺带确认 rpi 上游「执行隔离」未完成 → 沙箱为纯自研，勿对用户许诺）；② 审批卡能渲染**且保住用户已填参数/输入焦点、改参后放行**（对应 ContextMenu `modal+打开即聚焦` 契约冲突）；③ 事件映射正确且能处理 **seq 乱序 / 跨 Turn resync**。任一判据不满足即回方案层重议 |
| **MVP0 设计冻结** | 本文档 + 原型屏目冻结、IPC 与 Schema 定稿 | 无未定义事件/字段 |
| **MVP1 聊天底座** | rpi 嵌入 + 三栏骨架 + 皮肤系统 + assistant-ui 集成 + 端点配置 + 流式对话 + 会话持久化 | 端到端跑通，重启不丢历史 |
| **MVP2 工具与权限** | rpi 循环接线 + 适配层 + 桌面补充工具 + 权限引擎 + 审批卡 + 模式 | 一个真实任务多工具闭环，审批可拦可改参 |
| **MVP3 项目感知** | 文件树 + .gitignore + 预览 + 加入上下文 + 图片附件 | 大仓库扫描不卡 UI |
| **MVP4 Git 与 Revert** | 变更审查面板 + checkpoint shadow 仓库 + Revert/Redo + AI 提交信息 | 逐消息回滚文件正确，不污染用户仓库 |
| **MVP5 MCP 与 Skills** | 三协议客户端 + 管理页 + 工具接入权限 + Skills | 至少 2 个真实 MCP 可用 |
| **MVP6 打磨发布** | 皮肤扩展、通知、快捷键、托盘、自动更新、异常处理、签名与打包 | 三平台产物可用 |

依赖：MVP2 是最高风险项，排在前但内部再拆 2a 适配层（rpi 事件↔桌面协议）/ 2b 工具缝与桌面补充工具 / 2c 权限引擎；MVP4 依赖 MVP2 的写类工具与 checkpoint 钩子。

---

## 13. 体积与构建

**不设体积门禁。** 不再把产物体积作为硬性验收条件（历史上性价比较低，且与"采用 rpi"的选型冲突——rpi 自身二进制约 21.8 MiB，整栈嵌入后必然超过旧 15 MB 线）。

仍然保留的工程习惯（非门禁，不做 CI fail）：

- release profile 使用 `lto`、`codegen-units=1`、`strip`；按需关闭依赖 default-features。
- 不引入 `rpi-cli` / `rpi-tui` / `rpi-plugin-sdk` / `rpi-extensions`（TUI、插件 ABI、remote server 不在范围内）。
- 终端 / 沙箱等重能力做 feature 开关，默认关闭。
- 需要归因时用 `cargo bloat --release` 手动查看，不做自动检查。

---

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| assistant-ui 无法优雅承载自定义事件流与审批 interrupt | Spike 首要验证项；失败则退化为自研消息状态机（成本 +2 周），不阻塞架构 |
| rpi 的 `AgentEvent` / 工具执行缝与桌面协议、权限拦截点不匹配 | Spike ③ 先验证适配层；适配层是唯一工作集中处，不重写 rpi 循环本体 |
| 同进程 panic 崩窗 | §3.3 任务级隔离 + rpi 原生崩溃恢复 + 事件上报 + 检查点回滚按钮 |
| MCP stdio 子进程泄漏 | 统一进程组登记，退出钩子 kill；异常指数退避重启上限 5 次 |
| 大项目扫描卡顿 | 后台线程 + 增量 + 文件数/深度上限 + `scan_progress` 可取消 |
| 费用估算与服务商账单不一致 | 全部 UI 标注"仅为估算"，同时展示服务端 usage 原值与本地估算差异 |
| 皮肤扩展被乱配导致不可读 | 加载时完整度 + 对比度校验，提供"自动提亮"修复与一键回落默认皮肤 |
| Windows 无 git | 检测后降级为文件快照回滚（关闭 git 面板写操作）并明确提示安装 |
| 双栈维护（桌面 React / 扩展 Solid） | 明确不复用组件；共享的只有设计 token 规范与文档，不共享代码 |
| 上游 rpi 变动（仍在 0.x 迭代，作者自述执行隔离仍在设计、无交付时间）[v2.1] | **锁死 git commit hash + vendored**，不用版本区间；把 rpi 用法收敛在适配层与工具缝；升级=显式换 hash + 跑全量回归，禁止 `cargo update` 顺带升级 |

---

## 15. 工程结构

```
packages/desktop/
  src-tauri/            # Rust：宿主（Agent Runtime 由 rpi 提供，不自研）
    src/
      main.rs           # 薄壳
      adapt.rs          # ★ 适配层：rpi AgentEvent ↔ 桌面 20 事件协议
      tools/            # 桌面补充工具（todo/ask_user/apply_patch/git_*/mcp:*）
      perms.rs          # 权限引擎（审批拦截，插在 rpi 工具执行前）
      checkpoint.rs     # shadow 仓库 + 文件快照
      fsx.rs            # 扫描与预览
      gitx.rs           # 系统 git CLI 封装
      mcp.rs            # 最小 MCP 客户端（rpi 不覆盖）
      store.rs          # rusqlite + 迁移（桌面事实来源）
      ipc.rs            # 事件/命令定义（唯一协议来源）
    Cargo.toml          # 依赖 rpi-agent / rpi-ai / rpi-tools / rpi-harness（锁死 git commit hash + vendored）[v2.1]
    tauri.conf.json
packages/ui/            # @duo/ui：自建组件库（Base UI 原语 + Tailwind 4 + 语义 token）[v2.1]
    src/                # 组件源码自己持有，参照 shadcn/coss 的 Base UI 写法，不跑 shadcn init
  src/                  # React 前端
    ipc/                # AssistantRuntime 适配层
    views/              # chat / history / settings / skills / mcp
    panels/             # 右栏：terminal / tree / review / tasks
    skins/              # 内置皮肤 bundle + 加载器
  scripts/              # 打包脚本（无体积门禁）[v2.1]
    check-ui-boundaries.mjs  # 导入方向门禁：views/panels 不得反向污染 @duo/ui；纳入 CI
    ui-color-policy.mjs      # 散落色名清单只减不增；并入 check:ui-boundaries
```

`ipc` 模块是唯一协议来源，通过 `ts-rs` 生成前端类型，避免手写漂移。**不自建 harness/tools/llm crate**——这些由 rpi 提供；桌面侧只保留上表列出的宿主模块。

**UI 治理（v2.1 补）**：所有组件收进 `packages/ui`（`@duo/ui`），桌面 GUI 与（若未来做）WebUI 共享同一份 UI 包；靠 `check:ui-boundaries`（导入方向不能反向污染）+ `ui-color-policy`（散落色名只减不增）+ Biome（统一 lint/format）这套**工程纪律**收敛，而不靠「少引库」——这从 CI 层面一劳永逸解决「引太多 UI 库导致样式漂移」。

---

## 16. 原型对照（`prototype-v2.html`）

原型已按 v2 调整：皮肤系统（三套内置 + 导入 + 对比度校验）、左栏改为全局导航 + 工作空间分组、右栏改为本地能力面板（终端 / 文件树 / 变更审查 / 后台任务 + 文件预览子视图）、删除账号体系与云同步/市场/worktree/迁移向导/索引相关屏、审批卡补"改参数后执行"与"始终允许此类"、费用处标注"仅为估算"。屏目索引（⌘⇧S）按 M0–M6 分组，每屏 hash 可达，可直接作为 MVP 拆单依据。
