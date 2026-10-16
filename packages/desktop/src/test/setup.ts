/** jsdom 环境补齐：matchMedia / ResizeObserver / scrollIntoView / clipboard */
import { beforeEach, vi } from "vitest";
import { setLocale } from "../i18n";

if (!window.matchMedia) {
  window.matchMedia = (q: string) =>
    ({
      matches: false,
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList;
}
class RO {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
if (!("ResizeObserver" in window)) (globalThis as Record<string, unknown>).ResizeObserver = RO;
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? vi.fn();
Object.defineProperty(window.navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  configurable: true,
});

// 每个用例前清空持久化状态，避免皮肤 / 折叠态串台；
// 用例默认跑源语言（zh），语言切换本身由 i18n.test 覆盖
beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
  setLocale("zh");
});
