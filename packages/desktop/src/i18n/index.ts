/**
 * i18n（PLAN §11 M0：zh / en）
 * 中文是源语言（与 prototype.html 逐字一致），英文为对照词典；
 * Record<Key,string> 让「漏译」直接变成类型错误，而不是运行时掉回中文。
 * 语言偏好写入 ui_state（浏览器侧 localStorage），切换即时生效不重建 WebView。
 */
import { useSyncExternalStore } from "react";
import { zh, type Key } from "./dict.zh";
import { GLOSSARY } from "./glossary.en";
import { en } from "./dict.en";

export type Locale = "zh" | "en";
export type { Key };

const DICTS: Record<Locale, Record<Key, string>> = { zh, en };
const LS_KEY = "duo.locale";

function detect(): Locale {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* 无痕模式 */
  }
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let locale: Locale = detect();
const listeners = new Set<() => void>();

/** 启动即同步 html lang（屏幕阅读器与 CSS :lang() 依赖它，不能等到第一次 setLocale） */
function applyLang(l: Locale): void {
  document.documentElement.lang = l === "zh" ? "zh" : "en";
}
applyLang(locale);

export function setLocale(next: Locale): void {
  locale = next;
  try {
    localStorage.setItem(LS_KEY, next);
  } catch {
    /* ignore */
  }
  applyLang(next);
  for (const l of listeners) l();
}

export function getLocale(): Locale {
  return locale;
}

export function useLocale(): Locale {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => locale,
    () => locale,
  );
}

/**
 * t()：既接受枚举 key（外壳文案，编译期防漏译），也接受中文源串
 * （正文文案，source-string-as-key：漏译只降级回中文，不会显示成 key 名）。
 * 覆盖率由 test/i18n-coverage.test.ts 扫描全部源串并逐条比对语料表把住。
 */
export function t(key: Key | (string & {}), vars?: Record<string, string | number | undefined>): string {
  const known = (zh as Record<string, string>)[key];
  const raw = known ? DICTS[locale][key as Key] : locale === "en" ? (GLOSSARY[key] ?? key) : key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? ""));
}

/** 数字/金额等按 locale 分组（中文不加分隔符，英文千分位） */
export function nf(n: number): string {
  return n.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
}

/**
 * st = source translate。与 t() 同实现，单独命名是为了在把 t 用作局部变量/回调参数的
 * 视图文件里也能安全接入（Toasts / Dock / ModalHost 内部都有 `t` 绑定）。
 */
export const st = t;
