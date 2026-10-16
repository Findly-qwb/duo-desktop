/**
 * 会话数据水化：宿主 session_list / session_load 的 DB 行（snake_case）→ 前端运行时形状。
 * PLAN §6.9 硬约束的落点：跨重启的界面还原只从 SQLite 重建，不读 rpi 的 JSONL。
 * 纯映射模块——不 import client（避免环），取数函数由 client.ts 注入调用。
 */
import { t } from "../i18n";
import type { SessionRow } from "../data/fixtures";
import type { Part, PartContent, PartType, ToolState } from "./protocol";
import type { RuntimeMessage } from "./store";

export interface DbPart {
  id: string;
  message_id: string;
  seq: number;
  type: string;
  tool_name: string | null;
  tool_source: string | null;
  call_id: string | null;
  state: string | null;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: string;
  turn_index: number | null;
  status: string | null;
  model: string | null;
  created_at: number;
  parts: DbPart[];
}

export interface SessionDbRow {
  id: string;
  project_id: string;
  title: string;
  mode: string;
  model: string | null;
  status: string | null;
  pinned: number;
  updated_at: number;
  messages: number;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function mapDbMessage(m: DbMessage): RuntimeMessage {
  return {
    id: m.id,
    role: m.role === "user" ? "user" : "assistant",
    model: m.model ?? undefined,
    time: hhmm(m.created_at),
    turnIndex: m.turn_index ?? undefined,
    parts: m.parts.map(p => ({
      id: p.id,
      messageId: p.message_id,
      seq: p.seq,
      type: p.type as PartType,
      toolName: p.tool_name,
      toolSource: p.tool_source,
      callId: p.call_id,
      state: p.state as ToolState | null,
      content: JSON.parse(p.content) as PartContent,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    })),
  };
}

/** updated_at 分桶：今天 / 昨天 / 更早（本地日界；组名走 t()，双语 UI 不残留中文 key） */
function bucketOf(ms: number, now: number): string {
  const day = 86_400_000;
  const startToday = new Date(now).setHours(0, 0, 0, 0);
  if (ms >= startToday) return t("今天");
  if (ms >= startToday - day) return t("昨天");
  return t("更早");
}

export function groupSessions(rows: SessionDbRow[], now = Date.now()): { group: string; items: SessionRow[] }[] {
  const order = [t("今天"), t("昨天"), t("更早")];
  const items: SessionRow[] = rows.map(r => ({
    id: r.id,
    title: r.title,
    when: hhmm(r.updated_at),
    activity: "",
    project: r.project_id.split("/").filter(Boolean).pop() ?? r.project_id,
    mode: r.mode,
    model: r.model ?? "",
    messages: r.messages,
    cost: "",
    diff: "",
  }));
  return order
    .map(g => ({ group: g, items: items.filter((_, i) => bucketOf(rows[i].updated_at, now) === g) }))
    .filter(g => g.items.length > 0);
}
