// ── Coquille : en-tête, barre d'onglets, bandeaux d'état ────────────
import { Icon, LogoMark } from "./icons.jsx";
import { Button, StatusDot } from "./primitives.jsx";
import { useMinuteClock } from "./hooks.js";
import { fmtAgo, fmtClock, positioning, dataSource, tripSats } from "./format.js";
import { t } from "../i18n.js";

/**
 * AppHeader — en-tête compact (52 px + safe-area).
 * @param screen      "ar" | "map" | "ai" | "settings"
 * @param pos         { mode: "gps"|"vps"|"none", accuracy: m|null }
 * @param data        { apiLive, isMock, offline, lastUpdate: ms|null }
 * @param refreshing  bool — spinner sur la pastille données
 * @param onRefresh   fn   — tap sur la pastille données
 */
export function AppHeader({ screen, pos, data, refreshing, onRefresh }) {
  const now = useMinuteClock();
  const p = positioning(pos?.mode ?? "none", pos?.accuracy ?? null);
  const posLabel = p.accuracy != null ? `${t(p.key)} ±${Math.round(p.accuracy)} m` : t(p.key);
  const ds = dataSource(data ?? {});
  const updated = t("ui.updated", { ago: fmtAgo(data?.lastUpdate, now.getTime()) });
  return (
    <header className="vn-header">
      <div className="vn-brand">
        <LogoMark/>
        <div style={{ minWidth: 0 }}>
          <div className="vn-brand__name">VELOH<b>NAV</b></div>
          <div className="vn-brand__sub">{t(`ui.screen.${screen}`)}</div>
        </div>
      </div>
      <div className="vn-header__status">
        <span className="vn-pill" data-tone={p.tone} role="status"
          aria-label={t("ui.pos.status", { label: p.accuracy != null ? `${t(p.key)}, ${t("ui.pos.accuracy", { acc: Math.round(p.accuracy) })}` : t(p.key) })}>
          <Icon name={pos?.mode === "vps" ? "satellite" : "gps"} size={13} stroke={2}/>
          <span className="vn-num">{posLabel}</span>
        </span>
        <button type="button" className="vn-pill vn-pill--btn" data-tone={ds.tone} onClick={onRefresh}
          aria-busy={refreshing || undefined}
          aria-label={t("ui.data.status", { state: t(`${ds.key}_desc`), updated })}>
          {data?.offline ? <Icon name="wifiOff" size={13} stroke={2}/> : <StatusDot live={ds.tone === "good"}/>}
          <span>{t(ds.key)}</span>
          <Icon name="refresh" size={12} stroke={2} className={refreshing ? "vn-spin" : ""}
            style={{ color: "var(--vn-text3)" }}/>
        </button>
        <time className="vn-clock vn-num" dateTime={now.toISOString()}>{fmtClock(now)}</time>
      </div>
    </header>
  );
}

/**
 * TabBar — 4 onglets, indicateur glissant, role="tablist".
 * @param tabs     [{ id, icon, label }]
 * @param value    id actif
 * @param onChange fn(id)
 */
export function TabBar({ tabs, value, onChange }) {
  const idx = Math.max(0, tabs.findIndex(x => x.id === value));
  const onKey = e => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const n = tabs.length, next = (idx + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
    onChange(tabs[next].id);
    e.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
  };
  return (
    <nav className="vn-tabbar" role="tablist" aria-label={t("ui.tabs")} onKeyDown={onKey}>
      <span className="vn-tabbar__ind" aria-hidden="true" style={{ transform: `translateX(${idx * 100}%)` }}/>
      {tabs.map(x => (
        <button key={x.id} type="button" role="tab" className="vn-tab" id={`tab-${x.id}`}
          aria-selected={x.id === value} aria-controls="vn-main" tabIndex={x.id === value ? 0 : -1}
          onClick={() => onChange(x.id)}>
          <Icon name={x.icon} size={22} stroke={x.id === value ? 2 : 1.75}/>
          <span>{x.label}</span>
        </button>
      ))}
    </nav>
  );
}

/** OfflineStrip — visible tant que le réseau est coupé. */
export function OfflineStrip({ lastUpdate }) {
  return (
    <div className="vn-strip" data-tone="warn" role="status">
      <Icon name="wifiOff" size={16}/>
      <span className="vn-strip__title" style={{ color: "var(--vn-warn)" }}>{t("ui.offline.title")}</span>
      <span className="vn-strip__meta">{t("ui.offline.desc", { ago: fmtAgo(lastUpdate) })}</span>
    </div>
  );
}

/**
 * TripStrip — trajet en cours.
 * @param trip    { name, startAt }
 * @param lnOn    bool — affiche l'estimation en sats
 * @param ending  bool — paiement en cours (bouton en chargement)
 * @param onEnd   fn
 */
export function TripStrip({ trip, lnOn, ending, onEnd }) {
  useMinuteClock(); // rafraîchit la durée chaque minute
  const min = Math.max(0, Math.round((Date.now() - trip.startAt) / 60000));
  return (
    <div className="vn-strip" data-tone="accent" role="status">
      <span style={{ width: 30, height: 30, borderRadius: 8, background: "var(--vn-accent-soft)", color: "var(--vn-accent)",
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon name="bike" size={18}/>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="vn-strip__title">{t("ui.trip.title")}</div>
        <div className="vn-strip__meta vn-num" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {t("ui.trip.meta", { name: trip.name, min })}
          {lnOn && <span style={{ color: "var(--vn-sats)", marginLeft: 6 }}>· {t("ui.trip.est", { n: tripSats(min) })}</span>}
        </div>
      </div>
      <Button size="sm" variant="tonal" icon="flag" loading={ending} onClick={onEnd}>{t("ui.trip.end")}</Button>
    </div>
  );
}
