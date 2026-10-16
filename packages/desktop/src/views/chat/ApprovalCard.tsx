/**
 * 审批卡（PLAN §5.3 / §6.6）
 * 硬约束：卡片出现时不得抢走输入焦点；用户已填参数必须存活于重渲染与场景切换之外
 * （用模块级草稿表按 callId 持有，而不是组件 state），改参后才放行。
 */
import { st } from "../../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { t, useLocale } from "../../i18n";
import { Badge, Icon } from "@duo/ui";
import { DiffBlock } from "./parts";
import type { Part } from "../../ipc/protocol";
import { toast } from "../../state/app";
import { client } from "../../ipc/client";

interface ApprovalContent {
  type: "approval";
  callId: string;
  tool: string;
  source: string;
  kind: "command" | "paths" | "diff";
  command?: string;
  paths?: string[];
  diff?: { kind: string; text: string }[];
  matchedRule?: string;
  hint?: string;
  expiresAt: number;
  decision?: "allow" | "deny" | "allow_always" | "expired";
  editable?: boolean;
  modifiedArgs?: string;
}

/** 改参数草稿：跨组件挂载/重渲染持有（对应 PLAN「保住用户已填参数」契约） */
const drafts = new Map<string, string>();

function useCountdown(expiresAt: number): string {
  const [left, setLeft] = useState(() => remaining(expiresAt));
  useEffect(() => {
    const t = setInterval(() => setLeft(remaining(expiresAt)), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return left;
}
function remaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return st("已超时");
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return st("{m}:{x0} 后自动拒绝", { m: m, x0: String(s).padStart(2, "0") });
}

/** punycode / 同形域名检测（PLAN §6.6 安全默认） */
function suspiciousHosts(text: string): string[] {
  const hosts = text.match(/https?:\/\/[^\s'"]+|xn--\w+/gi) ?? [];
  // 非 ASCII（同形字符）+ punycode 前缀都算可疑主机
  return hosts.filter(h => h.includes("xn--") || [...h].some(ch => (ch.codePointAt(0) ?? 0) > 127));
}

export function ApprovalCard({ part }: { part: Part }): JSX.Element {
  const c = part.content as ApprovalContent;
  useLocale();
  const [editing, setEditing] = useState(drafts.has(c.callId));
  const [value, setValue] = useState(drafts.get(c.callId) ?? c.command ?? "");
  const [showRules, setShowRules] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const countdown = useCountdown(c.expiresAt);
  const decided = c.decision;

  useEffect(() => {
    drafts.set(c.callId, value);
  }, [value, c.callId]);

  // 只有用户主动点「改参数」才移动焦点；卡片出现本身绝不抢焦点
  useEffect(() => {
    if (editing) draftRef.current?.focus();
  }, [editing]);

  // 卡片出现时只登记快捷键，不抢焦点（保住输入焦点）
  useEffect(() => {
    if (decided) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = !!t && /^(INPUT|TEXTAREA)$/.test(t.tagName);
      if (!editing && inField) return; // 用户正在输入框里，Esc/↵ 归输入框
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit("allow");
      } else if (e.key === "Escape") {
        e.preventDefault();
        submit("deny");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const risky = useMemo(() => suspiciousHosts(`${c.command ?? ""} ${(c.paths ?? []).join(" ")}`), [c]);
  // 以组件状态为准：草稿 Map 只负责跨挂载存活，不参与渲染判定
  const dirty = value !== (c.command ?? "");

  function submit(decision: "allow" | "deny" | "allow_always"): void {
    // 以当前编辑值为准（drafts 只负责跨挂载存活），避免闭包/时序导致改后参数丢失
    const modified = value;
    const changed = decision !== "deny" && modified !== (c.command ?? "");
    client.approve(c.callId, decision, changed ? modified : undefined);
    if (decision === "deny") {
      client.setOutcome({
        kind: "denied",
        title: st("已拒绝"),
        detail: st("代理收到 deny，回合终止（可在实验性页改为拒绝后继续）"),
      });
      toast(st("已拒绝"), "warn");
    } else if (decision === "allow_always") {
      toast(st("已为同类命令放行：{tool}", { tool: c.tool }), "ok");
      client.setOutcome(null);
    } else {
      toast(changed ? st("已按修改后的参数执行") : st("已允许一次"), "ok");
      client.setOutcome(null);
    }
    drafts.delete(c.callId);
  }

  if (decided) {
    return (
      <div
        className="outcome approval-resolved"
        data-approval={decided}
        style={{ borderColor: decided === "deny" ? "var(--surface-critical-base)" : "var(--surface-success-base)" }}>
        <Icon name={decided === "deny" ? "x" : "shield-check"} size="sm" />
        <span>
          <b>{decided === "deny" ? st("已拒绝") : decided === "allow_always" ? st("已始终允许此类") : st("已允许")}</b> · {c.tool}
          {c.modifiedArgs ? <span className="mono"> {st("· 按修改后参数执行")}</span> : null}
        </span>
      </div>
    );
  }

  return (
    <div className="dock-card" role="alertdialog" aria-label={st("权限审批：{tool}", { tool: c.tool })}>
      <div className="dc-head">
        <Icon name="alert" size="md" />
        <span>
          {c.kind === "command"
            ? t("approval.runCommand")
            : c.kind === "paths" || c.kind === "diff"
              ? t("approval.modifyFiles", { n: (c.paths ?? []).length })
              : t("approval.runCommand")}
        </span>
        <span className="src">{c.source}</span>
      </div>
      <div className="dc-hint">{c.hint ?? st("该操作将影响你的工作区。允许一次，或为同类操作放行。")}</div>

      {c.kind === "command" ? (
        <pre className="cmd">
          <span className="p">$</span> {c.command}
          <span
            style={{ float: "right", color: "var(--icon-base)", cursor: "pointer" }}
            role="button"
            tabIndex={0}
            aria-label={st("复制命令")}
            onClick={() => {
              void navigator.clipboard?.writeText(c.command ?? "").catch(() => undefined);
              toast(st("已复制命令"));
            }}>
            <Icon name="copy" size="sm" />
          </span>
        </pre>
      ) : null}

      {c.paths?.length ? (
        <div style={{ marginBottom: 8 }}>
          {c.paths.map(p => (
            <div className="grow" key={p}>
              <Icon name="file" size="sm" />
              {p}
            </div>
          ))}
        </div>
      ) : null}

      {c.diff?.length ? (
        <div style={{ marginBottom: 8 }}>
          <DiffBlock lines={c.diff as never} />
        </div>
      ) : null}

      {risky.length ? (
        <div className="notice err" style={{ marginBottom: 8 }}>
          <Icon name="alert" size="sm" />
          <div>
            {st("检测到可疑主机（punycode / 同形字符）：")}
            <span className="mono">{risky.join(" · ")}</span>
          </div>
        </div>
      ) : null}

      {c.matchedRule ? (
        <div className="rules">
          <div className="rh">
            <Icon name="shield" size="sm" />
            {t("命中规则")}
          </div>
          <div className="mono" style={{ color: "var(--text-weak)" }}>
            {c.matchedRule}
          </div>
          <div style={{ color: "var(--text-weaker)", marginTop: 4 }}>
            {st("分层取最严格者生效：global → project → session → mode")}
          </div>
        </div>
      ) : null}

      {editing ? (
        <div style={{ marginBottom: 10 }}>
          <label className="sr" htmlFor={`draft-${c.callId}`}>
            {t("修改后要执行的命令")}
          </label>
          <textarea
            id={`draft-${c.callId}`}
            ref={draftRef}
            className="tinp mono"
            style={{ width: "100%", minHeight: 62, fontSize: "var(--fs-11)" }}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={st("改参数后再执行，例如追加 --reporter=dot")}
          />
          <div style={{ fontSize: "var(--fs-10)", color: "var(--text-weaker)", marginTop: 4 }}>
            {t("改参后「允许一次」按新参数执行；原始命令仍记录在审批 part。")}
          </div>
        </div>
      ) : null}

      <div className="dc-foot">
        <Icon name="shield" size="sm" />
        <span>{st("已匹配 3 条例外规则（本次及以后的匹配）")}</span>
        <button type="button" className="btn xs" onClick={() => setShowRules(v => !v)}>
          {t("approval.viewRules")}
        </button>
      </div>
      {showRules ? (
        <ExceptionRules
          onClose={() => setShowRules(false)}
          onAdd={() => {
            toast(st("已添加例外：bun test * → allow"));
            setShowRules(false);
          }}
        />
      ) : null}

      <div className="dc-actions">
        <button type="button" className="btn primary" onClick={() => submit("allow")}>
          <Icon name="check" size="sm" />
          {dirty ? t("approval.allowEdited") : t("approval.allowOnce")}
        </button>
        <button type="button" className="btn danger" onClick={() => submit("deny")}>
          <Icon name="x" size="sm" />
          {t("approval.deny")}
        </button>
        <button type="button" className="btn" onClick={() => submit("allow_always")}>
          <Icon name="shield-check" size="sm" />
          {t("approval.allowAlways")}
        </button>
        {!editing ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              // 用户主动要求改参时才移动焦点（未点则绝不抢输入框焦点）
              setEditing(true);
              draftRef.current?.focus();
            }}>
            <Icon name="pencil" size="sm" />
            {t("approval.editArgs")}
          </button>
        ) : (
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setEditing(false);
              setValue(drafts.get(c.callId) ?? c.command ?? "");
            }}>
            {t("approval.cancelEdit")}
          </button>
        )}
        <span className="push">
          <span className="kbd">↵</span>
          {st("允许")}
          <span className="kbd">esc</span>
          {st("拒绝")}
          <Badge tone="warn">{countdown}</Badge>
        </span>
      </div>
    </div>
  );
}

/** 审批卡内第二步：例外三态（原型把规则编辑挪到卡片外，避免打断 yes/no） */
function ExceptionRules({ onClose, onAdd }: { onClose: () => void; onAdd: () => void }): JSX.Element {
  return (
    <div className="sgroup" style={{ margin: "8px 0" }}>
      <div className="gh">
        <Icon name="list" size="sm" />
        {t("例外规则（3）")}
        <span className="act">
          <button type="button" className="btn xs" onClick={onClose}>
            {t("收起")}
          </button>
        </span>
      </div>
      {[
        ["bun test *", st("只读测试命令放行"), "allow"],
        ["rm -rf *", st("危险删除，永远禁止"), "deny"],
        ["git commit *", st("提交需审批"), "ask"],
      ].map(([m, d, lvl]) => (
        <div className="perm-rule" key={m}>
          <div className="pl">
            <div className="n">
              <span className="mono">{m}</span>
            </div>
            <div className="d">{d}</div>
          </div>
          <span className={`lvl ${lvl === "ask" ? "ask" : lvl}`}>{lvl === "ask" ? "require_approval" : lvl}</span>
        </div>
      ))}
      <div className="addrow" style={{ padding: "9px 15px" }}>
        <input
          className="tinp mono"
          style={{ flex: 1, width: "auto" }}
          defaultValue="bun test ./test/session/*"
          aria-label="matcher"
        />
        <select className="sel" defaultValue="allow" aria-label={st("策略")}>
          <option value="allow">allow</option>
          <option value="require_approval">require_approval</option>
          <option value="deny">deny</option>
        </select>
        <button type="button" className="btn primary" onClick={onAdd}>
          {t("添加")}
        </button>
      </div>
    </div>
  );
}
