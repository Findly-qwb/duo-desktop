/**
 * 对话视图（PLAN §5.1 中栏 / §11 M1）
 * 三栏中的「视觉主角」：TaskHeader + 消息流 + 输入区；左右栏可折叠，折叠态记忆在 ui_state。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { Icon } from "@duo/ui";
import { Message } from "./chat/Message";
import { OutcomeBar, QueuedBar, RevertBar, Working, Banner } from "./chat/cards";
import { TaskHeader } from "./chat/TaskHeader";
import { Composer } from "./chat/Composer";
import { useRuntime, client } from "../ipc/client";
import { useApp, actions } from "../state/app";
import { sceneOf } from "../ipc/client";

export function ChatView(): JSX.Element {
  const app = useApp();
  const rt = useRuntime();
  const scene = useMemo(() => sceneOf(app.scene), [app.scene]);
  const welcome = app.scene === "welcome" || app.scene === "chat-welcome";
  const listRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newSinceScroll, setNewSinceScroll] = useState(false);

  // 自动跟随滚动（用户上滚即停止跟随）
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [atBottom]);

  useEffect(() => {
    setNewSinceScroll(!atBottom && rt.busy);
  }, [atBottom, rt.busy]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 140);
  }, []);

  const marks = scene.railMarks ?? ["cur", "", ""];

  return (
    <>
      <div className="taskhead-host">
        {welcome ? null : (
          <TaskHeaderShell
            title={rt.sessionTitle || t("给 SessionStore 加 SQLite 持久化")}
            state={rt}
            withTimeline={app.scene === "chat-stream"}
          />
        )}
      </div>

      <div className="messages" ref={listRef} onScroll={onScroll}>
        <div className="stream">
          {app.protoLayer ? <div className="screen-badge">scene · {app.scene}</div> : null}

          {rt.protocolMismatch ? (
            <Banner tone="err" icon="alert-circle" html={`<b>${t("协议版本不同步")}</b> · ${rt.protocolMismatch ?? ""}`} />
          ) : null}

          {scene.banner ? <Banner tone={scene.banner.tone} icon={scene.banner.icon as never} html={scene.banner.text} /> : null}

          {rt.revert ? (
            <RevertBar label={rt.revert.label} files={rt.revert.files} stat={rt.revert.stat} detail={rt.revert.detail} />
          ) : null}

          {rt.busy ? <Working text={t("正在工作…")} elapsed="12s" /> : null}

          {rt.queues.steering.map(q => (
            <QueuedBar key={q.id} id={q.id} text={q.text} />
          ))}
          {rt.queues.follow_up.map(q => (
            <QueuedBar key={q.id} id={q.id} text={`[follow-up] ${q.text}`} />
          ))}

          {rt.messages.map(m => (
            <Message key={m.id} msg={m} />
          ))}

          {rt.outcome ? <OutcomeBar outcome={rt.outcome} /> : null}

          {app.scene === "compact" ? (
            <div className="notice info spec" style={{ maxWidth: 768, margin: "0 auto 12px" }}>
              <Icon name="info" size="sm" />
              <div>
                {t("自动压缩阈值 92%。压缩使用")}
                <b>{t("聊天模型")}</b>
                {t("生成摘要，工具输出会被丢弃、决策与文件路径保留。")}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {scene.search ? <TranscriptSearch host={listRef} /> : null}

      <div className="rail-marks" title={t("PromptRail：每个用户消息一个刻度，点击跳转")}>
        {marks.map((m, i) => (
          <button
            key={i}
            type="button"
            className={m}
            aria-label={t("跳转到第 {x1} 条提问", { x1: i + 1 })}
            onClick={() => actions.toast(t("PromptRail 跳转 · 预览第 {x1} 条提问", { x1: i + 1 }))}
          />
        ))}
      </div>

      {!atBottom && rt.busy ? (
        <button
          type="button"
          className="tobottom show"
          aria-label={t("回到底部")}
          onClick={() => {
            listRef.current && (listRef.current.scrollTop = listRef.current.scrollHeight);
            setAtBottom(true);
          }}>
          <Icon name="arrow-down" />
          <span className="new" style={{ display: newSinceScroll ? "block" : "none" }} />
        </button>
      ) : null}

      <div className="inputzone">
        {rt.pendingApprovals.length && app.scene !== "perm-dock" && app.scene !== "perm-edit" ? null : null}
        <Composer scene={scene} welcome={welcome} />
      </div>
    </>
  );
}

/** TaskHeader 在折叠欢迎态不渲染，用一层壳保持 DOM 与原型一致（.taskhead 由组件内部产出） */
function TaskHeaderShell(props: {
  title: string;
  state: ReturnType<typeof useRuntime>;
  withTimeline?: boolean;
}): JSX.Element | null {
  return <TaskHeader {...props} />;
}

function TranscriptSearch({ host }: { host: React.RefObject<HTMLDivElement | null> }): JSX.Element {
  const [q, setQ] = useState("sqlite|SQLite");
  const [opts, setOpts] = useState({ case: false, word: false, regex: true });
  const [index, setIndex] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el || !q.trim()) {
      setTotal(0);
      return;
    }
    try {
      const flags = `g${opts.case ? "" : "i"}${opts.word ? "\\b" : ""}`;
      const re = new RegExp(opts.word ? `\\b(${q})\\b` : q, opts.case ? "g" : "gi");
      setTotal((el.textContent?.match(re) ?? []).length);
      void flags;
    } catch {
      setTotal(0);
    }
  }, [q, opts, host]);

  return (
    <div className="tsearch show" role="search">
      <input value={q} placeholder={t("搜索转录…")} onChange={e => setQ(e.target.value)} aria-label={t("转录内搜索")} />
      {(["case", "word", "regex"] as const).map(k => (
        <button
          key={k}
          type="button"
          className={`toggle${opts[k] ? " on" : ""}`}
          aria-pressed={opts[k]}
          onClick={() => setOpts(o => ({ ...o, [k]: !o[k] }))}>
          {k === "case" ? "Aa" : k === "word" ? t("全词") : ".*"}
        </button>
      ))}
      <span className="count">
        {total ? index + 1 : 0}/{total}
      </span>
      <button type="button" className="iconbtn sm" aria-label={t("上一处")} onClick={() => setIndex(i => Math.max(0, i - 1))}>
        <Icon name="arrow-up" size="sm" />
      </button>
      <button
        type="button"
        className="iconbtn sm"
        aria-label={t("下一处")}
        onClick={() => setIndex(i => Math.min(Math.max(0, total - 1), i + 1))}>
        <Icon name="arrow-down" size="sm" />
      </button>
      <button
        type="button"
        className="iconbtn sm"
        aria-label={t("关闭搜索")}
        onClick={() => actions.openScene(client.currentScene() === "search" ? "chat-stream" : client.currentScene())}>
        <Icon name="x" size="sm" />
      </button>
    </div>
  );
}
