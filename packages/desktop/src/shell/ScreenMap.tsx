/** 屏目索引（⌘⇧S）：按 M0–M6 分组，hash 可直达，作为 MVP 拆单与验收清单 */
import { useMemo } from "react";
import { t } from "../i18n";
import { Icon } from "@duo/ui";
import { SCREENS, SCREEN_SECTIONS } from "../screens/registry";
import { actions, useApp } from "../state/app";

export function ScreenMap(): JSX.Element | null {
  const app = useApp();
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of SCREENS) c[s.kind] = (c[s.kind] ?? 0) + 1;
    return c;
  }, []);

  if (!app.screenMap) return null;

  return (
    <div className="screenmap show" role="dialog" aria-label={t("屏目索引")}>
      <div className="sm-head">
        <h2>{t("屏目索引")}</h2>
        <p>
          {t("duo Desktop v2-lite 原型 · Rust Agent Runtime + React + 皮肤系统 · 共")}
          <b className="mono">{SCREENS.length}</b> {t("屏 · 点击直达（hash 可分享）")}
        </p>
        <button
          type="button"
          className="btn iconbtn x"
          style={{ marginLeft: "auto" }}
          aria-label={t("关闭屏目索引")}
          onClick={() => actions.setScreenMap(false)}>
          <Icon name="x" />
        </button>
      </div>
      <div className="sm-legend">
        <span>{t("⌘K 命令面板 · ⌥[ / ⌥] 折叠 · ⌘⇧S 本索引 · ⌘⇧P 原型层（规格说明）· esc 关闭浮层")}</span>
        <span>{t("P0 首版必须 · P1 首版应有 · P2 延后")}</span>
        <span>
          {Object.entries(counts)
            .map(([k, v]) => `${k} ${v}`)
            .join(" · ")}
        </span>
      </div>
      {SCREEN_SECTIONS.map(sec => (
        <div className="sm-sec" key={sec}>
          <h3>
            {sec}
            <span className="cnt">
              {SCREENS.filter(s => s.section === sec).length} {t("屏")}
            </span>
          </h3>
          <div className="sm-grid">
            {SCREENS.filter(s => s.section === sec).map(s => (
              <button key={s.id} type="button" className={`sm-item${s.id === app.scene ? " on" : ""}`} onClick={s.run}>
                <span className="id mono">{s.id.slice(0, 5)}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="nm">
                    {s.name}
                    <span className="type">{s.kind}</span>
                  </span>
                  <span className="ds">{s.desc}</span>
                </span>
                <span className={`pri ${s.pri.toLowerCase()}`}>{s.pri}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
