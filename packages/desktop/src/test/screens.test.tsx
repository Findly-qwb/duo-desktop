/**
 * 逐屏自检：把屏目索引里的每一屏都跑一遍，断言不抛错且关键 DOM 存在。
 * 「按原型逐屏验收」的可执行版本 —— 屏目数 = 断言数，漏屏即测试漏项。
 */
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { SCREENS } from "../screens/registry";
import { actions, appStore } from "../state/app";

beforeEach(() => {
  document.body.innerHTML = "";
  render(<App />);
});

const settle = async () => {
  await waitFor(() => expect(document.querySelector(".window")).toBeTruthy());
};

describe("屏目索引逐屏自检", () => {
  it.each(SCREENS.map(s => [s.id, s] as const))("%s 可直达且不抛错", async (_id, s) => {
    s.run();
    await settle();
    expect(document.body.textContent).not.toMatch(/Cannot read|is not a function|Minified React error/);
  });

  it("对话状态屏渲染出消息流或输入区", async () => {
    for (const s of SCREENS.filter(x => x.kind === "对话状态")) {
      s.run();
      await waitFor(
        () => {
          const v = document.getElementById("v-chat");
          expect(v?.querySelector(".messages, .promptbox, .taskhead")).toBeTruthy();
        },
        { timeout: 3000 },
      );
    }
  });

  it("弹窗屏渲染出 .modal", async () => {
    for (const s of SCREENS.filter(x => x.kind === "弹窗")) {
      s.run();
      await waitFor(() => expect(document.querySelector(".scrim.show .modal.show")).toBeTruthy(), { timeout: 3000 });
      actions.closeModal();
      actions.closeConfirm();
    }
  });

  it("设置页屏切到对应 tab 并渲染策略表", async () => {
    for (const s of SCREENS.filter(x => x.kind === "设置页")) {
      s.run();
      await waitFor(() => expect(document.querySelector("#v-settings .set-body")).toBeTruthy(), { timeout: 3000 });
      expect(document.querySelector(".set-nav button.active")).toBeTruthy();
      expect(appStore.get().settingsTab).not.toBe("");
    }
  });

  it("面板屏打开右栏子视图", async () => {
    for (const s of SCREENS.filter(x => x.id.startsWith("panel-") && x.id !== "panel-picker")) {
      s.run();
      await waitFor(() => expect(document.querySelector(".dock .dock-body")?.textContent).toBeTruthy(), { timeout: 3000 });
    }
  });

  it("独立页屏渲染出页面骨架", async () => {
    for (const s of SCREENS.filter(x => x.kind === "独立页")) {
      s.run();
      await waitFor(() => expect(document.querySelector(".page")).toBeTruthy(), { timeout: 3000 });
    }
  });
});

describe("外壳与皮肤", () => {
  it("三套内置皮肤可切换且带 data-skin", async () => {
    for (const id of ["graphite-dark", "paper-light", "nocturne-amber"]) {
      actions.setSkin(id);
      await waitFor(() => expect(document.documentElement.dataset.skin).toBe(id));
    }
  });

  it("字号滑杆写入 --fscale", async () => {
    actions.setScale(17);
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--fscale")).toBe((17 / 13).toFixed(3)));
  });

  it("左右栏折叠双向可用并持久化到 ui_state 键", async () => {
    actions.openScene("chat-stream");
    await settle();
    const before = appStore.get();
    const shellBefore = document.querySelector(".shell")?.className ?? "";

    actions.toggleLeft();
    await waitFor(() => expect(document.querySelector(".shell")?.className).not.toBe(shellBefore));
    expect(appStore.get().leftCollapsed).toBe(!before.leftCollapsed);
    expect(localStorage.getItem("duo.ui.left")).toBe(appStore.get().leftCollapsed ? "1" : "0");

    actions.toggleLeft();
    await waitFor(() => expect(document.querySelector(".shell")?.className).toBe(shellBefore));
    expect(appStore.get().leftCollapsed).toBe(before.leftCollapsed);

    // 右栏折叠后状态栏仍在，⌥] 可随时恢复
    actions.toggleRight();
    await waitFor(() => expect(document.querySelector(".statusbar")).toBeTruthy());
    expect(appStore.get().rightCollapsed).toBe(!before.rightCollapsed);
  });

  it("原型层开关控制 .spec / .proto-only 可见性", async () => {
    actions.toggleProto(false);
    await waitFor(() => expect(document.documentElement.dataset.proto).toBe("off"));
    actions.toggleProto(true);
    await waitFor(() => expect(document.documentElement.dataset.proto).toBe("on"));
  });
});

describe("命令面板与屏目索引", () => {
  it("⌘K 打开后可点击执行", async () => {
    actions.setPalette(true);
    await waitFor(() => expect(document.querySelector(".palette.show")).toBeTruthy());
    const items = document.querySelectorAll(".palette .pitem");
    expect(items.length).toBeGreaterThan(10);
    (items[0] as HTMLElement).click();
    await waitFor(() => expect(document.querySelector(".palette.show")).toBeNull());
  });

  it("屏目索引按 M0–M6 分组且每屏可点", async () => {
    actions.setScreenMap(true);
    await waitFor(() => expect(document.querySelector(".screenmap.show")).toBeTruthy());
    expect(document.querySelectorAll(".sm-item").length).toBe(SCREENS.length);
    expect(document.querySelectorAll(".sm-sec").length).toBeGreaterThan(4);
  });
});

describe("hash 直达（原型「每屏 hash 可分享」）", () => {
  // 回归：曾把所有 hash 屏都当对话屏装载，导致设置页 / 弹窗 / 面板渲染成空视图
  it.each([
    ["s=approve-page", () => document.querySelector("#v-settings .set-body .sgroup")],
    ["s=panel-review", () => document.querySelector(".dock .dock-body .grp")],
    ["s=skin-manager", () => document.querySelector(".modal.show h3")],
    ["s=history", () => document.querySelector("#v-history .hrow")],
    ["s=mcp", () => document.querySelector("#v-mcp .sgroup")],
  ])("%s 打开对应视图而非空对话", async (hash, probe) => {
    document.body.innerHTML = "";
    window.location.hash = hash;
    render(<App />);
    await waitFor(() => expect(probe()).toBeTruthy(), { timeout: 3000 });
    window.location.hash = "";
  });
});

describe("英文态全屏回归", () => {
  // 语言切换后不得有任何屏崩溃；UI 文案已 100% 抽取，剩下的中文只可能是演示正文（data/scenes）
  it("79 屏在 en 下全部可打开", async () => {
    const { setLocale } = await import("../i18n");
    setLocale("en");
    try {
      for (const s of SCREENS) {
        s.run();
        await waitFor(() => expect(document.querySelector(".window")).toBeTruthy(), { timeout: 3000 });
        expect(document.body.textContent).not.toMatch(/Cannot read|is not a function|Minified React error/);
        actions.closeModal();
        actions.closeConfirm();
      }
    } finally {
      setLocale("zh");
    }
  }, 120000);

  it("en 态：设置各页整页无中文残留（SETTINGS 表里那份中文只是 key）", async () => {
    const { setLocale } = await import("../i18n");
    setLocale("en");
    const HAN = /[一-鿿]/;
    try {
      const tabs = SCREENS.filter(s => s.id.startsWith("set-"));
      expect(tabs.length).toBeGreaterThanOrEqual(7);
      for (const s of tabs) {
        s.run();
        await settle();
        const root = document.querySelector(".settings") ?? document.querySelector(".page");
        expect(root, s.id).toBeTruthy();
        // 语言名按惯例用各自语言书写（简体中文 / 日本語），断言时剔掉
        const text = (root?.textContent ?? "").replace(/简体中文|日本語/g, "");
        expect(HAN.test(text), `${s.id} 仍有中文：${text.match(/[^·|]{0,12}[一-鿿][^·|]{0,12}/)?.[0]}`).toBe(false);
      }
      // 皮肤下拉与 sel2 的逐片选项也要译
      SCREENS.find(s => s.id === "set-display")?.run();
      await settle();
      const opts = [...document.querySelectorAll(".set-body option")].map(o => o.textContent);
      expect(opts).toContain("Graphite Dark");
      expect(opts).toContain("expanded"); // sel2 先整串译再拆 |，所以选项是 collapsed / expanded
    } finally {
      setLocale("zh");
    }
  });
});
