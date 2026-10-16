/**
 * 右栏 · 本地能力面板（PLAN §5.1 / §11 M6）
 * 入口卡片总览 + 子视图：文件树 / 终端 / 变更审查 / 后台任务；折叠态与子视图按项目记忆。
 * 不做 SSH、不做内网穿透。
 */
import { useState } from "react";
import { st } from "../i18n";
import { Badge, Icon, type IconName } from "@duo/ui";
import { FILES, GITFILES, SNAPSHOTS, ST, TASKS, TERMINALS } from "../data/fixtures";
import { actions, toast, useApp } from "../state/app";
import { client } from "../ipc/client";

const MODULES: { id: "tree" | "terminal" | "review" | "tasks"; icon: IconName; name: string; desc: string; meta: string }[] = [
  {
    id: "tree",
    icon: "folder",
    name: st("文件树"),
    desc: st("懒加载 · .gitignore 过滤 · 勾选加入上下文 · 预览子视图"),
    meta: ST.files,
  },
  {
    id: "terminal",
    icon: "terminal",
    name: st("终端"),
    desc: st("Rust PTY 会话 · 输出可回灌上下文"),
    meta: st("{terms} 活动", { terms: ST.terms }),
  },
  {
    id: "review",
    icon: "diff",
    name: st("变更审查"),
    desc: st("git 状态 / diff / 暂存提交 / 检查点 Revert"),
    meta: `+${ST.diff.a} −${ST.diff.d}`,
  },
  {
    id: "tasks",
    icon: "list-checks",
    name: st("后台任务"),
    desc: st("扫描 / 压缩 / MCP 重连等异步作业"),
    meta: String(ST.tasks),
  },
];

export function Dock(): JSX.Element {
  const app = useApp();
  const mod = MODULES.find(m => m.id === app.dock);

  return (
    <aside className="dock">
      <div className="dock-head">
        <span className="ttl">
          <Icon name={mod ? mod.icon : "layout"} />
          {mod ? mod.name : st("模块")}
        </span>
        <button
          type="button"
          className="iconbtn sm"
          style={{ marginLeft: "auto" }}
          title={st("关闭右栏 ⌥]")}
          aria-label={st("关闭右栏")}
          onClick={() => actions.openDock(null)}>
          <Icon name="x" size="sm" />
        </button>
      </div>
      <div className="dock-tabs" style={{ display: mod ? "flex" : "none" }}>
        {MODULES.map(m => (
          <button key={m.id} type="button" className={m.id === app.dock ? "on" : ""} onClick={() => actions.openDock(m.id)}>
            <Icon name={m.icon} size="sm" />
            {m.name}
          </button>
        ))}
      </div>
      <div className="dock-body">{mod ? <ModuleBody id={mod.id} /> : <ModPicker />}</div>
    </aside>
  );
}

function ModPicker(): JSX.Element {
  return (
    <>
      <div
        className="spec"
        style={{ margin: "0 0 10px", fontSize: "var(--fs-11)", color: "var(--text-weaker)", lineHeight: 1.5 }}>
        {st("本地能力入口 · 折叠态按项目记忆 · 无 SSH / 无内网穿透")}
      </div>
      {MODULES.map(m => (
        <div key={m.id} className="modcard" title={m.desc} onClick={() => actions.openDock(m.id)}>
          <span className="ic">
            <Icon name={m.icon} size="md" />
          </span>
          <h4 style={{ flex: 1, paddingTop: 6 }}>{m.name}</h4>
          <span className="meta">{m.meta}</span>
        </div>
      ))}
    </>
  );
}

function ModuleBody({ id }: { id: "tree" | "terminal" | "review" | "tasks" }): JSX.Element {
  if (id === "tree") return <TreeModule />;
  if (id === "terminal") return <TerminalModule />;
  if (id === "review") return <ReviewModule />;
  return <TasksModule />;
}

/* ---------------- 文件树 ---------------- */

function TreeModule(): JSX.Element {
  const [checked, setChecked] = useState<Record<string, boolean>>({ "store.ts": true });
  const [preview, setPreview] = useState<string | null>("session/store.ts");

  return (
    <>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
        <select
          className="sel"
          style={{ minWidth: 0, flex: 1 }}
          aria-label={st("项目")}
          onChange={e => toast(st("切换项目：{x}", { x: e.target.value }))}
          defaultValue="opencode">
          <option>opencode</option>
          <option>cloud-billing</option>
          <option>duocode</option>
        </select>
        <button
          type="button"
          className="iconbtn sm"
          title={st("刷新扫描")}
          aria-label={st("刷新扫描")}
          onClick={() => toast(st("已触发增量扫描"))}>
          <Icon name="refresh" size="sm" />
        </button>
        <button
          type="button"
          className="iconbtn sm"
          title={st("搜索文件（⌘P）")}
          aria-label={st("搜索文件")}
          onClick={() => actions.setPalette(true)}>
          <Icon name="search" size="sm" />
        </button>
      </div>

      <div className="tree">
        {FILES.map(f => (
          <div
            key={f.name}
            className={`n${checked[f.name] ? " sel" : ""}`}
            style={{ paddingLeft: (f.depth - 1) * 13 }}
            onClick={() => setPreview(f.name)}>
            <input
              type="checkbox"
              style={{ width: 13, height: 13 }}
              checked={!!checked[f.name]}
              aria-label={st("把 {x} 加入上下文", { x: f.name })}
              onClick={e => e.stopPropagation()}
              onChange={e => {
                setChecked(c => ({ ...c, [f.name]: e.target.checked }));
                toast(e.target.checked ? st("已加入上下文：{x}", { x: f.name }) : st("已移出上下文：{x}", { x: f.name }));
              }}
            />
            {f.dir && f.open ? (
              <Icon name="chevron-down" size="sm" />
            ) : f.dir ? (
              <Icon name="chevron-right" size="sm" />
            ) : (
              <span className="tw" />
            )}
            <Icon name={f.dir ? "folder" : "file"} size="sm" />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</span>
            {f.lines ? (
              <span className="mono" style={{ color: "var(--text-weaker)", fontSize: "var(--fs-10)" }}>
                {f.lines}
              </span>
            ) : null}
          </div>
        ))}
      </div>

      {preview ? (
        <div className="fileview">
          <div className="fvh">
            <Icon name="file" size="sm" />
            <b>{preview}</b>
            <span className="mono" style={{ marginLeft: "auto" }}>
              {st("UTF-8 · 128 行")}
            </span>
            <button type="button" className="btn xs" onClick={() => toast(st("在系统编辑器打开"))}>
              <Icon name="external" size="sm" />
              {st("打开")}
            </button>
          </div>
          <pre>{`export class SessionStore {
  private map = new Map<string, Session>()

  load(id: string): Session | undefined {
    return this.map.get(id)
  }
}`}</pre>
        </div>
      ) : null}

      <div className="notice info spec" style={{ marginTop: 10 }}>
        <Icon name="info" size="sm" />
        <div>
          {st("勾选的文件内容作为 part 注入本轮上下文（不塞 system prompt）。单文件上限 256KB / 8K tokens，超限截断并提示。")}
        </div>
      </div>
    </>
  );
}

/* ---------------- 终端（feature，默认不打包） ---------------- */

function TerminalModule(): JSX.Element {
  return (
    <>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button type="button" className="btn sm primary" onClick={() => toast(st("新建 PTY 会话（默认项目根目录）"))}>
          <Icon name="plus" size="sm" />
          {st("新建终端")}
        </button>
        <button type="button" className="btn sm" onClick={() => toast(st("已把当前输出注入输入框 @terminal"))}>
          <Icon name="arrow-up" size="sm" />
          {st("输出加入上下文")}
        </button>
      </div>
      {TERMINALS.map(t => (
        <div className="ucard" key={t.name} style={{ padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={`dot ${t.state === "running" ? "run" : "idle"}`} />
            <b style={{ color: "var(--text-strong)", fontSize: "var(--fs-12)" }}>{t.name}</b>
            <span className="mono" style={{ fontSize: "var(--fs-10)", color: "var(--text-weaker)" }}>
              pid {t.pid} · {t.dir}
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <button
                type="button"
                className="btn xs"
                aria-label={st("终止进程组")}
                onClick={() => toast(st("已终止进程组（含子进程）"))}>
                <Icon name="stop" size="sm" />
              </button>
              <button type="button" className="btn xs" aria-label={st("复制输出")} onClick={() => toast(st("已复制输出"))}>
                <Icon name="copy" size="sm" />
              </button>
            </span>
          </div>
          <pre className="cmd" style={{ marginTop: 7 }}>
            <span className="p">$</span> {t.cmd}
            {"\n"}
            {t.state === "running" ? st("bun test v1.3.2 …运行中") : "✓ 12 pass · 0 fail [3.1s]"}
          </pre>
        </div>
      ))}
      <div className="notice warn spec">
        <Icon name="alert" size="sm" />
        <div>
          {st("终端为可选 feature（默认不打包，省体积）。Agent 的")}
          <code className="mono">bash</code> {st("工具走同一 PTY 服务并受权限引擎约束。")}
        </div>
      </div>
    </>
  );
}

/* ---------------- 变更审查 ---------------- */

function ReviewModule(): JSX.Element {
  const [staged, setStaged] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState(
    st("feat(session): persist sessions to SQLite - 新增 SqliteStore（rusqlite + WAL） - 旧 JSON 会话首次启动自动迁移"),
  );

  return (
    <>
      <div
        className="grp"
        style={{ margin: "0 0 4px" }}
        title={st("分支 {branch} · ↑{ahead} ↓{behind} · origin/{branch2}", {
          branch: ST.branch,
          ahead: ST.ahead,
          behind: ST.behind,
          branch2: ST.branch,
        })}>
        {st("未提交变更（{length} · +{a} −{d}）", { length: GITFILES.length, a: ST.diff.a, d: ST.diff.d })}
        <span className="act">
          <button
            type="button"
            className="btn xs"
            onClick={() => {
              setStaged(Object.fromEntries(GITFILES.map(f => [f.path, true])));
              toast(st("已 git add -A"));
            }}>
            {st("全部暂存")}
          </button>
          <button
            type="button"
            className="btn xs"
            title={st("刷新（git status --porcelain=v2）")}
            aria-label={st("刷新")}
            onClick={() => toast(st("已刷新"))}>
            <Icon name="refresh" size="sm" />
          </button>
        </span>
      </div>

      {GITFILES.map(f => (
        <div className="grow" key={f.path}>
          <Badge tone={f.status === "M" ? "warn" : f.status === "A" ? "ok" : "err"}>{f.status}</Badge>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{f.path.split("/").pop()}</span>
          <span className="stat">
            {f.added ? <span className="a">+{f.added}</span> : null}
            {f.deleted ? <span className="d">−{f.deleted}</span> : null}
          </span>
          <button type="button" className="btn xs" onClick={() => setStaged(s => ({ ...s, [f.path]: !s[f.path] }))}>
            {staged[f.path] ? st("取消暂存") : st("暂存")}
          </button>
          <button
            type="button"
            className="iconbtn sm"
            title={st("查看 diff")}
            aria-label={st("查看 diff")}
            onClick={() => toast(st("展开 {path} diff", { path: f.path }))}>
            <Icon name="eye" size="sm" />
          </button>
          <button
            type="button"
            className="iconbtn sm"
            title={st("还原")}
            aria-label={st("还原文件")}
            onClick={() =>
              actions.askConfirm({
                title: st("还原 {x}？", { x: f.path.split("/").pop() ?? "" }),
                danger: true,
                ok: st("还原"),
                done: st("已还原"),
                body: st("git checkout -- 该文件；未提交改动会丢失（会话内 Revert 可回退到检查点）。"),
              })
            }>
            <Icon name="redo" size="sm" />
          </button>
        </div>
      ))}

      <div className="field" style={{ marginTop: 11 }}>
        <label htmlFor="commit-msg">{st("提交信息")}</label>
        <textarea id="commit-msg" className="commitbox" value={message} onChange={e => setMessage(e.target.value)} />
        <button
          type="button"
          className="btn sm"
          style={{ marginTop: 6 }}
          onClick={() => toast(st("已按 diff 用小模型生成提交信息"))}>
          <Icon name="sparkle" size="sm" />
          {st("AI 生成")}
        </button>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" className="btn primary sm" style={{ flex: 1 }} onClick={() => actions.openScene("perm-dock")}>
          <Icon name="check" size="sm" />
          {st("提交（需审批）")}
        </button>
        <button type="button" className="btn sm" onClick={() => actions.openScene("perm-dock")}>
          <Icon name="upload" size="sm" />
          {st("推送")}
        </button>
      </div>

      <div className="grp" style={{ margin: "14px 0 4px" }}>
        {st("检查点（本会话）")}
        <span className="act">
          <button type="button" className="btn xs" onClick={() => toast(st("checkpoint 仓库：~/.local/share/duo-desktop/ckpt"))}>
            {st("位置")}
          </button>
        </span>
      </div>
      {SNAPSHOTS.map((s, i) => (
        <div className="grow" key={s.oid} style={{ borderBottom: "1px solid var(--border-weak)" }}>
          <Icon name="history" size="sm" />
          <span style={{ flex: 1, minWidth: 80 }}>{s.at}</span>
          <span className="mono" style={{ fontSize: "var(--fs-10)", color: "var(--text-weaker)", flex: 1, textAlign: "right" }}>
            {s.oid} · {s.tool}
          </span>
          {i ? (
            <button
              type="button"
              className="btn xs"
              onClick={() =>
                actions.askConfirm({
                  title: st("回退到 {at}？", { at: s.at }),
                  ok: st("回退"),
                  done: st("已恢复 3 个文件（可 Redo）"),
                  body: st("从 checkpoint 仓库恢复文件到该快照；用户仓库 HEAD 与 index 不受影响。"),
                  extra: `${s.oid} · ${s.tool}\nstore.ts +64 −12 · sqlite-store.ts +214 · json-store.ts −88`,
                  after: () => client.revertToMessage("u1"),
                })
              }>
              <Icon name="redo" size="sm" /> Revert
            </button>
          ) : (
            <Badge tone="gray">{st("基线")}</Badge>
          )}
        </div>
      ))}
      <div className="mono spec" style={{ fontSize: "var(--fs-10)", color: "var(--text-weaker)", margin: "5px 0 8px" }}>
        {st("快照粒度：每个写类工具执行前一次 · 不碰用户 HEAD / index / reflog")}
      </div>
      <div className="notice info spec" style={{ marginTop: 10 }}>
        <Icon name="lock" size="sm" />
        <div>
          {st("提交/推送为")}
          <code className="mono">require_approval</code>
          {st("，永不自动执行。checkpoint 用独立 git-dir，不写用户 HEAD / reflog / stash。")}
        </div>
      </div>
    </>
  );
}

/* ---------------- 后台任务 ---------------- */

function TasksModule(): JSX.Element {
  const rt = client.snapshot();
  const tasks = [...TASKS];
  if (rt.scan)
    tasks.unshift({
      name: st("目录扫描 {project}", { project: rt.scan.project }),
      progress: Math.round((rt.scan.scanned / rt.scan.total) * 100),
      state: "run",
      detail: st("{x} / {x2} · .gitignore 生效", { x: rt.scan.scanned.toLocaleString(), x2: rt.scan.total.toLocaleString() }),
    });

  return (
    <>
      <div className="grp" style={{ margin: "0 0 6px" }}>
        {st("异步作业（{length}）", { length: tasks.length })}
        <span className="act">
          <button type="button" className="btn xs" aria-label={st("清空已完成")} onClick={() => toast(st("已清空已完成"))}>
            <Icon name="trash" size="sm" />
          </button>
        </span>
      </div>
      {tasks.map(t => (
        <div className="ucard" key={t.name} style={{ padding: 11 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={`dot ${t.state === "run" ? "run" : t.state === "err" ? "err" : "idle"}`} />
            <b style={{ fontSize: "var(--fs-12)", color: "var(--text-strong)" }}>{t.name}</b>
            <span style={{ marginLeft: "auto" }}>
              {t.state === "run" ? (
                <Badge tone="run">{st("进行中")}</Badge>
              ) : t.state === "err" ? (
                <Badge tone="err">{st("失败")}</Badge>
              ) : (
                <Badge tone="ok">{st("完成")}</Badge>
              )}
            </span>
          </div>
          <div className="meter">
            <i className={t.state === "err" ? "crit" : ""} style={{ width: `${t.progress}%` }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-weaker)" }}>
              {t.detail}
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
              {t.state === "run" ? (
                <button type="button" className="btn xs" onClick={() => toast(st("已取消该作业"))}>
                  <Icon name="x" size="sm" />
                  {st("取消")}
                </button>
              ) : null}
              {t.state === "err" ? (
                <button type="button" className="btn xs" onClick={() => toast(st("重试中…"))}>
                  <Icon name="refresh" size="sm" />
                  {st("重试")}
                </button>
              ) : null}
            </span>
          </div>
        </div>
      ))}
      <div className="notice info spec">
        <Icon name="info" size="sm" />
        <div>{st("扫描 / 压缩 / MCP 重连等耗时操作不阻塞对话；后台任务写库统一经单 writer 队列，避免 SQLITE_BUSY。")}</div>
      </div>
    </>
  );
}
