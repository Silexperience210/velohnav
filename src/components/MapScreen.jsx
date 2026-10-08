import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { t } from "../i18n.js";
import { nearestStop } from "../utils.js";
import { getWeatherAdvice } from "../hooks/useWeather.js";
import { useCompass } from "../hooks/useCompass.js";
import { useFusedHeading } from "../hooks/useFusedHeading.js";
import { useRoute } from "../hooks/useRoute.js";
import { useTramDepartures } from "../hooks/useTramDepartures.js";
import { TRAM, TRAM_VALID_UNTIL, shortStopName } from "../utils/tram.js";
import { haversine } from "../utils/geo.js";
import WeatherBanner from "./WeatherBanner.jsx";
import { MapSearchBar, MapFilterBar, NetworkSummary, MapLegend, StationSheet, TramStopSheet } from "../ui/map.jsx";
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

  // Tram T1 : couche affichable/masquable (mémorisée), un arrêt sélectionnable.
  // Une seule fiche à la fois : choisir un arrêt ferme la station, et l'inverse.
  const [showTram, setShowTram] = useState(() => {
    try { return localStorage.getItem("velohnav_showTram") !== "0"; } catch { return true; }
  });
  const toggleTram = useCallback(() => setShowTram(v => {
    try { localStorage.setItem("velohnav_showTram", v ? "0" : "1"); } catch {}
    return !v;
  }), []);
  const [tramSel, setTramSel] = useState(null); // indice d'arrêt | null
  const tramStop = tramSel != null ? TRAM.stops[tramSel] : null;
  const tramDeps = useTramDepartures(tramSel);
  const selectTramStop = useCallback(idx => { setSel(null); setTramSel(idx); }, [setSel]);
  useEffect(() => { if (sel != null) setTramSel(null); }, [sel]);
  useEffect(() => { if (!showTram) setTramSel(null); }, [showTram]);

  // Aperçu d'itinéraire « Y aller » : même hook que l'AR (BRouter → OSRM → Google).
  // Vers un arrêt de tram, on marche.
  const [routeTarget, setRouteTarget] = useState(null); // station | arrêt T1 | null
  const { route, loading: routeLoading, error: routeError } =
    useRoute(gpsPos, routeTarget, routeTarget?.tram ? "walking" : mode, mapsKey);

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
    if (sid == null) { setSel(null); setTramSel(null); return; }
    const s = stations.find(x => String(x.id) === sid);
    setSel(s ? s.id : null);
  }, [stations, setSel]);

  const selStation = stations.find(s => s.id === sel) ?? null;

  // Changer de station ou d'arrêt / fermer la fiche annule l'aperçu d'itinéraire
  const focusId = sel ?? tramStop?.id ?? null;
  useEffect(() => {
    if (routeTarget && routeTarget.id !== focusId) setRouteTarget(null);
  }, [focusId, routeTarget]);

  if (!stations.length) return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--vn-text2)", fontSize: 13 }}>
      <Spinner/> {t("ui.map.loading")}
    </div>
  );

  const routeShown = routeTarget && route && routeTarget.id === focusId;
  const routeActive = !!(focusId != null && routeTarget?.id === focusId);

  // Itinéraire : état du calcul + résumé (fiche station ou arrêt)
  const routeSummary = routeActive && (
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
  );

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
            routeKey={routeShown ? `${routeTarget.id}_${route.computedAt}` : null}
            showTram={showTram} tramSel={tramSel} onSelectTramStop={selectTramStop} onToggleTram={toggleTram}/>
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
          {routeSummary}
          {!gpsPos && <div className="vn-field__hint" style={{ marginTop: 8 }}>{t("ui.map.gps_required")}</div>}
          {weather && (
            <WeatherBanner weather={weather} advice={getWeatherAdvice(weather)}
              nearStop={nearestStop(selStation.lat, selStation.lng)} station={selStation} style={{ marginTop: 10 }}/>
          )}
        </StationSheet>
      ) : tramStop && tramDeps ? (
        <TramStopSheet inline stop={{ ...tramStop, short: shortStopName(tramStop.name) }} deps={tramDeps}
          dist={gpsPos ? haversine(gpsPos.lat, gpsPos.lng, tramStop.lat, tramStop.lng) : null} validUntil={TRAM_VALID_UNTIL}
          onClose={() => setTramSel(null)}
          onGo={gpsPos ? () => setRouteTarget(routeActive ? null : { id: tramStop.id, name: tramStop.name, lat: tramStop.lat, lng: tramStop.lng, tram: true }) : null}>
          {routeSummary}
        </TramStopSheet>
      ) : (
        <div style={{ padding: "6px 12px 8px", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <MapLegend style={{ flex: 1 }} tram={showTram}/>
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
