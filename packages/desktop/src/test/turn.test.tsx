/**
 * 端到端回合自检：输入 → 流式 → 工具卡 → 审批阻塞 → 放行 → 结果条。
 * 覆盖 PLAN §6.2 的九步 Turn 流程与 §12 Spike①②③ 的前端侧判据。
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { actions } from "../state/app";
import { client } from "../ipc/client";

beforeEach(() => {
  document.body.innerHTML = "";
  actions.openScene("welcome");
  render(<App />);
});

const send = (text: string) => {
  const box = document.querySelector(".ptext") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
};

describe("单轮 Turn 端到端", () => {
  it("提交后依次产出思考链、工具卡，并在写类工具前停下等审批", async () => {
    send("给 store 加 sqlite 持久化并跑测试");

    await waitFor(() => expect(document.querySelectorAll(".msg").length).toBeGreaterThanOrEqual(2), { timeout: 6000 });
    expect(document.querySelector(".msg.user .bubble")?.textContent).toContain("给 store 加 sqlite 持久化");

    // 思考链 + 只读工具卡先出现
    await waitFor(() => expect(document.querySelector(".think")).toBeTruthy(), { timeout: 6000 });
    await waitFor(() => expect(document.querySelectorAll(".tool").length).toBeGreaterThanOrEqual(2), { timeout: 8000 });
    expect([...document.querySelectorAll(".tname")].map(n => n.textContent)).toContain("Grep");

    // 审批门：工具执行前阻塞
    await waitFor(() => expect(document.querySelector(".dock-card")).toBeTruthy(), { timeout: 10000 });
    const card = document.querySelector(".dock-card") as HTMLElement;
    expect(card.textContent).toContain("请求执行命令");
    expect(card.textContent).toContain("bun test ./test/session/sqlite-store.test.ts");
    expect(client.snapshot().pendingApprovals).toHaveLength(1);
    expect(client.snapshot().busy).toBe(true);

    // 允许一次 → 流式输出 → 结果条
    fireEvent.click([...card.querySelectorAll("button")].find(b => b.textContent?.includes("允许一次")) as HTMLElement);
    await waitFor(() => expect(client.snapshot().pendingApprovals).toHaveLength(0), { timeout: 4000 });
    await waitFor(() => expect(document.querySelector("[data-outcome]")?.textContent).toContain("完成"), { timeout: 15000 });
    expect(document.querySelector(".statusbar")).toBeTruthy();
  }, 40000);

  it("拒绝会把工具置为 denied 并终止回合", async () => {
    send("再跑一次");
    await waitFor(() => expect(document.querySelector(".dock-card")).toBeTruthy(), { timeout: 15000 });
    const card = document.querySelector(".dock-card") as HTMLElement;
    fireEvent.click([...card.querySelectorAll("button")].find(b => b.textContent?.includes("拒绝")) as HTMLElement);
    await waitFor(() => expect(document.querySelector("[data-outcome]")?.textContent).toMatch(/已拒绝|已中断/), {
      timeout: 8000,
    });
    expect(client.snapshot().busy).toBe(false);
  }, 40000);

  it("改参数后执行：草稿存活于重渲染，并按新参数放行", async () => {
    send("改参执行");
    await waitFor(() => expect(document.querySelector(".dock-card")).toBeTruthy(), { timeout: 15000 });
    const card = document.querySelector(".dock-card") as HTMLElement;
    const composer = document.querySelector(".ptext") as HTMLTextAreaElement;
    composer.focus();
    // 审批卡已出现，但没有抢走输入框焦点（PLAN §5.3 硬约束）
    expect(document.activeElement).toBe(composer);

    fireEvent.click([...card.querySelectorAll("button")].find(b => b.textContent?.includes("改参数后执行")) as HTMLElement);

    const draft = await waitFor(() => {
      const el = card.querySelector("textarea") as HTMLTextAreaElement;
      expect(el).toBeTruthy();
      // 用户主动要求改参后，焦点才移到草稿框
      expect(document.activeElement).toBe(el);
      return el;
    });
    fireEvent.change(draft, { target: { value: "bun test --reporter=dot" } });

    const allow = [...card.querySelectorAll("button")].find(b => b.textContent?.includes("按改后参数执行")) as HTMLElement;
    expect(allow).toBeTruthy();
    fireEvent.click(allow);
    await waitFor(() => expect(client.snapshot().pendingApprovals).toHaveLength(0), { timeout: 4000 });
    const decided = client
      .snapshot()
      .messages.flatMap(m => m.parts)
      .find(p => p.content.type === "approval" && p.content.decision);
    expect(decided?.content).toMatchObject({ modifiedArgs: "bun test --reporter=dot" });
  }, 40000);

  it("busy 时再次提交进 steering 队列而不是打断当前回合", async () => {
    send("先跑测试");
    await waitFor(() => expect(client.snapshot().busy).toBe(true), { timeout: 6000 });
    const before = client.snapshot().messages.length;
    send("顺便更新 README");
    await waitFor(
      () => expect(client.snapshot().queues.steering.length + client.snapshot().queues.follow_up.length).toBeGreaterThan(0),
      { timeout: 6000 },
    );
    expect(client.snapshot().messages.length).toBe(before);
    client.stop();
  }, 40000);

  it("/panic 走任务级隔离：不崩窗，给出重试与回退入口", async () => {
    send("/panic");
    await waitFor(() => expect(document.querySelector("[data-outcome]")?.textContent).toContain("任务异常终止"), {
      timeout: 8000,
    });
    expect(document.querySelector(".window")).toBeTruthy();
    const push = document.querySelector("[data-outcome] .push") as HTMLElement;
    expect(push.textContent).toContain("重试本 Turn");
  }, 30000);

  it("/outoforder 的乱序事件被丢弃并触发 resync", async () => {
    send("/outoforder");
    await waitFor(() => expect(client.snapshot().dropped).toBeGreaterThan(0), { timeout: 6000 });
    expect(document.body.textContent).not.toContain("这条应当被丢弃");
    expect(document.body.textContent).toContain("乱序之后仍继续");
  }, 30000);
});
