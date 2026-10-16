/**
 * 协议防漂移（PLAN §15：ipc 模块是唯一协议来源，前端类型不得手写漂移）
 * 直接读 Rust 侧 ipc.rs 与 TS 侧 protocol.ts，比对事件名与命令名集合。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom 下 import.meta.url 不是 file: 协议，按包根解析
const rust = readFileSync(resolve(process.cwd(), "src-tauri/src/ipc.rs"), "utf8");
const ts = readFileSync(resolve(process.cwd(), "src/ipc/protocol.ts"), "utf8");

/** Rust enum DuoEvent 的变体名 → snake_case 事件名 */
const rustEvents = (() => {
  const body = rust.slice(
    rust.indexOf("pub enum DuoEvent"),
    rust.indexOf("pub const RUNTIME_VERSION") > -1 ? rust.indexOf("/* ---------------- 命令入参") : rust.length,
  );
  const variants = [...body.matchAll(/^\s{4}([A-Z][A-Za-z0-9]*)\s*\{/gm)].map(m => m[1]);
  return variants.map(v => v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase());
})();

/** TS 侧：只取 DuoEvents / Commands 两个接口体内的键，避免把类型别名里的联合值算进来 */
function keysOf(block: string): string[] {
  return [...block.matchAll(/^ {2}([a-z_]+):/gm)].map(m => m[1]);
}
function slice(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start < 0) throw new Error(`协议文件缺少 ${header}，防漂移测试失效`);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}
const tsEvents = keysOf(slice(ts, "export interface DuoEvents {"));
const tsCommands = keysOf(slice(ts, "export interface Commands {"));

describe("IPC 协议单一来源", () => {
  it("Rust 侧事件数 = PLAN §9.1 的 20 个", () => {
    expect(rustEvents).toHaveLength(20);
  });

  it("Rust 与 TS 的事件名集合完全一致", () => {
    expect(new Set(rustEvents)).toEqual(new Set(tsEvents));
  });

  it("TS 命令表覆盖 PLAN §9.2 的关键命令", () => {
    for (const c of [
      "submit_message",
      "submit_steering",
      "queue_action",
      "approve_tool_call",
      "answer_question",
      "stop_agent",
      "session_load",
      "revert_to_message",
      "redo_step",
      "permission_set",
      "resync",
      "compact_now",
      "skin_apply",
      "settings_get",
      "settings_set",
    ]) {
      expect(tsCommands).toContain(c);
    }
  });

  it("schema_version 两侧一致", () => {
    const inRust = Number(rust.match(/SCHEMA_VERSION:\s*i32\s*=\s*(\d+)/)?.[1]);
    const inTs = Number(
      ts.match(/SCHEMA_VERSION\s*=?\s*(?::\s*number)?\s*(\d+)/)?.[1] ?? ts.match(/SCHEMA_VERSION[^\d]*?(\d+)/)?.[1],
    );
    expect(inRust).toBe(inTs);
    expect(inTs).toBe(8);
  });

  it("resync 带 turn_index 游标（跨 Turn 断流可定位，PLAN §9.2 [v2.1]）", () => {
    const resync = ts.slice(ts.indexOf("resync:"));
    expect(resync.slice(0, 120)).toMatch(/turn_index/);
    expect(resync.slice(0, 120)).toMatch(/since_seq/);
  });
});
