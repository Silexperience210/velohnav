// ── Vel'OH! via GBFS v3 (cyclocity, public, sans clé) ──────────────
// Remplace l'appel JCDecaux à clé comme chemin par défaut.
// Flux vérifiés le 08/10/2026 :
//   station_information.json  ttl 300  — 146 stations, name = [{text,language}]
//   station_status.json       ttl 1    — dispo temps réel
//   vehicle_types.json        ttl 3600 — 1 seul type aujourd'hui : "electrical"
// On appelle directement les flux (pas de découverte via gbfs.json) : chaque
// requête vers cyclocity risque un reset TCP, autant en faire le moins possible.
// Les flux statiques (info, types) sont mémorisés selon leur ttl ; seul
// station_status est re-téléchargé à chaque rafraîchissement.

import { fetchJSONWithRetry } from "./http.js";

export const GBFS_BASE = "https://api.cyclocity.fr/contracts/luxembourg/gbfs/v3";

// ── Parseurs purs (testés sur fixtures réelles) ────────────────────

/** Texte localisé GBFS v3 : tableau [{text, language}] (ou chaîne en v2). */
export function pickLang(value, lang = "fr") {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.length) return "";
  const hit = value.find(v => v?.language === lang && v.text)
           ?? value.find(v => v?.text);
  return hit?.text ?? "";
}

/** "#00001-LEON XIII" → "LEON XIII" (accepte aussi "00001 - X" façon JCDecaux). */
export function cleanStationName(name) {
  return String(name || "").replace(/^#?\d+\s*[-–]\s*/, "").trim();
}

/** Ids des types de véhicule électriques (propulsion ≠ humaine). */
export function electricTypeIds(vehicleTypesJson) {
  const types = vehicleTypesJson?.data?.vehicle_types;
  const ids = new Set();
  if (Array.isArray(types)) {
    for (const t of types) {
      if (t?.propulsion_type && t.propulsion_type !== "human") ids.add(t.vehicle_type_id);
    }
  }
  return ids;
}

// Stations non publiques présentes dans le flux (dépôt / atelier opérateur).
const NON_PUBLIC_RE = /\bATELIER\b/i;

/**
 * Fusionne station_information + station_status en modèle station interne
 * (même contrat que parseStation JCDecaux : id, name, lat, lng, cap, bikes,
 * elec, meca, docks, status, _mock) + renting / returning / lastReported.
 *
 * Sémantique « utilisable » :
 *  - is_renting=false  → bikes/elec/meca = 0 (vélos présents mais non louables)
 *  - is_returning=false → docks = 0
 *  - CLOSED si non installée, ou ni location ni retour possibles
 *
 * @param {object} infoJson    station_information.json
 * @param {object} statusJson  station_status.json
 * @param {Set<string>} [elecIds] ids électriques (vehicle_types) ; à défaut,
 *        heuristique sur l'id (« electrical », « ebike »…)
 */
export function parseGBFS(infoJson, statusJson, elecIds = null) {
  const infos = infoJson?.data?.stations;
  const statuses = statusJson?.data?.stations;
  if (!Array.isArray(infos) || !Array.isArray(statuses)) return [];
  const byId = new Map(statuses.map(s => [String(s.station_id), s]));
  const isElec = id => elecIds?.size ? elecIds.has(id) : /elec|ebike|e-bike/i.test(String(id));

  const out = [];
  for (const info of infos) {
    const sid = String(info.station_id);
    const st = byId.get(sid);
    const name = cleanStationName(pickLang(info.name));
    const cap = Number(info.capacity) || 0;
    // Stations fantômes (nom vide, capacité 0) et dépôts : hors carte
    if ((!name && cap === 0) || NON_PUBLIC_RE.test(name)) continue;
    if (!Number.isFinite(info.lat) || !Number.isFinite(info.lon)) continue;

    const installed = st?.is_installed !== false && !!st;
    const renting   = installed && st.is_renting !== false;
    const returning = installed && st.is_returning !== false;

    const types = Array.isArray(st?.vehicle_types_available) ? st.vehicle_types_available : [];
    const typedTotal = types.reduce((n, t) => n + (Number(t.count) || 0), 0);
    const rawBikes = Number.isFinite(st?.num_vehicles_available) ? st.num_vehicles_available : typedTotal;
    const rawElec  = types.filter(t => isElec(t.vehicle_type_id))
                          .reduce((n, t) => n + (Number(t.count) || 0), 0);

    const bikes = renting ? rawBikes : 0;
    const elec  = renting ? Math.min(rawElec, rawBikes) : 0;

    out.push({
      // Id numérique si possible : compatible avec l'historique / la dispo
      // enregistrés sous les numéros JCDecaux (même numérotation).
      id:    /^\d+$/.test(sid) ? Number(sid) : sid,
      name:  name || info.address || `Station ${sid}`,
      lat:   info.lat,
      lng:   info.lon,
      cap,
      bikes, elec,
      meca:  Math.max(0, bikes - elec),
      docks: returning ? (Number(st?.num_docks_available) || 0) : 0,
      status: installed && (renting || returning) ? "OPEN" : "CLOSED",
      renting, returning,
      lastReported: st?.last_reported ?? null,
      _mock: false,
    });
  }
  return out;
}

// ── Fetch ──────────────────────────────────────────────────────────
// Mémoire des flux statiques : { data, exp }
const staticCache = new Map();

async function getFeed(name, { fetchOpts, useTtl }) {
  const now = Date.now();
  const hit = staticCache.get(name);
  if (useTtl && hit && hit.exp > now) return hit.data;
  try {
    const data = await fetchJSONWithRetry(`${GBFS_BASE}/${name}.json`, fetchOpts);
    const ttl = Number(data?.ttl);
    // Plancher 60s / plafond 1h — on ne fait pas confiance aveuglément au ttl
    const ttlMs = Math.min(Math.max(Number.isFinite(ttl) ? ttl : 300, 60), 3600) * 1000;
    if (useTtl) staticCache.set(name, { data, exp: now + ttlMs });
    return data;
  } catch (e) {
    // Flux statique : une version périmée vaut mieux que rien
    if (useTtl && hit) return hit.data;
    throw e;
  }
}

/** Réinitialise la mémoire des flux statiques (tests / refresh forcé). */
export function resetGBFSCache() { staticCache.clear(); }

/**
 * Télécharge et fusionne les flux GBFS. Retourne la liste de stations
 * (non enrichie — pas de distance) ou null si échec.
 */
export async function fetchGBFSStations(fetchOpts = {}) {
  try {
    const [info, status, types] = await Promise.all([
      getFeed("station_information", { fetchOpts, useTtl: true }),
      getFeed("station_status",      { fetchOpts, useTtl: false }),
      // Optionnel : sans lui, heuristique sur l'id du type
      getFeed("vehicle_types",       { fetchOpts, useTtl: true }).catch(() => null),
    ]);
    const stations = parseGBFS(info, status, electricTypeIds(types));
    return stations.length ? stations : null;
  } catch (e) {
    console.warn("[GBFS] fetch:", e?.message || e);
    return null;
  }
}
