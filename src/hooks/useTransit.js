// ── useTransit — arrêts + départs bus/tram via Transitous (sans clé) ──
// Remplace HAFAS ATP (clé accessId). Couvre bus AVL/RGTR ET tram Luxtram T1
// (flux officiel ATP), temps réel quand MOTIS en dispose.
//
// Fair use Transitous : pas de polling agressif.
//  - Rien n'est chargé tant que `active` est faux (onglet non affiché).
//  - Pause quand l'app est en arrière-plan (document caché).
//  - Départs rafraîchis au plus toutes les 60 s (≥ 30 s exigés), arrêts 10 min.
//  - Cache module partagé : remonter le hook ne relance pas de requête.

import { useState, useEffect, useRef, useMemo } from "react";
import { fetchNearbyStops, fetchStopTimes } from "../utils/transitous.js";
import { haversine } from "../utils.js";

const CACHE = new Map();        // clé → { ts, data }
const DEPARTURES_TTL = 60_000;  // 1 min
const NEARBY_TTL     = 600_000; // 10 min
const MAX_STOPS_WITH_DEPARTURES = 2;
const NEARBY_RADIUS = 1500;     // m — rayon de findNearbyStops

// ── Départs d'un arrêt ────────────────────────────────────────────
export async function fetchDepartures(stopId, maxJourneys = 6) {
  const cacheKey = `dep_${stopId}`;
  const cached = CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < DEPARTURES_TTL) return cached.data;
  try {
    const departures = await fetchStopTimes(stopId, maxJourneys);
    CACHE.set(cacheKey, { ts: Date.now(), data: departures });
    return departures;
  } catch (e) {
    console.warn("[Transitous] stoptimes:", e.message);
    // Cache périmé : mieux qu'un échec total
    return cached ? cached.data : null;
  }
}

// ── Arrêts bus/tram proches ───────────────────────────────────────
export async function findNearbyStops(lat, lng, radius = NEARBY_RADIUS) {
  const cacheKey = `nb_${Math.round(lat*100)}_${Math.round(lng*100)}`;
  const cached = CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < NEARBY_TTL) return cached.data;
  try {
    const stops = await fetchNearbyStops(lat, lng, { radius, limit: 4 });
    CACHE.set(cacheKey, { ts: Date.now(), data: stops });
    return stops;
  } catch (e) {
    console.warn("[Transitous] map/stops:", e.message);
    return cached ? cached.data : [];
  }
}

/**
 * Distances des arrêts recalculées depuis la position COURANTE, comme celles des stations
 * (utils.enrich). Celles de l'API sont figées à la position du téléchargement, refait au
 * plus une fois par cellule de ~1 km : l'écran IA pouvait afficher « Foetz, Am Brill —
 * 200 m » à côté d'une station calculée depuis une autre position, 12 km plus loin.
 * Un arrêt sorti du rayon n'est plus « proche » : il disparaît jusqu'au prochain chargement.
 */
export function relocateStops(stops, pos, radius = NEARBY_RADIUS) {
  if (!pos || !Array.isArray(stops)) return stops ?? [];
  return stops
    .filter(s => Number.isFinite(s?.lat) && Number.isFinite(s?.lng))
    .map(s => ({ ...s, dist: haversine(pos.lat, pos.lng, s.lat, s.lng) }))
    .filter(s => s.dist <= radius)
    .sort((a, b) => a.dist - b.dist);
}

// ── Formatter pour prompt IA ──────────────────────────────────────
export function formatDeparturesForAI(stopName, departures) {
  if (!departures?.length) return "";
  const lines = departures.slice(0, 5).map(dep => {
    const time = dep.rtTime || dep.time;
    const delay = dep.rtTime && dep.rtTime !== dep.time ? " ⚠️retard" : "";
    const cancel = dep.cancelled ? " ❌annulé" : "";
    return `  ${dep.line} → ${dep.direction} à ${time}${delay}${cancel}`;
  });
  return `\nArrêt "${stopName}" :\n${lines.join("\n")}`;
}

function pruneCache() {
  const now = Date.now();
  for (const [key, { ts }] of CACHE) {
    const ttl = key.startsWith("nb_") ? NEARBY_TTL : DEPARTURES_TTL;
    if (now - ts > ttl * 2) CACHE.delete(key);
  }
}

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

// ── Hook React ────────────────────────────────────────────────────
// gpsPos : { lat, lng } | null
// active : true uniquement quand un écran consommateur est affiché
// → { stops, departures: { [stopId]: [...] }, loading }
export function useTransit(gpsPos, { active = true } = {}) {
  const [stops,      setStops]      = useState([]);
  const [departures, setDepartures] = useState({});
  const [loading,    setLoading]    = useState(false);
  const fetchingRef = useRef(false);
  // Changement de cellule pendant un chargement : on le refait à la fin au lieu de
  // l'ignorer (avant, la liste de l'ancienne position restait jusqu'à 60 s de plus).
  const pendingRef = useRef(false);
  const rerunRef = useRef(null);   // doFetch de l'effet en cours (pas celui d'une position périmée)
  const gpsRef = useRef(gpsPos);
  useEffect(() => { gpsRef.current = gpsPos; }, [gpsPos]);

  // Arrondi GPS pour clé stable — ~1 km de granularité
  const gpsKey = gpsPos ? `${Math.round(gpsPos.lat * 100)}_${Math.round(gpsPos.lng * 100)}` : null;

  useEffect(() => {
    if (!gpsKey || !active) return;
    let cancelled = false;

    const doFetch = async () => {
      const pos = gpsRef.current;
      if (!pos || !isVisible()) return;
      if (fetchingRef.current) { pendingRef.current = true; return; }
      fetchingRef.current = true;
      setLoading(true);
      try {
        const nearby = await findNearbyStops(pos.lat, pos.lng);
        if (cancelled) return;
        setStops(nearby);
        const depsMap = {};
        for (const stop of nearby.slice(0, MAX_STOPS_WITH_DEPARTURES)) {
          if (cancelled) return;
          const deps = await fetchDepartures(stop.id);
          if (deps) depsMap[stop.id] = deps;
        }
        if (!cancelled) setDepartures(depsMap);
      } finally {
        fetchingRef.current = false;
        if (!cancelled) setLoading(false);
        pruneCache();
        if (pendingRef.current) { pendingRef.current = false; rerunRef.current?.(); }
      }
    };

    rerunRef.current = doFetch;
    doFetch();
    const interval = setInterval(doFetch, DEPARTURES_TTL);
    // Retour au premier plan : rafraîchit (le cache évite les doublons)
    const onVisible = () => { if (isVisible()) doFetch(); };
    document.addEventListener?.("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (rerunRef.current === doFetch) rerunRef.current = null;
      clearInterval(interval);
      document.removeEventListener?.("visibilitychange", onVisible);
    };
  }, [gpsKey, active]);

  const located = useMemo(() => relocateStops(stops, gpsPos), [stops, gpsPos]);
  return { stops: located, departures, loading };
}
