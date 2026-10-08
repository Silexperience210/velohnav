// ── NavHud — HUD de navigation AR sur le design system (src/ui/arHud.jsx) ──
// Même disposition que <ArHud> (étape, positionnement + vent, bascules,
// statistiques, destination), composée à partir de ses sous-composants pour
// garder ce qu'ArHud ne prévoit pas : bouton « Recalculer », suggestion de
// station prédictive et badge de dénivelé. Aucun calcul de projection ici.
import { useMemo } from "react";
import { ArStepCard, ArNavStats, PositioningBadge, WindGauge, MultimodalSwitch } from "../../ui/arHud.jsx";
import { Badge, Button } from "../../ui/primitives.jsx";
import { Icon } from "../../ui/icons.jsx";
import { t } from "../../i18n.js";
import { fmtDist } from "../../ui/format.js";
import { getBearing, haversine } from "../../utils.js";
import { windImpact } from "../../hooks/useWeather.js";
import { climbEtaFactor, EBIKE_ASCENT_THRESHOLD_M } from "../../hooks/useRoute.js";
import { remainingAlongRoute } from "./navProgress.js";

/**
 * Valeurs dérivées du HUD (pures, exportées pour les tests).
 * - remainingM : distance restante LE LONG du tracé (avant : longueur totale
 *   du tracé, figée — « 899 m · 2 min total » ne décroissait jamais)
 * - baseMin    : durée du fournisseur au prorata du restant
 * - windFactor : windImpact sur le cap vers la prochaine manœuvre (vélo)
 * - climbFactor: pente appliquée aux seuls temps « plats » (OSRM/Google) ;
 *                BRouter intègre déjà la pente dans son total-time
 */
export function hudFigures({ route, step, gpsPos, mode, weather }) {
  if (!route) return null;
  const nextWp = route.waypoints?.[step];
  const last = (route.waypoints?.length ?? 1) - 1;
  const distNext = nextWp && gpsPos ? haversine(gpsPos.lat, gpsPos.lng, nextWp.lat, nextWp.lng) : null;
  const arriving = distNext != null && step === last && distNext < 30;
  const remainingM = remainingAlongRoute(route.coords, gpsPos) ?? route.totalDist;
  const share = route.totalDist > 0 ? Math.min(1, remainingM / route.totalDist) : 1;
  const baseMin = route.totalTime ? (route.totalTime * share) / 60 : null;
  const bearing = nextWp && gpsPos ? getBearing(gpsPos.lat, gpsPos.lng, nextWp.lat, nextWp.lng) : null;
  const wind = weather && mode !== "walking" && bearing != null
    ? windImpact(bearing, weather.windDir ?? 0, weather.wind ?? 0)
    : { factor: 1, label: null, headWindKmh: 0 };
  const ascent = route.totalAscent;
  const climbFactor = ascent == null || route.provider === "brouter" ? 1 : climbEtaFactor(ascent, route.totalDist, mode);
  return {
    nextWp, distNext, arriving, remainingM, baseMin, bearing,
    windFactor: wind.factor, climbFactor,
    ascent, descent: route.totalDescent ?? 0,
    recommendElectric: mode !== "walking" && ascent != null && ascent >= EBIKE_ASCENT_THRESHOLD_M,
  };
}

export default function NavHud({
  route, step, gpsPos, mode, weather, navStation, onStop,
  offRoute = false, recalculating = false, manualRecalc = null, spatialAudio = false,
  mmSuggestion = null, onMmAccept, onMmDismiss,
  predSuggestion = null, navIntent = "pickup", onPredAccept, onPredDismiss,
}) {
  const f = useMemo(() => hudFigures({ route, step, gpsPos, mode, weather }),
    [route, step, gpsPos, mode, weather]);
  if (!route || !f) return null;
  const steps = route.waypoints.length;

  return (
    // Sous le bandeau boussole (34 px), au-dessus du flux caméra et du tracé
    <div style={{ position: "absolute", inset: "34px 0 0 0", zIndex: 22, pointerEvents: "none" }}>
      <div className="vn-hud">
        <ArStepCard
          modifier={f.arriving ? "arrive" : (f.nextWp?.modifier ?? "straight")}
          distanceToStep={f.distNext}
          street={f.nextWp?.streetName || undefined}
          step={Math.min(step + 1, steps)} steps={steps}
          offRoute={offRoute} recalculating={recalculating}/>

        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <PositioningBadge mode={gpsPos ? "gps" : "none"} accuracy={gpsPos?.acc ?? null}/>
          </div>
          {mode !== "walking" && weather && f.bearing != null && (
            <WindGauge windKmh={Math.round(weather.wind ?? 0)} windDir={weather.windDir ?? 0} bearing={f.bearing}/>
          )}
        </div>

        {(f.ascent != null && f.ascent >= 20 && mode !== "walking") || spatialAudio ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {f.ascent != null && f.ascent >= 20 && mode !== "walking" && (
              <Badge tone={f.recommendElectric ? "warn" : "neutral"} icon={f.recommendElectric ? "bolt" : "route"}>
                D+ {f.ascent} m{f.descent >= 20 ? ` · D− ${f.descent} m` : ""}{f.recommendElectric ? " · élec conseillé" : ""}
              </Badge>
            )}
            {spatialAudio && <Badge tone="good" icon="headphones">3D</Badge>}
          </div>
        ) : null}

        {offRoute && !recalculating && manualRecalc && (
          <div><Button size="sm" variant="tonal" icon="refresh" onClick={manualRecalc}>{t("nav.recalc_btn")}</Button></div>
        )}

        <div style={{ flex: 1, pointerEvents: "none" }}/>

        {mmSuggestion && mode === "cycling" && (
          <MultimodalSwitch value="bike" suggestion={mmSuggestion}
            onChange={v => { if (v === "transit") onMmAccept?.(); }}
            onAccept={onMmAccept} onDismiss={onMmDismiss}/>
        )}

        {predSuggestion && (
          <div className="vn-glass" role="status" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <Icon name="alert" size={20} style={{ color: "var(--vn-warn)", flexShrink: 0 }}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--vn-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {predSuggestion.station.name}
                </div>
                <div style={{ fontSize: 12, color: "var(--vn-text2)" }}>
                  {predSuggestion.reason} · {predSuggestion.detourMeters > 0 ? "+" : ""}{fmtDist(predSuggestion.detourMeters)} ·{" "}
                  <span className="vn-num">{predSuggestion.stockAvailable}</span> {navIntent === "dropoff" ? "bornes" : "vélos"}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button size="sm" variant="primary" icon="route" onClick={onPredAccept} style={{ flex: 2 }}>Basculer</Button>
              <Button size="sm" variant="ghost" onClick={onPredDismiss} style={{ flex: 1 }}>Ignorer</Button>
            </div>
          </div>
        )}

        <ArNavStats remainingM={f.remainingM} baseMin={f.baseMin} windFactor={f.windFactor} climbFactor={f.climbFactor}/>

        <div className="vn-glass" style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 4px 4px 12px" }}>
          <Icon name={mode === "walking" ? "walk" : "bike"} size={18} style={{ color: "var(--vn-accent)" }}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="vn-eyebrow" style={{ fontSize: 11 }}>{t("ui.nav.dest")}</div>
            <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{navStation?.name}</div>
          </div>
          <Button variant="danger" size="sm" icon="stop" onClick={onStop} style={{ minHeight: 40 }}>{t("ui.nav.stop")}</Button>
        </div>
      </div>
    </div>
  );
}
