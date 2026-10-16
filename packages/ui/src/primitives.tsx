import type { CSSProperties, JSX, ReactNode } from "react";
import type { IconName } from "./IconSprite.js";

export interface IconProps {
  name: IconName;
  /** sm=12 / md=16，缺省 14（与原型 .i 一致） */
  size?: "sm" | "md" | "lg";
  className?: string;
  style?: CSSProperties;
  /** 装饰性图标默认 aria-hidden；需要语义时传 label */
  label?: string;
}

export function Icon({ name, size, className, style, label }: IconProps): JSX.Element {
  const cls = ["i", size, className].filter(Boolean).join(" ");
  return (
    <svg
      className={cls}
      style={style}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  );
}

export type BadgeTone = "ok" | "err" | "run" | "warn" | "gray" | "brand" | "purple";

export function Badge({ tone = "gray", children }: { tone?: BadgeTone; children: ReactNode }): JSX.Element {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <span className="kbd">{children}</span>;
}

export interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "xs" | "sm";
  icon?: IconName;
}

export function Btn({ variant = "default", size, icon, children, className, ...rest }: BtnProps): JSX.Element {
  const cls = ["btn", size, variant === "default" ? "" : variant, className].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} {...rest}>
      {icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </button>
  );
}

export function IconBtn({
  icon,
  size,
  active,
  className,
  title,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  size?: "sm";
  active?: boolean;
  title: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`iconbtn${size ? ` ${size}` : ""}${active ? " on" : ""}${className ? ` ${className}` : ""}`}
      title={title}
      aria-label={title}
      {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Switch({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}): JSX.Element {
  return (
    <span
      role="switch"
      tabIndex={0}
      aria-checked={on}
      aria-label={label}
      className={`switch${on ? " on" : ""}${disabled ? " dis" : ""}`}
      onClick={() => !disabled && onChange(!on)}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!disabled) onChange(!on);
        }
      }}>
      <i />
    </span>
  );
}

export type DotState = "run" | "ask" | "err" | "idle";

/**
 * 状态点。@duo/ui 不依赖 i18n：文案由调用方给（桌面层用 t() 生成并本地重算），
 * 组件层因此不会写死任何中文，也不会出现「模块加载时算好译文」的过期状态。
 */
export function Dot({ state, label }: { state: DotState; label: string }): JSX.Element {
  return <span className={`dot ${state}`} role="img" aria-label={label} title={label} />;
}

export function Meter({ value, tone }: { value: number; tone?: "warn" | "crit" }): JSX.Element {
  return (
    <div className="meter">
      <i className={tone ?? ""} style={{ width: `${value}%` }} />
    </div>
  );
}

/** ± 行级统计（diff 加/删） */
export function Stat({ added, deleted }: { added?: number; deleted?: number }): JSX.Element {
  return (
    <span className="stat">
      {added ? <span className="a">+{added}</span> : null}
      {deleted ? <span className="d">−{deleted}</span> : null}
    </span>
  );
}

export function Mono({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <span className={`mono${className ? ` ${className}` : ""}`} style={style}>
      {children}
    </span>
  );
}
