// ── Tram T1 — tracé, arrêts et horaires embarqués (hors ligne) ─────────
// Données : src/data/tramT1.json, extraites du GTFS officiel ATP
// (scripts/extract-tram.mjs, docs/TRAM.md). Aucun flux de positions de
// véhicules n'est publié au Luxembourg : la position affichée est déduite
// de l'horaire — théorique, déterministe, sans réseau. Les retards temps réel
// (Transitous) ne s'appliquent qu'aux départs d'un arrêt (mergeRealtime).
//
// Horloge : les heures GTFS sont celles du Luxembourg (Europe/Luxembourg),
// comptées depuis minuit du jour de service ; une course partie avant minuit
// peut afficher 24:30:00. On lit donc l'heure locale luxembourgeoise quelle
// que soit la zone du téléphone, et on regarde aussi le jour de service de la
// veille. Approximation assumée : les deux nuits de changement d'heure, les
// courses après 2 h sont décalées d'une heure.

import DATA from "../data/tramT1.json";
import { decodePolyline } from "./transitous.js";

const DAY = 86400;
const TZ = "Europe/Luxembourg";

// ── Géométrie ──────────────────────────────────────────────────────────
const R = 6371000;
const rad = d => d * Math.PI / 180;
function segLen(a, b) {
  const x = rad(b.lng - a.lng) * Math.cos(rad((a.lat + b.lat) / 2));
  const y = rad(b.lat - a.lat);
  return Math.hypot(x, y) * R;
}
function bearingOf(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function build(data) {
  const coords = decodePolyline(data.geometry, 5);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + segLen(coords[i - 1], coords[i]));
  // Les distances d'arrêt ont été calculées à l'extraction avec une projection
  // locale : on les remet à l'échelle de la longueur recalculée ici.
  const scale = cum[cum.length - 1] / (data.stops[data.stops.length - 1].d || 1);
  return {
    ...data,
    coords,
    cum,
    length: cum[cum.length - 1],
    stops: data.stops.map((s, i) => ({ ...s, idx: i, d: s.d * scale })),
    // Types de jour : deltas → heures absolues, aplaties en [profil, départ]
    dayTypes: data.dayTypes.map(dt => {
      const list = [];
      for (const p in dt) { let s = 0; for (const d of dt[p]) { s += d; list.push([Number(p), s]); } }
      return list;
    }),
    // Repli hors validité : type de jour le plus fréquent pour chaque jour de semaine
    byWeekday: weekdayModes(data),
  };
}

function weekdayModes(data) {
  const counts = Array.from({ length: 7 }, () => new Map());
  const start = ymdToUTC(data.firstDate);
  for (let i = 0; i < data.days.length; i++) {
    if (data.days[i] === "-") continue;
    const wd = new Date(start + i * DAY * 1000).getUTCDay();
    const k = parseInt(data.days[i], 36);
    counts[wd].set(k, (counts[wd].get(k) || 0) + 1);
  }
  return counts.map(m => [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null);
}

const ymdToUTC = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const utcToYmd = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

export const TRAM = build(DATA);

/** Date de fin de validité des horaires embarqués (YYYYMMDD, inclus). */
export const TRAM_VALID_UNTIL = utcToYmd(ymdToUTC(TRAM.firstDate) + (TRAM.days.length - 1) * DAY * 1000);

/** Point et cap à la distance `d` (m) le long du tracé. */
export function pointAt(d, tram = TRAM) {
  const { coords, cum } = tram;
  const x = Math.max(0, Math.min(tram.length, d));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= x) lo = m; else hi = m; }
  const a = coords[lo], b = coords[hi], L = cum[hi] - cum[lo];
  const u = L > 0 ? (x - cum[lo]) / L : 0;
  return { lat: a.lat + (b.lat - a.lat) * u, lng: a.lng + (b.lng - a.lng) * u, bearing: bearingOf(a, b) };
}

// ── Horloge luxembourgeoise ────────────────────────────────────────────
let fmt = null;
/** Date → { ymd: "20261008", sec: secondes depuis minuit, heure de Luxembourg }. */
export function luxClock(date = new Date()) {
  fmt ||= new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return { ymd: `${p.year}${p.month}${p.day}`, sec: +p.hour * 3600 + +p.minute * 60 + +p.second };
}

const prevYmd = ymd => utcToYmd(ymdToUTC(ymd) - DAY * 1000);

/**
 * Courses d'un jour de service.
 * → { trips: [[profil, départ s]], estimated } — estimated : date hors de la
 *   période publiée, horaire déduit du jour de semaine habituel.
 */
export function serviceDay(ymd, tram = TRAM) {
  const i = Math.round((ymdToUTC(ymd) - ymdToUTC(tram.firstDate)) / (DAY * 1000));
  if (i >= 0 && i < tram.days.length) {
    const c = tram.days[i];
    return { trips: c === "-" ? [] : tram.dayTypes[parseInt(c, 36)], estimated: false };
  }
  const k = tram.byWeekday[new Date(ymdToUTC(ymd)).getUTCDay()];
  return { trips: k == null ? [] : tram.dayTypes[k], estimated: true };
}

// Jour de service courant et veille, avec l'heure exprimée dans chacun
function serviceWindows(date, tram) {
  const { ymd, sec } = luxClock(date);
  const today = serviceDay(ymd, tram), yest = serviceDay(prevYmd(ymd), tram);
  return {
    sec, estimated: today.estimated,
    windows: [{ trips: yest.trips, t: sec + DAY }, { trips: today.trips, t: sec }],
  };
}

/**
 * Position théorique d'une course à `rel` secondes de son départ, ou null.
 * Arrêt à quai entre arrivée et départ, puis progression linéaire jusqu'à
 * l'arrêt suivant (accélérations ignorées).
 */
export function tripPosition(profile, rel, tram = TRAM) {
  const { arr, dep, stops } = profile;
  const n = stops.length;
  if (!(rel >= 0) || rel > arr[n - 1]) return null;
  for (let i = 0; i < n - 1; i++) {
    if (rel < arr[i + 1]) {
      const a = tram.stops[stops[i]].d, b = tram.stops[stops[i + 1]].d;
      const span = arr[i + 1] - dep[i];
      const u = rel <= dep[i] || span <= 0 ? 0 : (rel - dep[i]) / span;
      const p = pointAt(a + (b - a) * u, tram);
      return { ...p, bearing: b >= a ? p.bearing : (p.bearing + 180) % 360,
               atStop: u === 0 ? stops[i] : null, next: stops[i + 1] };
    }
  }
  const p = pointAt(tram.stops[stops[n - 1]].d, tram);
  return { ...p, atStop: stops[n - 1], next: null };
}

/** Trams en circulation à l'instant `date` (position théorique). */
export function tramPositions(date = new Date(), tram = TRAM) {
  const { windows, estimated } = serviceWindows(date, tram);
  const out = [];
  for (const [w, { trips, t }] of windows.entries()) {
    for (const [p, start] of trips) {
      const prof = tram.profiles[p];
      if (t < start || t > start + prof.arr[prof.arr.length - 1]) continue;
      const pos = tripPosition(prof, t - start, tram);
      if (pos) out.push({ id: `${w}_${p}_${start}`, dir: prof.dir, headsign: prof.headsign, estimated, ...pos });
    }
  }
  return out;
}

const hhmm = s => {
  const m = Math.floor(((s % DAY) + DAY) % DAY / 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/**
 * Prochains départs théoriques d'un arrêt, par direction.
 * → { estimated, dirs: { 0: [...], 1: [...] } }, chaque départ :
 *   { time: "HH:MM", min: minutes d'attente (≥ 0), headsign }
 * Un terminus n'a pas de départ dans la direction qui s'y arrête.
 */
export function nextDepartures(stopIdx, date = new Date(), { limit = 3, horizon = 2 * 3600 } = {}, tram = TRAM) {
  const { windows, estimated } = serviceWindows(date, tram);
  const dirs = { 0: [], 1: [] };
  for (const { trips, t } of windows) {
    for (const [p, start] of trips) {
      const prof = tram.profiles[p];
      const k = prof.stops.indexOf(stopIdx);
      if (k < 0 || k === prof.stops.length - 1) continue;
      const at = start + prof.dep[k];
      if (at < t - 30 || at > t + horizon) continue; // départ de la minute en cours encore affiché
      dirs[prof.dir].push({ at, time: hhmm(at), min: Math.max(0, Math.round((at - t) / 60)), headsign: prof.headsign });
    }
  }
  for (const d of [0, 1]) dirs[d] = dirs[d].sort((a, b) => a.at - b.at).slice(0, limit).map(({ at, ...x }) => x);
  return { estimated, dirs };
}

// ── Temps réel (Transitous) ────────────────────────────────────────────
const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\(tram\)/g, "").replace(/\s+/g, " ").trim();
const toMin = s => { const m = /^(\d\d):(\d\d)$/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : null; };

/**
 * Applique aux départs théoriques les retards et suppressions connus.
 * rt : sortie de transitous.parseStopTimes ({ line, direction, time, rtTime, cancelled }).
 * Appariement : ligne T1, même heure prévue, même destination si les deux en ont une.
 * Ajoute { delay: minutes | null, cancelled, live } ; sans donnée, rien ne change.
 */
export function mergeRealtime(deps, rt) {
  const pool = (rt || []).filter(r => r.line === TRAM.line);
  return deps.map(d => {
    const i = pool.findIndex(r => r.time === d.time &&
      (!r.direction || !d.headsign || norm(r.direction) === norm(d.headsign)));
    if (i < 0) return d;
    const [r] = pool.splice(i, 1);
    let delay = null;
    if (r.rtTime) {
      const a = toMin(r.time), b = toMin(r.rtTime);
      if (a != null && b != null) delay = ((b - a + 720 + 1440) % 1440) - 720; // passage de minuit
    }
    return { ...d, live: !!r.rtTime || r.cancelled, delay, cancelled: !!r.cancelled,
             min: delay ? Math.max(0, d.min + delay) : d.min };
  });
}

// ── GeoJSON pour la carte ──────────────────────────────────────────────
export function tramLineGeoJSON(tram = TRAM) {
  return { type: "FeatureCollection", features: [{
    type: "Feature", properties: {},
    geometry: { type: "LineString", coordinates: tram.coords.map(p => [p.lng, p.lat]) },
  }] };
}

/** Nom court d'arrêt : sans quartier ni « (Tram) » — « Kirchberg, Coque » → « Coque ». */
export function shortStopName(name) {
  const s = String(name).replace(/\s*\(Tram\)\s*$/i, "");
  const i = s.indexOf(", ");
  return i > 0 ? s.slice(i + 2) : s;
}

export function tramStopsGeoJSON(tram = TRAM) {
  return { type: "FeatureCollection", features: tram.stops.map(s => ({
    type: "Feature", geometry: { type: "Point", coordinates: [s.lng, s.lat] },
    properties: { idx: s.idx, name: shortStopName(s.name) },
  })) };
}

export function tramsGeoJSON(positions) {
  return { type: "FeatureCollection", features: positions.map(p => ({
    type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    properties: { id: p.id, bearing: Math.round(p.bearing), dir: p.dir },
  })) };
}

/** Terminus de ligne par direction (0 : vers Stadion, 1 : vers Findel). */
export const TRAM_TERMINI = { 0: TRAM.stops[TRAM.stops.length - 1].name, 1: TRAM.stops[0].name };

/** Arrêts T1 au format historique TRANSIT_STOPS ({ id, name, lat, lng, lines }). */
export const TRAM_STOPS = TRAM.stops.map(s => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, type: "tram", lines: [TRAM.line] }));
