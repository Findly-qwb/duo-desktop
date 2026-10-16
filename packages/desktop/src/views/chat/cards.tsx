/**
 * 回合结果条 / 错误卡 / 提问卡 / 排队条 / 压缩分割线 / Revert 横幅 / 工作条
 * DOM 与原型 outcome() / ecard() / qDock() / queued() / compactLine() / revertBar() / working() 对应。
 */
import { useState } from "react";
import { t, useLocale, type Key } from "../../i18n";
import { Badge, Icon, type IconName } from "@duo/ui";
import type { Part, QuestionItem } from "../../ipc/protocol";
import { actions, toast } from "../../state/app";
import { client } from "../../ipc/client";
import type { Outcome } from "../../ipc/store";

/* ---------- 回合结果条（四态） ---------- */

export function OutcomeBar({ outcome }: { outcome: Outcome }): JSX.Element {
  useLocale();
  const map: Record<Outcome["kind"], { cls: string; icon: IconName }> = {
    done: { cls: "", icon: "check" },
    stopped: { cls: "stop", icon: "stop" },
    error: { cls: "err", icon: "alert" },
    limit: { cls: "limit", icon: "alert-circle" },
    denied: { cls: "stop", icon: "x" },
    panic: { cls: "err", icon: "alert" },
  };
  const m = map[outcome.kind];
  return (
    <div className={`outcome turn-${outcome.kind} ${m.cls}`} data-outcome={outcome.kind} role="status">
      <Icon name={m.icon} size="sm" />
      <span>
        <b>{titleFor(outcome)}</b>
        {detailFor(outcome) ? <> · {detailFor(outcome)}</> : null}
      </span>
      <span className="push" style={{ display: "flex", gap: 6 }}>
        {outcome.kind === "done" ? (
          <>
            <button type="button" className="btn sm" onClick={() => actions.openDock("review")}>
              <Icon name="diff" size="sm" />
              {t("outcome.viewDiff")}
            </button>
            <button type="button" className="btn sm" onClick={() => toast(t("已导出 markdown"))}>
              <Icon name="download" size="sm" />
              {t("outcome.export")}
            </button>
          </>
        ) : null}
        {outcome.kind === "stopped" ? (
          <>
            <button type="button" className="btn sm" onClick={() => toast(t("已回退到中断前"))}>
              <Icon name="redo" size="sm" />
              {t("outcome.revert")}
            </button>
            <button type="button" className="btn sm primary" onClick={() => toast(t("继续生成：请在输入框补充指令"))}>
              {t("outcome.resume")}
            </button>
          </>
        ) : null}
        {outcome.kind === "error" ? (
          <>
            <button type="button" className="btn sm" onClick={() => toast(t("已复制错误详情"))}>
              <Icon name="copy" size="sm" />
              {t("outcome.detail")}
            </button>
            <button type="button" className="btn sm primary" onClick={() => client.retryLast()}>
              {t("outcome.retry")}
            </button>
          </>
        ) : null}
        {outcome.kind === "limit" ? (
          <>
            <button type="button" className="btn sm" onClick={() => toast(t("上限 +$5（写入会话配置）"))}>
              $5 → $10
            </button>
            <button
              type="button"
              className="btn sm primary"
              onClick={() => {
                actions.openScene("perm-dock");
                toast(t("已批准继续，回合恢复"));
              }}>
              {t("outcome.approveMore")}
            </button>
          </>
        ) : null}
        {outcome.kind === "panic" ? (
          <>
            <button type="button" className="btn sm" onClick={() => actions.openModal("panic")}>
              {t("outcome.diagnose")}
            </button>
            <button
              type="button"
              className="btn sm primary"
              onClick={() => {
                client.retryLast();
                toast(t("已重试本 Turn"));
              }}>
              {t("outcome.retryTurn")}
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}

const OUTCOME_TITLE: Record<Outcome["kind"], Key> = {
  done: "outcome.done",
  stopped: "outcome.stopped",
  error: "outcome.error",
  limit: "outcome.limit",
  denied: "outcome.denied",
  panic: "outcome.panic",
};

function titleFor(o: Outcome): string {
  // 宿主下发过 summary 就用它，否则按 kind 走 i18n
  return o.title && o.title !== OUTCOME_TITLE[o.kind] ? o.title : t(OUTCOME_TITLE[o.kind]);
}

function detailFor(o: Outcome): string {
  return o.detail ?? "";
}

/* ---------- 错误卡 ---------- */

interface ErrorContent {
  type: "error";
  code: string;
  variant: "auth" | "rate" | "provider" | "retry" | "fatal";
  title: string;
  body: string;
  badge?: string;
  progress?: number;
  retryInMs?: number;
  actions?: string[];
}

export function ErrorCard({ part }: { part: Part }): JSX.Element {
  const c = part.content as ErrorContent;
  const icon: IconName =
    c.variant === "auth" ? "key" : c.variant === "rate" ? "clock" : c.variant === "retry" ? "refresh" : "alert-circle";
  return (
    <div className={`ecard ${c.variant}`}>
      <div className="eh">
        <Icon name={icon} size="md" />
        <span>{c.title}</span>
        {c.badge ? <Badge tone="gray">{c.badge}</Badge> : null}
      </div>
      <div className="ed">{c.body}</div>
      {c.progress ? (
        <div className="progressline">
          <i style={{ width: `${c.progress}%` }} />
        </div>
      ) : null}
      <div className="ea">
        {(c.actions ?? []).map(a => (
          <button
            key={a}
            type="button"
            className={`btn sm ${a === "update-key" || a === "add-endpoint" ? "primary" : ""} ${a === "cancel-retry" ? "danger" : ""}`}
            onClick={() => actionFor(a)}>
            <Icon name={actionIcon(a)} size="sm" />
            {actionLabel(a)}
          </button>
        ))}
        {c.retryInMs ? (
          <span className="countdown">
            {Math.ceil(c.retryInMs / 1000)}
            {t("s 后重试")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function actionFor(a: string): void {
  switch (a) {
    case "update-key":
      actions.openModal("endpoint", { n: t("Anthropic 兼容端点") });
      break;
    case "switch-model":
      actions.openScene("pop-model");
      break;
    case "add-endpoint":
      actions.openModal("endpoint");
      break;
    case "onboard":
      actions.go("onboard");
      break;
    case "retry-now":
      client.retryLast();
      toast(t("已立即重试"));
      break;
    case "cancel-retry":
      client.stop();
      toast(t("已取消重试"), "warn");
      break;
    default:
      break;
  }
}
function actionIcon(a: string): IconName {
  const map: Record<string, IconName> = {
    "update-key": "key",
    "switch-model": "cpu",
    "add-endpoint": "plus",
    onboard: "compass",
    "retry-now": "refresh",
    "cancel-retry": "x",
  };
  return map[a] ?? "external";
}
function actionLabel(a: string): string {
  const map: Record<string, string> = {
    "update-key": t("更新密钥"),
    "switch-model": t("换模型"),
    "add-endpoint": t("添加端点"),
    onboard: t("首启向导"),
    "retry-now": t("立即重试"),
    "cancel-retry": t("取消"),
  };
  return map[a] ?? a;
}

/* ---------- 提问卡 ---------- */

interface QuestionContent {
  type: "question";
  questionId: string;
  questions: QuestionItem[];
  index: number;
  answered?: string[];
}

export function QuestionCard({ part }: { part: Part }): JSX.Element {
  const c = part.content as QuestionContent;
  const [index, setIndex] = useState(c.index ?? 0);
  const [picked, setPicked] = useState<Record<number, number>>({ 0: 0 });
  const [custom, setCustom] = useState<Record<number, string>>({});
  const q = c.questions[Math.min(index, c.questions.length - 1)];
  const total = c.questions.length;

  const answer = (): void => {
    const chosen = picked[index] ?? 0;
    const label = custom[index] ?? q.options[chosen]?.label ?? "";
    const next = { ...picked };
    if (index + 1 < total) {
      setIndex(index + 1);
      toast(t("已记录：{label}", { label: label }));
    } else {
      client.answer(
        c.questionId,
        Object.keys(custom).length ? [label] : c.questions.map((_, i) => custom[i] ?? q.options[picked[i] ?? 0]?.label ?? ""),
      );
      toast(t("已提交回答（⌘↵）"));
    }
    setPicked(next);
  };

  return (
    <div className="dock-card q" role="dialog" aria-label={t("Agent 提问")}>
      <div className="dc-head">
        <Icon name="alert-circle" size="md" />
        <span>{t("问题 {x1}/{total}", { x1: index + 1, total: total })}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button
            type="button"
            className="iconbtn sm"
            aria-label={t("上一题")}
            disabled={index === 0}
            onClick={() => setIndex(i => Math.max(0, i - 1))}>
            <Icon name="chevron-up" size="sm" />
          </button>
          <button
            type="button"
            className="iconbtn sm"
            aria-label={t("下一题")}
            disabled={index >= total - 1}
            onClick={() => setIndex(i => Math.min(total - 1, i + 1))}>
            <Icon name="chevron-down" size="sm" />
          </button>
        </span>
      </div>
      <div style={{ fontSize: "var(--fs-13)", fontWeight: 600, color: "var(--text-strong)", marginBottom: 10 }}>{q.q}</div>
      {q.options.map((o, i) => (
        <div
          key={o.label}
          className={`qopt${(picked[index] ?? 0) === i ? " sel" : ""}`}
          role="radio"
          aria-checked={(picked[index] ?? 0) === i}
          tabIndex={0}
          onClick={() => setPicked(p => ({ ...p, [index]: i }))}
          onKeyDown={e => e.key === "Enter" && setPicked(p => ({ ...p, [index]: i }))}>
          <span className="mk" />
          <div style={{ minWidth: 0 }}>
            <div className="t">{o.label}</div>
            {o.detail ? <div className="d">{o.detail}</div> : null}
          </div>
          <span className="num">{i + 1}</span>
        </div>
      ))}
      {q.allowCustom ? (
        <div
          className={`qopt${custom[index] ? " sel" : ""}`}
          role="radio"
          aria-checked={!!custom[index]}
          tabIndex={0}
          onClick={() => setPicked(p => ({ ...p, [index]: q.options.length }))}>
          <span className="mk" />
          <div style={{ flex: 1 }}>
            <input
              className="tinp"
              style={{ width: "100%", border: "none", background: "transparent", padding: 0 }}
              placeholder={t("输入自定义答案…")}
              value={custom[index] ?? ""}
              onChange={e => setCustom(v => ({ ...v, [index]: e.target.value }))}
              aria-label={t("自定义答案")}
            />
          </div>
          <span className="num">✎</span>
        </div>
      ) : null}
      <div className="dc-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={() => toast(t("已跳过并继续"))}>
          {t("跳过")}
        </button>
        <span style={{ marginLeft: "auto" }} />
        <button type="button" className="btn" disabled={index === 0} onClick={() => setIndex(i => Math.max(0, i - 1))}>
          {t("上一题")}
        </button>
        <button type="button" className="btn primary" onClick={answer}>
          {index + 1 < total ? t("下一题") : t("提交")}
        </button>
      </div>
    </div>
  );
}

/** ask_user 工具卡的内联形态（区别于 dock 提问卡：嵌在消息流里，多题分组） */
export function InlineQuestion({ part }: { part: Part }): JSX.Element {
  const c = part.content as QuestionContent;
  return (
    <div className="tool running">
      <div className="thead">
        <span className="ti">
          <Icon name="alert-circle" size="sm" />
        </span>
        <span className="tname">Question</span>
        <span className="tsub">
          {c.questions.length} {t("个问题 · 等待回答")}
        </span>
        <span className="tstat">
          <Badge tone="warn">{t("等待输入")}</Badge>
        </span>
      </div>
      <div className="tbody">
        {c.questions.map((q, qi) => (
          <div key={q.q} style={{ marginBottom: qi + 1 < c.questions.length ? 12 : 0 }}>
            <div style={{ fontSize: "var(--fs-12)", color: "var(--text-strong)", fontWeight: 600, marginBottom: 7 }}>
              Q{qi + 1} · {q.q}
            </div>
            {q.options.map((o, i) => (
              <div
                className={`qopt${(c.index ?? 0) === qi && i === 0 ? " sel" : ""}`}
                key={o.label}
                style={{ padding: "7px 10px" }}
                onClick={() => toast(t("已选择：{label}", { label: o.label }))}>
                <span className="mk" />
                <div style={{ minWidth: 0 }}>
                  <div className="t" style={{ fontSize: "var(--fs-12)" }}>
                    {o.label}
                  </div>
                  {o.detail ? <div className="d">{o.detail}</div> : null}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- 排队条 / 压缩线 / Revert 横幅 / 工作条 ---------- */

export function QueuedBar({ id, text }: { id: string; text: string }): JSX.Element {
  return (
    <div className="queued">
      <span className="qtag">{t("排队中")}</span>
      <span className="t">{text}</span>
      <button
        type="button"
        className="btn xs"
        onClick={() => {
          client.queueAction(id, "edit");
          toast(t("已取回输入框编辑"));
        }}>
        <Icon name="pencil" size="sm" />
        {t("编辑")}
      </button>
      <button
        type="button"
        className="btn xs"
        onClick={() => {
          client.queueAction(id, "delete");
          toast(t("已删除排队项"));
        }}>
        <Icon name="trash" size="sm" />
        {t("删除")}
      </button>
      <button
        type="button"
        className="btn xs"
        onClick={() => {
          client.queueAction(id, "promote");
          toast(t("已提升为 steering（Turn 边界优先注入）"));
        }}>
        <Icon name="arrow-up" size="sm" />
        {t("提升")}
      </button>
    </div>
  );
}

export function CompactLine({ part }: { part: Part }): JSX.Element {
  const c = part.content as { type: "compact"; summaryTokens: number; kept: number; releasedTokens: number };
  return (
    <div className="compact">
      <span className="tag">
        <Icon name="archive" size="sm" />
        {t("上下文已压缩 · 摘要 {x} tokens · 保留 {kept} 条关键决策 · 释放{x2}", {
          x: c.summaryTokens.toLocaleString(),
          kept: c.kept,
          x2: " ",
        })}
        {(c.releasedTokens / 1000).toFixed(1)}K
      </span>
    </div>
  );
}

export function RevertBar({
  label,
  files,
  stat,
  detail,
}: {
  label: string;
  files: string;
  stat: string;
  detail: string;
}): JSX.Element {
  return (
    <div className="revertbar" role="status">
      <Icon name="history" size="md" />
      <span>
        <b>{t("已回退到 {label}", { label: label })}</b> {t("· 恢复 {files}（{stat}）", { files: files, stat: stat })}
      </span>
      <button type="button" className="btn sm" onClick={() => toast(t("已 Redo 一步"))}>
        <Icon name="redo" size="sm" />
        Redo
      </button>
      <button type="button" className="btn sm" onClick={() => toast(t("已 Redo 全部"))}>
        <Icon name="redo" size="sm" />
        Redo All
      </button>
      <span className="mono" style={{ marginLeft: "auto", fontSize: "var(--fs-11)" }}>
        {detail}
      </span>
    </div>
  );
}

export function Working({ text, elapsed, retry }: { text: string; elapsed?: string; retry?: boolean }): JSX.Element {
  return (
    <div className="working show" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{text}</span>
      {retry ? (
        <>
          <button
            type="button"
            className="btn sm danger"
            style={{ marginLeft: 8 }}
            onClick={() => {
              client.stop();
              toast(t("已取消重试"), "warn");
            }}>
            {t("取消重试")}
          </button>
          <span className="countdown">{t("第 2 次重试 · 3s")}</span>
        </>
      ) : null}
      <span className="elapsed">{elapsed ?? "12s"}</span>
    </div>
  );
}

export function Banner({
  tone,
  icon,
  html,
}: {
  tone: "info" | "warn" | "ok" | "err";
  icon: IconName;
  html: string;
}): JSX.Element {
  return (
    <div className={`notice ${tone} spec`} style={{ maxWidth: 768, margin: "0 auto 12px" }}>
      <Icon name={icon} size="sm" />
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
