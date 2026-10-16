// 导入方向门禁（PLAN §15）：views/panels 不得反向污染 @duo/ui，@duo/ui 不得依赖 desktop
// 纳入 CI：pnpm check:ui-boundaries
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name)) files.push(p);
  }
}

walk(join(root, "packages"));

const errors = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const rel = relative(root, file);
  const isUi = rel.startsWith("packages/ui/");
  const imports = [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(m => m[1]);

  for (const spec of imports) {
    // @duo/ui 是叶子包：不得引用桌面应用内部（数据/协议/状态都属于产品层）
    if (isUi && /^(\.\.\/)+(desktop|src)\//.test(spec)) errors.push(`${rel}: @duo/ui 反向依赖桌面应用 → ${spec}`);
    if (isUi && /@duo\/(desktop|app)/.test(spec)) errors.push(`${rel}: @duo/ui 不得依赖产品包 → ${spec}`);
    // views / panels 不得互相深引用内部文件（只允许走 @duo/ui 或各自入口）
    if (!isUi && /["']\.\.\/(?:views|panels)\/[\w/]+\/internal/.test(spec)) errors.push(`${rel}: 跨视图深引用 → ${spec}`);
  }
}

if (errors.length) {
  console.error(`check:ui-boundaries ✗ ${errors.length} 处违规`);
  for (const e of errors) console.error("  · " + e);
  process.exit(1);
}

// 颜色策略：散落色名清单只减不增
const baseline = readBaseline();
const found = countScatteredColors(join(root, "packages"));
if (found > baseline) {
  console.error(`ui-color-policy ✗ 组件层出现新的硬编码色：当前 ${found} > 基线 ${baseline}（基线只减不增）`);
  console.error("  修复：改用 L2 语义令牌（见 PLAN §4），或运行 pnpm check:ui-boundaries --bless 更新基线（需评审）");
  process.exit(1);
}
console.log(`check:ui-boundaries ✓ · 颜色基线 ${baseline} → 当前 ${found}（只减不增）`);

function readBaseline() {
  try {
    return Number(readFileSync(join(root, "scripts/color-baseline.txt"), "utf8").trim());
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** 组件样式里不允许出现十六进制/颜色函数（皮肤文件与结构令牌除外） */
function countScatteredColors(dir) {
  const exempt = /styles\/(tokens|skins)\.css$/;
  let n = 0;
  const scan = d => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) scan(p);
      else if (/\.(css|tsx?)$/.test(name) && !exempt.test(p)) {
        const src = readFileSync(p, "utf8");
        n += (src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length;
        n += (src.match(/\brgba?\(/g) ?? []).length;
      }
    }
  };
  scan(dir);
  return n;
}
