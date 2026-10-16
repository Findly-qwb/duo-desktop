/**
 * 消息流原子件：Markdown 正文 / 代码块 / 思考链 / diff / todo / 徽章行
 * DOM 结构与 class 与 prototype.html 的 D 段组件库一一对应。
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { Badge, Icon, type IconName } from "@duo/ui";
import { highlight } from "../../lib/highlight";
import { hydrateIcons, renderMarkdown, renderRich } from "../../lib/markdown";
import type { DiffLine, TodoItem } from "../../ipc/protocol";
import { toast } from "../../state/app";

/** 富文本正文（含 chip / filelink / cursor 等自定义类） */
export function Md({ html, plain }: { html: string; plain?: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => hydrateIcons(ref.current), []);
  const openFile = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-open]");
    if (el) toast(t("在编辑器打开 {open}", { open: el.dataset.open ?? "" }));
  };
  return (
    <div
      className={plain ? "md" : "md"}
      ref={ref}
      onClick={openFile}
      // 内容已经过 DOMPurify（lib/markdown.ts），模型输出不可信，先清洗再挂载
      dangerouslySetInnerHTML={{ __html: plain ? renderMarkdown(html) : renderRich(html) }}
    />
  );
}

export function CodeBlock({ lang, code, copyable = true }: { lang: string; code: string; copyable?: boolean }): JSX.Element {
  return (
    <div className="codeblock">
      <div className="cbhead">
        <Icon name="code" size="sm" />
        <span className="lang">{lang}</span>
        <span className="cp">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(code).catch(() => undefined);
              toast(t("已复制代码"));
            }}>
            <Icon name="copy" size="sm" />
            {t("复制")}
          </button>
          {copyable ? (
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new CustomEvent("duo:insert-prompt", { detail: code }));
                toast(t("已插入输入框"));
              }}>
              <Icon name="plus" size="sm" />
              {t("插入")}
            </button>
          ) : null}
        </span>
      </div>
      <pre dangerouslySetInnerHTML={{ __html: highlight(code) }} />
    </div>
  );
}

export function Think({ text, ms, defaultOpen }: { text: string; ms?: number; defaultOpen?: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => hydrateIcons(ref.current), []);
  return (
    <details className="think" open={defaultOpen}>
      <summary>
        <Icon name="bulb" size="sm" />
        <span>{t("思考过程")}</span>
        <span className="chev">
          <Icon name="chevron-right" size="sm" />
        </span>
        {ms ? <span className="dur">{ms}ms</span> : null}
      </summary>
      <div className="body" ref={ref} dangerouslySetInnerHTML={{ __html: renderRich(text) }} />
    </details>
  );
}

export function DiffBlock({ lines }: { lines: DiffLine[] }): JSX.Element {
  return (
    <div className="diff" role="list" aria-label={t("代码 diff")}>
      {lines.map((l, i) => (
        <span key={i} className={l.kind} role="listitem">
          <span className="gn" />
          {l.text}
        </span>
      ))}
    </div>
  );
}

export function TodoList({ items }: { items: TodoItem[] }): JSX.Element {
  return (
    <ul className="todo">
      {items.map((t, i) => (
        <li key={i} className={t.state ?? ""}>
          <span className="cb">{t.state === "done" ? <Icon name="check" size="sm" /> : null}</span>
          {t.text}
          {t.note ? <span className="pct">{t.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** 输出截断策略（PLAN §6.5）：超 230px 折叠 + 「已截断」提示 */
export function Output({ text, command }: { text: string; command?: boolean }): JSX.Element {
  const [expand, setExpand] = useState(false);
  const long = text.split("\n").length > 12;
  return (
    <>
      <pre className={command ? "cmd" : undefined} style={expand ? { maxHeight: 640 } : undefined}>
        {text}
      </pre>
      {long ? (
        <button type="button" className="btn xs" style={{ marginTop: 6 }} onClick={() => setExpand(v => !v)}>
          {expand ? t("tool.collapseOutput") : t("tool.expandOutput")}
        </button>
      ) : null}
    </>
  );
}

export function ResultBadge({ state }: { state: string | undefined }): JSX.Element | null {
  if (!state) return null;
  const map: Record<string, [string, "ok" | "err" | "run" | "warn" | "gray"]> = {
    done: ["tool.done", "ok"],
    running: ["tool.running", "run"],
    error: ["tool.error", "err"],
    denied: ["tool.denied", "err"],
    pending: ["tool.awaiting", "gray"],
    awaiting_approval: ["tool.awaiting", "warn"],
  };
  const hit = map[state];
  if (!hit) return null;
  return <Badge tone={hit[1]}>{t(hit[0] as never)}</Badge>;
}

export function StatBadge({ added, deleted }: { added?: number; deleted?: number }): JSX.Element | null {
  if (!added && !deleted) return null;
  return (
    <span className="stat">
      {added ? <span className="a">+{added}</span> : null}
      {deleted ? <span className="d">−{deleted}</span> : null}
    </span>
  );
}

/** 措辞分级当可信度用（PLAN §5.2）：单点检查不得写「验证通过」 */
export function VerifiedTag({ level }: { level?: "full" | "single-site" | "unverified" }): JSX.Element | null {
  if (!level) return null;
  const text = level === "full" ? t("verify.full") : level === "single-site" ? t("verify.single") : t("verify.none");
  return <span style={{ color: level === "full" ? "var(--text-ok)" : "var(--text-warn)" }}>{text}</span>;
}

export function HoverActs({
  opts,
}: {
  opts: { onCopy?: () => void; onFork?: () => void; onRevert?: () => void; extra?: JSX.Element; throughput?: string };
}): JSX.Element {
  return (
    <div className="hoveract">
      <button type="button" onClick={opts.onCopy ?? (() => toast(t("已复制")))}>
        <Icon name="copy" size="sm" />
        {t("复制")}
      </button>
      <button type="button" onClick={opts.onFork ?? (() => toast(t("已从此处 Fork 新会话")))}>
        <Icon name="fork" size="sm" />
        Fork
      </button>
      <button type="button" onClick={opts.onRevert ?? (() => toast(t("已回退到此处（checkpoint 恢复文件快照）")))}>
        <Icon name="redo" size="sm" />
        Revert
      </button>
      {opts.extra}
      {opts.throughput ? <span className="throughput">{opts.throughput}</span> : null}
    </div>
  );
}

export function Mark({ children }: { children: React.ReactNode }): JSX.Element {
  return <mark>{children}</mark>;
}

export function Chip({ icon, label }: { icon: IconName; label: string }): JSX.Element {
  return (
    <span className="chip" onClick={() => toast(t("在编辑器打开 {label}", { label: label }))}>
      <Icon name={icon} size="sm" />
      {label}
    </span>
  );
}
