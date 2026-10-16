/** toast 栈：软删撤销等一次性反馈（原型 .toast + .undo） */
import { Icon } from "@duo/ui";
import { actions, useApp } from "../state/app";

export function Toasts(): JSX.Element | null {
  const app = useApp();
  if (!app.toasts.length) return null;
  const t = app.toasts[app.toasts.length - 1];
  const toneIcon = t.kind === "warn" || t.kind === "err" ? "alert-circle" : "check";
  return (
    <div className="toast show" role="status" aria-live="polite">
      <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <Icon
          name={toneIcon}
          style={{
            color:
              t.kind === "err"
                ? "var(--surface-critical-strong)"
                : t.kind === "warn"
                  ? "var(--surface-warning-strong)"
                  : undefined,
          }}
        />
        <span>{t.text}</span>
      </span>
      {t.undo ? (
        <span
          className="undo"
          role="button"
          tabIndex={0}
          onClick={() => {
            t.undo?.run();
            actions.dismissToast(t.id);
          }}
          onKeyDown={e => {
            if (e.key !== "Enter") return;
            t.undo?.run();
            actions.dismissToast(t.id);
          }}>
          {t.undo.label}
        </span>
      ) : null}
    </div>
  );
}
