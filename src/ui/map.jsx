// ── Chrome de la carte — composants autonomes à props ───────────────
// Aucun accès aux hooks de données : la phase 1 (MapLibre) branche ses
// données ici. Contrats détaillés dans docs/UI-V4-INTEGRATION.md.
import { Icon } from "./icons.jsx";
import { Badge, Button, IconButton, Meter, SegmentedControl, Stat, Chip } from "./primitives.jsx";
import { BottomSheet } from "./Sheet.jsx";
import { FILTERS, STATUS_COLOR, STATUS_TONE, fmtAgo, fmtDist, stationView, statusLabel, walkMinutes } from "./format.js";
import { color } from "./tokens.js";
import { t } from "../i18n.js";

const FILTER_ICON = { all: "layers", bikes: "bike", docks: "dock", elec: "bolt" };

/**
 * MapSearchBar
 * @param value        string
 * @param onChange     fn(string)
 * @param resultCount  number|null — affiché quand une recherche est saisie
 */
export function MapSearchBar({ value, onChange, resultCount = null, onSubmit }) {
  return (
    <form role="search" className="vn-search" onSubmit={e => { e.preventDefault(); onSubmit?.(value); }}>
      <Icon name="search" size={18} style={{ color: "var(--vn-text3)" }}/>
      <input className="vn-search__input" type="search" value={value} enterKeyHint="search"
        placeholder={t("ui.map.search")} aria-label={t("ui.map.search")} autoComplete="off"
        onChange={e => onChange(e.target.value)}/>
      {value && resultCount !== null && (
        <span className="vn-search__count vn-num" aria-live="polite">{t("ui.map.results", { n: resultCount })}</span>
      )}
      {value && <IconButton icon="x" size="sm" label={t("ui.map.search_clear")} onClick={() => onChange("")}/>}
    </form>
  );
}

/**
 * MapFilterBar — Tout / Vélos / Bornes / Élec avec compteurs.
 * @param value     "all"|"bikes"|"docks"|"elec"
 * @param onChange  fn(filter)
 * @param counts    { all, bikes, docks, elec } — cf. format.filterCounts()
 */
export function MapFilterBar({ value = "all", onChange, counts = {} }) {
  return (
    <div className="vn-filters vn-scroll" role="group" aria-label={t("ui.map.filters")}>
      {FILTERS.map(f => (
        <Chip key={f} icon={FILTER_ICON[f]} pressed={value === f} count={counts[f] ?? 0}
          onClick={() => onChange(f)}>{t(`ui.map.f.${f}`)}</Chip>
      ))}
    </div>
  );
}

/**
 * NetworkSummary — totaux réseau + fraîcheur des données (une ligne).
 * @param totals      { bikes, elec, docks, open, stations } — format.networkTotals()
 * @param lastUpdate  ms|null
 */
export function NetworkSummary({ totals, lastUpdate }) {
  return (
    <div className="vn-netsum vn-num">
      <span><b style={{ color: color.good }}>{totals.bikes}</b> {t("ui.st.bikes").toLowerCase()}</span>
      <span><b style={{ color: color.elec }}>{totals.elec}</b> {t("ui.st.elec").toLowerCase()}</span>
      <span><b style={{ color: color.text }}>{totals.docks}</b> {t("ui.st.docks").toLowerCase()}</span>
      {lastUpdate !== undefined && <span style={{ marginLeft: "auto", color: "var(--vn-text3)" }}>
        <Icon name="clock" size={11} stroke={2} style={{ display: "inline", verticalAlign: "-1px", marginRight: 3 }}/>
        {fmtAgo(lastUpdate)}</span>}
    </div>
  );
}

/** MapLegend — légende compacte des marqueurs. */
export function MapLegend({ style }) {
  const items = [
    ["ok", STATUS_COLOR.ok], ["low", STATUS_COLOR.low], ["empty", STATUS_COLOR.empty], ["closed", STATUS_COLOR.closed],
  ];
  return (
    <div className="vn-legend" role="group" aria-label={t("ui.map.legend")} style={style}>
      {items.map(([k, c]) => (
        <span key={k} className="vn-legend__item"><span className="vn-legend__dot" style={{ background: c }}/>{statusLabel(k)}</span>
      ))}
      <span className="vn-legend__item">
        <span className="vn-legend__dot" style={{ background: "transparent", boxShadow: `inset 0 0 0 2px ${color.elec}` }}/>{t("ui.st.elec")}
      </span>
      <span className="vn-legend__item">
        <span className="vn-legend__dot" style={{ background: color.user, boxShadow: `0 0 0 3px ${color.user}40` }}/>{t("ui.map.legend.you")}
      </span>
    </div>
  );
}

/**
 * RecenterButton — bouton flottant « recentrer ».
 * @param following  bool — la carte suit la position (icône accent)
 * @param disabled   bool — pas de GPS
 */
export function RecenterButton({ onClick, following = false, disabled = false, style }) {
  return (
    <IconButton icon="locate" variant="filled" label={disabled ? t("ui.map.recenter_off") : t("ui.map.recenter")}
      pressed={following} disabled={disabled} onClick={onClick} style={style}/>
  );
}

/** StationMarker — pastille de station (HTML), utilisable comme marqueur MapLibre. */
export function StationMarker({ station, selected = false, onClick }) {
  const v = stationView(station);
  const c = STATUS_COLOR[v.status];
  return (
    <button type="button" className="vn-marker" data-selected={selected || undefined} onClick={onClick}
      aria-label={`${v.name} — ${statusLabel(v.status)}, ${v.bikes} ${t("ui.st.bikes").toLowerCase()}`}
      style={{ "--c": c }}>
      <span className="vn-marker__dot vn-num" style={v.elec > 0 && v.status !== "closed" ? { boxShadow: `0 0 0 2px ${color.bg}, 0 0 0 4px ${color.elec}` } : undefined}>
        {v.status === "closed" ? "×" : v.bikes}
      </span>
    </button>
  );
}

/**
 * StationSheet — fiche station en bottom-sheet.
 * @param station       objet station (JCDecaux actuel ou GBFS phase 1) — normalisé par stationView()
 * @param open          bool
 * @param onClose       fn
 * @param mode          "cycling"|"walking"
 * @param onModeChange  fn(mode)
 * @param onGo          fn(station, mode)  — « Y aller » : itinéraire 2D sur la carte
 * @param onAR          fn(station, mode)  — « AR » : bascule vers l'onglet AR + nav
 * @param onStartTrip   fn(station)|null   — masqué si null ou station sans vélo
 * @param externalHref  string|null        — lien « ouvrir dans une app de cartes »
 * @param prediction    number|null        — vélos prévus à l'arrivée (useAvailability)
 * @param children      contenu additionnel (ex. <WeatherBanner/>)
 */
export function StationSheet({ station, open = true, onClose, mode = "cycling", onModeChange, onGo, onAR,
                               onStartTrip = null, externalHref = null, prediction = null, inline = false, children }) {
  const v = stationView(station);
  if (!v) return null;
  const sc = STATUS_COLOR[v.status];
  const walk = walkMinutes(v.dist);
  return (
    <BottomSheet open={open} onClose={onClose} label={v.name} inline={inline}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Badge tone={STATUS_TONE[v.status]}>{statusLabel(v.status)}</Badge>
            <span className="vn-num" style={{ fontSize: 12, color: "var(--vn-text2)" }}>
              {fmtDist(v.dist)}{walk ? ` · ${t("ui.st.walk", { min: walk })}` : ""}
            </span>
            {v.simulated && <Badge tone="warn" icon="info">{t("ui.st.simulated")}</Badge>}
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.25, marginTop: 6, color: "var(--vn-text)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</h2>
        </div>
        <IconButton icon="x" label={t("ui.close")} onClick={onClose} style={{ marginTop: -6, marginRight: -8 }}/>
      </div>

      <div className="vn-stgrid" style={{ marginTop: 12, gridTemplateColumns: v.meca > 0 ? undefined : "repeat(3, 1fr)" }}>
        <Stat size="lg" value={v.bikes} label={t("ui.st.bikes")} color={sc} icon="bike"/>
        <Stat size="lg" value={v.elec} label={t("ui.st.elec")} color={v.elec ? color.elec : undefined} icon="bolt"/>
        {v.meca > 0 && <Stat size="lg" value={v.meca} label={t("ui.st.meca")}/>}
        <Stat size="lg" value={v.docks} label={t("ui.st.docks")} color={v.docks ? color.text : color.bad} icon="dock"/>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
        <div style={{ flex: 1 }}>
          <Meter label={t("ui.st.composition", { elec: v.elec, meca: v.meca, docks: v.docks })} segments={[
            { key: "e", value: v.elec, color: color.elec },
            { key: "m", value: v.meca, color: "#C9D1DC" },
            { key: "d", value: v.docks, color: "rgba(255,255,255,0.14)" },
          ]}/>
        </div>
        <span className="vn-num" style={{ fontSize: 11, color: "var(--vn-text3)", whiteSpace: "nowrap" }}>{t("ui.st.cap", { n: v.cap })}</span>
      </div>
      {(prediction !== null || v.updatedAt) && (
        <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 12, color: "var(--vn-text2)" }}>
          {prediction !== null && <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Icon name="clock" size={12} stroke={2}/>{t("ui.st.predict", { n: prediction })}</span>}
          {v.updatedAt && <span style={{ marginLeft: "auto", color: "var(--vn-text3)" }}>{t("ui.st.updated", { ago: fmtAgo(v.updatedAt) })}</span>}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <SegmentedControl label={t("ui.st.mode")} value={mode} onChange={onModeChange} className="vn-seg--compact"
          options={[{ value: "cycling", label: t("ui.st.mode_bike"), icon: "bike" },
                    { value: "walking", label: t("ui.st.mode_walk"), icon: "walk" }]}/>
        {onStartTrip && v.bikes > 0 && v.status !== "closed" && (
          <Button variant="secondary" icon="play" onClick={() => onStartTrip(station)} style={{ flex: "0 0 auto" }}
            aria-label={t("ui.st.start_trip")}>
            {t("ui.st.trip")}
          </Button>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button variant="primary" icon="route" block onClick={() => onGo?.(station, mode)}>{t("ui.st.go")}</Button>
        <Button variant="tonal" icon="ar" onClick={() => onAR?.(station, mode)} aria-label={t("ui.st.ar_label")}
          style={{ flex: "0 0 96px" }}>{t("ui.st.ar")}</Button>
        {externalHref && (
          <a className="vn-iconbtn vn-iconbtn--filled" href={externalHref} target="_blank" rel="noopener noreferrer"
            aria-label={t("ui.st.external")} title={t("ui.st.external")} style={{ boxShadow: "none" }}>
            <Icon name="external" size={18}/>
          </a>
        )}
      </div>
      {children}
    </BottomSheet>
  );
}
