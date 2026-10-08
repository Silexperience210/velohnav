// ── VelohNav v4 — composants de base ───────────────────────────────
// Sans état métier : chaque composant ne reçoit que des props. Les styles
// sont dans ui.css (classes vn-*), les états passent par les attributs ARIA
// (aria-pressed, aria-checked, aria-busy) pour que style et accessibilité
// ne divergent jamais.
import { useId } from "react";
import { Icon } from "./icons.jsx";

const cx = (...c) => c.filter(Boolean).join(" ");

export function Spinner({ size = 16, label }) {
  return (
    <svg className="vn-icon vn-spin" width={size} height={size} viewBox="0 0 24 24" fill="none"
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5"/>
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

/**
 * Button — variant: primary | secondary | tonal | ghost | danger
 * state: idle | success | error (feedback après action) ; loading → spinner + aria-busy.
 */
export function Button({ variant = "secondary", size, block, icon, iconRight, loading = false,
                         state = "idle", className, children, disabled, ...rest }) {
  const iconSize = size === "sm" ? 16 : 18;
  const lead = loading ? <Spinner size={iconSize}/>
    : state === "success" ? <Icon name="check" size={iconSize}/>
    : state === "error" ? <Icon name="alert" size={iconSize}/>
    : icon ? <Icon name={icon} size={iconSize}/> : null;
  return (
    <button type="button" {...rest}
      className={cx("vn-btn", `vn-btn--${variant}`, size === "sm" && "vn-btn--sm", block && "vn-btn--block", className)}
      data-state={state !== "idle" ? state : undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}>
      {lead}
      {children}
      {iconRight && !loading && <Icon name={iconRight} size={iconSize}/>}
    </button>
  );
}

/** IconButton — `label` obligatoire (aria-label). variant: plain | filled | accent */
export function IconButton({ icon, label, variant = "plain", size, pressed, loading, iconSize, className, ...rest }) {
  return (
    <button type="button" {...rest} aria-label={label} title={label}
      aria-pressed={pressed === undefined ? undefined : !!pressed}
      aria-busy={loading || undefined}
      className={cx("vn-iconbtn", variant !== "plain" && `vn-iconbtn--${variant}`, size === "sm" && "vn-iconbtn--sm", className)}>
      {loading ? <Spinner size={iconSize ?? 18}/> : <Icon name={icon} size={iconSize ?? (size === "sm" ? 16 : 20)}/>}
    </button>
  );
}

/** Chip — filtre basculable avec compteur optionnel. */
export function Chip({ icon, count, pressed = false, children, className, ...rest }) {
  return (
    <button type="button" {...rest} aria-pressed={pressed} className={cx("vn-chip", className)}>
      {icon && <Icon name={icon} size={15}/>}
      <span>{children}</span>
      {count !== undefined && count !== null && <span className="vn-chip__count">{count}</span>}
    </button>
  );
}

/** SegmentedControl — options: [{ value, label, icon }] ; radiogroup accessible. */
export function SegmentedControl({ options, value, onChange, label, className }) {
  const idx = Math.max(0, options.findIndex(o => o.value === value));
  const n = options.length;
  const onKey = e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (idx + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
    onChange?.(options[next].value);
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx("vn-seg", className)} onKeyDown={onKey}>
      <span className="vn-seg__thumb" aria-hidden="true"
        style={{ width: `calc((100% - 6px) / ${n})`, transform: `translateX(${idx * 100}%)` }}/>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" className="vn-seg__opt"
          aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange?.(o.value)}>
          {o.icon && <Icon name={o.icon} size={16}/>}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Badge — tone: neutral | good | warn | bad | accent | elec | transit | closed */
export function Badge({ tone = "neutral", icon, children, className, ...rest }) {
  return (
    <span {...rest} className={cx("vn-badge", className)} data-tone={tone}>
      {icon && <Icon name={icon} size={12} stroke={2}/>}
      {children}
    </span>
  );
}

export function Card({ pad = true, className, children, as: Tag = "div", ...rest }) {
  return <Tag {...rest} className={cx("vn-card", pad && "vn-card--pad", className)}>{children}</Tag>;
}

/** Stat — valeur chiffrée + libellé ; `color` teinte la valeur. */
export function Stat({ value, unit, label, icon, color, size, className }) {
  return (
    <div className={cx("vn-stat", size === "lg" && "vn-stat--lg", className)}>
      <div className="vn-stat__value" style={color ? { color } : undefined}>
        {value ?? "—"}{unit && <small>{unit}</small>}
      </div>
      <div className="vn-stat__label">{icon && <Icon name={icon} size={12} stroke={2}/>}{label}</div>
    </div>
  );
}

export function Skeleton({ w = "100%", h = 14, r, className, style }) {
  return <span aria-hidden="true" className={cx("vn-skel", className)}
    style={{ display: "block", width: w, height: h, borderRadius: r, ...style }}/>;
}

export function EmptyState({ icon = "info", title, desc, action }) {
  return (
    <div className="vn-empty" role="status">
      <div className="vn-empty__icon"><Icon name={icon} size={22}/></div>
      {title && <div className="vn-empty__title">{title}</div>}
      {desc && <div className="vn-empty__desc">{desc}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

/** Switch — interrupteur accessible (role="switch"). */
export function Switch({ checked, onChange, label, disabled, id }) {
  return (
    <button type="button" role="switch" id={id} aria-checked={!!checked} aria-label={label}
      disabled={disabled} className="vn-switch" onClick={() => onChange?.(!checked)}/>
  );
}

/** Field — libellé + aide + erreur reliés au champ via aria-describedby. */
export function Field({ label, hint, error, children, className }) {
  const id = useId();
  const hintId = `${id}-hint`, errId = `${id}-err`;
  const describedBy = [hint && hintId, error && errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("vn-field", className)}>
      {label && <label className="vn-field__label" htmlFor={id}>{label}</label>}
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error && <div className="vn-field__error" id={errId} role="alert"><Icon name="alert" size={13}/>{error}</div>}
      {hint && <div className="vn-field__hint" id={hintId}>{hint}</div>}
    </div>
  );
}

export function Input({ mono, className, ...rest }) {
  return <input {...rest} className={cx("vn-input", mono && "vn-input--mono", className)}/>;
}

export function ProgressBar({ value = 0, indeterminate, label }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={cx("vn-progress", indeterminate && "vn-progress--indet")}
      role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(v)}>
      <div className="vn-progress__bar" style={{ width: `${v}%` }}/>
    </div>
  );
}

export function StatusDot({ live, color }) {
  return <span className={cx("vn-dot", live && "vn-dot--live")} style={color ? { color, background: color } : undefined} aria-hidden="true"/>;
}

/** Section — groupe titré (réglages, listes). */
export function Section({ title, aside, children, id }) {
  return (
    <section className="vn-section" aria-labelledby={title ? `${id ?? title}-h` : undefined}>
      {title && (
        <div className="vn-section__head">
          <h2 className="vn-eyebrow" id={`${id ?? title}-h`} style={{ margin: 0 }}>{title}</h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** Row — ligne de liste : icône, titre, sous-titre, contrôle à droite. */
export function Row({ icon, iconColor, title, sub, right, onClick, children }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={cx("vn-row", onClick && "vn-row--btn")} onClick={onClick} type={onClick ? "button" : undefined}>
      {icon && <span className="vn-row__icon" style={iconColor ? { color: iconColor } : undefined}><Icon name={icon} size={16}/></span>}
      <span className="vn-row__body">
        <span className="vn-row__title" style={{ display: "block" }}>{title}</span>
        {sub && <span className="vn-row__sub" style={{ display: "block" }}>{sub}</span>}
        {children}
      </span>
      {right}
    </Tag>
  );
}

/** Meter — barre segmentée (ex. élec / méca / bornes libres). */
export function Meter({ segments, label }) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value || 0), 0) || 1;
  return (
    <div className="vn-meter" role="img" aria-label={label}>
      {segments.filter(s => s.value > 0).map(s => (
        <span key={s.key ?? s.color} style={{ flexGrow: s.value / total, flexBasis: 0, background: s.color }}/>
      ))}
    </div>
  );
}
