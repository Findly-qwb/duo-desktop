/**
 * 屏目注册表（原型 §H SCREENS 的等价物）：⌘⇧S 索引与 ⌘K 直达共用同一张表。
 * 屏 ≠ 页面：多数屏是同一视图的不同状态，因此 kind 用来避免按独立页面估工。
 */
import { actions } from "../state/app";

export type Priority = "P0" | "P1" | "P2";
export type ScreenKind = "对话状态" | "弹窗" | "设置页" | "独立页" | "浮层 / 系统" | "皮肤";

export interface Screen {
  section: string;
  id: string;
  name: string;
  desc: string;
  pri: Priority;
  kind: ScreenKind;
  run: () => void;
}

const scene = (id: string) => () => actions.openScene(id);
const page = (v: Parameters<typeof actions.go>[0]) => () => actions.go(v);
const tab = (t: string) => () => actions.setSettingsTab(t);
const modal = (name: string, arg?: Record<string, unknown>) => () => {
  actions.openScene("chat-stream");
  actions.openModal(name as never, arg);
};
const dock = (m: "tree" | "terminal" | "review" | "tasks") => () => {
  actions.openScene("chat-stream");
  actions.openDock(m);
};

export const SCREENS: Screen[] = [
  /* ---------- M0 骨架与皮肤 ---------- */
  {
    section: "M0 骨架 / 皮肤",
    id: "onboard",
    name: "首启 · 配置端点",
    desc: "无账号无登录；填 OpenAI 兼容端点或本地模型",
    pri: "P0",
    kind: "独立页",
    run: page("onboard"),
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "chat-welcome",
    name: "三栏空态（欢迎）",
    desc: "居中大号输入框 + 快捷卡片",
    pri: "P0",
    kind: "对话状态",
    run: scene("welcome"),
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "chat-stream",
    name: "会话中（三栏全开）",
    desc: "TaskHeader + 时间线 + 流式 + 输入区",
    pri: "P0",
    kind: "对话状态",
    run: scene("chat-stream"),
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "skin-graphite",
    name: "皮肤 · 石墨深灰",
    desc: "深色 IDE · 蓝墨偏移",
    pri: "P0",
    kind: "皮肤",
    run: () => {
      actions.setSkin("graphite-dark");
      scene("chat-stream")();
    },
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "skin-paper",
    name: "皮肤 · 纸张浅灰",
    desc: "极简灰度 + 少量蓝强调",
    pri: "P0",
    kind: "皮肤",
    run: () => {
      actions.setSkin("paper-light");
      scene("chat-stream")();
    },
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "skin-amber",
    name: "皮肤 · 夜航暖橙",
    desc: "强调色可替换的扩展性验证",
    pri: "P1",
    kind: "皮肤",
    run: () => {
      actions.setSkin("nocturne-amber");
      scene("chat-stream")();
    },
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "skin-manager",
    name: "皮肤管理 · 导入与校验",
    desc: "skin.json bundle · extends · 对比度守护",
    pri: "P0",
    kind: "弹窗",
    run: modal("skin"),
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "set-display",
    name: "设置 · 显示与皮肤",
    desc: "字号滑杆实时生效 / 密度 / 折叠默认态",
    pri: "P0",
    kind: "设置页",
    run: tab("display"),
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "shell-nol",
    name: "左栏折叠",
    desc: "边缘把手恢复",
    pri: "P0",
    kind: "浮层 / 系统",
    run: () => {
      scene("chat-stream")();
      setTimeout(actions.toggleLeft, 0);
    },
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "shell-nor",
    name: "右栏折叠",
    desc: "能力面板收起，状态栏保留入口",
    pri: "P0",
    kind: "浮层 / 系统",
    run: () => {
      scene("chat-stream")();
      setTimeout(actions.toggleRight, 0);
    },
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "shell-focus",
    name: "专注模式（双栏折叠）",
    desc: "阅读/演示态",
    pri: "P1",
    kind: "浮层 / 系统",
    run: () => {
      scene("chat-stream")();
      setTimeout(actions.toggleFocus, 0);
    },
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "cmdk",
    name: "命令面板 ⌘K",
    desc: "会话 / 命令 / 面板 / 皮肤统一入口",
    pri: "P0",
    kind: "浮层 / 系统",
    run: () => {
      actions.openScene("chat-stream");
      setTimeout(() => actions.setPalette(true), 0);
    },
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "tray",
    name: "系统托盘菜单",
    desc: "后台运行 · 快速提问 · 退出",
    pri: "P1",
    kind: "浮层 / 系统",
    run: () => {
      actions.openScene("chat-stream");
      setTimeout(() => actions.setOsLayer("tray"), 0);
    },
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "notif",
    name: "系统通知",
    desc: "回合完成 / 需审批 / 异常终止",
    pri: "P1",
    kind: "浮层 / 系统",
    run: () => {
      actions.openScene("chat-stream");
      setTimeout(
        () => actions.showNotif("需要你的批准", 'Code 模式请求执行 <span class="mono">git commit -m "feat: sqlite store"</span>'),
        0,
      );
    },
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "update",
    name: "自动更新",
    desc: "签名校验 + 安装并重启",
    pri: "P1",
    kind: "浮层 / 系统",
    run: () => {
      actions.openScene("chat-stream");
      setTimeout(() => actions.setOsLayer("update"), 0);
    },
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "runtime",
    name: "Runtime 诊断",
    desc: "同进程 · Tokio · 子进程与 checkpoint 仓库",
    pri: "P0",
    kind: "弹窗",
    run: modal("runtime"),
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "panic",
    name: "任务异常隔离",
    desc: "catch_unwind：不崩窗，可重试或回退检查点",
    pri: "P0",
    kind: "弹窗",
    run: modal("panic"),
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "shortcuts",
    name: "快捷键",
    desc: "含全局快捷键与冲突提示",
    pri: "P1",
    kind: "弹窗",
    run: modal("shortcuts"),
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "project-new",
    name: "打开 / 新建工作空间",
    desc: "git 仓库与普通目录两种路径",
    pri: "P0",
    kind: "弹窗",
    run: modal("projectnew"),
  },
  {
    section: "M0 骨架 / 皮肤",
    id: "multiwin",
    name: "多窗口与布局记忆",
    desc: "几何 / 折叠态 / 面板子视图按项目存 ui_state",
    pri: "P1",
    kind: "弹窗",
    run: () => {
      actions.openScene("chat-stream");
      actions.askConfirm({
        title: "为新工作空间打开独立窗口？",
        ok: "新窗口",
        note: "UI 态写入 ui_state 表（不污染会话数据）",
        body: "opencode · 1440×900 · 左栏展开 · 面板=变更审查\ncloud-billing · 1280×820 · 左栏折叠 · 面板=文件树",
        done: "已按项目记忆还原布局",
      });
    },
  },

  /* ---------- M1 对话核心 ---------- */
  {
    section: "M1 对话核心",
    id: "tool-read",
    name: "工具卡 · Read / List / Glob / Grep",
    desc: "含失败态与输出截断",
    pri: "P0",
    kind: "对话状态",
    run: scene("tool-read"),
  },
  {
    section: "M1 对话核心",
    id: "tool-bash",
    name: "工具卡 · Bash",
    desc: "命令块 + 流式输出 + 超时 kill",
    pri: "P0",
    kind: "对话状态",
    run: scene("tool-bash"),
  },
  {
    section: "M1 对话核心",
    id: "tool-edit",
    name: "工具卡 · Write / Edit / Apply Patch",
    desc: "内嵌 diff + ±统计 + 审查面板跳转",
    pri: "P0",
    kind: "对话状态",
    run: scene("tool-edit"),
  },
  {
    section: "M1 对话核心",
    id: "tool-web",
    name: "工具卡 · 检索类（grep/MCP 文档）",
    desc: "结果列表 + 抓取正文",
    pri: "P1",
    kind: "对话状态",
    run: scene("tool-web"),
  },
  {
    section: "M1 对话核心",
    id: "tool-todo",
    name: "工具卡 · To-dos",
    desc: "完成 / 进行中 / 待办 + 分段耗时",
    pri: "P0",
    kind: "对话状态",
    run: scene("tool-todo"),
  },
  {
    section: "M1 对话核心",
    id: "tool-question",
    name: "工具卡 · ask_user（内联）",
    desc: "多题 + 选项 + 自定义答案",
    pri: "P0",
    kind: "对话状态",
    run: scene("tool-question"),
  },
  {
    section: "M1 对话核心",
    id: "tool-task",
    name: "工具卡 · 子任务 / Skill 注入",
    desc: "可展开子步骤 + 后台化",
    pri: "P1",
    kind: "对话状态",
    run: scene("tool-task"),
  },
  {
    section: "M1 对话核心",
    id: "tool-mcp",
    name: "工具卡 · MCP 泛用",
    desc: "结果 + needs_auth 态",
    pri: "P1",
    kind: "对话状态",
    run: scene("tool-mcp"),
  },
  {
    section: "M1 对话核心",
    id: "outcome-done",
    name: "回合结果 · 完成",
    desc: "turns / 费用估算 / 吞吐 + 反馈",
    pri: "P0",
    kind: "对话状态",
    run: scene("outcome-done"),
  },
  {
    section: "M1 对话核心",
    id: "outcome-stop",
    name: "回合结果 · 已中断",
    desc: "Esc 中断保留内容",
    pri: "P0",
    kind: "对话状态",
    run: scene("outcome-stop"),
  },
  {
    section: "M1 对话核心",
    id: "outcome-error",
    name: "回合结果 · 错误",
    desc: "SQLITE_IOERR + 重试",
    pri: "P0",
    kind: "对话状态",
    run: scene("outcome-error"),
  },
  {
    section: "M1 对话核心",
    id: "outcome-limit",
    name: "回合结果 · 花费熔断",
    desc: "达上限暂停并询问",
    pri: "P0",
    kind: "对话状态",
    run: scene("outcome-limit"),
  },
  {
    section: "M1 对话核心",
    id: "err-set",
    name: "错误卡集合",
    desc: "端点未配置 / 401 / 429 / 重试倒计时",
    pri: "P0",
    kind: "对话状态",
    run: scene("err-set"),
  },
  {
    section: "M1 对话核心",
    id: "perm-dock",
    name: "审批卡 · 命令",
    desc: "shell 高亮 + 复制 + 命中规则 + 例外三态",
    pri: "P0",
    kind: "对话状态",
    run: scene("perm-dock"),
  },
  {
    section: "M1 对话核心",
    id: "perm-edit",
    name: "审批卡 · 文件与 diff",
    desc: "路径列表 + diff 预览 + 始终允许 + 改参数",
    pri: "P0",
    kind: "对话状态",
    run: scene("perm-edit"),
  },
  {
    section: "M1 对话核心",
    id: "q-dock",
    name: "提问卡",
    desc: "多题翻页 + 自定义答案 + 跳过",
    pri: "P0",
    kind: "对话状态",
    run: scene("q-dock"),
  },
  {
    section: "M1 对话核心",
    id: "queued",
    name: "排队消息（steering 队列）",
    desc: "busy 时入队，可编辑 / 删除 / 提升",
    pri: "P0",
    kind: "对话状态",
    run: scene("queued"),
  },
  {
    section: "M1 对话核心",
    id: "revert",
    name: "Revert / Redo",
    desc: "消息 hover + 回退横幅 + 文件统计",
    pri: "P0",
    kind: "对话状态",
    run: scene("revert"),
  },
  {
    section: "M1 对话核心",
    id: "compact",
    name: "上下文压缩",
    desc: "分割线 + 阈值 + 摘要说明",
    pri: "P0",
    kind: "对话状态",
    run: scene("compact"),
  },
  {
    section: "M1 对话核心",
    id: "search",
    name: "转录内搜索 + PromptRail",
    desc: "Aa / 全词 / 正则 + n/m 计数",
    pri: "P0",
    kind: "对话状态",
    run: scene("search"),
  },
  {
    section: "M1 对话核心",
    id: "pop-slash",
    name: "斜杠命令补全",
    desc: "内置动作 + Skills 分组",
    pri: "P0",
    kind: "对话状态",
    run: scene("pop-slash"),
  },
  {
    section: "M1 对话核心",
    id: "pop-mention",
    name: "@ 提及",
    desc: "文件 / 目录 / 终端 / git 变更 / 检查点",
    pri: "P0",
    kind: "对话状态",
    run: scene("pop-mention"),
  },
  {
    section: "M1 对话核心",
    id: "pop-model",
    name: "模型选择弹层",
    desc: "按端点分组 + 收藏 + 上下文/价格/能力",
    pri: "P0",
    kind: "对话状态",
    run: scene("pop-model"),
  },
  {
    section: "M1 对话核心",
    id: "pop-shield",
    name: "权限速览弹层",
    desc: "各工具摘要 + 例外 + 熔断 + 跳全量设置",
    pri: "P0",
    kind: "对话状态",
    run: scene("pop-shield"),
  },
  {
    section: "M1 对话核心",
    id: "pop-mode",
    name: "模式切换 Ask/Plan/Code",
    desc: "含描述与策略预览",
    pri: "P0",
    kind: "对话状态",
    run: scene("pop-mode"),
  },
  {
    section: "M1 对话核心",
    id: "pop-variant",
    name: "推理变体选择器",
    desc: "端点无 variants 时自动隐藏 · ⇧Tab",
    pri: "P0",
    kind: "对话状态",
    run: scene("pop-variant"),
  },
  {
    section: "M1 对话核心",
    id: "attach",
    name: "附件缩略条",
    desc: "图片 Base64 直传视觉模型",
    pri: "P0",
    kind: "对话状态",
    run: scene("attach"),
  },
  {
    section: "M1 对话核心",
    id: "dragover",
    name: "拖拽热区",
    desc: "dragover 态 + 数量/体积上限",
    pri: "P1",
    kind: "对话状态",
    run: scene("dragover"),
  },
  {
    section: "M1 对话核心",
    id: "enhance",
    name: "提示词增强",
    desc: "小模型改写 + Ctrl+Z 回滚",
    pri: "P1",
    kind: "对话状态",
    run: scene("enhance"),
  },
  {
    section: "M1 对话核心",
    id: "goal",
    name: "Goal 模式",
    desc: "跨回合持续推进同一目标",
    pri: "P1",
    kind: "对话状态",
    run: scene("goal"),
  },
  {
    section: "M1 对话核心",
    id: "reload",
    name: "热重载",
    desc: "/reload 刷新 Skills 与 MCP",
    pri: "P1",
    kind: "对话状态",
    run: scene("reload"),
  },

  /* ---------- M2 会话与持久化 ---------- */
  {
    section: "M2 会话与持久化",
    id: "history",
    name: "历史会话",
    desc: "本地 SQLite · 工作空间过滤 · FTS 搜索",
    pri: "P0",
    kind: "独立页",
    run: page("history"),
  },
  {
    section: "M2 会话与持久化",
    id: "sess-ops",
    name: "会话行内操作",
    desc: "重命名 / 导出 / 软删 + 撤销",
    pri: "P0",
    kind: "弹窗",
    run: () => {
      actions.go("history");
      actions.askConfirm({
        title: "删除会话？",
        danger: true,
        ok: "删除",
        done: "已删除（软删，可撤销 10s）",
        body: "sessions.deleted_at 标记，30 天后清理；附件缓存与检查点一并回收。",
      });
    },
  },
  {
    section: "M2 会话与持久化",
    id: "draft",
    name: "草稿恢复",
    desc: "按会话隔离保存（drafts 表）",
    pri: "P1",
    kind: "对话状态",
    run: scene("chat-welcome"),
  },
  {
    section: "M2 会话与持久化",
    id: "resume",
    name: "断点恢复",
    desc: "重启后从 checkpoints.queue_state 续跑未完成 Turn",
    pri: "P0",
    kind: "弹窗",
    run: () => {
      actions.openScene("chat-stream");
      actions.askConfirm({
        title: "恢复上次未完成的任务？",
        ok: "恢复",
        done: "已从检查点续跑（Turn 5）",
        body: "应用在你离开时退出了，队列状态已持久化。",
        extra: "queue_state：main 0 · steering 1 · follow-up 2\nlast_turn：4 · 文件快照 3b8de02",
      });
    },
  },

  /* ---------- M3 权限与安全 ---------- */
  {
    section: "M3 权限与安全",
    id: "approve-page",
    name: "权限与审批页",
    desc: "三态 × 分层作用域 + 例外 matcher + effective 表",
    pri: "P0",
    kind: "设置页",
    run: tab("approve"),
  },
  {
    section: "M3 权限与安全",
    id: "tools-page",
    name: "工具策略页",
    desc: "逐工具策略 + 输出截断 + 沙箱(P1)",
    pri: "P0",
    kind: "设置页",
    run: tab("tools"),
  },
  {
    section: "M3 权限与安全",
    id: "cost",
    name: "花费与熔断",
    desc: "估算上限 / 最大 Turn / 重复检测",
    pri: "P0",
    kind: "弹窗",
    run: modal("cost"),
  },
  {
    section: "M3 权限与安全",
    id: "sec-defaults",
    name: "安全默认",
    desc: "keychain · 无端口 · 无遥测 · punycode 提示",
    pri: "P0",
    kind: "设置页",
    run: tab("approve"),
  },

  /* ---------- M4 端点与模型 ---------- */
  {
    section: "M4 端点与模型",
    id: "endpoints",
    name: "模型端点列表",
    desc: "OpenAI 兼容 · key 引用 · 连通性",
    pri: "P0",
    kind: "设置页",
    run: tab("endpoints"),
  },
  {
    section: "M4 端点与模型",
    id: "endpoint-new",
    name: "添加端点",
    desc: "base URL + key + 协议细节",
    pri: "P0",
    kind: "弹窗",
    run: modal("endpoint"),
  },
  {
    section: "M4 端点与模型",
    id: "endpoint-edit",
    name: "编辑端点",
    desc: "/models 拉取合并 + 思考链字段 + 超时重试",
    pri: "P0",
    kind: "弹窗",
    run: modal("endpoint", { n: "Ollama（本地）" }),
  },
  {
    section: "M4 端点与模型",
    id: "role-models",
    name: "角色模型",
    desc: "对话 / 小模型 / 压缩 + 按模式覆盖",
    pri: "P0",
    kind: "设置页",
    run: tab("models"),
  },

  /* ---------- M5 扩展 ---------- */
  {
    section: "M5 扩展",
    id: "mcp",
    name: "MCP 页",
    desc: "三协议 · 状态机 · Sign in / 重试 / 删除",
    pri: "P1",
    kind: "独立页",
    run: page("mcp"),
  },
  {
    section: "M5 扩展",
    id: "mcp-edit",
    name: "MCP 编辑",
    desc: "stdio 命令/args/env 与 remote url/headers + 策略",
    pri: "P1",
    kind: "弹窗",
    run: modal("mcp"),
  },
  {
    section: "M5 扩展",
    id: "skills",
    name: "Skills 页",
    desc: "扫描目录 · 作用域 · 重载",
    pri: "P1",
    kind: "独立页",
    run: page("skills"),
  },
  {
    section: "M5 扩展",
    id: "skill-new",
    name: "Skill 编辑",
    desc: "命令 / 作用域 / 模型变体覆盖 / 模板占位",
    pri: "P1",
    kind: "弹窗",
    run: modal("skill"),
  },

  /* ---------- M6 能力面板与设置 ---------- */
  {
    section: "M6 能力面板",
    id: "panel-tree",
    name: "文件树",
    desc: "懒加载 + .gitignore + 勾选加入上下文 + 预览",
    pri: "P0",
    kind: "浮层 / 系统",
    run: dock("tree"),
  },
  {
    section: "M6 能力面板",
    id: "panel-terminal",
    name: "终端",
    desc: "PTY 会话 + 输出加入上下文（feature）",
    pri: "P1",
    kind: "浮层 / 系统",
    run: dock("terminal"),
  },
  {
    section: "M6 能力面板",
    id: "panel-review",
    name: "变更审查",
    desc: "git 状态 / diff / 暂存提交 / 检查点 Revert",
    pri: "P0",
    kind: "浮层 / 系统",
    run: dock("review"),
  },
  {
    section: "M6 能力面板",
    id: "panel-tasks",
    name: "后台任务",
    desc: "扫描 / 压缩 / MCP 重连 · 可取消可重试",
    pri: "P1",
    kind: "浮层 / 系统",
    run: dock("tasks"),
  },
  {
    section: "M6 能力面板",
    id: "panel-picker",
    name: "能力面板入口总览",
    desc: "折叠态与子视图按项目记忆",
    pri: "P0",
    kind: "浮层 / 系统",
    run: dock(null as never),
  },
  {
    section: "M6 设置",
    id: "set-context",
    name: "设置 · 上下文",
    desc: "压缩阈值 / 注入预算 / watcher 忽略",
    pri: "P0",
    kind: "设置页",
    run: tab("context"),
  },
  {
    section: "M6 设置",
    id: "set-git",
    name: "设置 · Git 与检查点",
    desc: "CLI 后端 / 提交策略 / 快照保留",
    pri: "P0",
    kind: "设置页",
    run: tab("git"),
  },
  {
    section: "M6 设置",
    id: "set-files",
    name: "设置 · 文件与附件",
    desc: "扫描预算 / 附件缓存与上限",
    pri: "P1",
    kind: "设置页",
    run: tab("files"),
  },
  {
    section: "M6 设置",
    id: "set-notify",
    name: "设置 · 通知",
    desc: "触发条件 / 提示音 / 静默时段",
    pri: "P1",
    kind: "设置页",
    run: tab("notify"),
  },
  {
    section: "M6 设置",
    id: "set-experimental",
    name: "设置 · 实验性",
    desc: "终端 / 索引 / 多代理 / 沙箱",
    pri: "P2",
    kind: "设置页",
    run: tab("experimental"),
  },
  {
    section: "M6 设置",
    id: "set-about",
    name: "设置 · 关于与诊断",
    desc: "版本 / runtime / 数据路径 / 构建习惯",
    pri: "P1",
    kind: "设置页",
    run: tab("about"),
  },
  {
    section: "M6 设置",
    id: "usage-modal",
    name: "用量与费用（估算）",
    desc: "Token 细分 + 上下文三段 + 估算声明",
    pri: "P0",
    kind: "弹窗",
    run: modal("usage"),
  },
];

export const SCREEN_SECTIONS = [...new Set(SCREENS.map(s => s.section))];

export function findScreen(id: string): Screen | undefined {
  return SCREENS.find(s => s.id === id);
}

/** 命令面板条目（原型 PALETTE 的等价物，含真实动作） */
export interface PaletteItem {
  group: string;
  icon: string;
  title: string;
  shortcut?: string;
  run: () => void;
}

export const PALETTE: PaletteItem[] = [
  {
    group: "会话",
    icon: "chat",
    title: "打开：给 SessionStore 加 SQLite 持久化",
    shortcut: "⌘1",
    run: () => actions.openScene("chat-stream"),
  },
  { group: "会话", icon: "history", title: "历史会话", run: () => actions.go("history") },
  { group: "会话", icon: "plus", title: "新会话", shortcut: "⌘N", run: () => actions.openScene("welcome") },
  { group: "会话", icon: "history", title: "回退到上一检查点", shortcut: "⌘⇧R", run: () => actions.openScene("revert") },
  { group: "导航", icon: "cpu", title: "选择模型", shortcut: "/models", run: () => actions.openScene("pop-model") },
  { group: "导航", icon: "sliders", title: "打开设置", shortcut: "⌘,", run: () => actions.go("settings") },
  { group: "导航", icon: "slash", title: "Skills（斜杠命令）", run: () => actions.go("skills") },
  { group: "导航", icon: "zap", title: "MCP Servers", run: () => actions.go("mcp") },
  { group: "导航", icon: "folder", title: "文件与附件设置", run: () => actions.setSettingsTab("files") },
  { group: "导航", icon: "shield-check", title: "自动批准规则", run: () => actions.setSettingsTab("approve") },
  { group: "面板", icon: "diff", title: "变更审查（git / 暂存 / 检查点）", run: () => actions.openDock("review") },
  { group: "面板", icon: "folder-open", title: "文件树", run: () => actions.openDock("tree") },
  { group: "面板", icon: "terminal", title: "终端（PTY）", run: () => actions.openDock("terminal") },
  { group: "面板", icon: "list-checks", title: "后台任务", run: () => actions.openDock("tasks") },
  { group: "面板", icon: "archive", title: "压缩当前上下文", shortcut: "/compact", run: () => actions.openScene("compact") },
  { group: "面板", icon: "search", title: "转录内搜索", shortcut: "⌘F", run: () => actions.openScene("search") },
  { group: "面板", icon: "activity", title: "用量与费用", run: () => actions.openModal("usage") },
  {
    group: "命令",
    icon: "download",
    title: "导出 Markdown 转录",
    shortcut: "/export",
    run: () => actions.toast("已导出 session-2026-10-16.md"),
  },
  {
    group: "命令",
    icon: "refresh",
    title: "重载 Skills / Commands",
    shortcut: "/reload",
    run: () => actions.openScene("reload"),
  },
  { group: "命令", icon: "key", title: "添加模型端点", run: () => actions.openModal("endpoint") },
  { group: "命令", icon: "cpu", title: "重启 Agent Runtime（会话保留）", run: () => actions.openModal("runtime") },
  { group: "系统", icon: "monitor", title: "托盘菜单", run: () => actions.setOsLayer("tray") },
  {
    group: "系统",
    icon: "bell",
    title: "发送测试系统通知",
    run: () => actions.showNotif("回合完成", "9 steps · 1m 42s · $0.0421（估算）· 42.1 tok/s"),
  },
  { group: "系统", icon: "upload", title: "检查更新", run: () => actions.setOsLayer("update") },
  { group: "皮肤", icon: "palette", title: "皮肤管理 / 导入 skin.json", run: () => actions.openModal("skin") },
  { group: "皮肤", icon: "moon", title: "切换到 纸张浅灰", run: () => actions.setSkin("paper-light") },
  { group: "皮肤", icon: "sun", title: "切换到 石墨深灰", run: () => actions.setSkin("graphite-dark") },
  { group: "皮肤", icon: "moon", title: "切换到 夜航暖橙", run: () => actions.setSkin("nocturne-amber") },
  { group: "系统", icon: "layout", title: "屏目索引（全部原型屏）", shortcut: "⌘⇧S", run: () => actions.setScreenMap(true) },
  { group: "系统", icon: "eye", title: "原型层：显示 / 隐藏规格说明", shortcut: "⌘⇧P", run: () => actions.toggleProto() },
];
