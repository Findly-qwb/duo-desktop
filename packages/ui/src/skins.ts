/**
 * 皮肤系统（PLAN §4）
 * L1 原语 / L2 语义由 skin bundle 提供；组件层只引用语义令牌。
 * 内置三套：graphite-dark（默认深色 IDE）、paper-light（极简灰度）、nocturne-amber（暖色低光，扩展性验证）
 */

export type SkinMode = "light" | "dark";

export interface SkinBundle {
  id: string;
  name: string;
  mode: SkinMode;
  /** 继承自另一套皮肤，缺省 token 回落父皮肤 */
  extends?: string;
  /** L2 语义令牌覆盖 */
  tokens: Record<string, string>;
  /** 语法高亮令牌（--tk-*） */
  syntax?: Record<string, string>;
  assets?: { logo?: string; welcomeArt?: string };
}

/** L2 必需令牌：缺任一即拒绝加载并提示（PLAN §4 完整度校验） */
export const REQUIRED_L2 = [
  "--background-base",
  "--background-strong",
  "--surface-base",
  "--surface-raised-base",
  "--surface-inset-base",
  "--text-strong",
  "--text-base",
  "--text-weak",
  "--text-weaker",
  "--border-base",
  "--accent",
  "--surface-success-strong",
  "--surface-warning-strong",
  "--surface-critical-strong",
  "--diff-add-text",
  "--diff-del-text",
] as const;

export const SKINS: SkinBundle[] = [
  { id: "graphite-dark", name: "石墨深灰", mode: "dark", tokens: {} },
  { id: "paper-light", name: "纸张浅灰", mode: "light", tokens: {} },
  { id: "nocturne-amber", name: "夜航暖橙", mode: "dark", tokens: {} },
];

export const DEFAULT_SKIN = "graphite-dark";
export const STORAGE_KEYS = {
  skin: "duo.skin",
  scale: "duo.scale",
  proto: "duo.proto",
  follow: "duo.followSystem",
} as const;

/* ---------- 对比度计算（WCAG 2.1） ---------- */

function channelLum(v: number): number {
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.5;
}

function parseColor(raw: string): [number, number, number] | null {
  const s = raw.trim();
  if (!s) return null;
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map(c => c + c).join("");
    return [0, 2, 4].map(i => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = s.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.every(n => !Number.isNaN(n))) {
      // rgba 需按黑底合成（组件层常见于浮层），此处保守取合成值
      const a = parts.length >= 4 ? parts[3] : 1;
      return [0, 1, 2].map(i => Math.round(parts[i] * a)) as [number, number, number];
    }
  }
  return null;
}

export function relativeLuminance(color: string): number {
  const rgb = parseColor(color);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(v => channelLum(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 对比度：null 表示无法解析（非十六进制/RGB，跳过判定） */
export function contrastRatio(a: string, b: string): number | null {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  if (!parseColor(a) || !parseColor(b)) return null;
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastId = "body" | "secondary" | "muted";

export interface ContrastIssue {
  id: ContrastId;
  token: string;
  ratio: number;
  min: number;
}

export interface ContrastReport {
  issues: ContrastIssue[];
  checked: { id: ContrastId; ratio: number; min: number; ok: boolean }[];
}

/**
 * 对比度门禁：text-strong/text-weak/text-weaker 对 surface-base
 * 正文 ≥4.5:1、次要 ≥3:1、弱化 ≥2.2:1（原型 applySkin 同阈值）
 * 只回 id + token，显示名由调用方译 —— @duo/ui 不带文案。
 */
export function auditContrast(read: (token: string) => string): ContrastReport {
  const spec: [ContrastId, string, number][] = [
    ["body", "--text-strong", 4.5],
    ["secondary", "--text-weak", 3],
    ["muted", "--text-weaker", 2.2],
  ];
  const surface = read("--surface-base");
  const issues: ContrastIssue[] = [];
  const checked = spec.map(([id, token, min]) => {
    const r = contrastRatio(read(token), surface);
    if (r == null) return { id, ratio: 0, min, ok: true };
    const ok = r >= min;
    if (!ok) issues.push({ id, token, ratio: r, min });
    return { id, ratio: r, min, ok };
  });
  return { issues, checked };
}

/** 自动提亮：按不足比例把前景色往反方向推（供修复动作调用） */
export function autoBrighten(fg: string, bg: string, target = 4.5): string {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return fg;
  const bgLight = relativeLuminance(bg) > 0.5;
  let out = [...f] as [number, number, number];
  for (let step = 0; step < 40; step++) {
    if ((contrastRatio(`rgb(${out.join(",")})`, bg) ?? 0) >= target) break;
    out = out.map(v => (bgLight ? Math.max(0, v - 8) : Math.min(255, v + 8))) as [number, number, number];
  }
  return `rgb(${out.join(" ")})`;
}

/** skin.json 完整度校验：缺 L2 必需 token 即拒绝加载 */
export function validateSkinBundle(bundle: SkinBundle): { ok: boolean; missing: string[] } {
  const inherited = bundle.extends ? (SKINS.find(s => s.id === bundle.extends)?.tokens ?? {}) : {};
  const missing = REQUIRED_L2.filter(
    t => !(t in bundle.tokens) && !(t in inherited) && t !== "--background-base" && t !== "--background-strong",
  );
  return { ok: missing.length === 0, missing };
}
