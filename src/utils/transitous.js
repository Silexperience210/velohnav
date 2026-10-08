// ── Transitous (MOTIS 2) — transports en commun sans clé ───────────
// Remplace HAFAS ATP (clé accessId). Données officielles ATP Luxembourg
// (flux « lu-administration-des-transports-publics ») + CFL, SNCF, etc.
//
// Version d'API : /api/v6 — version courante du spec OpenAPI MOTIS
// (github.com/motis-project/motis/openapi.yaml). /api/v1 répond encore mais
// garde des sémantiques dépréciées (polylines précision 7, maxTransfers…).
//
// Politique d'usage Transitous (transitous.org/api) :
//  - User-Agent identifiant l'app + contact. En navigateur, le Referer suffit
//    (le navigateur ne laisse pas fixer User-Agent) ; en natif Capacitor,
//    fetch passe par CapacitorHttp → l'en-tête est réellement envoyé.
//  - Attribution visible : lien vers https://transitous.org/sources/
//  - Pas de polling agressif ; le routage (plan) est coûteux → à la demande.

import { fetchJSONWithRetry, isNativePlatform } from "./http.js";

export const TRANSITOUS_BASE = "https://api.transitous.org/api/v6";
export const TRANSITOUS_SOURCES_URL = "https://transitous.org/sources/";
export const APP_USER_AGENT = "VelohNav/3.3.0 (+https://github.com/Silexperience210/velohnav)";

// Préfixe des ids d'arrêts du flux officiel ATP Luxembourg
export const ATP_FEED_PREFIX = "lu-administration-des-transports-publics_";

export function transitousHeaders() {
  return isNativePlatform() ? { "User-Agent": APP_USER_AGENT } : undefined;
}

// ── Utilitaires purs ───────────────────────────────────────────────

function dist(la1, ln1, la2, ln2) {
  const R = 6371000, dL = (la2 - la1) * Math.PI / 180, dl = (ln2 - ln1) * Math.PI / 180;
  const a = Math.sin(dL / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dl / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** Polyline Google à précision variable (MOTIS v6 : 6 ; v1 : 7 ; Google : 5). */
export function decodePolyline(encoded, precision = 5) {
  const pts = [];
  if (!encoded) return pts;
  const f = 10 ** precision;
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : (result >> 1);
    pts.push({ lat: lat / f, lng: lng / f });
  }
  return pts;
}

/** Boîte englobante ~carrée autour d'un point (paramètres min/max de map/stops). */
export function bboxAround(lat, lng, radiusM) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos(lat * Math.PI / 180));
  const r = v => v.toFixed(5);
  return { min: `${r(lat - dLat)},${r(lng - dLng)}`, max: `${r(lat + dLat)},${r(lng + dLng)}` };
}

/** ISO → "HH:MM" heure locale de l'appareil (même référence que minutesUntilTime). */
export function toHHMM(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const normName = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/**
 * Réponse map/stops → arrêts proches, même contrat que l'ancien HAFAS :
 * { id, name, lat, lng, dist, modes }.
 * Le même arrêt physique apparaît dans plusieurs flux (ATP, DELFI, SNCF,
 * SNCB, Flixbus…) : si des arrêts ATP sont présents on ne garde qu'eux,
 * sinon dédoublonnage par nom.
 */
export function parseStops(list, { lat, lng }, { radius = 1500, modes = ["BUS", "TRAM"], limit = 6 } = {}) {
  if (!Array.isArray(list)) return [];
  const wanted = new Set(modes);
  let stops = list.filter(s =>
    s?.stopId && Number.isFinite(s.lat) && Number.isFinite(s.lon) &&
    (!Array.isArray(s.modes) || s.modes.some(m => wanted.has(m))));
  if (stops.some(s => s.stopId.startsWith(ATP_FEED_PREFIX))) {
    stops = stops.filter(s => s.stopId.startsWith(ATP_FEED_PREFIX));
  }
  const seen = new Set();
  return stops
    .map(s => ({ id: s.stopId, name: s.name, lat: s.lat, lng: s.lon,
                 dist: dist(lat, lng, s.lat, s.lon), modes: s.modes ?? [] }))
    .filter(s => s.dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .filter(s => { const k = normName(s.name); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, limit);
}

/**
 * Réponse stoptimes → départs, même contrat que l'ancien HAFAS
 * ({ line, direction, time, rtTime, stop, cancelled }) + mode, departureAt.
 * rtTime n'est renseigné que si MOTIS a une donnée temps réel.
 */
export function parseStopTimes(json) {
  const list = json?.stopTimes;
  if (!Array.isArray(list)) return [];
  return list.map(st => {
    const p = st.place || {};
    const sched = p.scheduledDeparture ?? p.departure ?? p.scheduledArrival ?? p.arrival;
    const real  = p.departure ?? p.arrival ?? sched;
    return {
      line:      st.routeShortName || st.displayName || "?",
      direction: st.headsign || st.tripTo?.name || "?",
      time:      toHHMM(sched) ?? "?",
      rtTime:    st.realTime ? toHHMM(real) : null,
      stop:      p.name || "?",
      cancelled: !!(st.cancelled || st.tripCancelled || p.cancelled),
      mode:      st.mode || null,
      agency:    st.agencyName || null,
      departureAt: Date.parse(real) || null,
    };
  });
}

function parsePlace(p) {
  if (!p) return null;
  return { name: p.name, lat: p.lat, lng: p.lon, stopId: p.stopId ?? null };
}

function parseLeg(l) {
  const g = l.legGeometry;
  return {
    mode:      l.mode,
    line:      l.routeShortName || l.displayName || null,
    headsign:  l.headsign || null,
    agency:    l.agencyName || null,
    duration:  l.duration ?? 0,
    distance:  Number.isFinite(l.distance) ? Math.round(l.distance) : null,
    startTime: l.startTime ?? null,
    endTime:   l.endTime ?? null,
    realTime:  !!l.realTime,
    cancelled: !!(l.cancelled || l.tripCancelled),
    from:      parsePlace(l.from),
    to:        parsePlace(l.to),
    coords:    g?.points ? decodePolyline(g.points, g.precision ?? 6) : [],
  };
}

const NON_TRANSIT = new Set(["WALK", "BIKE", "RENTAL", "CAR", "CAR_PARKING", "FLEX", "ODM"]);
export const isTransitLeg = leg => !NON_TRANSIT.has(leg.mode);

function parseItinerary(it) {
  const legs = Array.isArray(it.legs) ? it.legs.map(parseLeg) : [];
  return {
    duration:  it.duration ?? 0,
    startTime: it.startTime ?? null,
    endTime:   it.endTime ?? null,
    transfers: it.transfers ?? 0,
    legs,
    transitLegs: legs.filter(isTransitLeg).length,
  };
}

/** Réponse plan → { direct, itineraries } (itinéraires directs = sans TC). */
export function parsePlan(json) {
  return {
    direct:      Array.isArray(json?.direct) ? json.direct.map(parseItinerary) : [],
    itineraries: Array.isArray(json?.itineraries) ? json.itineraries.map(parseItinerary) : [],
  };
}

/** Résumé court d'un itinéraire : "T1" / "23 → 26". */
export function itineraryLines(it) {
  return it.legs.filter(isTransitLeg).map(l => l.line || l.mode).join(" → ");
}

// ── Fetchers ───────────────────────────────────────────────────────

const fetchOpts = () => ({ headers: transitousHeaders(), retries: 2, timeoutMs: 12000 });

export async function fetchNearbyStops(lat, lng, { radius = 1500, ...opts } = {}) {
  const { min, max } = bboxAround(lat, lng, radius);
  const json = await fetchJSONWithRetry(`${TRANSITOUS_BASE}/map/stops?min=${min}&max=${max}`, fetchOpts());
  return parseStops(json, { lat, lng }, { radius, ...opts });
}

export async function fetchStopTimes(stopId, n = 6) {
  const q = new URLSearchParams({ stopId, n: String(n), mode: "BUS,TRAM" });
  const json = await fetchJSONWithRetry(`${TRANSITOUS_BASE}/stoptimes?${q}`, fetchOpts());
  return parseStopTimes(json);
}

/**
 * Planification intermodale. Par défaut « bike & ride » : vélo jusqu'à un
 * arrêt (≤ 10 min), puis bus/tram, puis marche ; + itinéraire vélo direct
 * pour comparaison.
 */
export async function fetchPlan(from, to, {
  preTransitModes = "BIKE", postTransitModes = "WALK", directModes = "BIKE",
  transitModes = "BUS,TRAM", numItineraries = 3, maxPreTransitTime = 600,
} = {}) {
  const q = new URLSearchParams({
    fromPlace: `${from.lat.toFixed(5)},${from.lng.toFixed(5)}`,
    toPlace:   `${to.lat.toFixed(5)},${to.lng.toFixed(5)}`,
    preTransitModes, postTransitModes, directModes, transitModes,
    numItineraries: String(numItineraries),
    maxPreTransitTime: String(maxPreTransitTime),
  });
  const json = await fetchJSONWithRetry(`${TRANSITOUS_BASE}/plan?${q}`, { ...fetchOpts(), retries: 1 });
  return parsePlan(json);
}
