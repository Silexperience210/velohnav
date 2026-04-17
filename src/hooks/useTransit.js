// ── useTransit — Départs RGTR temps réel via API HAFAS ATP Luxembourg ──
// API couvre : bus RGTR (régionaux Grand-Duché), product=32
// Tram Luxtram T1 : non inclus dans cette instance (horaires statiques utilisés)
// Rate limit : ~10 req/min — on cache 2 min et on appelle au minimum

import { useState, useEffect, useRef } from "react";

const HAFAS_BASE = "https://cdt.hafas.de/opendata/apiserver";
const CACHE = {};      // { stopId: { ts, departures } }
const CACHE_TTL = 120; // secondes

// Récupérer les prochains départs d'un arrêt HAFAS
export async function fetchDepartures(stopId, apiKey, maxJourneys = 6) {
  const now = Date.now();
  const cached = CACHE[stopId];
  if (cached && (now - cached.ts) < CACHE_TTL * 1000) return cached.departures;

  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toTimeString().slice(0, 5);
  const url = `${HAFAS_BASE}/departureBoard?accessId=${apiKey}&id=${stopId}&date=${date}&time=${time}&maxJourneys=${maxJourneys}&duration=90&format=json`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": "VelohNav/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const departures = (d.Departure || []).map(dep => ({
      line:      dep.name || "?",
      direction: dep.direction || "?",
      time:      dep.time?.slice(0, 5) || "?",
      rtTime:    dep.rtTime?.slice(0, 5) || null,
      stop:      dep.stop || "?",
      cancelled: dep.cancelled === "true",
    }));
    CACHE[stopId] = { ts: now, departures };
    return departures;
  } catch (e) {
    console.warn("[HAFAS] fetchDepartures:", e.message);
    return null;
  }
}

// Trouver les arrêts RGTR proches d'une position GPS
export async function findNearbyStops(lat, lng, apiKey, radius = 1500) {
  const cacheKey = `nearby_${Math.round(lat*100)}_${Math.round(lng*100)}`;
  const cached = CACHE[cacheKey];
  if (cached && (Date.now() - cached.ts) < 300_000) return cached.stops; // 5 min

  const url = `${HAFAS_BASE}/location.nearbystops?accessId=${apiKey}&originCoordLat=${lat}&originCoordLong=${lng}&r=${radius}&maxNo=8&format=json`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "VelohNav/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const stops = (d.stopLocationOrCoordLocation || []).map(s => {
      const sl = s.StopLocation || {};
      const slat = parseFloat(sl.lat || 0);
      const slng = parseFloat(sl.lon || 0);
      const dist = Math.round(Math.sqrt((slat-lat)**2 + (slng-lng)**2) * 111000);
      return { id: sl.extId, name: sl.name, lat: slat, lng: slng, dist };
    }).filter(s => s.id && s.dist < radius);
    stops.sort((a, b) => a.dist - b.dist);
    CACHE[cacheKey] = { ts: Date.now(), stops };
    return stops.slice(0, 4);
  } catch (e) {
    console.warn("[HAFAS] findNearbyStops:", e.message);
    return [];
  }
}

// Formatter les départs pour le prompt IA
export function formatDeparturesForAI(stopName, departures) {
  if (!departures?.length) return "";
  const lines = departures.slice(0, 5).map(dep => {
    const time = dep.rtTime || dep.time;
    const delay = dep.rtTime && dep.rtTime !== dep.time ? " ⚠️retard" : "";
    const cancel = dep.cancelled ? " ❌annulé" : "";
    return `  ${dep.line} → ${dep.direction} à ${time}${delay}${cancel}`;
  });
  return `\nBus RGTR à "${stopName}" :\n${lines.join("\n")}`;
}

// Hook React — récupère arrêts proches + départs si clé disponible
export function useTransit(gpsPos, hafasKey) {
  const [stops,      setStops]      = useState([]);
  const [departures, setDepartures] = useState({}); // { stopId: [deps] }
  const [loading,    setLoading]    = useState(false);
  const lastFetch = useRef(0);

  useEffect(() => {
    if (!gpsPos || !hafasKey) return;
    const now = Date.now();
    // Ne re-fetcher que toutes les 2 min ou si GPS a bougé de >200m
    if (now - lastFetch.current < 120_000) return;
    lastFetch.current = now;

    let cancelled = false;
    setLoading(true);

    (async () => {
      const nearby = await findNearbyStops(gpsPos.lat, gpsPos.lng, hafasKey);
      if (cancelled) return;
      setStops(nearby);

      // Récupérer les départs des 2 premiers arrêts seulement (rate limit)
      const depsMap = {};
      for (const stop of nearby.slice(0, 2)) {
        const deps = await fetchDepartures(stop.id, hafasKey);
        if (deps) depsMap[stop.id] = deps;
        await new Promise(r => setTimeout(r, 500)); // 500ms entre les appels
      }
      if (!cancelled) {
        setDepartures(depsMap);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  // Arrondi GPS pour éviter re-fetch à chaque micro-mouvement
  }, [
    gpsPos ? Math.round(gpsPos.lat * 100) : null,
    gpsPos ? Math.round(gpsPos.lng * 100) : null,
    hafasKey,
  ]);

  return { stops, departures, loading };
}
