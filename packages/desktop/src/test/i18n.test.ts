/**
 * i18n（PLAN §11 M0：zh / en）
 * 覆盖：英文零漏译（类型之外的运行时校验）、插值、切换即时生效与持久化。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { t, useLocale, setLocale, getLocale, type Key } from "../i18n";
import { zh } from "../i18n/dict.zh";
import { en } from "../i18n/dict.en";

const KEYS = Object.keys(zh) as Key[];

beforeEach(() => {
  localStorage.clear();
  setLocale("zh");
});

describe("i18n", () => {
  it("中英键集合完全一致（英文不得漏译）", () => {
    expect(Object.keys(en).sort()).toEqual(KEYS.slice().sort());
  });

  it("没有空值，也没有把键当值用", () => {
    for (const k of KEYS) {
      expect(en[k].trim().length, `en.${k}`).toBeGreaterThan(0);
      expect(zh[k].trim().length, `zh.${k}`).toBeGreaterThan(0);
      expect(en[k], `en.${k} 不能等于键名`).not.toBe(k);
    }
  });

  it("占位符两侧一致，插值可用", () => {
    const ph = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const k of KEYS) expect(ph(en[k]), `en.${k} 占位符`).toEqual(ph(zh[k]));
    expect(t("sb.changes", { n: 4 })).toBe("4 变更");
    setLocale("en");
    expect(t("sb.changes", { n: 4 })).toBe("4 changed");
    expect(t("composer.heroTitle", { project: "opencode" })).toBe("Keep going on opencode");
  });

  it("切换即时生效、写入 localStorage 并同步 html lang", () => {
    expect(getLocale()).toBe("zh");
    setLocale("en");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("duo.locale")).toBe("en");
    expect(t("nav.newChat")).toBe("New chat");
    setLocale("zh");
    expect(t("nav.newChat")).toBe("新对话");
  });

  it("useLocale 订阅者随切换重渲染", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { result } = renderHook(() => useLocale());
    expect(result.current).toBe("zh");
    act(() => setLocale("en"));
    expect(result.current).toBe("en");
    act(() => setLocale("zh"));
    expect(result.current).toBe("zh");
  });

  it("未知键原样回显，便于发现漏译", () => {
    expect(t("不存在的键" as Key)).toBe("不存在的键");
  });
});
