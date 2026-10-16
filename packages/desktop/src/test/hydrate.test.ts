/** DB 行 → 运行时形状的水化映射（§6.9：重启还原只从 SQLite 重建） */
import { describe, expect, it } from "vitest";
import { groupSessions, mapDbMessage, type DbMessage, type SessionDbRow } from "../ipc/hydrate";

const dbMsg = (over: Partial<DbMessage> = {}): DbMessage => ({
  id: "m1",
  session_id: "s1",
  role: "assistant",
  turn_index: 6,
  status: "complete",
  model: "claude-opus-4-1",
  created_at: new Date(2026, 9, 16, 9, 41).getTime(),
  parts: [
    {
      id: "p1",
      message_id: "m1",
      seq: 1,
      type: "text",
      tool_name: null,
      tool_source: null,
      call_id: null,
      state: null,
      content: JSON.stringify({ type: "text", md: "<p>你好</p>" }),
      created_at: 1,
      updated_at: 1,
    },
  ],
  ...over,
});

const dbSession = (over: Partial<SessionDbRow> = {}): SessionDbRow => ({
  id: "s1",
  project_id: "/work/opencode",
  title: "标题",
  mode: "code",
  model: "m",
  status: null,
  pinned: 0,
  updated_at: Date.now(),
  messages: 4,
  ...over,
});

describe("hydrate 映射", () => {
  it("DB snake_case 行 → 运行时 camelCase，content JSON 解析", () => {
    const m = mapDbMessage(dbMsg());
    expect(m.role).toBe("assistant");
    expect(m.turnIndex).toBe(6);
    expect(m.time).toBe("09:41");
    expect(m.parts[0].content).toEqual({ type: "text", md: "<p>你好</p>" });
    expect(m.parts[0].messageId).toBe("m1");
  });

  it("user 角色直传，缺 turn_index 不造假", () => {
    const m = mapDbMessage(dbMsg({ role: "user", turn_index: null }));
    expect(m.role).toBe("user");
    expect(m.turnIndex).toBeUndefined();
  });

  it("会话按本地日界分桶：今天/昨天/更早", () => {
    const now = new Date(2026, 9, 16, 12, 0).getTime();
    const groups = groupSessions(
      [
        dbSession({ id: "a", updated_at: now - 3600_000 }),
        dbSession({ id: "b", updated_at: now - 86_400_000 - 3600_000 }),
        dbSession({ id: "c", updated_at: now - 10 * 86_400_000 }),
      ],
      now,
    );
    expect(groups.map(g => g.group)).toEqual(["今天", "昨天", "更早"]);
    expect(groups[0].items[0].project).toBe("opencode");
  });
});
