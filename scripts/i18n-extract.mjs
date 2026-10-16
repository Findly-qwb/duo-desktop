#!/usr/bin/env node
/**
 * i18n 正文抽取器（AST 定位 + 按字符区间改写，绝不做整文件正则批改）。
 *
 *   node scripts/i18n-extract.mjs --dry  --only src/views/SkillsView.tsx   # 只看计划
 *   node scripts/i18n-extract.mjs --only src/views/SkillsView.tsx          # 落盘
 *
 * 改写规则
 *   1) JSX 文本，含「中文 {expr} 中文」连续片段 → {t("key {var}", { var: expr })}
 *   2) 字符串字面量 / 模板串（表达式位置）→ t("key") / t("key {var}", { var })
 *   3) JSX 属性值（显示用途）→ {t("key")}
 *   4) 比较、switch case、对象键、类型、className/id/key 等属性 → 不改，进 NEEDS-REVIEW
 *      只译比较的一侧会静默改逻辑，这是上一版正则批改踩过的坑。
 * 导出名：文件里若存在局部 t 绑定（SettingsView 的 .map(t => …)、Dock/ModalHost/Toasts），
 * 新调用一律用 st，避免变量遮蔽；不做全文 t( → st( 替换。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const HAN = /[㐀-䶿一-鿿豈-﫿]/;
const DRY = process.argv.includes("--dry");
let files = process.argv.reduce((a, x, i) => (x === "--only" || x === "--file" ? [...a, process.argv[i + 1]] : a), []);
if (process.argv.includes("--all")) {
  // 全量：src 下所有 .tsx/.ts，跳过测试、i18n 语料层与内容层（同 i18n-scan.mjs 的 SKIP/AS_DATA）
  const SKIP = new Set(["test", "i18n", "types", "data", "src-tauri"]);
  const AS_DATA = new Set(["mockRuntime.ts", "registry.ts"]);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name) || name.startsWith(".")) continue;
      const p = resolve(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !AS_DATA.has(name)) files.push(`src/${relative(resolve(ROOT, "packages/desktop/src"), p)}`);
    }
  };
  walk(resolve(ROOT, "packages/desktop/src"));
  files = [...new Set(files)];
}
if (!files.length) {
  console.error("用法：--dry|--only|--all --only <src/…> [--only …]");
  process.exit(2);
}

const RESERVED = new Set(["var", "new", "class", "function", "default", "if", "else", "case", "in", "of", "type", "key", "name", "value", "data", "id", "void", "x2"]);
const NON_DISPLAY_ATTR = new Set(["className", "id", "key", "href", "src", "type", "role", "width", "height", "viewBox", "xmlns", "fill", "stroke", "d", "path", "as", "rel", "slot", "part"]);
/**
 * 表格式文案源（SETTINGS 这类「中文原文就是 key、渲染处再译」的数据表）：
 * 里面的中文字面量是 *key* 而不是显示文本，包上 t() 会让「拿 label 做逻辑比较」的
 * 代码在英文态静默失效。抽取器跳过它们，由渲染点负责 t()。
 */
const SOURCE_TABLES = new Set(["SETTINGS", "SKINS", "CONTRAST_TEXT"]);

const squash = (s) => s.replace(/\s+/g, " ").trim();
const needsReview = [];
const sourceTable = [];

for (const rel of files) {
  const path = resolve(ROOT, "packages/desktop", rel);
  const src = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const hasLocalT = /[(,]\s*t\s*(=>|,[^)]*\)=>)/.test(src) || /\bconst t\s*=/.test(src) || /\bfunction t\s*[(/]/.test(src) || /\(\s*t\s*\)\s*=>/.test(src);
  const FN = hasLocalT ? "st" : "t";
  const plans = [];
  const edits = [];
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const take = (node, text, tag, key) => {
    edits.push({ pos: node.getStart(sf), end: node.getEnd(), text });
    plans.push(`${rel}:${line(node.getStart(sf))}  ${tag}  ${key.slice(0, 62)}`);
  };

  function build(node) {
    const used = new Set();
    const args = [];
    let key = "";
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      key = node.text;
    } else if (ts.isTemplateExpression(node)) {
      key = node.head.text;
      for (const s of node.templateSpans) {
        const e = s.expression;
        let seg = (e.getText().trim().split(/[.?\s([+\-*/]/).filter(Boolean).pop() ?? "").replace(/[^\w$]/g, "").replace(/^(\d)/, "x$1");
        if (!seg || RESERVED.has(seg)) seg = "x";
        let n = seg;
        let i = 2;
        while (used.has(n)) n = `${seg}${i++}`;
        used.add(n);
        args.push([n, e.getText().trim()]);
        key += `{${n}}${s.literal.text}`;
      }
    } else return null;
    key = squash(key);
    if (!key || !HAN.test(key)) return null;
    return { key, args };
  }

  const call = (b) =>
    b.args.length
      ? `${FN}(${JSON.stringify(b.key)}, { ${b.args.map(([n, e]) => `${n}: ${e}`).join(", ")} })`
      : `${FN}(${JSON.stringify(b.key)})`;

  function protectedBy(node) {
    const p = node.parent;
    if (!p) return "顶层";
    for (let q = p; q; q = q.parent) {
      if (ts.isVariableStatement(q)) {
        const d = q.declarationList.declarations[0];
        if (d && ts.isIdentifier(d.name) && SOURCE_TABLES.has(d.name.text)) return "§SOURCETABLE";
      }
    }
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (
        [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.PlusToken].includes(k)
      )
        return k === ts.SyntaxKind.PlusToken ? null : `比较：${p.getText().trim().slice(0, 44)}`;
    }
    if (ts.isCaseClause(p) || (ts.isPropertyAssignment(p) && p.name === node)) return "对象键/switch";
    if (ts.isTypeNode(p) || ts.isLiteralTypeNode(p) || ts.isEnumMember(p)) return "类型/枚举";
    if (ts.isJsxAttribute(p) && p.name && NON_DISPLAY_ATTR.has(p.name.getText())) return `属性 ${p.name.getText()}`;
    if (ts.isPropertyAccessExpression(p) && p.name === node) return "属性名";
    if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return "下标键";
    return null;
  }

  /** JSX children 里「文本 (表达式 文本)*」连续片段合成一条 key */
  function runChildren(children, out) {
    const containsJsx = (n) => {
      let found = false;
      (function w(x) {
        if (found) return;
        if (ts.isJsxElement(x) || ts.isJsxFragment(x) || ts.isJsxSelfClosingElement(x)) {
          found = true;
          return;
        }
        x.forEachChild(w);
      })(n);
      return found;
    };
    const isText = (n) => ts.isJsxText(n) && /\S/.test(n.text);
    const isExpr = (n) => ts.isJsxExpression(n) && n.expression && !containsJsx(n.expression);
    let i = 0;
    while (i < children.length) {
      if (!isText(children[i])) {
        i++;
        continue;
      }
      let j = i;
      const run = [];
      while (j < children.length && (isText(children[j]) || isExpr(children[j]))) {
        if (run.length && isText(children[j]) === isText(run[run.length - 1])) break;
        run.push(children[j]);
        j++;
      }
      if (run.some((n) => ts.isJsxText(n) && HAN.test(n.text))) {
        const used = new Set();
        const args = [];
        let key = "";
        let ok = true;
        for (const n of run) {
          if (ts.isJsxText(n)) {
            key += n.text;
          } else {
            const e = n.expression;
            let seg = (e.getText().trim().split(/[.?\s([+\-*/]/).filter(Boolean).pop() ?? "").replace(/[^\w$]/g, "").replace(/^(\d)/, "x$1");
            if (!seg || RESERVED.has(seg)) seg = "x";
            let name = seg;
            let k = 2;
            while (used.has(name)) name = `${seg}${k++}`;
            used.add(name);
            args.push([name, e.getText().trim()]);
            key += `{${name}}`;
          }
        }
        key = squash(key);
        if (/[{}]/.test(key.replace(/\{[\w$]+\}/g, ""))) ok = false;
        if (ok && key && HAN.test(key)) {
          out.push({ pos: run[0].getStart(sf), end: run[run.length - 1].getEnd(), text: `{${call({ key, args })}}` });
          plans.push(`${rel}:${line(run[0].getStart(sf))}  JSX  ${key.slice(0, 62)}`);
        } else {
          needsReview.push(`${rel}:${line(run[0].getStart(sf))}  JSX 未改写（含裸花括号）：${key.slice(0, 56)}`);
        }
      }
      i = Math.max(j, i + 1);
    }
  }

  const jsxConsumed = [];
  (function visit(node) {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const out = [];
      runChildren(node.children, out);
      for (const e of out) {
        edits.push(e);
        jsxConsumed.push(e);
      }
    }
    // 关键：条件渲染写在 {cond ? <div/> : null} 里，表达式容器下面还有 JSX 子树，必须继续下钻
    node.forEachChild((c) => {
      if (!ts.isJsxText(c)) visit(c);
    });
  })(sf);

  const isWrapped = (node) => {
    const p = node.parent;
    return p && ts.isCallExpression(p) && p.arguments[0] === node && ts.isIdentifier(p.expression) && ["t", "st", "__"].includes(p.expression.text);
  };

  (function visit2(node) {
    const staticHan = (n) => {
      if (ts.isTemplateExpression(n)) {
        // 只看静态片段：`<b>${t("中文")}</b> · ${x}` 的中文在实参里，模板本身不是待抽取文案
        const s = n.head.text + n.templateSpans.map((x) => x.literal.text).join("");
        return HAN.test(s);
      }
      return HAN.test(n.getText());
    };
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && staticHan(node) && !isWrapped(node)) {
      const pos = node.getStart(sf);
      const insideJsxRun = jsxConsumed.some((e) => pos >= e.pos && pos < e.end);
      if (!insideJsxRun) {
        const prot = protectedBy(node);
        const b = build(node);
        if (prot === "§SOURCETABLE") sourceTable.push(squash(node.getText().slice(1, -1)));
        else if (prot) needsReview.push(`${rel}:${line(pos)}  ${prot}  ${node.getText().trim().slice(0, 52)}`);
        else if (!b) needsReview.push(`${rel}:${line(pos)}  无法建 key  ${node.getText().trim().slice(0, 52)}`);
        else if (node.parent && ts.isJsxAttribute(node.parent)) take(node, `{${call(b)}}`, "attr", b.key);
        else take(node, call(b), "lit", b.key);
      }
    }
    node.forEachChild(visit2);
  })(sf);

  const sorted = edits.sort((a, b) => a.pos - b.pos);
  const kept = [];
  let cursor = -1;
  for (const e of sorted) {
    if (e.pos < cursor) continue;
    kept.push(e);
    cursor = e.end;
  }

  let out = src;
  for (const e of kept.sort((a, b) => b.pos - a.pos)) out = out.slice(0, e.pos) + e.text + out.slice(e.end);

  if (kept.length && !new RegExp(`import \\{[^}]*\\b${FN}\\b[^}]*\\} from "[^"]*i18n"`).test(out)) {
    const dirs = dirname(rel).replace(/^src\/?/, "").split("/").filter(Boolean).length;
    const spec = `${dirs ? "../".repeat(dirs) : "./"}i18n`;
    const m = out.match(/^import[^\n]*\n/m);
    out = m ? out.slice(0, m.index) + `import { ${FN} } from "${spec}";\n` + out.slice(m.index) : `import { ${FN} } from "${spec}";\n` + out;
  }

  console.log(`\n=== ${rel}  ${FN}  改写 ${kept.length} 条${DRY ? "（dry-run）" : ""}`);
  console.log(plans.join("\n"));
  if (!DRY) writeFileSync(path, out);
}

console.log(`\n--- 源语料表（SETTINGS 之类，交给渲染点译）：${sourceTable.length} 条 ---`);
if (needsReview.length) console.log(`\n--- NEEDS-REVIEW（${needsReview.length}）---\n${[...new Set(needsReview)].join("\n")}`);
