/**
 * 工具卡全家（PLAN §11 M1）：read / list / glob / grep / bash 流式 / write / edit / apply_patch /
 * todo / ask_user / 子任务 / Skill / MCP 泛用；DOM 与原型 tool() 一致。
 */
import { useState } from "react";
import { t } from "../../i18n";
import { Badge, Icon, type IconName } from "@duo/ui";
import { DiffBlock, Output, ResultBadge, StatBadge, TodoList, VerifiedTag, Md } from "./parts";
import type { Part, PartContent } from "../../ipc/protocol";
import { actions } from "../../state/app";

interface ToolContent {
  type: "tool";
  tool: string;
  title: string;
  sub?: string;
  state: string;
  icon?: string;
  output?: string;
  isCommand?: boolean;
  stat?: { added?: number; deleted?: number };
  diff?: { kind: string; text: string }[];
  todos?: { text: string; state?: string; note?: string }[];
  paths?: string[];
  nested?: PartContent[];
  error?: string;
  source?: string;
  agent?: string;
  meta?: { verified?: "full" | "single-site" | "unverified"; truncated?: boolean; durationMs?: number };
}

const ICON_BY_TOOL: Record<string, IconName> = {
  read: "file",
  list: "folder-open",
  glob: "search",
  grep: "search",
  bash: "terminal",
  write: "file",
  edit: "diff",
  apply_patch: "diff",
  todo: "list-checks",
  ask_user: "alert-circle",
  task: "bot",
  skill: "sparkle",
  websearch: "globe",
  webfetch: "download",
};

function iconFor(c: ToolContent): IconName {
  if (c.icon && ICON_BY_TOOL[c.icon]) return ICON_BY_TOOL[c.icon];
  if (c.tool.startsWith("mcp:")) return "zap";
  return ICON_BY_TOOL[c.tool] ?? "file";
}

/** 检索类结果行：`标题|说明` */
function isResultSet(c: ToolContent): boolean {
  return (c.tool === "grep" || c.tool.startsWith("mcp:")) && !!c.output && c.output.includes("|") && !c.output.includes("\n{");
}

export function ToolCard({ part, depth = 0 }: { part: Part; depth?: number }): JSX.Element {
  const c = part.content as ToolContent;
  const [open, setOpen] = useState(true);
  const hasBody = !!(c.output || c.diff?.length || c.todos?.length || c.nested?.length || c.paths?.length || c.error);
  const cls = `tool${c.state === "running" ? " running" : ""}${c.state === "error" || c.state === "denied" ? " err" : ""}`;

  return (
    <div className={cls}>
      <div
        className="thead"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => hasBody && setOpen(v => !v)}
        onKeyDown={e => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          setOpen(v => !v);
        }}>
        <span className="ti">
          <Icon name={iconFor(c)} size="sm" />
        </span>
        <span className="tname">{c.title}</span>
        <span className="tsub">{c.sub ?? ""}</span>
        <span className="tstat">
          {c.meta?.durationMs && c.state === "done" ? <span>{(c.meta.durationMs / 1000).toFixed(1)}s</span> : null}
          <StatBadge added={c.stat?.added} deleted={c.stat?.deleted} />
          <ResultBadge state={c.state} />
          {c.state === "done" && (c.tool === "edit" || c.tool === "apply_patch" || c.tool === "write") ? (
            <button
              type="button"
              className="btn xs"
              onClick={e => {
                e.stopPropagation();
                actions.openDock("review");
              }}>
              <Icon name="eye" size="sm" />
              {t("Diff 面板")}
            </button>
          ) : null}
          {c.state === "running" && c.source === "subagent" ? (
            <button
              type="button"
              className="btn xs"
              onClick={e => {
                e.stopPropagation();
                actions.openDock("tasks");
              }}>
              <Icon name="pause" size="sm" />
              {t("后台化")}
            </button>
          ) : null}
        </span>
      </div>
      {hasBody && open ? (
        <div className="tbody">
          {c.error ? <pre style={{ color: "var(--surface-critical-strong)" }}>{c.error}</pre> : null}

          {c.diff?.length ? <DiffBlock lines={c.diff as never} /> : null}

          {c.todos?.length ? <TodoList items={c.todos as never} /> : null}

          {c.paths?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {c.paths.map((p, i) => (
                <div className="grow" key={p}>
                  <Badge tone={["M", "A", "M", "D"][i] === "A" ? "ok" : ["M", "A", "M", "D"][i] === "D" ? "err" : "warn"}>
                    {["M", "A", "M", "D"][i]}
                  </Badge>
                  <span style={{ flex: 1 }}>{p}</span>
                  <button type="button" className="btn xs" onClick={() => actions.toast(t("还原该文件（走 checkpoint）"))}>
                    <Icon name="redo" size="sm" />
                    {t("还原")}
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {c.nested?.length ? (
            <div className="sub-flow">
              {c.nested.map((content, i) =>
                content.type === "text" ? (
                  <Md key={i} html={content.md} />
                ) : (
                  <ToolCard
                    key={i}
                    part={{
                      id: `nested-${i}`,
                      messageId: part.messageId,
                      seq: i,
                      type: "tool",
                      content,
                      createdAt: 0,
                      updatedAt: 0,
                    }}
                    depth={depth + 1}
                  />
                ),
              )}
            </div>
          ) : null}

          {c.output && isResultSet(c) ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {c.output
                .split("\n")
                .filter(Boolean)
                .map(line => {
                  const [t, d] = line.split("|");
                  return (
                    <div className="grow" key={line} style={{ alignItems: "flex-start" }}>
                      <span className="gbadge A" style={{ borderRadius: "50%" }}>
                        <Icon name={c.tool.startsWith("mcp:") ? "book" : "globe"} size="sm" />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: "var(--f-ui)", color: "var(--text-strong)", fontWeight: 500 }}>{t}</div>
                        <div style={{ fontSize: "var(--fs-11)", color: "var(--text-weaker)", fontFamily: "var(--f-mono)" }}>
                          {d}
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          ) : c.output ? (
            <Output text={c.output} command={c.isCommand} />
          ) : null}

          {c.state === "done" && c.meta?.verified ? (
            <div style={{ marginTop: 7, fontSize: "var(--fs-11)", color: "var(--text-weaker)" }}>
              <VerifiedTag level={c.meta.verified} />
              {c.meta.truncated ? <span> {t("· 输出已截断（超出单工具上限，完整内容落盘）")}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
