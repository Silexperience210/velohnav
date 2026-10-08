import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { t } from "../i18n.js";
import { nearestStop } from "../utils.js";
import { getWeatherAdvice } from "../hooks/useWeather.js";
import { useCompass } from "../hooks/useCompass.js";
import { useFusedHeading } from "../hooks/useFusedHeading.js";
import { useRoute } from "../hooks/useRoute.js";
import WeatherBanner from "./WeatherBanner.jsx";
import { MapSearchBar, MapFilterBar, NetworkSummary, MapLegend, StationSheet } from "../ui/map.jsx";
import { Badge, EmptyState, Spinner } from "../ui/primitives.jsx";
import { Icon } from "../ui/icons.jsx";
import { filterStations, filterCounts, networkTotals, fmtDist, fmtDuration } from "../ui/format.js";

// MapLibre (~1 Mo) chargé à la demande — hors du bundle initial
const MapView = lazy(() => import("./map/MapView.jsx"));

// ── MAP SCREEN ────────────────────────────────────────────────────
// Données : phase 1 (GBFS, BRouter, MapLibre). Chrome : design system src/ui (phase 2).

function MapScreen({ stations, sel, setSel, gpsPos, trip, onStartTrip, mapsKey, onTabChange, weather, lastUpdate = null }) {
  const [filter, setFilter] = useState("all"); // all | bikes | docks | elec
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState("cycling"); // cycling | walking — pour « Y aller » et AR

  // Cap fusionné (boussole + course GPS) pour le cône de la position.
  // iOS exige un geste utilisateur pour la boussole → démarrage aussi au 1er toucher.
  const { heading: magHeading, start: startCompass } = useCompass();
  const heading = useFusedHeading(magHeading, gpsPos);
  const compassStarted = useRef(false);
  const ensureCompass = useCallback(() => {
    if (compassStarted.current) return;
    compassStarted.current = true;
    startCompass();
  }, [startCompass]);
  useEffect(() => {
    if (typeof DeviceOrientationEvent?.requestPermission !== "function") ensureCompass();
  }, [ensureCompass]);

  // Aperçu d'itinéraire « Y aller » : même hook que l'AR (BRouter → OSRM → Google)
  const [routeTarget, setRouteTarget] = useState(null); // station | null
  const { route, loading: routeLoading, error: routeError } =
    useRoute(gpsPos, routeTarget, mode, mapsKey);

  // Lancer navigation AR : sélectionner la station + switcher vers l'onglet AR
  // ARScreen lit velohnav_pendingNavMode au montage pour auto-démarrer la nav
  const launchArNav = useCallback((station, navMode) => {
    setSel(station.id);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("velohnav_pendingNavMode", navMode);
      localStorage.setItem("velohnav_pendingNavId", String(station.id));
    }
    onTabChange?.("ar");
  }, [setSel, onTabChange]);

  // Stations filtrées pour affichage (recherche insensible aux accents)
  const displayed = useMemo(() => filterStations(stations, filter, search), [stations, filter, search]);
  const counts = useMemo(() => filterCounts(stations), [stations]);
  const totals = useMemo(() => networkTotals(stations), [stations]);

  // Tap sur la carte : id string (GeoJSON) → id station d'origine
  const onSelect = useCallback(sid => {
    if (sid == null) { setSel(null); return; }
    const s = stations.find(x => String(x.id) === sid);
    setSel(s ? s.id : null);
  }, [stations, setSel]);

  const selStation = stations.find(s => s.id === sel) ?? null;

  // Changer de station / fermer la fiche annule l'aperçu d'itinéraire
  useEffect(() => {
    if (routeTarget && routeTarget.id !== sel) setRouteTarget(null);
  }, [sel, routeTarget]);

  if (!stations.length) return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--vn-text2)", fontSize: 13 }}>
      <Spinner/> {t("ui.map.loading")}
    </div>
  );

  const routeShown = routeTarget && route && routeTarget.id === sel;
  const routeActive = !!(selStation && routeTarget?.id === selStation.id);

  return (
    <div className="vn-mapscreen" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, position: "relative" }}>

      {/* ── Recherche + filtres + totaux ───────────────────── */}
      <div style={{ padding: "8px 12px 6px", display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
        <MapSearchBar value={search} onChange={setSearch} resultCount={search.trim() ? displayed.length : null}/>
        <MapFilterBar value={filter} onChange={setFilter} counts={counts}/>
        <NetworkSummary totals={totals} lastUpdate={lastUpdate}/>
      </div>

      {/* ── Carte MapLibre ───────────────────────────────── */}
      <div onPointerDown={ensureCompass} className="vn-mapframe"
        style={{ flex: 1, position: "relative", margin: "0 12px", minHeight: 160,
          border: "1px solid var(--vn-border)", borderRadius: "var(--vn-r-lg, 14px)", overflow: "hidden", background: "#0b0d10" }}>
        <Suspense fallback={
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            color: "var(--vn-text2)", fontSize: 12 }}><Spinner/> {t("ui.map.loading")}</div>
        }>
          <MapView stations={displayed} selId={sel} onSelect={onSelect}
            gpsPos={gpsPos} heading={heading}
            routeCoords={routeShown ? route.coords : null}
            routeKey={routeShown ? `${routeTarget.id}_${route.computedAt}` : null}/>
        </Suspense>
        {displayed.length === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <div className="vn-glass" style={{ pointerEvents: "auto" }}>
              <EmptyState icon="search" title={t("ui.map.no_result")} desc={t("ui.map.no_result_desc")}/>
            </div>
          </div>
        )}
      </div>

      {/* ── Fiche station (bottom-sheet inline) ou légende ── */}
      {selStation ? (
        <StationSheet inline station={selStation} mode={mode} onModeChange={setMode}
          onClose={() => setSel(null)}
          onGo={s => { if (gpsPos) setRouteTarget(routeActive ? null : s); }}
          onAR={(s, m) => launchArNav(s, m)}
          onStartTrip={!trip && onStartTrip ? onStartTrip : null}
          externalHref={null}>
          {/* Itinéraire : état du calcul + résumé */}
          {routeActive && (
            <div className="vn-glass" style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", fontSize: 12 }}>
              <Icon name="route" size={16} style={{ color: "var(--vn-accent)", flexShrink: 0 }}/>
              {routeLoading && !route ? <><Spinner size={14}/><span style={{ color: "var(--vn-text2)" }}>{t("ui.map.route_loading")}</span></>
               : routeError && !route ? <Badge tone="bad" icon="alert">{routeError}</Badge>
               : route ? <>
                  <b className="vn-num">{fmtDist(route.totalDist)}</b>
                  <b className="vn-num">{fmtDuration(route.totalTime / 60)}</b>
                  {route.totalAscent != null && <span className="vn-num" style={{ color: "var(--vn-text2)" }}>{t("ui.map.ascent", { m: route.totalAscent })}</span>}
                  <span style={{ marginLeft: "auto", color: "var(--vn-text3)", fontSize: 11 }}>{route.provider}</span>
                </> : null}
            </div>
          )}
          {!gpsPos && <div className="vn-field__hint" style={{ marginTop: 8 }}>{t("ui.map.gps_required")}</div>}
          {weather && (
            <WeatherBanner weather={weather} advice={getWeatherAdvice(weather)}
              nearStop={nearestStop(selStation.lat, selStation.lng)} station={selStation} style={{ marginTop: 10 }}/>
          )}
        </StationSheet>
      ) : (
        <div style={{ padding: "6px 12px 8px", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <MapLegend style={{ flex: 1 }}/>
          {weather && (() => {
            const advice = getWeatherAdvice(weather);
            const tone = advice.mode === "bike" ? "good" : advice.mode === "transit" ? "transit" : "warn";
            return <Badge tone={tone} icon="thermo"><span className="vn-num">{weather.temp}°C</span></Badge>;
          })()}
        </div>
      )}
    </div>
  );
}

export default MapScreen;
