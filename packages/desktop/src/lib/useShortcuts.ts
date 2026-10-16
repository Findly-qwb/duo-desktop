/**
 * 快捷键（原型 document keydown 段的等价实现）
 * ⌘K 命令面板 / ⌘⇧S 屏目索引 / ⌘⇧P 原型层 / ⌥[ ⌥] 折叠 / ⌘⌥F 专注
 * ⌘, 设置 / ⌘N 新会话 / ⌘F 转录搜索 / Esc 分层关闭浮层或中断生成
 */
import { t } from "../i18n";
import { useEffect } from "react";
import { actions, appState } from "../state/app";
import { client } from "../ipc/client";

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const typing = !!target && /^(INPUT|TEXTAREA)$/.test(target.tagName);

      // 输入态只放行 Esc / Enter / 带 Alt 的组合键
      if (typing && !["Escape", "Enter"].includes(e.key) && !e.altKey && !(meta && e.key.toLowerCase() === "k")) return;

      if (meta && e.key.toLowerCase() === "k" && !e.shiftKey) {
        e.preventDefault();
        actions.setPalette(true);
        return;
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        actions.setScreenMap(true);
        return;
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        actions.toggleProto();
        return;
      }
      if (meta && e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        actions.toggleFocus();
        return;
      }
      if (meta && e.key === ",") {
        e.preventDefault();
        actions.go("settings");
        return;
      }
      if (meta && e.key.toLowerCase() === "n") {
        e.preventDefault();
        actions.openScene("welcome");
        actions.toast(t("新会话 · 草稿按会话隔离保存"));
        return;
      }
      if (meta && e.key.toLowerCase() === "f") {
        e.preventDefault();
        actions.openScene("search");
        return;
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        actions.openScene("revert");
        return;
      }
      if (e.altKey && e.key === "[") {
        e.preventDefault();
        actions.toggleLeft();
        return;
      }
      if (e.altKey && e.key === "]") {
        e.preventDefault();
        actions.toggleRight();
        return;
      }
      if (e.key === "Escape") {
        // 分层关闭：弹窗 → 浮层 → 生成中断（原型 esc 关闭浮层的同一优先级）
        const s = appState();
        if (s.modal || s.confirm) {
          actions.closeModal();
          actions.closeConfirm();
        } else if (s.screenMap) actions.setScreenMap(false);
        else if (s.palette) actions.setPalette(false);
        else if (s.notif || s.osLayer !== "none") actions.closeOverlays();
        else if (client.snapshot().busy) {
          client.stop();
          actions.toast(t("已中断（Esc）· 保留已生成内容"), "warn");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
