/**
 * 对比度检查项的显示名。@duo/ui 的 auditContrast 只回 id + token（组件层不带文案），
 * 文案归桌面层，渲染时现取，切语言不会残留旧字符串。
 */
import { st } from "../i18n";

const CONTRAST_TEXT: Record<string, string> = {
  body: "正文 text-strong",
  secondary: "次要 text-weak",
  muted: "弱化 text-weaker",
};

export function contrastLabel(id: string): string {
  return st(CONTRAST_TEXT[id] ?? id);
}
