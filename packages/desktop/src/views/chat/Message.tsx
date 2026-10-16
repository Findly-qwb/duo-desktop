/** 消息气泡（用户 / 助手），DOM 对应原型 userMsg() / aiMsg() */
import { useEffect, useRef } from "react";
import { t } from "../../i18n";
import { Badge, Icon } from "@duo/ui";
import type { RuntimeMessage } from "../../ipc/store";
import type { Part } from "../../ipc/protocol";
import { HoverActs, Md, Think } from "./parts";
import { ToolCard } from "./ToolCard";
import { ApprovalCard } from "./ApprovalCard";
import { ErrorCard, InlineQuestion, QuestionCard, CompactLine } from "./cards";
import { actions, toast } from "../../state/app";
import { client } from "../../ipc/client";

const DUO_MARK_PATH = "M5 21V9a7 7 0 0 1 14 0v12l-3.5-2.5L12 21l-3.5-2.5z";

/** sprite 图标占位 hydrate（chip / 工具图标写在富文本字符串里） */
function useHydrate(ref: React.RefObject<HTMLDivElement | null>, _deps: unknown): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>("[data-icon]").forEach(el => {
      const name = el.dataset.icon;
      if (!name || el.querySelector("svg")) return;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "i sm");
      svg.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", `#i-${name}`);
      svg.appendChild(use);
      el.insertBefore(svg, el.firstChild);
      delete el.dataset.icon;
    });
  }, [ref.current]);
}

export function Message({ msg }: { msg: RuntimeMessage }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useHydrate(ref, msg.parts);

  if (msg.role === "user") {
    const text = msg.parts.find(p => p.content.type === "text");
    return (
      <div className="msg user" ref={ref}>
        <div className="meta">
          {msg.mode ? <Badge tone="gray">{msg.mode}</Badge> : null}
          {msg.model ? <span className="mono">{msg.model}</span> : null}
          {msg.time ? <span className="mono">{msg.time}</span> : null}
        </div>
        {text && text.content.type === "text" ? <div className="bubble">{<Md html={text.content.md} />}</div> : null}
        {msg.attach?.length ? (
          <div className="attach">
            {msg.attach.map(a => (
              <div className="thumb" key={a.name} title={t("点击放大预览")} onClick={() => actions.openDock("tree")}>
                <img src={a.src} alt={a.name} />
                <span
                  className="rm"
                  role="button"
                  tabIndex={0}
                  aria-label={t("移除附件 {x}", { x: a.name })}
                  onClick={e => {
                    e.stopPropagation();
                    toast(t("已移除附件"));
                  }}>
                  <Icon name="x" size="sm" />
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <HoverActs
          opts={{
            onRevert: () => revertTo(msg),
            extra: <ForkButton />,
          }}
        />
      </div>
    );
  }

  return (
    <div className="msg ai" ref={ref}>
      <div className="aihead">
        <span className="mark">
          <svg viewBox="0 0 24 24" fill="none" style={{ width: 11, height: 11 }} aria-hidden="true">
            <path d={DUO_MARK_PATH} stroke="#c6d0de" strokeWidth={1.6} />
            <path d="M9.4 10.6h1.6M13 10.6h1.6" stroke="#58a6ff" strokeWidth={2.4} strokeLinecap="round" />
          </svg>
        </span>
        <span className="who">duo</span>
        {msg.mode ? <Badge tone="gray">{msg.mode}</Badge> : null}
        {msg.agent ? <Badge tone="purple">{msg.agent}</Badge> : null}
        <span className="mono">{msg.model ?? "claude-sonnet-4.5"}</span>
        {msg.duration ? (
          <span className="mono" style={{ marginLeft: "auto" }}>
            {msg.duration}
          </span>
        ) : null}
      </div>
      {msg.parts.map(p => (
        <PartView key={p.id} part={p} />
      ))}
      {msg.checkpointOid && msg.role === "assistant" ? (
        <HoverActs opts={{ onRevert: () => revertTo(msg), extra: <ForkButton />, throughput: "42.1 tok/s" }} />
      ) : null}
    </div>
  );
}

function ForkButton(): JSX.Element {
  return (
    <button type="button" onClick={() => toast(t("已从此处 Fork 新会话"))}>
      <Icon name="fork" size="sm" />
      Fork
    </button>
  );
}

function revertTo(msg: RuntimeMessage): void {
  actions.askConfirm({
    title: t("回退到 {x}？", { x: msg.time ?? t("本条消息") }),
    ok: t("回退"),
    done: t("已恢复 3 个文件（可 Redo）"),
    body: t("从 checkpoint 仓库恢复文件到该快照；用户仓库 HEAD 与 index 不受影响。"),
    extra: `${msg.checkpointOid ?? "a10c4f7"}\nstore.ts +64 −12 · sqlite-store.ts +214 · json-store.ts −88`,
    note: t("按文件粒度 git checkout <ckpt> -- <paths>"),
    after: () => client.revertToMessage(msg.id),
  });
}

export function PartView({ part }: { part: Part }): JSX.Element | null {
  const c = part.content;
  switch (c.type) {
    case "text":
      return <Md html={c.md} />;
    case "reasoning":
      return <Think text={c.text} ms={c.durationMs} defaultOpen={!c.collapsed} />;
    case "tool":
      return <ToolCard part={part} />;
    case "approval":
      return <ApprovalCard part={part} />;
    case "question":
      return c.dock === false ? <InlineQuestion part={part} /> : <QuestionCard part={part} />;
    case "error":
      return <ErrorCard part={part} />;
    case "compact":
      return <CompactLine part={part} />;
    default:
      return null;
  }
}
