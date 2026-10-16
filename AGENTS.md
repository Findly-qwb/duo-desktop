# AGENTS.md · duo Desktop 施工守则

本文件是**约束**，不是介绍。任何在此仓库工作的 agent（含本助手）都必须遵守。
仓库无 git 版本控制，改动前先备份到 `/tmp`，破坏性操作（删文件、批量改写、覆盖）需先说明。

---

## 1. 权威来源（不可偏离）

| 来源 | 管什么 | 冲突时 |
| --- | --- | --- |
| `PLAN.md`（v2.1） | 架构、模块边界、IPC 协议、SQLite schema、权限引擎、Git 双通道、MCP、体积与构建、里程碑 | **以 PLAN 为准** |
| `prototype.html` | 每一屏的 DOM 结构、类名、文案原文、间距/字号/颜色令牌、交互态 | **以原型为准**（含文案逐字） |
| `todos.md` | 当前进度、已批准偏离、待决策 | 反映事实，不许写"已完成"来掩盖未验证的事 |

**禁止静默偏离。** 若你认为 PLAN 或原型有问题（确实存在过：PLAN §10 的表级 `UNIQUE(IFNULL(...))` SQLite 会直接拒绝；prototype.html 156–159 有一段大括号不配对的悬空 token 块），做法是：

1. 用最小可运行的方式验证它真的有问题（写测试，别靠嘴说）；
2. 在代码里就地写注释说明原文是什么、为什么改、改成什么；
3. 同步记进 `todos.md`，并告知用户。

未经用户同意，不得引入新的技术栈替换、新的依赖、或"以后再说"的占位实现。已有偏离见 §7，**只减不增**。

---

## 2. 开工前必读（顺序不能换）

1. `todos.md` —— 看现在在哪、什么已做完、有没有你即将撞上的决策项；
2. `PLAN.md` 对应章节 —— 动哪个模块读哪节（§3 架构 / §4 皮肤 / §5 前端 / §6 runtime+权限+FS+适配 / §7 Git / §8 MCP / §9 协议 / §10 schema / §11 功能点 / §12 里程碑 / §13 构建 / §14 风险 / §15 工程结构）；
3. `prototype.html` 对应屏 —— 用屏目索引（⌘⇧S）或 `packages/desktop/src/screens/registry.ts` 的 `id` 定位，改完全屏对照原型；
4. 目标模块的现有代码与测试。

---

## 3. Todo 同步纪律（用户明确要求，不可省）

- 拆 todo 用任务工具（`TaskCreate` / `TaskUpdate`），**一个 todo = 一个可验证的结果**，不是"改文件"这种动作；
- 开始做就置 `in_progress`，做完立刻 `completed`；**做完 ≠ 通过验证不许标完成**；
- 发现新的必要工作当场补条目，不要憋着；被阻塞就把阻塞写进 `description`；
- 里程碑级别的变化同步到 `todos.md`（带证据：测试数、门禁结果、实测数字）；
- 每个里程碑收尾必须跑 §6 的全量验证，并把结果原样报给用户（含没跑成的部分）。

---

## 4. 架构硬约束（违反即返工）

- **只走 Tauri IPC**：`event` + `command`。不起 HTTP 服务、不开端口、不做鉴权层、不引入 sidecar 端口通信（PLAN §3.2）。
- **SQLite 是唯一事实来源**，写全部经单 writer 队列；`parts` 与 `parts_fts` 必须同事务（PLAN §10）。
- **跨重启的界面还原只从 SQLite 重建**；rpi 的 JSONL 绝不参与 UI 状态恢复（PLAN §6.9 硬约束）。
- **协议单一来源**：Rust `src-tauri/src/ipc.rs` 与前端 `src/ipc/protocol.ts` 的 20 事件 / 52 命令必须逐字一致，`protocol-parity.test.ts` 会解析两边并拦截漂移。改协议要同时改两处 + `SCHEMA_VERSION`。
- **事件游标语义是 `(session_id, turn_index, seq)`**，乱序要丢弃并触发 `resync`（带 `turn_index`）。
- **权限引擎取最严格者生效**（global → project → session → mode），例外列表只用于**收紧**，不能用来给模式默认放水；`commit` / `push` 属 REQUIRE_APPROVAL，永不自动执行。
- **Git 走系统 CLI**，不编译 `libgit2` / `git2`；checkpoint 用独立 `--git-dir`，绝不写用户 HEAD / index / reflog / stash。
- **MCP stdio 子进程**必须登记进程组并在停用/退出时回收（含孙进程）；异常按 1/2/4/8s 指数退避重启，上限 5 次。
- **安全默认**：API key 只进系统 keychain（库里只存 `key_ref` 引用名）、日志脱敏、无遥测上报、punycode/同形域名要在审批卡高亮。
- **崩溃域**：任务级 `catch_unwind`，panic 只终止该 Turn，不崩窗。
- **rpi 未接入时不许假装跑通**：`hub::Runtime` 默认实现以 `agent_error(runtime_unavailable)` 如实收尾。任何"看起来能用"的假成功都算缺陷。

---

## 5. 代码与文案规范

**样式 / UI**
- 组件层**不得出现硬编码颜色**，只能用 L1/L2/L3 令牌；`scripts/check-ui-boundaries.mjs` 的颜色基线（当前 **73**）只降不升，新增硬色会被门禁拒绝。
- `@duo/ui` 是叶子包：不得 import 桌面应用内部模块，也**不得含中文文案**（文案由调用方经 `t()` 传入，见 `Dot` / `auditContrast` 的处理方式）。
- 原型 CSS 已逐字移植到 `packages/ui/src/styles/*.css`（Biome 不格式化它们）。改样式先找原型对应行，别重新发明。

**i18n（source-string-as-key）**
- 中文是源语言，key 就是中文原文；漏译降级回中文，不显示 key 名。
- 新增文案：写成 `t("中文原文")` → 跑 `pnpm i18n:scan` 更新 `src/i18n/strings.json` → 在 `src/i18n/glossary.en.ts` 补英文。清单过期或不补译都会让测试失败，**这是有意的**。
- 动态文案一律 `t("删除 {name}？", { name })`，禁止 `已${t("启用")}` 这类跨语言拼接。
- `SETTINGS` / `SKINS` / `CONTRAST_TEXT` 这类"中文原文即 key"的表：**表内不包 `t()`**，只在渲染点译（`tr()` / `st()` / `contrastLabel()`）。因为 `onSpecial(label)` 之类会拿它做 `===` 判断，把译文当 key 会静默改逻辑。
- 批量抽取只能用 `scripts/i18n-extract.mjs`（AST 定位 + 按字符区间改写）。**禁止整文件正则批改**——上一版那么干损坏过 13 个文件。比较 / switch / 对象键 / className 等位置由脚本送进 NEEDS-REVIEW，人工判断。

**Rust**
- 每个模块自带 `#[cfg(test)]`，测试名用中文写清"在验证什么约束"；需要真实外部程序的（git、python 假 server）就真起，别 mock 掉断言。
- 错误类型必须可解释：区分"未接入"（`NoRuntime`）、"未打包的可选 feature"（`FeatureOff`）、"尚未实现"（`Unsupported`）、"参数不对"（`BadArgs`）。不要用 `unwrap()` 掩盖，也不要把失败吞成成功。
- 默认 `cargo test` 不拉 tauri 依赖树（外壳在 `--features shell` 后面）；不要把 tauri 变成默认依赖。

**工具链**
- 格式化/lint：Biome（`pnpm check`）。TS 严格模式；React 19 全局 `JSX` 命名空间由 `src/types/jsx.d.ts` 提供。
- 不新增依赖，除非用户批准；新增后要更新 `pnpm-lock.yaml` 并说明为什么需要。

---

## 6. 验证矩阵（改什么，跑什么）

| 改动 | 必跑 |
| --- | --- |
| 任何前端代码 | `pnpm typecheck` + `pnpm --filter @duo/desktop test` |
| 样式 / 组件 | 上述 + `pnpm check:ui-boundaries` + 起 `vite preview` 用浏览器对照原型截图 |
| 协议（事件/命令） | `protocol-parity.test.ts` + `cargo test` |
| 文案 | `pnpm i18n:scan` + `pnpm i18n:gap`（必须 0）+ `i18n-coverage` 测试 |
| Rust 宿主 | `cargo test` + `cargo clippy --tests`（须 0 warning） |
| 外壳 | `cargo build --offline --features shell` |
| 里程碑收尾 | 下面全量，且逐条报告结果 |

```bash
pnpm typecheck && pnpm check && pnpm --filter @duo/desktop test && pnpm --filter @duo/desktop build
cd packages/desktop/src-tauri && cargo test && cargo clippy --tests && cargo build --offline --features shell
```

交付前自查：改动过的屏是否在 **zh 与 en 两种语言、三套皮肤、折叠/展开两种栏宽**下都看过；测试是否真的断言了行为而不是快照糊弄。

---

## 7. 已存在的偏离（已记录，等用户拍板；不得再增）

1. 未引入 PLAN §2 的 Tailwind 4 / `@base-ui/react` / `@assistant-ui/react` / `@git-diff-view/react` / shiki / monaco / xterm —— 改为原型 CSS 逐字移植 + 自研 primitives + 零依赖高亮分词。理由：忠实还原原型且离线可构建。**属未批准偏离，见 `todos.md` T5。**
2. `data/scenes.ts`、`data/fixtures.ts`（演示会话正文、模型名）与 `screens/registry.ts`（屏目索引元数据）保持中文，不计入 i18n 覆盖率——按"内容层来自后端/模型"处理。
3. rpi 未 vendor：上游 0.x 需锁 commit hash，且本环境禁止拉取/检视外部代码。`hub::Runtime` 是留给 `adapt` 的接缝。
4. PLAN §10 schema 的 skills 唯一约束改为函数式唯一索引（SQLite 拒绝表级表达式）。
5. prototype.html 的悬空 token 块在移植时删除（见 `styles/skins.css` 就地注释）。

---

## 8. 禁止事项

- 禁止用 mock 冒充真实链路来"让测试变绿"；mock 只允许出现在明确标注为浏览器验收路径的位置（`ipc/mockRuntime.ts`）。
- 禁止顺手重构与任务无关的文件、批量格式化全仓、改动 `node_modules` 或 `pnpm-lock.yaml`（除新增依赖）。
- 禁止未经要求创建 README/文档、写"进度总结"型注释、或留下 `// TODO 以后` 而无对应 todo 条目。
- 禁止跳过 §3 的 todo 同步，禁止把多个里程碑攒到最后一次性汇报。
- 禁止把用户没要求的平台特性（Windows 终端、沙箱、插件市场、云同步）悄悄做进来。
- 外部网络：不主动拉取第三方源码；确需新依赖先向用户说明用途、体积与替代方案。

## 9. 需要问用户的情况

只有这几类值得打断：技术栈替换或新增依赖、与 PLAN/原型冲突且无法两全、影响已交付屏的破坏性改动、用户没定义过的产品决策（见 `todos.md` T5）。其余按本文与 PLAN 自行推进。
