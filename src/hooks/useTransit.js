// ── useTransit — arrêts + départs bus/tram via Transitous (sans clé) ──
// Remplace HAFAS ATP (clé accessId). Couvre bus AVL/RGTR ET tram Luxtram T1
// (flux officiel ATP), temps réel quand MOTIS en dispose.
//
// Fair use Transitous : pas de polling agressif.
//  - Rien n'est chargé tant que `active` est faux (onglet non affiché).
//  - Pause quand l'app est en arrière-plan (document caché).
//  - Départs rafraîchis au plus toutes les 60 s (≥ 30 s exigés), arrêts 10 min.
//  - Cache module partagé : remonter le hook ne relance pas de requête.

import { useState, useEffect, useRef } from "react";
import { fetchNearbyStops, fetchStopTimes } from "../utils/transitous.js";

const CACHE = new Map();        // clé → { ts, data }
const DEPARTURES_TTL = 60_000;  // 1 min
const NEARBY_TTL     = 600_000; // 10 min
const MAX_STOPS_WITH_DEPARTURES = 2;

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
export async function findNearbyStops(lat, lng, radius = 1500) {
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
  const gpsRef = useRef(gpsPos);
  useEffect(() => { gpsRef.current = gpsPos; }, [gpsPos]);

  // Arrondi GPS pour clé stable — ~1 km de granularité
  const gpsKey = gpsPos ? `${Math.round(gpsPos.lat * 100)}_${Math.round(gpsPos.lng * 100)}` : null;

  useEffect(() => {
    if (!gpsKey || !active) return;
    let cancelled = false;

    const doFetch = async () => {
      const pos = gpsRef.current;
      if (!pos || fetchingRef.current || !isVisible()) return;
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
      }
      pruneCache();
    };

    doFetch();
    const interval = setInterval(doFetch, DEPARTURES_TTL);
    // Retour au premier plan : rafraîchit (le cache évite les doublons)
    const onVisible = () => { if (isVisible()) doFetch(); };
    document.addEventListener?.("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener?.("visibilitychange", onVisible);
    };
  }, [gpsKey, active]);

  return { stops, departures, loading };
}
