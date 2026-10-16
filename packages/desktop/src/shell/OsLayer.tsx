/**
 * 系统层：托盘菜单 / OS 通知 / 自动更新 / ⌘K 命令面板
 * 桌面侧托盘与通知由 Tauri 提供，浏览器内以同结构浮层等价呈现（PLAN §11 M0）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { Icon } from "@duo/ui";
import { PALETTE, type PaletteItem } from "../screens/registry";
import { actions, toast, useApp } from "../state/app";

export function OsLayer(): JSX.Element {
  const app = useApp();
  return (
    <div className="oslayer">
      {app.osLayer === "tray" ? <TrayMenu /> : null}
      {app.notif ? <OsNotif title={app.notif.title} body={app.notif.body} /> : null}
      {app.osLayer === "update" ? <UpdatePill /> : null}
      {app.palette ? <CommandPalette /> : null}
    </div>
  );
}

function TrayMenu(): JSX.Element {
  return (
    <div className="traymenu show" role="menu" aria-label={t("系统托盘菜单")}>
      <div className="hd">{t("duo Desktop · 后台运行中")}</div>
      <button
        type="button"
        className="tm"
        role="menuitem"
        onClick={() => {
          actions.closeOverlays();
          actions.go("chat");
        }}>
        <Icon name="chat" />
        {t("显示主窗口")}
        <span className="kbd">⌘0</span>
      </button>
      <button
        type="button"
        className="tm"
        role="menuitem"
        onClick={() => {
          actions.closeOverlays();
          actions.openScene("welcome");
        }}>
        <Icon name="plus" />
        {t("新会话")}
        <span className="kbd">⌘N</span>
      </button>
      <button
        type="button"
        className="tm"
        role="menuitem"
        onClick={() => {
          actions.closeOverlays();
          actions.setPalette(true);
        }}>
        <Icon name="search" />
        {t("命令面板")}
        <span className="kbd">⌘K</span>
      </button>
      <div className="hr" />
      <button
        type="button"
        className="tm"
        role="menuitem"
        onClick={() => {
          actions.closeOverlays();
          actions.openModal("shortcuts");
        }}>
        <Icon name="keyboard" />
        {t("快捷键与手势")}
      </button>
      <button
        type="button"
        className="tm"
        role="menuitem"
        onClick={() => {
          actions.closeOverlays();
          actions.setSettingsTab("about");
        }}>
        <Icon name="info" />
        {t("关于 / 诊断")}
      </button>
      <div className="hr" />
      <button
        type="button"
        className="tm"
        role="menuitem"
        onClick={() => {
          actions.closeOverlays();
          actions.openModal("panic");
        }}>
        <Icon name="alert" />
        {t("重启引擎")}
      </button>
      <button
        type="button"
        className="tm"
        role="menuitem"
        onClick={() => {
          actions.closeOverlays();
          toast(t("已退出（子进程组一并回收，无 PTY 泄漏）"));
        }}>
        <Icon name="power" />
        {t("退出 duo")}
        <span className="kbd">⌘Q</span>
      </button>
    </div>
  );
}

function OsNotif({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="osnotif show" role="status" aria-live="polite">
      <div className="nh">
        <span className="mark" style={{ width: 16, height: 16, borderRadius: 4 }}>
          <Icon name="mark" style={{ width: 10, height: 10 }} />
        </span>
        duo Desktop
        <span className="mono" style={{ marginLeft: "auto" }}>
          {t("现在")}
        </span>
      </div>
      <div className="nt">{title}</div>
      <div className="nd" dangerouslySetInnerHTML={{ __html: body }} />
      <div className="na">
        <button
          type="button"
          className="btn sm primary"
          onClick={() => {
            actions.closeOverlays();
            actions.openScene("perm-dock");
          }}>
          {t("查看")}
        </button>
        <button type="button" className="btn sm" onClick={() => actions.closeOverlays()}>
          {t("忽略")}
        </button>
      </div>
    </div>
  );
}

function UpdatePill(): JSX.Element {
  const [pct, setPct] = useState(0);
  const [label, setLabel] = useState(t("未开始"));
  const timer = useRef<number | null>(null);

  useEffect(() => {
    timer.current = window.setInterval(() => setPct(p => Math.min(100, p + 18)), 420);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);
  useEffect(() => {
    if (pct >= 100) setLabel(t("校验签名 · 准备替换 sidecar"));
    else if (pct > 0) setLabel(t("下载中…"));
  }, [pct]);

  return (
    <div className="update-pill show" role="dialog" aria-label={t("自动更新")}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span className="picon" style={{ color: "var(--surface-success-strong)" }}>
          <Icon name="upload" />
        </span>
        <b style={{ color: "var(--text-strong)", fontSize: "var(--fs-13)" }}>{t("duo Desktop 1.1.0 可用")}</b>
        <button
          type="button"
          className="iconbtn sm"
          style={{ marginLeft: "auto" }}
          aria-label={t("关闭")}
          onClick={() => actions.closeOverlays()}>
          <Icon name="x" size="sm" />
        </button>
      </div>
      <div style={{ fontSize: "var(--fs-12)", color: "var(--text-weak)", lineHeight: 1.55 }}>
        {t("修复 sidecar 重启后会话视图丢失；新增 Diff 并排视图。签名校验通过。")}
      </div>
      <div className="meter" style={{ margin: "10px 0" }}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-weaker)" }}>
          {label}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn sm" onClick={() => toast(t("查看更新日志"))}>
          {t("发行说明")}
        </button>
        <button
          type="button"
          className="btn sm primary"
          onClick={() => {
            actions.closeOverlays();
            toast(t("已安装 1.1.0，重启后生效"));
          }}>
          {t("安装并重启")}
        </button>
      </div>
    </div>
  );
}

export function CommandPalette(): JSX.Element {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PALETTE.filter(x => !q || `${x.title}${x.group}${x.shortcut ?? ""}`.toLowerCase().includes(q));
  }, [query]);

  useEffect(() => {
    setIndex(i => Math.min(i, Math.max(0, list.length - 1)));
  }, [list.length]);

  const run = (item: PaletteItem, shift = false): void => {
    actions.closeOverlays();
    item.run();
    if (shift) toast(t("已在新会话中打开"));
  };

  return (
    <div className="palette show" role="dialog" aria-label={t("命令面板")}>
      <input
        ref={inputRef}
        value={query}
        placeholder={t("搜索会话、命令、设置项、文件…")}
        aria-label={t("命令面板搜索")}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex(i => (list.length ? (i + 1) % list.length : 0));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex(i => (list.length ? (i - 1 + list.length) % list.length : 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const item = list[index];
            if (item) run(item, e.shiftKey);
          } else if (e.key === "Escape") {
            actions.closeOverlays();
          }
        }}
      />
      <div className="plist" role="listbox">
        {list.length ? (
          list.map((x, i) => (
            <div
              key={`${x.group}-${x.title}`}
              className={`pitem${i === index ? " hl" : ""}`}
              role="option"
              tabIndex={i === index ? 0 : -1}
              aria-selected={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(x)}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  run(x, e.shiftKey);
                }
              }}>
              <Icon name={x.icon as never} />
              <span>{x.title}</span>
              <span className="g">
                {x.group}
                {x.shortcut ? ` · ${x.shortcut}` : ""}
              </span>
            </div>
          ))
        ) : (
          <div style={{ padding: 18, textAlign: "center", color: "var(--text-weaker)", fontSize: "var(--fs-12)" }}>
            {t("无匹配项")}
          </div>
        )}
      </div>
      <div className="pfoot">
        <span>
          <span className="kbd">↑↓</span> {t("选择")}
        </span>
        <span>
          <span className="kbd">↵</span> {t("打开")}
        </span>
        <span>
          <span className="kbd">⇧↵</span> {t("新会话")}
        </span>
        <span>
          <span className="kbd">esc</span> {t("关闭")}
        </span>
        <span className="mono" style={{ marginLeft: "auto" }}>
          {list.length} {t("项")}
        </span>
      </div>
    </div>
  );
}
