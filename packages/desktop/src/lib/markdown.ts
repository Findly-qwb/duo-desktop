/**
 * Markdown → HTML（marked）+ DOMPurify 清洗 + 图标占位 hydrate。
 * 安全（PLAN 注意事项 5）：模型输出属于不可信输入，先 sanitize 再挂载；
 * `<span data-icon="file">` 只由本模块替换为 sprite 引用，字符串里不存在可执行内容。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

const ALLOW_ATTR = ["class", "data-icon", "data-open", "title", "colspan", "rowspan", "href", "start"];

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "code",
      "pre",
      "ul",
      "ol",
      "li",
      "a",
      "span",
      "mark",
      "h3",
      "h4",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "blockquote",
      "hr",
      "del",
    ],
    ALLOWED_ATTR: ALLOW_ATTR,
    ALLOW_DATA_ATTR: true,
  });
}

/** 直接给出成品的富文本片段（原型消息体含自定义类名：chip / filelink / cursor / tool） */
export function renderRich(src: string): string {
  return DOMPurify.sanitize(src, {
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "b",
      "code",
      "pre",
      "ul",
      "ol",
      "li",
      "a",
      "span",
      "mark",
      "h3",
      "h4",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "div",
      "button",
      "i",
    ],
    ALLOWED_ATTR: [...ALLOW_ATTR, "style", "type", "checked", "colspan"],
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "svg", "use"],
  });
}

/** 把 `[data-icon]` 占位替换为 sprite 图标；`[data-open]` 交给调用方处理点击 */
export function hydrateIcons(root: HTMLElement | null): void {
  if (!root) return;
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach(el => {
    const name = el.dataset.icon;
    if (!name || el.firstElementChild?.tagName.toLowerCase() === "svg") return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "i sm");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.appendChild(use);
    el.insertBefore(svg, el.firstChild);
    delete el.dataset.icon;
  });
}
