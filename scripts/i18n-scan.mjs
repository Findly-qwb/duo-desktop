#!/usr/bin/env node
/**
 * i18n 正文抽取工作台（TypeScript AST 版，不靠正则猜注释）。
 *
 * 用法：
 *   node scripts/i18n-scan.mjs            # 每个文件：已走 t() / 未抽取 的条数
 *   node scripts/i18n-scan.mjs --raw      # 逐条列出未抽取原文（文件:行号 + 类型）
 *   node scripts/i18n-scan.mjs --keys     # 全部源串（含 key），用于补语料
 *   node scripts/i18n-scan.mjs --missing  # 源串里英文语料表缺失的部分
 *   node scripts/i18n-scan.mjs --glossary # 输出可直接粘进 glossary.en.ts 的骨架
 *
 * 口径：注释是 AST trivia，天然排除；被 t()/st() 当第一个实参的中文字面量算「已抽取」，
 * 其余中文字面量与 JSX 文本节点都算「未抽取」，必须改写成带 {占位符} 的 key。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const SKIP = new Set(["test", "i18n", "types", "data", "node_modules", "dist", "src-tauri"]);
const HAN = /[㐀-䶿一-鿿豈-﫿]/;
/**
 * 内容/元数据层，中文是数据本身，不进 UI 文案覆盖率：
 *  mockRuntime.ts / data/*  演示会话正文与 fixture（真实产品里来自后端或模型）
 *  screens/registry.ts      屏目索引（⌘⇧S）的原型导航元数据，只在原型层出现
 */
const AS_DATA = new Set(["mockRuntime.ts", "registry.ts"]);
/** 大写常量表：中文原文就是 key，由渲染点译（表内不包 t()，避免译文参与 === 比较） */
const SOURCE_TABLES = new Set(["SETTINGS", "SKINS", "CONTRAST_TEXT"]);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(name) && !AS_DATA.has(name)) files.push(p);
  }
})(resolve(ROOT, "packages/desktop/src"));
files.push(resolve(ROOT, "packages/ui/src/primitives.tsx"), resolve(ROOT, "packages/ui/src/skins.ts"));

function wrappedCall(node) {
  let p = node.parent;
  // st(cond ? "甲" : "乙") —— 穿过三元/括号再判定
  while (p && (ts.isConditionalExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
  if (!p || !ts.isCallExpression(p)) return false;
  const idx = p.arguments.indexOf(node);
  if (idx < 0) return false;
  const fn = p.expression;
  return ts.isIdentifier(fn) && ["t", "st", "tr", "__"].includes(fn.text);
}

function inSourceTable(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isVariableStatement(p)) {
      const d = p.declarationList.declarations[0];
      if (d && ts.isIdentifier(d.name) && SOURCE_TABLES.has(d.name.text)) return true;
    }
  }
  return false;
}

function textOf(node, sf) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    const name = (e) => {
      const t = e.getText(sf);
      const seg = t.split(/[.[]/).pop().replace(/[.\]\s]/g, "");
      return /^[A-Za-z_$][\w$]*$/.test(seg) ? seg : "x";
    };
    let out = node.head.text;
    for (const s of node.templateSpans) out += `{${name(s.expression)}}${s.literal.text}`;
    return out;
  }
  if (ts.isJsxText(node)) return node.text;
  return "";
}

function scan(file) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const keys = [];
  const raw = [];
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  (function visit(node) {
    const kind =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
        ? "literal"
        : ts.isJsxText(node)
          ? "text"
          : null;
    if (kind) {
      const text = textOf(node, sf).trim();
      // 模板串只看静态片段：中文若只出现在 ${…} 里，说明文案已经在实参中处理过了
      const statics = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((s) => s.literal.text).join("") : text;
      if (text && HAN.test(statics)) {
        const hit = { text, line: line(node.getStart(sf)), kind };
        if (kind === "literal" && (wrappedCall(node) || inSourceTable(node))) keys.push(hit);
        else raw.push(hit);
      }
    }
    node.forEachChild(visit);
  })(sf);
  return { keys, raw };
}

const all = files.map((f) => {
  const { keys, raw } = scan(f);
  return { f: relative(ROOT, f), keys, raw };
});
const every = (r) => [...r.keys, ...r.raw];

function glossary() {
  const gsrc = readFileSync(resolve(ROOT, "packages/desktop/src/i18n/glossary.en.ts"), "utf8");
  const dict = new Map();
  const PAIR = /(?:"((?:\\.|[^"\\])*)"|([^\s"',:{}]+))\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const m of gsrc.matchAll(PAIR)) {
    if (m[1] === undefined && (m[2] === "Record" || m[2] === "string")) continue;
    dict.set(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2], m[3]);
  }
  return dict;
}

const mode = process.argv[2] ?? "";
const set = new Set();
const keySet = new Set();
for (const r of all) {
  for (const k of every(r)) set.add(k.text);
  for (const k of r.keys) keySet.add(k.text);
}

if (mode === "--manifest") {
  const out = resolve(ROOT, "packages/desktop/src/i18n/strings.json");
  const body = [...keySet].sort().map((s) => `  ${JSON.stringify(s)}`).join(",\n");
  writeFileSync(out, `[\n${body}\n]\n`);
  console.log(`已写 ${relative(ROOT, out)}：${keySet.size} 条源串（含 SETTINGS/SKINS 表内 key）`);
} else if (mode === "--keys") {
  for (const s of [...set].sort()) console.log(s);
  console.log(`\n// 合计 ${set.size} 条`);
} else if (mode === "--missing" || mode === "--glossary") {
  const dict = glossary();
  const missing = [...keySet].filter((s) => !dict.has(s));
  if (mode === "--glossary") for (const s of missing.sort()) console.log(`  ${JSON.stringify(s)}: "",`);
  else {
    for (const s of missing.sort()) console.log(s);
    console.log(`\n// 已抽取源串 ${keySet.size} · 已译 ${keySet.size - missing.length} · 漏译 ${missing.length} · 语料 ${dict.size} · 另有未抽取 ${set.size - keySet.size}`);
  }
} else if (mode === "--keys-all") {
  for (const s of [...set].sort()) console.log(s);
  console.log(`\n// 合计 ${set.size} 条（含未抽取）`);
} else {
  let kt = 0;
  let rt = 0;
  for (const r of all) {
    kt += r.keys.length;
    rt += r.raw.length;
    if (mode === "--raw" && !r.raw.length) continue;
    if (r.keys.length || r.raw.length) {
      console.log(`${r.f}  已抽取 ${r.keys.length}  未抽取 ${r.raw.length}`);
      if (mode === "--raw")
        for (const k of r.raw) console.log(`    ${r.f}:${k.line}  ${k.kind === "text" ? "JSX文本" : "字面量"}  ${k.text.slice(0, 74)}`);
    }
  }
  console.log(`\n合计：已走 t() ${kt} 条 · 未抽取 ${rt} 条 · 去重源串 ${set.size} 条`);
}
