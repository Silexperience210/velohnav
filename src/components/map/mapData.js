// ── Données carte — fonctions pures (sans maplibre, testables en node) ──
import { bCol } from "../../utils.js";

// Fond OpenFreeMap sans clé. Style « dark » (noir) dérivé ci-dessous vers
// l'identité VelohNav : noir bleuté, rues lisibles, pistes cyclables
// détachées, accent orange discret sur les grands axes.
export const OFM_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
export const STYLE_CACHE_KEY = "velohnav_mapStyle_v1";

// Peintures remplacées : { layerId: { prop: valeur } }
const THEME_PAINT = {
  background:              { "background-color": "#080c0f" },
  water:                   { "fill-color": "#0a1822" },
  waterway:                { "line-color": "#0e2433" },
  landuse_park:            { "fill-color": "#0c1510" },
  landcover_wood:          { "fill-color": "#0c1510" },
  landuse_residential:     { "fill-color": "#0b1014" },
  building:                { "fill-color": "#0e1318", "fill-outline-color": "#181e25" },
  highway_path:            { "line-color": "#24414a" },             // chemins / pistes
  highway_minor:           { "line-color": "#1b2026" },
  highway_major_casing:    { "line-color": "rgba(92,100,112,0.55)" },
  highway_major_inner:     { "line-color": "#23282f" },
  highway_motorway_casing: { "line-color": "rgba(245,130,13,0.30)" },
  highway_motorway_inner:  { "line-color": "#2a1b0e" },
  railway_transit:         { "line-color": "#24303a" },
  railway:                 { "line-color": "#24303a" },
  highway_name_other:      { "text-color": "#6b7480" },
  place_other:             { "text-color": "#8a94a6" },
  place_suburb:            { "text-color": "#8a94a6" },
  place_village:           { "text-color": "#8a94a6" },
  place_town:              { "text-color": "#a0a9b8" },
  place_city:              { "text-color": "#c0c7d2" },
};

/** Applique le thème VelohNav à un style MapLibre (copie, original intact). */
export function themeDarkStyle(style) {
  if (!style || !Array.isArray(style.layers)) return style;
  return {
    ...style,
    layers: style.layers.map(l => {
      if (!THEME_PAINT[l.id]) return l;
      const paint = { ...(l.paint || {}), ...THEME_PAINT[l.id] };
      // « wood-pattern » est référencé par le style dark mais absent du sprite OFM
      delete paint["fill-pattern"];
      return { ...l, paint };
    }),
  };
}

// Style minimal hors ligne (pas de tuiles) : les stations restent visibles.
export const FALLBACK_STYLE = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#080c0f" } }],
};

/** Stations → FeatureCollection (propriétés utilisées par les couches). */
export function stationsToGeoJSON(stations) {
  return {
    type: "FeatureCollection",
    features: (stations || [])
      .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng))
      .map(s => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: {
          sid:   String(s.id),
          name:  s.name,
          col:   bCol(s),
          bikes: s.bikes ?? 0,
          elec:  s.elec ?? 0,
          docks: s.docks ?? 0,
          closed: s.status === "CLOSED",
        },
      })),
  };
}

/** Coords route [{lat,lng}] → LineString GeoJSON ([lng,lat]). */
export function routeToGeoJSON(coords) {
  const pts = (coords || []).filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  return {
    type: "FeatureCollection",
    features: pts.length >= 2 ? [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: pts.map(p => [p.lng, p.lat]) },
      properties: {},
    }] : [],
  };
}

/** Emprise [[minLng,minLat],[maxLng,maxLat]] d'une liste {lat,lng}, ou null. */
export function boundsOf(points) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of points || []) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) continue;
    w = Math.min(w, p.lng); e = Math.max(e, p.lng);
    s = Math.min(s, p.lat); n = Math.max(n, p.lat);
  }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}
