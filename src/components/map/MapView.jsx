// ── MapView — carte MapLibre GL + OpenFreeMap (chargée paresseusement) ──
// Seul module qui importe maplibre-gl : MapScreen le charge via React.lazy
// pour garder la lib (et son worker) hors du bundle initial.
//
// Couches : tram T1 (tracé, arrêts, rames à leur position théorique),
// stations (cluster au dézoom, couleur = dispo, badge électrique),
// itinéraire (useRoute), position + cône de cap (useFusedHeading).
// Attribution OSM / OpenMapTiles / OpenFreeMap : fournie par la TileJSON
// OpenFreeMap, affichée en permanence (non repliée — exigence OSM).

import { useEffect, useRef, useState, useCallback } from "react";
import { Map as MlMap, Marker, ScaleControl, AttributionControl, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import { C, REF } from "../../constants.js";
import { color } from "../../ui/tokens.js";
import { tramLineGeoJSON, tramStopsGeoJSON, tramsGeoJSON, tramPositions } from "../../utils/tram.js";
import { t } from "../../i18n.js";
import { IconButton, Spinner } from "../../ui/primitives.jsx";
import { RecenterButton } from "../../ui/map.jsx";
import {
  OFM_STYLE_URL, STYLE_CACHE_KEY, FALLBACK_STYLE,
  themeDarkStyle, stationsToGeoJSON, routeToGeoJSON, boundsOf,
} from "./mapData.js";

setWorkerUrl(workerUrl);

const FONT = ["Noto Sans Regular"];
const ELEC_COL = "#60A5FA"; // même bleu que la colonne ⚡ de la fiche station
const EMPTY_FC = { type: "FeatureCollection", features: [] };
const TRAM_COL = color.transit;
const TRAM_LAYERS = ["tram-line-casing", "tram-line", "tram-stop", "tram-stop-hit", "tram-sel", "tram-stop-label", "tram-veh-halo", "tram-veh", "tram-veh-arrow"];
const TRAM_TICK = 1000; // rames : une position par seconde (~6 m à 20 km/h)

// Flèche de cap des rames : image RGBA calculée (pas de canvas, pas de sprite
// réseau), suréchantillonnée 4×4 pour des bords nets. Pointe vers le nord.
function arrowImage(size = 32) {
  const data = new Uint8Array(size * size * 4);
  const tri = (p, a, b, c) => {
    const s = (u, v, w) => (u[0] - w[0]) * (v[1] - w[1]) - (v[0] - w[0]) * (u[1] - w[1]);
    const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const k = size / 32;
  const tip = [16 * k, 8 * k], l = [10 * k, 23 * k], notch = [16 * k, 19.5 * k], r = [22 * k, 23 * k];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let hit = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const p = [x + (sx + 0.5) / 4, y + (sy + 0.5) / 4];
      if (tri(p, tip, l, notch) || tri(p, tip, notch, r)) hit++;
    }
    const i = (y * size + x) * 4;
    data[i] = 7; data[i + 1] = 9; data[i + 2] = 11; data[i + 3] = Math.round(hit / 16 * 255);
  }
  return { width: size, height: size, data };
}

// Style : réseau → cache localStorage → style minimal (stations seules)
async function loadStyle() {
  try {
    const r = await fetch(OFM_STYLE_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const style = themeDarkStyle(await r.json());
    try { localStorage.setItem(STYLE_CACHE_KEY, JSON.stringify(style)); } catch {}
    return style;
  } catch (e) {
    console.warn("[Map] style OpenFreeMap:", e?.message || e);
    try {
      const cached = localStorage.getItem(STYLE_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch {}
    return FALLBACK_STYLE;
  }
}

function addLayers(map) {
  // Tram T1 : sous l'itinéraire et les stations (les stations restent prioritaires au toucher)
  map.addSource("tram-line", { type: "geojson", data: tramLineGeoJSON() });
  map.addLayer({ id: "tram-line-casing", type: "line", source: "tram-line",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": C.bg, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 8] } });
  map.addLayer({ id: "tram-line", type: "line", source: "tram-line",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": TRAM_COL, "line-opacity": 0.75,
             "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 16, 4] } });

  map.addSource("route", { type: "geojson", data: EMPTY_FC });
  map.addLayer({ id: "route-casing", type: "line", source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#000", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 6, 17, 12], "line-opacity": 0.8 } });
  map.addLayer({ id: "route-line", type: "line", source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": C.accent, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 17, 7] } });

  map.addSource("tram-stops", { type: "geojson", data: tramStopsGeoJSON() });
  map.addLayer({ id: "tram-stop", type: "circle", source: "tram-stops", minzoom: 11,
    paint: { "circle-color": C.bg, "circle-stroke-color": TRAM_COL,
             "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 16, 5],
             "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 16, 2.5] } });
  // Zone de toucher élargie (invisible) : un arrêt de 5 px ne se vise pas au doigt
  map.addLayer({ id: "tram-stop-hit", type: "circle", source: "tram-stops", minzoom: 12,
    paint: { "circle-radius": 16, "circle-opacity": 0 } });
  map.addLayer({ id: "tram-sel", type: "circle", source: "tram-stops", filter: ["==", ["get", "idx"], -1],
    paint: { "circle-radius": 13, "circle-color": TRAM_COL, "circle-opacity": 0.2,
             "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  map.addLayer({ id: "tram-stop-label", type: "symbol", source: "tram-stops", minzoom: 14,
    layout: { "text-field": ["get", "name"], "text-font": FONT, "text-size": 10, "text-anchor": "left",
              "text-offset": [0.9, 0], "text-optional": true, "text-max-width": 8 },
    paint: { "text-color": "#C4B5FD", "text-halo-color": C.bg, "text-halo-width": 1.5 } });

  map.addSource("trams", { type: "geojson", data: EMPTY_FC });
  map.addImage("tram-arrow", arrowImage(32), { pixelRatio: 2 });
  // Rame : pastille pleine + halo (un arrêt est un anneau creux), flèche de cap dès le zoom quartier
  map.addLayer({ id: "tram-veh-halo", type: "circle", source: "trams",
    paint: { "circle-color": TRAM_COL, "circle-opacity": 0.22, "circle-blur": 0.4,
             "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 8, 15, 15, 17, 18] } });
  map.addLayer({ id: "tram-veh", type: "circle", source: "trams",
    paint: { "circle-color": TRAM_COL, "circle-stroke-color": C.bg, "circle-stroke-width": 1.5,
             "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 5, 13, 7, 15, 9, 17, 11] } });
  map.addLayer({ id: "tram-veh-arrow", type: "symbol", source: "trams", minzoom: 12.5,
    layout: { "icon-image": "tram-arrow", "icon-rotate": ["get", "bearing"],
              "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true,
              "icon-size": ["interpolate", ["linear"], ["zoom"], 12.5, 0.75, 15, 1.05, 17, 1.25] } });

  map.addSource("stations", {
    type: "geojson", data: EMPTY_FC,
    cluster: true, clusterMaxZoom: 13, clusterRadius: 44,
    clusterProperties: { bikes: ["+", ["get", "bikes"]] },
  });
  const isCluster = ["has", "point_count"];
  const notCluster = ["!", ["has", "point_count"]];

  // Clusters : disque sombre cerclé orange, nombre de stations
  map.addLayer({ id: "st-cluster", type: "circle", source: "stations", filter: isCluster,
    paint: {
      "circle-color": "rgba(8,12,15,0.92)",
      "circle-stroke-color": C.accent, "circle-stroke-width": 1.5,
      "circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 30, 23],
    } });
  map.addLayer({ id: "st-cluster-n", type: "symbol", source: "stations", filter: isCluster,
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": FONT, "text-size": 11,
              "text-allow-overlap": true },
    paint: { "text-color": C.text } });

  // Halo de sélection (filtre mis à jour via setFilter)
  map.addLayer({ id: "st-sel", type: "circle", source: "stations",
    filter: ["all", notCluster, ["==", ["get", "sid"], ""]],
    paint: { "circle-radius": 16, "circle-color": ["get", "col"], "circle-opacity": 0.22,
             "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });

  // Stations : couleur = convention bCol (vert/orange/rouge/gris)
  map.addLayer({ id: "st-point", type: "circle", source: "stations", filter: notCluster,
    paint: {
      "circle-color": ["get", "col"],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 4, 14, 7, 17, 10],
      "circle-stroke-color": C.bg, "circle-stroke-width": 1.5,
      "circle-opacity": ["case", ["get", "closed"], 0.6, 1],
    } });

  // Badge électrique : pastille bleue + nombre de VAE, en haut à droite
  map.addLayer({ id: "st-elec", type: "circle", source: "stations", minzoom: 14,
    filter: ["all", notCluster, [">", ["get", "elec"], 0]],
    paint: { "circle-radius": 6, "circle-color": ELEC_COL, "circle-translate": [8, -8],
             "circle-stroke-color": C.bg, "circle-stroke-width": 1 } });
  map.addLayer({ id: "st-elec-n", type: "symbol", source: "stations", minzoom: 14,
    filter: ["all", notCluster, [">", ["get", "elec"], 0]],
    layout: { "text-field": ["to-string", ["get", "elec"]], "text-font": FONT, "text-size": 8,
              "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": C.bg, "text-translate": [8, -8] } });

  // Noms au zoom rue
  map.addLayer({ id: "st-label", type: "symbol", source: "stations", minzoom: 15, filter: notCluster,
    layout: { "text-field": ["get", "name"], "text-font": FONT, "text-size": 10,
              "text-anchor": "top", "text-offset": [0, 1.1], "text-optional": true, "text-max-width": 9 },
    paint: { "text-color": C.text, "text-halo-color": C.bg, "text-halo-width": 1.5 } });
}

// Pastille utilisateur + cône de cap (SVG), orienté via Marker.setRotation
function createUserEl() {
  const el = document.createElement("div");
  el.style.cssText = "width:64px;height:64px;pointer-events:none";
  el.innerHTML = `
    <svg width="64" height="64" viewBox="0 0 64 64">
      <defs><radialGradient id="vnCone" cx="32" cy="32" r="30" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${C.blue}" stop-opacity="0.75"/>
        <stop offset="1" stop-color="${C.blue}" stop-opacity="0"/>
      </radialGradient></defs>
      <path data-cone d="M32 32 L19 4 A30 30 0 0 1 45 4 Z" fill="url(#vnCone)" style="display:none"/>
      <circle cx="32" cy="32" r="11" fill="${C.blue}" fill-opacity="0.15"/>
      <circle cx="32" cy="32" r="6" fill="${C.blue}" stroke="#fff" stroke-width="2"/>
    </svg>`;
  return el;
}

export default function MapView({ stations, selId, onSelect, gpsPos, heading, routeCoords, routeKey,
                                  showTram = true, tramSel = null, onSelectTramStop, onToggleTram }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const userMarkerRef = useRef(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  const onTramRef = useRef(onSelectTramStop);
  useEffect(() => { onTramRef.current = onSelectTramStop; }, [onSelectTramStop]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [bearing, setBearing] = useState(0);
  const initialCenterRef = useRef(gpsPos ? [gpsPos.lng, gpsPos.lat] : null);
  const initialStationsRef = useRef(stations);

  // ── Création / destruction ─────────────────────────────────────
  useEffect(() => {
    let map = null, ro = null, dead = false;
    loadStyle().then(style => {
      if (dead || !containerRef.current) return;
      try {
        const c = initialCenterRef.current;
        map = new MlMap({
          container: containerRef.current,
          style,
          center: c ?? [REF.lng, REF.lat],
          zoom: c ? 15 : 12.5,
          minZoom: 9, maxZoom: 19,
          maxBounds: [[5.4, 49.3], [6.8, 50.3]], // Grand-Duché + marge
          attributionControl: false,
          dragRotate: true, pitchWithRotate: false,
        });
      } catch (e) {
        console.warn("[Map] init (WebGL ?):", e?.message || e);
        setFailed(true);
        return;
      }
      mapRef.current = map;
      map.addControl(new AttributionControl({ compact: false }), "bottom-right");
      map.addControl(new ScaleControl({ unit: "metric", maxWidth: 90 }), "bottom-left");
      map.on("error", e => console.warn("[Map]", e?.error?.message || e));
      map.on("rotate", () => setBearing(map.getBearing()));

      map.on("load", () => {
        addLayers(map);
        // Sans GPS : cadrer l'ensemble des stations
        if (!initialCenterRef.current) {
          const b = boundsOf(initialStationsRef.current);
          if (b) map.fitBounds(b, { padding: 30, duration: 0, maxZoom: 14 });
        }
        setReady(true);
      });

      map.on("click", "st-point", e => {
        const f = e.features?.[0];
        if (f) { e.originalEvent?.stopPropagation?.(); onSelectRef.current?.(f.properties.sid); }
      });
      map.on("click", "st-cluster", async e => {
        const f = e.features?.[0];
        if (!f) return;
        try {
          const z = await map.getSource("stations").getClusterExpansionZoom(f.properties.cluster_id);
          map.easeTo({ center: f.geometry.coordinates, zoom: z + 0.3 });
        } catch {}
      });
      map.on("click", "tram-stop-hit", e => {
        // Une station sous le doigt reste prioritaire (Hamilius, Gare…)
        if (map.queryRenderedFeatures(e.point, { layers: ["st-point", "st-cluster"] }).length) return;
        const f = e.features?.[0];
        if (f) onTramRef.current?.(f.properties.idx);
      });
      map.on("click", e => {
        const hit = map.queryRenderedFeatures(e.point, { layers: ["st-point", "st-cluster", "tram-stop-hit"] });
        if (!hit.length) onSelectRef.current?.(null);
      });
      for (const id of ["st-point", "st-cluster", "tram-stop-hit"]) {
        map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
      }

      // La fiche station change la hauteur du conteneur → resize
      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => map.resize());
        ro.observe(containerRef.current);
      }
    });
    return () => {
      dead = true;
      ro?.disconnect();
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Stations ───────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    mapRef.current?.getSource("stations")?.setData(stationsToGeoJSON(stations));
  }, [ready, stations]);

  // ── Sélection : halo + recentrage si hors écran ────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const sid = selId == null ? "" : String(selId);
    map.setFilter("st-sel", ["all", ["!", ["has", "point_count"]], ["==", ["get", "sid"], sid]]);
    if (!sid) return;
    const s = stations.find(x => String(x.id) === sid);
    if (!s) return;
    const b = map.getBounds();
    if (!b.contains([s.lng, s.lat]) || map.getZoom() < 13.5) {
      map.easeTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 15) });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selId]);

  // ── Tram : visibilité, arrêt sélectionné, rames animées ────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    for (const id of TRAM_LAYERS) map.setLayoutProperty(id, "visibility", showTram ? "visible" : "none");
    if (!showTram) return;
    const src = map.getSource("trams");
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      src?.setData(tramsGeoJSON(tramPositions()));
    };
    tick();
    const id = setInterval(tick, TRAM_TICK);
    return () => clearInterval(id);
  }, [ready, showTram]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setFilter("tram-sel", ["==", ["get", "idx"], tramSel ?? -1]);
  }, [ready, tramSel]);

  // ── Itinéraire : tracé + cadrage une fois par nouvel itinéraire ─
  const framedRouteRef = useRef(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.getSource("route")?.setData(routeToGeoJSON(routeCoords));
    if (routeCoords?.length >= 2 && framedRouteRef.current !== routeKey) {
      framedRouteRef.current = routeKey;
      const b = boundsOf(routeCoords);
      if (b) map.fitBounds(b, { padding: { top: 40, bottom: 40, left: 40, right: 60 }, maxZoom: 16 });
    }
    if (!routeCoords?.length) framedRouteRef.current = null;
  }, [ready, routeCoords, routeKey]);

  // ── Position utilisateur + cône de cap ─────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (!gpsPos) { userMarkerRef.current?.remove(); userMarkerRef.current = null; return; }
    if (!userMarkerRef.current) {
      userMarkerRef.current = new Marker({
        element: createUserEl(), rotationAlignment: "map", pitchAlignment: "map",
      }).setLngLat([gpsPos.lng, gpsPos.lat]).addTo(map);
    } else {
      userMarkerRef.current.setLngLat([gpsPos.lng, gpsPos.lat]);
    }
  }, [ready, gpsPos?.lat, gpsPos?.lng]);

  useEffect(() => {
    const m = userMarkerRef.current;
    if (!m) return;
    const cone = m.getElement().querySelector("[data-cone]");
    if (heading == null) { cone.style.display = "none"; return; }
    cone.style.display = "";
    m.setRotation(heading);
  }, [heading, ready, gpsPos?.lat, gpsPos?.lng]);

  // ── Commandes ──────────────────────────────────────────────────
  const recenter = useCallback(() => {
    const map = mapRef.current;
    if (!map || !gpsPos) return;
    map.easeTo({ center: [gpsPos.lng, gpsPos.lat], zoom: Math.max(map.getZoom(), 15.5), bearing: 0 });
  }, [gpsPos]);
  const zoomBy = d => mapRef.current?.easeTo({ zoom: mapRef.current.getZoom() + d });
  const resetNorth = () => mapRef.current?.easeTo({ bearing: 0, pitch: 0 });

  if (failed) return (
    <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center",
      color:"var(--vn-text2)", fontSize:13, textAlign:"center", padding:20 }}>
      {t("ui.map.webgl")}
    </div>
  );

  return (
    <>
      <style>{`
        .vn-map .maplibregl-ctrl-attrib { background: rgba(7,9,11,0.82); color: var(--vn-text3);
          font: 10px var(--vn-font); padding: 1px 6px; border-radius: 4px 0 0 0; }
        .vn-map .maplibregl-ctrl-attrib a { color: var(--vn-text2); }
        .vn-map .maplibregl-ctrl-scale { background: rgba(7,9,11,0.7); color: var(--vn-text);
          border-color: var(--vn-text3); font: 10px var(--vn-font); }
      `}</style>
      <div ref={containerRef} className="vn-map" style={{ position:"absolute", inset:0 }}/>
      {!ready && (
        <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", gap:8,
          pointerEvents:"none", color:"var(--vn-text2)", fontSize:12 }}>
          <Spinner/> {t("ui.map.loading")}
        </div>
      )}
      <div style={{ position:"absolute", right:10, top:10, zIndex:5, display:"flex", flexDirection:"column", gap:6 }}>
        <IconButton icon="plus" label={t("ui.map.zoom_in")} onClick={() => zoomBy(1)} className="vn-iconbtn--filled"/>
        <IconButton icon="minus" label={t("ui.map.zoom_out")} onClick={() => zoomBy(-1)} className="vn-iconbtn--filled"/>
        {onToggleTram && (
          <IconButton icon="tram" label={t("ui.tram.toggle")} pressed={showTram} onClick={onToggleTram}
            className="vn-iconbtn--filled" style={showTram ? { color: "var(--vn-transit)" } : undefined}/>
        )}
        {Math.abs(bearing) > 1 && (
          <button type="button" className="vn-iconbtn vn-iconbtn--filled" onClick={resetNorth} aria-label={t("ui.map.north")}
            style={{ color:"var(--vn-accent)", fontWeight:700, fontSize:13 }}>
            <span style={{ display:"inline-block", transform:`rotate(${-bearing}deg)` }}>N</span>
          </button>
        )}
      </div>
      <RecenterButton onClick={recenter} disabled={!gpsPos} style={{ position:"absolute", right:10, bottom:34, zIndex:5 }}/>
    </>
  );
}
