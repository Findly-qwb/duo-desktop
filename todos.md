# duo Desktop · 功能进度与待办

> 施工守则见 `AGENTS.md`（权威来源、硬约束、验证矩阵、禁止事项）；本文件只记录进度与待办。
> 更新：2026-10-17 00:25 · 依据 `PLAN.md`（v2.1）与 `prototype.html` 逐屏实现
> 现状一句话：**前端 79 屏全部可交互且中英双语 100% 覆盖；宿主核心 + rpi Agent Runtime（T3）已打通 —— 真回合、权限审批、写前快照、队列三栈都能跑，64 个 Rust 测试全绿；外壳已在真窗口跑过，人工验收与真端点 keychain 待做。**

验证口径：下面每条「已完成」都对应可跑的命令或测试，不是口头承诺。跑法见文末《怎么验》。

---

## 一、已完成（前端里程碑 M0–M6）

- [x] **P0 工程骨架** — pnpm workspace（`packages/ui` + `packages/desktop`）、Vite 7 + React 19 + TS 5.9 strict、Biome 2.2、`scripts/check-ui-boundaries.mjs` 两道门禁（ui 不得反向依赖 desktop；组件层硬编码色基线 73 只降不升）
- [x] **P1 皮肤系统** — 三层 token（L1 原语 / L2 语义 / L3 组件）+ 三套内置皮肤 + `skin.json` bundle（支持 `extends`）+ 对比度守护（正文 ≥4.5:1、次要 ≥3:1、弱化 ≥2.2:1，不达标阻止保存并提供自动提亮）
- [x] **P2 外壳** — 自绘标题栏、三栏可折叠 shell、左栏导航（工作空间分组 / 最近会话 / 活动状态点）、状态栏（runtime · git · 费用 · 上下文 · 待审批 · 屏数 · 原型层）
- [x] **P3 命令面板 / 屏目索引 / 系统层** — ⌘K 面板、⌘⇧S 屏目索引（79 屏 hash 深链）、托盘菜单、系统通知卡、更新 pill、toast 栈（软删撤销）
- [x] **P4 IPC 协议层** — 20 事件 + 52 命令的单一来源（`ipc/protocol.ts` ↔ Rust `ipc.rs`，由 `protocol-parity.test.ts` 防漂移；2026-10-17 起 53 条命令 / SCHEMA_VERSION 8，新增 provider_list）、ExternalStore 适配器、`(session_id, turn_index, seq)` 乱序丢弃 + `resync` 补齐
- [x] **P5 消息流** — 流式文本 / 思考链折叠 / Markdown+DOMPurify / 零依赖语法高亮分词 / 结果条 / 错误卡与重试倒计时 / 压缩分割线
- [x] **P6 工具卡全家** — read / bash（流式输出）/ edit（diff 面板）/ web / todo / task / mcp / question，含「后台化」「还原该文件」「展开右栏」等动作
- [x] **P7 输入区与浮层** — 模式 / 模型 / 推理变体选择器、斜杠命令补全、@ 提及、附件（图片 Base64 直传、非图片转 @mention、超限拦截）、三队列（main / steering / follow-up）
- [x] **P8 审批与回退** — 审批卡（允许一次 / 始终允许此类 / 拒绝 / 改参后执行，草稿跨重渲染存活、焦点契约）、命中规则展示、punycode 同形域名高亮、提问卡、转录内搜索、PromptRail、Revert / Redo
- [x] **P9 会话与持久化** — 历史页（FTS5 搜索 / 工作空间与模式过滤 / 软删撤销 / Fork / 导出）、行内重命名、草稿按会话隔离、断点恢复、首启向导
- [x] **P10 设置中心** — 13 个 tab（显示 / 模型 / 端点 / 权限 / 工具 / 上下文 / Git / 文件 / MCP / Skills / 通知 / 关于 / 实验性），权限页含三态 × 分层作用域 + 例外 + effective 链
- [x] **P11 端点与模型** — 端点 CRUD、`/models` 合并（已存在条目不覆盖、变体字段保留）、角色模型、用量估算与熔断
- [x] **P12 扩展** — MCP 管理页（stdio / sse / http 状态机、进程回收、退避重试、stderr 查看）+ Skills 管理页（frontmatter 校验、热重载）
- [x] **P13 右栏能力面板** — 文件树（懒加载 / 勾选注入上下文）、终端（Rust PTY 语义占位）、变更审查（stage / commit / 检查点 Revert）、后台任务、图片预览
- [x] **P15 诊断 / 快捷键 / 无障碍** — runtime 诊断弹窗（事件计数、乱序丢弃、resync、崩溃隔离、git 后端、日志脱敏）、10 组快捷键、a11y（role / aria-label / 焦点顺序 / `html lang` 同步）
- [x] **P16 i18n 正文抽取** — 见下节，**941 条源串 100% 有英文对照，漏译基线 130 → 0**

### i18n 这一轮实际做了什么（因为上一版口径不可信，重做了工具链）

- 新增 `scripts/i18n-scan.mjs`（TypeScript AST 度量）与 `scripts/i18n-extract.mjs`（按字符区间改写，**不做整文件正则批改**）。旧正则口径把 SettingsView 报成「已抽取 21 条」，AST 实测还剩 275 条 —— 这是重做的直接原因
- 抽取覆盖：JSX 文本节点、`中文 {expr} 中文` 连续片段合并为带占位符的 key、模板串、JSX 属性；**比较 / switch / 对象键 / className 等位置一律不改**，只进 NEEDS-REVIEW 清单人工判断（把译文放进 `===` 一侧会静默改逻辑）
- `SETTINGS` / `SKINS` / `CONTRAST_TEXT` 三张表按「中文原文即 key」处理：表内不包 `t()`，只在渲染点译，`onSpecial(label)` 这类字符串派发因此仍然正确
- `@duo/ui` 去中文：`Dot` 改吃 `label`、`auditContrast` 只回 id，文案移到桌面层 `src/lib/contrast.ts`
- 修掉 5 处 `已${启用}` 式拼接（否则英文态输出 "已Enable"）
- 新增 `src/i18n/strings.json` 清单 + 两道闸：清单过期检测、漏译数只降不升；并加测试断言 **en 态 7 个设置页零中文残留**（这条测试当场抓出皮肤名与 `折叠|展开` 两个真 bug）
- 语言选项里「外壳已译，正文待抽取」「(shell only)」的诚实标注已摘除

---

## 二、已完成（宿主 H1–H5，Rust）

`packages/desktop/src-tauri`（crate `duo-host-core`，**6445 行 / 64 个测试全绿 / clippy 0 警告**；含 `adapt.rs` rpi 适配 ~1000 行 + 5 条真循环 e2e）

- [x] **H1 `gitx.rs`** — 系统 git CLI 通道（PLAN §7.1，不编译 libgit2）：`status --porcelain=v2 -z -b` 解析（含各 git 版本字段数差异）、numstat、diff、stage / unstage / commit / push、ahead-behind、中文路径不转义、unborn HEAD 时与空树比并逐文件 `--no-index` 给新文件出 diff
- [x] **H2 `checkpoint.rs`** — shadow 仓库（`GIT_DIR` + `GIT_WORK_TREE`）+ `commit-tree` 写 `refs/duo/ckpt`：按文件粒度回滚、Redo 走链上下一个快照、保留策略**重建父子链**（光挪 ref 不会让老快照不可达，这点用测试钉死了）、`file_snapshots` 落库
  - 性能尖刺（PLAN §7.2 要求实测）：1200 文件 × 连续 20 次快照 = **2.71s（135ms/次）** → 不需要去抖合并。跑法 `cargo test -- --ignored --nocapture`
- [x] **H3 `fsx.rs`** — 扫描 + `.gitignore` 链（全局 excludesFile / `.git/info/exclude` / 各级 `.gitignore` **按目录作用域生效**）、深度与文件数上限熔断、进度回调、目录树懒加载、文件名搜索、预览 256KB 超限截断并**落盘给路径引用**、二进制拒读、越出工作区拒绝
- [x] **H4 `mcp.rs`** — stdio JSON-RPC 客户端：`initialize` / `tools/list` / `tools/call`、工具命名 `mcp:<server>:<tool>`、`{env:VAR}` 注入、超时熔断、指数退避 **1/2/4/8s 上限 5 次**、状态机含 `needs_auth`、输出截断落盘、**进程组回收（测试实证：孙进程 `sleep` 在 shutdown 后消失）**
- [x] **H5 `hub.rs`** — §9.2 命令路由 + 事件出口，transport 无关：52 个命令全覆盖、`EventSink` trait（Tauri 实现为 `emit`）、`(turn, seq)` 游标 + 512 条环形缓冲供 `resync`、三队列落 `checkpoints.queue_state`、权限规则落库后即时重建引擎、`Runtime` trait 接缝

---

## 三、待办（按优先级，可直接开工）

### T1 · 前端接上真宿主（代码与自动化验证完成 · 2026-10-16）
- [x] `ipc/client.ts` 占位桥删除：`createTauriTransport()` 改用 `@tauri-apps/api@2.12.4`（`invoke("duo_invoke", { cmd, args })` + `listen("duo://event")` 拆 Envelope 为 `(name, payload)`；实现在 `ipc/transport.ts`，底层原语可注入供测试 fake）
- [x] 标题栏红绿灯接窗口命令：tauri 态红=关窗 / 黄=最小化 / 绿=最大化还原（`duo_window_close` / `duo_window_minimize` / `duo_window_toggle_maximize`），带 aria-label；浏览器 mock 态保持原型纯装饰 DOM 不变（screens 测试零改动通过）。原型 CSS 只认 `.lights i`，故保留 `i` 标签 + 就地 biome-ignore（换标签会偏离 prototype.html）
- [x] 状态栏 runtime 文案：tauri 态显示 `ready` 事件带来的宿主 `runtime_version`（host-core），ready 未到回退前端 `RUNTIME_VERSION`；mock 态仍 `mock (browser)`
- [x] 新增 `src/test/transport-parity.test.ts`（3 用例）：52 命令子集在 tauri 通道必须包成固定信封 `{cmd,args}` 且 args 与 fixture 深比较逐字一致（防前端夹带宿主不认的字段）；同一批命令过两通道形状逐条一致；Envelope 解包与退订后不抛
- [ ] 真窗口内验收（`transportKind === "tauri"`、状态栏实际显示 host-core）：依赖 T2 首次 `pnpm tauri dev`
- 附带：`biome.json` 排除 `src-tauri/gen`（Tauri build 生成物，`acl-manifests.json` 非人类维护代码，format 门禁无法稳定通过）
- 验证证据：`pnpm typecheck` 干净 · `pnpm check` 62 文件 0 诊断 · 前端 **132/132** 通过（129 + 3 新增）· `pnpm i18n:gap` 漏译 0（941 条，新增「最大化或还原」）· `pnpm build` 成功 · 颜色基线 73 → 73

### T2 · Tauri 外壳运行时验证（2026-10-16 首次真跑成功）
- [x] 外壳编译通过：`cargo build --features shell` → `target/debug/duo`（34 MB debug），tauri 依赖树离线可解析（含 objc2 / wry / tray）
- [x] **首次真跑**：vite(5173) + debug 产物直跑（debug 构建自动连 `build.devUrl`，无需 `@tauri-apps/cli`——未新增依赖）。`DUO_DATA_DIR=/tmp/duo-t2-data` 下 SQLite 三件套建立、schema v7 迁移通过、setup 未 panic（`ready` 事件已广播）。窗口已可见，待用户直观验收下列三项
- [ ] 人工验收（进程运行中）：invoke/emit 往返（状态栏应显示 `host-core`、发一条消息应收到 `agent_error(runtime_unavailable)` 而非前端剧本）、关窗进托盘、托盘「显示主窗口 / 退出 duo」、红绿灯三键
- [ ] 退出时 `hub.shutdown_mcp()` 真的被 `RunEvent::ExitRequested` 触发（托盘退出后检查无残留子进程；现在只有单测覆盖 `shutdown_mcp` 本身）
- [ ] 打包资源：`icons/` 目前只有 RGBA png，`icns` / `ico` 需 `pnpm tauri icon`（要装 `@tauri-apps/cli`，**需用户批准新增依赖**）；Windows `webviewInstallMode` 配了但未验证

### T3 · `adapt.rs`:接 rpi Agent Runtime —— **已完成**(2026-10-16,用户批准拉取外部代码)
- [x] **Vendor**:`vendor/pi-rust` ← `bigfish1913/pi-rust` @ `b6b8e8311a4d6fd5dd1dc9e436e96f5d4cd22a52`(v0.4.0,MIT);只收 5 个 crate(telemetry/ai/agent/tools/harness),cli/tui/plugin-sdk/extensions 按 PLAN §13 不引入;补丁清单钉在 `vendor/pi-rust/Cargo.toml` 顶注(① rpi-tools 去 plugin-sdk、env 名内联;② rusqlite 0.31→0.32 与宿主统一,单份 bundled sqlite)
- [x] **`adapt.rs`(约 1000 行)**:`RpiRuntime` 实现 `hub::Runtime` —— 每会话一个 `AgentHarness`(harness 单槽),`before_tool_call` 接权限引擎(Auto/Deny/Ask→`human_confirm_required`+30min 超时回流+改参执行+写前快照),11 个 `AgentEvent` → duo 20 事件映射,消息/part 双写 SQLite,`FauxProvider` 走真循环做 e2e
- [x] **e2e 测试 5 条**(`cargo test --lib adapt`,连跑 6/6 稳定):纯文本流+落库 / write 审批放行(真写盘+file_changed+快照+审批 part 记录决定)/ 拒绝(不写盘、模型收到拒绝继续完成)/ 待审批中 stop(abort 语义 Stopped)/ 切模型重建 harness 历史不丢
- 集成决策(不许静默,对应代码内"决策 1–6"注释):
  1. **harness 用 `InMemorySessionStorage`**:UI 还原只从 duo SQLite(§6.9);代价 = rpi 原生崩溃续跑不跨重启
  2. 用户消息由提交侧落库:harness 不把 `MessageStart(User)` 广播进 pump(prompt 直写 session)
  3. 压缩边界 `kept/releasedTokens/tokens_after` rpi 不暴露 → 持久化 0(协议占位);`tokens_before` 真实
  4. `Runtime` trait 扩展 `steer/follow_up/cancel_queued` + `stop→bool`(duo 内部 trait,**20 事件/52 命令协议未动**,protocol-parity 无感)
  5. 新增依赖(**属"接入 rpi"批准范围**):rpi 五 crate(path)+ `reqwest`(rpi-ai providers feature,T4 的 provider_test 可复用)/ `schemars` / `async-trait` / `futures` / `tokio-util`
  6. hook/pump 在 async 上下文:SQLite 写改 `submit_fire`(单写队列顺序不变)+ 快照走专用 blocking 线程桥
- [x] 外壳 `bin/duo.rs` 接 `RpiRuntime` + `DbProviderFactory`(读 providers 表;`key_ref` 暂按环境变量名解析,真 keychain 属 T4);**端点未配置时 submit 如实 `provider_unconfigured` 错误卡,不假装跑通**
- [ ] 真端点验证(OpenAI 兼容网关)与 T4 的 keychain 一起做;MCP 工具并入 agent(`mcp:<server>:<tool>` 注册为 AgentTool)未做 —— 下一步

### T4 · 宿主还缺的能力
- [x] `provider_test` / `/models` 拉取 + 端点读命令（2026-10-16 补）：
  - `provider_test` = 真实 `GET {base}/models`（reqwest blocking），成功即**按 id 合并落库**（已有条目不覆盖、变体/价格字段保留）并记 `last_check`；密钥只存引用名（`{env:VAR}`/裸 env 名；`keychain:` 前缀在钥匙串接入前按无 key 处理）
  - 协议变更：**新增第 53 条命令 `provider_list`**（两端同步 + `SCHEMA_VERSION` 7→8，parity 测试把守）；`provider_upsert` 的 `api_key` 字段修正为 `key_ref`（明文密钥禁止过 IPC）
  - **`appState.model` 语义统一为模型 id**（此前显示名与宿主 id 匹配错位是"models 接不上"的直接原因）：端点页/模型下拉/弹窗全部改走 `provider_list` 真数据流（`ipc/providers.ts`），mock 同源形状
  - e2e：`adapt::tests::真实http端点_从刷新模型到跑完一个回合` —— provider_test→落库→**rpi 循环真 POST /chat/completions（SSE）→ text_delta→转录落库** 全链路不 mock
- [ ] MCP `sse` / `http` 传输：状态机与 `mcp:<server>:<tool>` 命名已共用，只差传输实现
- [ ] 系统通知（`tauri-plugin-notification`）与自动更新（updater + 签名校验）：UI 侧屏已做好，宿主未接
- [ ] keychain：`providers.key_ref` 只存引用名的约定已落库，真正的钥匙串读写需 `keyring` crate
- [ ] `terminal_open/write/resize/close`：当前返回 `FeatureOff("内嵌终端（xterm feature）默认不打包")`，与 PLAN 的可选 feature 定位一致；要做需 `portable-pty` + xterm
- [x] 单 writer 队列的真实并发压测（多会话同时写 + FTS 同事务）—— 2026-10-16 补：`store.rs::多会话并发写单writer无冲突且全文索引行数一致`，8 线程 × 25 条 part 各自会话经单队列串行写，全程 0 冲突；断言 parts=FTS 行数成对、每会话关键词全命中、updated_at 无丢写、写入期间读线程看到中间状态（WAL 读写并行）。cargo test 59 全绿
- [x] `reqwest` 已随 T3 落地（rpi-ai providers feature）：provider_test / models 拉取只差命令实现，无需再批依赖
- [ ] 其余仍需**新增依赖审批**：`keyring`、`tauri-plugin-notification`、updater、`portable-pty`+xterm —— 等用户拍板后再动

### T5 · 产品决策项（不是漏做，是需要你拍板）
- [ ] **PLAN §2 技术栈偏离**：现在原型 CSS 逐字移植 + 自研 primitives，未引入 Tailwind 4 / `@base-ui/react` / `@assistant-ui/react` / shiki / monaco / xterm。要不要回归 PLAN 的栈？代价是重做样式层与一批组件
- [ ] 演示内容语言：`data/scenes.ts`、`data/fixtures.ts`（会话正文、模型名等）与 `screens/registry.ts`（屏目索引元数据，⌘⇧S 原型导航用）**刻意保持中文**，不计入 i18n 覆盖率 —— 真实产品里这些来自后端 / 模型。如果希望英文态连演示正文一起翻，说一声，我按同一套清单机制补
- [ ] bundle 611 kB（>500 kB 警告线）：主要是 941 条语料 + 原型 CSS。要不要 code-split / 把语料拆成懒加载 chunk？

---

## 四、怎么验

```bash
pnpm typecheck                 # tsc --noEmit（当前干净）
pnpm check                     # ui-boundaries 门禁 + biome check（当前 61 文件 0 诊断）
pnpm --filter @duo/desktop test    # 132 个前端用例（79 屏 zh/en 双态、6 条 Turn 端到端、协议防漂移、transport 入参一致性、i18n 棘轮）
pnpm --filter @duo/desktop build   # dist：css 81.64 kB / js 611 kB
pnpm i18n:gap                  # 漏译清单（当前 0）；pnpm i18n:scan 重新生成 strings.json
cd packages/desktop/src-tauri
cargo test                     # 64 个宿主测试（+1 个 #[ignore] 压测；adapt 5 条为真 rpi 循环 e2e）
cargo test -- --ignored --nocapture   # checkpoint 快照墙钟
cargo clippy --tests           # 干净
cargo build --offline --features shell   # Tauri 外壳
```

改动文案后要跑 `pnpm i18n:scan`，否则 `i18n-coverage` 会以「清单过期」失败 —— 这是有意的。
