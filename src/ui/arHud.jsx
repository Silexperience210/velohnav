// ── HUD AR — composants autonomes à props ───────────────────────────
// Pur affichage : aucun calcul de projection, de cap ni d'itinéraire.
// Les valeurs viennent de RouteOverlay / useRoute / useMultimodalSwitch
// (phase 3) — voir docs/UI-V4-INTEGRATION.md pour le branchement.
import { Icon } from "./icons.jsx";
import { Badge, Button, IconButton, SegmentedControl } from "./primitives.jsx";
import { cardinal, etaWithWind, fmtClock, fmtDist, fmtDuration, headwind, maneuver, positioning, windRelative } from "./format.js";
import { t } from "../i18n.js";

/**
 * ArStepCard — prochaine manœuvre.
 * @param modifier        "left"|"right"|"slight left"|"sharp right"|"uturn"|"straight"|"arrive"
 * @param distanceToStep  m jusqu'à la manœuvre
 * @param street          nom de rue (optionnel)
 * @param step / steps    index 1-based / total (optionnel)
 * @param offRoute / recalculating  états d'alerte (remplacent la consigne)
 */
export function ArStepCard({ modifier = "straight", distanceToStep, street, step, steps, offRoute = false, recalculating = false }) {
  const m = maneuver(modifier);
  const alert = offRoute || recalculating;
  const tone = modifier === "arrive" ? "good" : alert ? "warn" : "accent";
  return (
    <div className="vn-glass vn-step" data-tone={tone} role="status" aria-live="polite">
      <span className="vn-step__icon">
        {recalculating ? <Icon name="refresh" size={26} stroke={2.2} className="vn-spin"/> : <Icon name={alert ? "alert" : m.icon} size={28} stroke={2.2}/>}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {!alert && modifier !== "arrive" && <div className="vn-step__dist">{fmtDist(distanceToStep)}</div>}
        <div className="vn-step__text">
          {recalculating ? t("nav.recalculating").toLowerCase().replace(/^./, c => c.toUpperCase())
            : offRoute ? t("nav.off_route").toLowerCase().replace(/^./, c => c.toUpperCase())
            : t(m.key)}
        </div>
        {street && !alert && <div className="vn-step__street">{street}</div>}
      </div>
      {step && steps && <span className="vn-mono vn-num" style={{ fontSize: 11, color: "var(--vn-text3)", alignSelf: "flex-start" }}>{step}/{steps}</span>}
    </div>
  );
}

/**
 * ArNavStats — restant / durée (corrigée du vent) / heure d'arrivée.
 * @param remainingM   m restants
 * @param baseMin      durée brute (min) — route.totalTime/60
 * @param windFactor   facteur de windImpact() (1 = neutre)
 * @param climbFactor  facteur de climbEtaFactor() (optionnel)
 */
export function ArNavStats({ remainingM, baseMin, windFactor = 1, climbFactor = 1, now = new Date() }) {
  const eta = etaWithWind(baseMin == null ? null : baseMin * climbFactor, windFactor);
  const arrival = eta.min == null ? "—" : fmtClock(new Date(now.getTime() + eta.min * 60000));
  const d = eta.deltaMin;
  return (
    <div className="vn-glass vn-navstats">
      <div>
        <div className="vn-navstats__v">{fmtDist(remainingM)}</div>
        <div className="vn-navstats__l">{t("ui.nav.remaining")}</div>
      </div>
      <div>
        <div className="vn-navstats__v">{fmtDuration(eta.min)}</div>
        <div className="vn-navstats__l" style={d ? { color: d > 0 ? "var(--vn-warn)" : "var(--vn-good)", textTransform: "none", letterSpacing: 0 } : undefined}>
          {d ? t("ui.nav.wind_delta", { d: d > 0 ? `+${d}` : `${d}` }) : t("ui.nav.duration")}
        </div>
      </div>
      <div>
        <div className="vn-navstats__v">{arrival}</div>
        <div className="vn-navstats__l">{t("ui.nav.eta")}</div>
      </div>
    </div>
  );
}

/**
 * PositioningBadge — précision VPS / GPS + « Passer en GPS ».
 * @param mode            "vps"|"gps"|"none"
 * @param accuracy        m (horizontale)
 * @param onSwitchToGps   fn|null — bouton affiché en mode VPS
 */
export function PositioningBadge({ mode, accuracy, onSwitchToGps }) {
  const p = positioning(mode, accuracy);
  const label = `${t(p.key)}${p.accuracy != null ? ` ±${p.accuracy < 10 ? p.accuracy.toFixed(1).replace(".0", "") : Math.round(p.accuracy)} m` : ""}`;
  return (
    <div className="vn-glass" style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px 4px 10px", minHeight: 44 }}>
      <Badge tone={p.tone} icon={mode === "vps" ? "satellite" : "gps"}><span className="vn-num">{label}</span></Badge>
      <span style={{ fontSize: 12, color: "var(--vn-text2)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {mode === "vps" ? (p.tone === "good" ? "ARCore Geospatial" : t("ui.nav.vps_hint")) : mode === "gps" ? t("ui.nav.gps_limited") : ""}
      </span>
      {mode === "vps" && onSwitchToGps && (
        <Button size="sm" variant="ghost" icon="gps" onClick={onSwitchToGps}>{t("ui.nav.switch_gps")}</Button>
      )}
    </div>
  );
}

/**
 * WindGauge — vent relatif au cap de déplacement.
 * @param windKmh   vitesse (km/h)
 * @param windDir   direction d'où vient le vent (°)
 * @param bearing   cap de déplacement (°)
 * La flèche indique où le vent pousse : vers le haut = dans le dos.
 */
export function WindGauge({ windKmh, windDir, bearing }) {
  const rel = windRelative(bearing, windDir);
  const hw = headwind(bearing, windDir, windKmh);
  const labelKey = !windKmh || windKmh < 5 ? "ui.nav.wind_calm" : hw > 5 ? "ui.nav.wind_head" : hw < -5 ? "ui.nav.wind_tail" : "ui.nav.wind_cross";
  const c = labelKey === "ui.nav.wind_head" ? "var(--vn-warn)" : labelKey === "ui.nav.wind_tail" ? "var(--vn-good)" : "var(--vn-text2)";
  return (
    <div className="vn-glass vn-wind" role="img" aria-label={t("ui.nav.wind_gauge", { label: t(labelKey), kmh: windKmh ?? 0 })}>
      <span className="vn-wind__dial">
        <Icon name="arrowUp" size={18} stroke={2.2} className="vn-wind__arrow"
          style={{ color: c, transform: `rotate(${rel ?? 0}deg)` }}/>
      </span>
      <span>
        <span className="vn-num" style={{ display: "block", fontSize: 15, fontWeight: 700, color: "var(--vn-text)", lineHeight: 1.1 }}>
          {windKmh ?? "—"}<small style={{ fontSize: 11, color: "var(--vn-text2)", fontWeight: 600 }}> km/h {cardinal(windDir)}</small>
        </span>
        <span style={{ display: "block", fontSize: 11, color: c, fontWeight: 600 }}>{t(labelKey)}</span>
      </span>
    </div>
  );
}

/**
 * MultimodalSwitch — bascule vélo ↔ vélo + bus, avec suggestion (useMultimodalSwitch).
 * @param value       "bike"|"transit"
 * @param onChange    fn(value)
 * @param suggestion  { busLine, busTime, busDirection, pivotStation:{name,docks}, distFromUser, reason } | null
 * @param onAccept / onDismiss  fn
 */
export function MultimodalSwitch({ value = "bike", onChange, suggestion = null, onAccept, onDismiss }) {
  return (
    <div className="vn-glass" style={{ padding: 8 }}>
      {suggestion && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "4px 4px 10px" }}>
          <span style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(167,139,250,0.14)", color: "var(--vn-transit)",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon name="bus" size={18}/></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--vn-text)" }}>
              {t("ui.nav.mm.suggest", { line: suggestion.busLine, time: suggestion.busTime })}
              {suggestion.busDirection && <span style={{ color: "var(--vn-text2)", fontWeight: 400 }}> → {suggestion.busDirection}</span>}
            </div>
            <div style={{ fontSize: 12, color: "var(--vn-text2)", marginTop: 2 }}>
              {t("ui.nav.mm.pivot", { station: suggestion.pivotStation?.name, dist: fmtDist(suggestion.distFromUser), docks: suggestion.pivotStation?.docks ?? 0 })}
            </div>
            {suggestion.reason && <Badge tone="warn" icon="rain" style={{ marginTop: 6 }}>{suggestion.reason}</Badge>}
          </div>
          {onDismiss && <IconButton icon="x" size="sm" label={t("ui.nav.mm.dismiss")} onClick={onDismiss}/>}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <SegmentedControl label={t("ui.nav.mm.label")} value={value} onChange={onChange} className="vn-seg--compact"
          options={[{ value: "bike", label: t("ui.nav.mm.bike"), icon: "bike" }, { value: "transit", label: t("ui.nav.mm.transit"), icon: "bus" }]}/>
        {suggestion && onAccept && <Button variant="primary" size="sm" onClick={onAccept} style={{ minHeight: 44 }}>{t("ui.nav.mm.accept")}</Button>}
      </div>
    </div>
  );
}

/**
 * ArHud — composition complète, à superposer au flux caméra (position absolue).
 * Toutes les props des sous-composants, regroupées :
 * @param step        props d'ArStepCard
 * @param stats       props d'ArNavStats
 * @param pos         props de PositioningBadge
 * @param wind        props de WindGauge (null = masqué)
 * @param multimodal  props de MultimodalSwitch (null = masqué)
 * @param destination { name, mode } ; onStop fn
 */
export function ArHud({ step, stats, pos, wind, multimodal, destination, onStop }) {
  return (
    <div className="vn-hud">
      <ArStepCard {...step}/>
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <div style={{ flex: 1, minWidth: 0 }}><PositioningBadge {...pos}/></div>
        {wind && <WindGauge {...wind}/>}
      </div>
      <div style={{ flex: 1, pointerEvents: "none" }}/>
      {multimodal && <MultimodalSwitch {...multimodal}/>}
      <ArNavStats {...stats}/>
      {destination && (
        <div className="vn-glass" style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 4px 4px 12px" }}>
          <Icon name={destination.mode === "walking" ? "walk" : "bike"} size={18} style={{ color: "var(--vn-accent)" }}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="vn-eyebrow" style={{ fontSize: 11 }}>{t("ui.nav.dest")}</div>
            <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{destination.name}</div>
          </div>
          <Button variant="danger" size="sm" icon="stop" onClick={onStop} style={{ minHeight: 40 }}>{t("ui.nav.stop")}</Button>
        </div>
      )}
    </div>
  );
}
