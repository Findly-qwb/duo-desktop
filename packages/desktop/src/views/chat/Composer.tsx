/**
 * 输入区（PLAN §11 M1）：模式 / 模型 / 变体 / 斜杠命令 / @ 提及 / 权限速览 / 附件 / 增强 / 排队
 * 快捷键：↵ 发送 · ⇧↵ 换行 · / 命令 · @ 提及 · ⇧Tab 循环推理变体 · esc 中断
 */
import { st } from "../../i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { t, useLocale } from "../../i18n";
import { Icon, type IconName } from "@duo/ui";
import { VARIANTS } from "../../data/fixtures";
import { actions, toast, useApp } from "../../state/app";
import { client } from "../../ipc/client";
import { modelLabel, useProviders } from "../../ipc/providers";
import { useRuntime } from "../../ipc/client";
import { Popover, SlashPop, MentionPop, ModePop, ShieldPop, VariantPop, ModelPop } from "./popovers";
import type { Scene } from "../../data/scenes";

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface Attachment {
  id: string;
  name: string;
  dataUrl: string;
  bytes: number;
}

export function Composer({ scene, welcome }: { scene: Scene; welcome: boolean }): JSX.Element {
  useLocale();
  const app = useApp();
  useProviders(); // 端点缓存就绪后重渲染，模型徽标显示真实展示名
  const rt = useRuntime();
  const pop = scene.composer?.pop;
  const [text, setText] = useState(scene.composer?.value ?? "");
  const [focus, setFocus] = useState(false);
  const [drag, setDrag] = useState(!!scene.composer?.dragover);
  const [imgs, setImgs] = useState<Attachment[]>(
    scene.composer?.images
      ? [
          { id: "i1", name: st("会话截图.png"), dataUrl: "/logo.png", bytes: 240_000 },
          { id: "i2", name: st("表结构草图.png"), dataUrl: "/logo.png", bytes: 180_000 },
        ]
      : [],
  );
  const [enhanced, setEnhanced] = useState(!!scene.composer?.enhanced);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);
  const lastRaw = useRef<string>("");

  useEffect(() => {
    setText(scene.composer?.value ?? "");
    setImgs(
      scene.composer?.images
        ? [
            { id: "i1", name: st("会话截图.png"), dataUrl: "/logo.png", bytes: 240_000 },
            { id: "i2", name: st("表结构草图.png"), dataUrl: "/logo.png", bytes: 180_000 },
          ]
        : [],
    );
    setEnhanced(!!scene.composer?.enhanced);
  }, [scene.composer?.enhanced, scene.composer?.images, scene.composer?.value]);

  // 自适应高度（上限 220px，同原型 onType）
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);

  const insertListener = useMemo(
    () => (e: Event) => {
      const code = (e as CustomEvent<string>).detail;
      setText(t => (t ? `${t}\n${code}` : code));
      taRef.current?.focus();
    },
    [],
  );
  useEffect(() => {
    const fill = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      taRef.current?.focus();
    };
    window.addEventListener("duo:insert-prompt", insertListener);
    window.addEventListener("duo:fill-prompt", fill);
    return () => {
      window.removeEventListener("duo:insert-prompt", insertListener);
      window.removeEventListener("duo:fill-prompt", fill);
    };
  }, [insertListener]);

  function send(): void {
    const value = text.trim();
    if (!value) {
      actions.openScene("chat-stream");
      return;
    }
    if (value === "/") return;
    if (handleSlash(value)) return;
    lastRaw.current = value;
    history.current.unshift(value);
    histIdx.current = -1;
    setText("");
    client.sendUserMessage(value, imgs);
    if (rt.busy) toast(st("当前回合进行中 · 已加入 steering 队列"), "warn");
  }

  function handleSlash(value: string): boolean {
    const cmd = value.split(" ")[0];
    switch (cmd) {
      case "/compact":
        client.compact();
        toast(st("已请求压缩上下文"));
        return true;
      case "/models":
        actions.openScene("pop-model");
        return true;
      case "/mode":
        actions.openScene("pop-mode");
        return true;
      case "/variant":
        actions.openScene("pop-variant");
        return true;
      case "/sessions":
        actions.go("history");
        return true;
      case "/settings":
        actions.go("settings");
        return true;
      case "/export":
        toast(st("已导出 session-2026-10-16.md"));
        return true;
      case "/revert":
        actions.openScene("revert");
        return true;
      case "/reload":
        actions.openScene("reload");
        return true;
      case "/new":
        actions.openScene("welcome");
        toast(st("新会话 · 草稿按会话隔离保存"));
        return true;
      case "/goal":
        actions.openScene("goal");
        return true;
      default:
        if (client.isSkill(cmd)) {
          toast(st("已执行 Skill {cmd}", { cmd: cmd }));
          return true;
        }
        return false;
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape" && rt.busy) {
      e.preventDefault();
      client.stop();
      toast(st("已中断（Esc）· 保留已生成内容"), "warn");
      return;
    }
    if (e.shiftKey && e.key === "Tab") {
      e.preventDefault();
      const i = VARIANTS.indexOf(app.variant);
      actions.setVariant(VARIANTS[(i + 1) % VARIANTS.length]);
      toast(st("推理强度：{length}", { length: VARIANTS[(i + 1) % VARIANTS.length] }));
      return;
    }
    if (e.key === "ArrowUp" && !text) {
      e.preventDefault();
      histIdx.current = Math.min(histIdx.current + 1, history.current.length - 1);
      if (history.current[histIdx.current]) setText(history.current[histIdx.current]);
      return;
    }
    if (e.key === "ArrowDown" && !text) {
      e.preventDefault();
      histIdx.current = Math.max(histIdx.current - 1, -1);
      setText(histIdx.current < 0 ? "" : (history.current[histIdx.current] ?? ""));
    }
  }

  const onPick = (cmd: string): void => {
    if (cmd.startsWith("@")) {
      toast(st("已附加上下文：{cmd}", { cmd: cmd }));
      setText(t => t.replace(/^@.*$/, ""));
      return;
    }
    setText(cmd.endsWith(" ") ? cmd : `${cmd} `);
    taRef.current?.focus();
  };

  function addFiles(files: File[]): void {
    let overflow = false;
    for (const f of files) {
      if (!f.type.startsWith("image/")) {
        toast(st("非图片附件 {x} 已转为 @mention 引用", { x: f.name }));
        setText(t => `${t}${t && !t.endsWith(" ") ? " " : ""}@${f.name} `);
        continue;
      }
      if (f.size > MAX_IMAGE_BYTES || imgs.length >= MAX_IMAGES) {
        overflow = true;
        continue;
      }
      const reader = new FileReader();
      reader.onload = () =>
        setImgs(list => [
          ...list,
          { id: `${f.name}-${Date.now()}`, name: f.name, dataUrl: String(reader.result), bytes: f.size },
        ]);
      reader.readAsDataURL(f);
    }
    if (overflow) toast(st("附件超限（≤ {MAX_IMAGES} 张 / 单张 ≤ 5 MB），已阻止", { MAX_IMAGES: MAX_IMAGES }), "err");
  }

  const tokenHint = `≈ ${Math.max(1, Math.round(text.length / 3.6))} tok · ${((rt.context?.used ?? 68200) / 1000).toFixed(1)}K/${((rt.context?.window ?? 200000) / 1000).toFixed(0)}K`;

  return (
    <>
      {welcome ? (
        <div className="hero">
          <img className="logo" src="/logo.png" alt={st("duo 吉祥物")} />
          <h2>{t("composer.heroTitle", { project: app.project })}</h2>
          <p>{t("composer.heroSub")}</p>
        </div>
      ) : null}

      <div
        className={`promptbox${focus ? " focus" : ""}${rt.busy ? " busy" : ""}${drag ? " dragover" : ""}`}
        onDragOver={e => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => {
          e.preventDefault();
          setDrag(false);
          addFiles([...e.dataTransfer.files]);
        }}>
        {pop === "slash" ? (
          <Popover>
            <SlashPop onPick={onPick} />
          </Popover>
        ) : pop === "mention" ? (
          <Popover>
            <MentionPop onPick={onPick} />
          </Popover>
        ) : pop === "mode" ? (
          <Popover>
            <ModePop />
          </Popover>
        ) : pop === "shield" ? (
          <Popover kind="shieldpop">
            <ShieldPop />
          </Popover>
        ) : pop === "variant" ? (
          <Popover kind="shieldpop">
            <VariantPop />
          </Popover>
        ) : pop === "model" ? (
          <ModelPop />
        ) : null}

        {imgs.length ? (
          <div className="pimgs">
            {imgs.map(a => (
              <div className="thumb" key={a.id} title={`${a.name} · ${(a.bytes / 1024).toFixed(0)} KB`}>
                <img src={a.dataUrl} alt={a.name} />
                <span
                  className="rm"
                  role="button"
                  tabIndex={0}
                  aria-label={st("移除 {x}", { x: a.name })}
                  onClick={() => setImgs(list => list.filter(x => x.id !== a.id))}>
                  <Icon name="x" size="sm" />
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          className="ptext"
          ref={taRef}
          rows={1}
          aria-label={st("让 duo 做什么")}
          placeholder={welcome ? t("composer.placeholderWelcome") : t("composer.placeholder")}
          value={text}
          onChange={e => {
            setText(e.target.value);
            if (e.target.value === "/") actions.openScene("pop-slash");
            else if (e.target.value === "@") actions.openScene("pop-mention");
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onPaste={e => {
            const files = [...e.clipboardData.items]
              .filter(i => i.kind === "file")
              .map(i => i.getAsFile())
              .filter(Boolean) as File[];
            if (files.length) {
              e.preventDefault();
              addFiles(files);
              toast(st("已粘贴 {length} 张图片，将走视觉模型", { length: files.length }));
            }
          }}
        />

        <div className="pbar">
          <button
            type="button"
            className="iconbtn"
            title={t("composer.attach")}
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.multiple = true;
              input.accept = "image/*,*";
              input.onchange = () => addFiles([...(input.files ?? [])]);
              input.click();
            }}>
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className={`selector${pop === "model" || pop === "mode" || pop === "variant" ? " on" : ""}`}
            title={t("composer.modelTip")}
            onClick={() => actions.openScene("pop-model")}>
            <Icon name="cpu" />
            <span className="v">{modelLabel(app.model)}</span>
            <span style={{ color: "var(--text-weaker)" }}>·</span>
            <span className="v">{app.mode}</span>
            <span className="caret">
              <Icon name="chevron-down" size="sm" />
            </span>
          </button>
          <span className="spacer" />
          <button
            type="button"
            className={`selector${pop === "shield" ? " on" : ""}`}
            title={t("composer.shieldTip")}
            onClick={() => actions.openScene("pop-shield")}>
            <Icon name="shield" />
          </button>
          <button
            type="button"
            className="iconbtn"
            title={t("composer.enhanceTip")}
            onClick={() => {
              if (!text.trim()) {
                toast(st("先写一句目标，再增强"), "warn");
                return;
              }
              lastRaw.current = text;
              setText(st("目标：{text} 约束：保持现有接口签名不变 验收：跑测试给出结果与回滚步骤", { text: text }));
              setEnhanced(true);
              toast(st("已用 GPT-5 Mini 增强提示词（Ctrl+Z 回滚原文）"));
            }}>
            <Icon name="sparkle" />
          </button>
          {rt.busy ? (
            <button
              type="button"
              className="sendbtn stop"
              title={t("composer.stop")}
              aria-label={t("composer.stop")}
              onClick={() => {
                client.stop();
                toast(st("已中断（Esc）· 保留已生成内容"), "warn");
              }}>
              <span style={{ width: 11, height: 11, background: "currentColor", borderRadius: 2.5, display: "block" }} />
            </button>
          ) : (
            <button
              type="button"
              className="sendbtn"
              title={t("composer.send")}
              aria-label={t("composer.send")}
              disabled={!text.trim() && !imgs.length}
              onClick={send}>
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
      </div>

      <div className="hintline">
        <span>{t("composer.hint")}</span>
        <span className="push">{tokenHint}</span>
      </div>

      {enhanced ? (
        <div className="notice ok" style={{ maxWidth: 768, margin: "8px auto 0" }}>
          <Icon name="sparkle" size="sm" />
          <div>
            <b>{st("已用 GPT-5 Mini 增强提示词")}</b>
            {st("（Ctrl+Z 回滚原文）：增强只改写输入框文本，不发送、不改上下文。")}
          </div>
        </div>
      ) : null}

      {imgs.length ? (
        <div className="notice info spec" style={{ maxWidth: 768, margin: "8px auto 0" }}>
          <Icon name="image" size="sm" />
          <div>
            {st("图片走")}
            <b>{st("视觉模型")}</b>
            {st("识别（Base64 直传，不内置 OCR）；非图片附件自动转成")}
            <code className="inline">@mention</code> {st("以免污染上下文。")}
          </div>
        </div>
      ) : null}

      {drag ? (
        <div className="notice warn spec" style={{ maxWidth: 768, margin: "8px auto 0" }}>
          <Icon name="alert" size="sm" />
          <div>{st("松开即上传（≤ {MAX_IMAGES} 张 / 单张 ≤ 5 MB）。超限会提示并阻止发送。", { MAX_IMAGES: MAX_IMAGES })}</div>
        </div>
      ) : null}

      {welcome ? (
        <div className="chips">
          {WELCOME_CHIPS.map(c => (
            <button
              key={c.label}
              type="button"
              onClick={() => {
                actions.openScene("chat-stream");
                // 空态卡片把提示词真正填进输入框（原型 fillPrompt），不只是一句 toast
                window.dispatchEvent(new CustomEvent("duo:fill-prompt", { detail: c.prompt }));
              }}>
              <Icon name={c.icon} size="sm" />
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

const WELCOME_CHIPS: { label: string; icon: IconName; prompt: string }[] = [
  { label: st("给 SessionStore 加 SQLite 持久化"), icon: "db", prompt: st("给 SessionStore 加 SQLite 持久化，跑测试") },
  { label: st("修复 MCP 超时不重试"), icon: "zap", prompt: st("修复 MCP 连接超时后不重试的问题") },
  { label: st("评审未提交改动"), icon: "diff", prompt: st("评审当前分支的未提交改动") },
  { label: st("运行 /review"), icon: "bot", prompt: "/review pr-14906" },
];
