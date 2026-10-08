// ── Logique pure de présentation (testée sans DOM) ──────────────────
// Aucune dépendance React. Tolère les deux formes de station : l'actuelle
// (JCDecaux : bikes/elec/meca/docks/cap) et celle attendue de la phase 1
// (GBFS : ebikes / docks / capacity…) — voir docs/UI-V4-INTEGRATION.md.
import { t, getCurrentLang } from "../i18n.js";

const nf = (opts) => new Intl.NumberFormat(getCurrentLang() === "en" ? "en-GB" : "fr-FR", opts);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

// ── Distances / durées ───────────────────────────────────────────────
/** 380 → "380 m" ; 1240 → "1,2 km" (fr) / "1.2 km" (en) ; null → "—" */
export function fmtDist(m) {
  if (m === null || m === undefined || !Number.isFinite(+m)) return "—";
  if (m < 1000) return `${Math.round(m / 10) * 10 || Math.round(m)} m`;
  return `${nf({ maximumFractionDigits: m < 10000 ? 1 : 0 }).format(m / 1000)} km`;
}

/** Minutes → "4 min" ; 65 → "1 h 05" ; < 1 → "< 1 min" */
export function fmtDuration(min) {
  if (min === null || min === undefined || !Number.isFinite(+min)) return "—";
  const m = Math.round(min);
  if (min > 0 && m < 1) return "< 1 min";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/** Temps de marche (80 m/min, cohérent avec utils.fWalk). */
export const walkMinutes = m => (m === null || m === undefined ? null : Math.max(1, Math.ceil(m / 80)));

/** Horodatage → "à l'instant" / "il y a 3 min" / "il y a 2 h". */
export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return t("ui.ago.never");
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return t("ui.ago.now");
  const m = Math.round(s / 60);
  if (m < 60) return t("ui.ago.min", { n: m });
  return t("ui.ago.h", { n: Math.round(m / 60) });
}

/** "14:05" (heure locale, 24 h). */
export function fmtClock(d = new Date()) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── Stations ─────────────────────────────────────────────────────────
/** Normalise une station (JCDecaux actuel ou GBFS phase 1) vers un modèle d'affichage. */
export function stationView(s) {
  if (!s) return null;
  const bikes = num(s.bikes ?? s.num_bikes_available ?? s.available);
  const elec  = num(s.elec ?? s.ebikes ?? s.electric ?? s.num_ebikes_available);
  const meca  = num(s.meca ?? s.mechanical, Math.max(0, bikes - elec));
  const docks = num(s.docks ?? s.num_docks_available ?? s.freeDocks);
  const cap   = num(s.cap ?? s.capacity, bikes + docks);
  const closed = s.status === "CLOSED" || s.is_renting === false || s.isRenting === false;
  const status = closed ? "closed" : bikes === 0 ? "empty" : bikes <= 2 ? "low" : "ok";
  return {
    id: s.id ?? s.station_id, name: s.name ?? "", lat: s.lat, lng: s.lng ?? s.lon,
    bikes, elec, meca, docks, cap, status,
    dist: s.dist ?? null,
    simulated: !!s._mock,
    updatedAt: s.updatedAt ?? s.last_reported ?? s.lastUpdate ?? null,
  };
}

export const STATUS_TONE = { ok: "good", low: "warn", empty: "bad", closed: "closed" };
export const STATUS_COLOR = { ok: "#2ECC8F", low: "#F2B33D", empty: "#F0524A", closed: "#5C6573" };
export const statusLabel = status => t(`ui.status.${status}`);

export const FILTERS = ["all", "bikes", "docks", "elec"];

/** Une station passe-t-elle le filtre ? (fermées exclues des filtres de dispo) */
export function matchesFilter(v, filter) {
  if (filter === "all") return true;
  if (v.status === "closed") return false;
  if (filter === "bikes") return v.bikes > 0;
  if (filter === "docks") return v.docks > 0;
  if (filter === "elec")  return v.elec > 0;
  return true;
}

/** Recherche insensible à la casse et aux accents ("faien" trouve "Faïencerie"). */
export const fold = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function filterStations(stations, filter = "all", query = "") {
  const q = fold(query);
  return (stations || []).filter(s => {
    const v = stationView(s);
    return matchesFilter(v, filter) && (!q || fold(v.name).includes(q));
  });
}

/** Compteurs par filtre (pour les chips). */
export function filterCounts(stations) {
  const out = { all: 0, bikes: 0, docks: 0, elec: 0 };
  for (const s of stations || []) {
    const v = stationView(s);
    for (const f of FILTERS) if (matchesFilter(v, f)) out[f]++;
  }
  return out;
}

/** Totaux réseau : vélos, dont élec, bornes libres, stations ouvertes. */
export function networkTotals(stations) {
  const tot = { stations: 0, open: 0, bikes: 0, elec: 0, docks: 0 };
  for (const s of stations || []) {
    const v = stationView(s);
    tot.stations++;
    if (v.status !== "closed") { tot.open++; tot.bikes += v.bikes; tot.elec += v.elec; tot.docks += v.docks; }
  }
  return tot;
}

// ── Vent / cap ───────────────────────────────────────────────────────
const CARD = { fr: ["N","NE","E","SE","S","SO","O","NO"], en: ["N","NE","E","SE","S","SW","W","NW"] };
export function cardinal(deg) {
  if (deg === null || deg === undefined || !Number.isFinite(+deg)) return "—";
  const list = CARD[getCurrentLang()] ?? CARD.fr;
  return list[Math.round((((+deg % 360) + 360) % 360) / 45) % 8];
}

/**
 * Angle (°) vers lequel souffle le vent, relatif au cap de déplacement.
 * 0 = vent dans le dos (pousse), 180 = vent de face. windDir = d'où vient le vent.
 */
export function windRelative(bearing, windDir) {
  if (bearing === null || bearing === undefined || windDir === null || windDir === undefined) return null;
  return (((windDir + 180 - bearing) % 360) + 360) % 360;
}

/** Composante de face (+) / de dos (−) en km/h. */
export function headwind(bearing, windDir, kmh) {
  const rel = windRelative(bearing, windDir);
  if (rel === null || !kmh) return 0;
  return Math.round(-Math.cos(rel * Math.PI / 180) * kmh);
}

/** ETA corrigée du vent : { min, deltaMin } (deltaMin > 0 = ralentissement). */
export function etaWithWind(baseMin, factor = 1) {
  if (baseMin === null || baseMin === undefined) return { min: null, deltaMin: 0 };
  const min = Math.round(baseMin * (factor || 1));
  return { min, deltaMin: min - Math.round(baseMin) };
}

// ── Navigation ───────────────────────────────────────────────────────
const MANEUVER = {
  left: "turnLeft", "slight left": "turnLeft", right: "turnRight", "slight right": "turnRight",
  "sharp left": "sharpLeft", "sharp right": "sharpRight", uturn: "uturn",
  straight: "straight", arrive: "flag",
};
/** Modificateur OSRM/BRouter → { icon, key } (clé i18n ui.nav.*). */
export function maneuver(modifier) {
  const m = modifier && MANEUVER[modifier] ? modifier : "straight";
  return { icon: MANEUVER[m], key: `ui.nav.${m.replace(" ", "_")}` };
}

/**
 * Positionnement (badge AR / en-tête).
 * mode : "vps" (ARCore Geospatial) | "gps" | "none" ; accuracy en mètres.
 */
export function positioning(mode, accuracy) {
  if (mode === "vps") {
    const tone = accuracy == null ? "warn" : accuracy <= 1.5 ? "good" : accuracy <= 5 ? "warn" : "bad";
    return { tone, key: accuracy != null && accuracy <= 5 ? "ui.pos.vps" : "ui.pos.vps_weak", accuracy };
  }
  if (mode === "gps") {
    const tone = accuracy == null ? "warn" : accuracy <= 12 ? "good" : accuracy <= 35 ? "warn" : "bad";
    return { tone, key: "ui.pos.gps", accuracy };
  }
  return { tone: "bad", key: "ui.pos.none", accuracy: null };
}

/** Source des données stations → { tone, key } pour l'en-tête. */
export function dataSource({ apiLive, isMock, offline }) {
  if (offline) return { tone: "warn", key: "ui.data.offline" };
  if (apiLive) return { tone: "good", key: "ui.data.live" };
  if (isMock) return { tone: "warn", key: "ui.data.demo" };
  return { tone: "accent", key: "ui.data.cache" };
}

// ── Récompense trajet ────────────────────────────────────────────────
/** 2 sats/min, minimum 10 (règle historique d'App.jsx). */
export const tripSats = durMin => Math.max(10, Math.round(durMin) * 2);
