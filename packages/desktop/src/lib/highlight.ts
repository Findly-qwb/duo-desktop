/**
 * 代码高亮：与原型同一套 `--tk-*` 令牌（皮肤可替换；shiki 双主题为后续升级项）
 * 分词顺序与 prototype.html 的 hl() 一致：注释 → 字符串 → 关键字 → 类型 → 调用 → 数字。
 * 输入先 HTML 转义，标签只由本模块生成，用户内容不会直达 DOM。
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const KW =
  "const|let|var|function|return|if|else|import|export|from|new|class|async|await|type|interface|extends|implements|switch|case|break|continue|throw|try|catch|for|of|in|while|null|undefined|true|false|this|CREATE|TABLE|PRIMARY|KEY|NOT|NULL|DEFAULT|INSERT|INTO|VALUES|SELECT|FROM|WHERE|ORDER|LIMIT|PRAGMA|BEGIN|COMMIT|UNIQUE|INDEX|REFERENCES|DELETE|SET|AND|OR|INTEGER|REAL|TEXT|BLOB|WITH|AS|ON|CONFLICT|REPLACE|def|self|None|True|False|fn|mut|pub|struct|impl|match";

const TOKEN_RE = new RegExp(
  [
    "(\\/\\/[^\\n]*|--[^\\n]*|#[^\\n]*)",
    "(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)",
    `\\b(${KW})\\b`,
    "\\b([A-Z][A-Za-z0-9_]{2,})\\b",
    "([A-Za-z_$][\\w$]*)(?=\\()",
    "\\b(\\d[\\d_.]*)\\b",
  ].join("|"),
  "g",
);

export function highlight(src: string): string {
  return escapeHtml(src).replace(
    TOKEN_RE,
    (match, cmt?: string, str?: string, key?: string, typ?: string, fn?: string, _num?: string) => {
      const cls = cmt ? "cmt" : str ? "str" : key ? "key" : typ ? "typ" : fn ? "fn" : "num";
      return `<span class="tk-${cls}">${match}</span>`;
    },
  );
}
