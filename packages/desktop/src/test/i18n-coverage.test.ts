/**
 * i18n 覆盖率棘轮。
 *
 * 源串清单由 `pnpm i18n:scan`（scripts/i18n-scan.mjs --manifest）用 TypeScript AST 生成到
 * src/i18n/strings.json：既是所有 t()/st()/tr() 的中文 key，也含 SETTINGS / SKINS /
 * CONTRAST_TEXT 这类「中文原文即 key」的文案表（表内不包 t()，由渲染点译）。
 * 注释、演示正文（data/scenes、fixtures）、mock runtime、屏目索引元数据属于内容层，不计入。
 *
 * 两道闸：
 *  1) 清单不许过期 —— 源码里新写的 t("中文") 必须在清单内（防止绕过 pnpm i18n:scan）；
 *  2) 漏译条数只降不升（基线 src/i18n/untranslated.baseline）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GLOSSARY } from "../i18n/glossary.en";
import { zh } from "../i18n/dict.zh";

const manifest: string[] = JSON.parse(readFileSync(resolve(process.cwd(), "src/i18n/strings.json"), "utf8"));
const missing = manifest.filter(s => !GLOSSARY[s]).sort();

/** 源码里直接写在 t()/st()/tr() 里的中文 key，用来发现清单过期 */
function literalsInCode(): Set<string> {
  const root = resolve(process.cwd(), "src");
  const skip = new Set(["test", "i18n", "types", "data", "node_modules", "src-tauri"]);
  const out = new Set<string>();
  (function walk(d: string) {
    for (const n of readdirSync(d)) {
      if (skip.has(n) || n.startsWith(".")) continue;
      const p = resolve(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n) && !/(mockRuntime|registry)\.ts$/.test(n)) {
        for (const m of readFileSync(p, "utf8").matchAll(/\b(?:st|t|tr)\(\s*"([^"]*[㐀-䶿一-鿿][^"]*)"/g)) out.add(m[1]);
      }
    }
  })(root);
  return out;
}

describe("i18n 覆盖", () => {
  it("枚举 key 全部有英文（编译期已保证，这里再兜一层）", () => {
    for (const k of Object.keys(zh)) expect(GLOSSARY[k] ?? zh[k as keyof typeof zh]).toBeTruthy();
  });

  it("源串清单没有过期：代码里的 t() key 都在清单内", () => {
    const have = new Set(manifest);
    const stale = [...literalsInCode()].filter(s => !have.has(s));
    if (stale.length)
      console.error(`[i18n] 清单缺 ${stale.length} 条，请跑 pnpm i18n:scan：\n  ${stale.slice(0, 12).join("\n  ")}`);
    expect(stale).toEqual([]);
  });

  it("漏译条数不超过基线（棘轮，只降不升）", () => {
    const baseline = Number(readFileSync(resolve(process.cwd(), "src/i18n/untranslated.baseline"), "utf8").trim());
    if (missing.length > baseline)
      console.error(`[i18n] 漏译从 ${baseline} 涨到 ${missing.length}：\n  ${missing.slice(0, 20).join("\n  ")}`);
    expect(missing.length).toBeLessThanOrEqual(baseline);
  });

  it("打印当前进度", () => {
    const total = manifest.length;
    console.log(
      `[i18n] 源串 ${total} 条 · 已译 ${total - missing.length}（${(((total - missing.length) / total) * 100).toFixed(1)}%）· 漏译 ${missing.length} 条`,
    );
    if (missing.length) console.log(`  待补:\n${missing.map(x => `    ${x}`).join("\n")}`);
    expect(total).toBeGreaterThan(0);
  });
});
