// ── useTransit — Départs RGTR temps réel via API HAFAS ATP Luxembourg ──
// API couvre : bus RGTR (régionaux Grand-Duché), product=32
// Tram Luxtram T1 : non inclus dans cette instance (horaires statiques utilisés)
// Rate limit : ~10 req/min — cache 2 min + backoff exponentiel sur 429/503

import { useState, useEffect, useRef } from "react";

const HAFAS_BASE = "https://cdt.hafas.de/opendata/apiserver";
const CACHE = new Map();        // stopId / "nearby_X_Y" → { ts, data }
const DEPARTURES_TTL = 120_000; // 2 min
const NEARBY_TTL     = 300_000; // 5 min

// ── fetch avec retry + backoff exponentiel ────────────────────────
async function fetchWithRetry(url, { maxRetries = 3, timeout = 8000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Backoff exponentiel : 1s, 2s, 4s
      await new Promise(r => setTimeout(r, 2 ** (attempt - 1) * 1000));
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);

      if (r.status === 429 || r.status === 503) {
        lastErr = new Error(`Rate limit HTTP ${r.status}`);
        continue; // retry
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e.name === "AbortError") continue;
      if (attempt === maxRetries) break;
    }
  }
  throw lastErr || new Error("fetch failed");
}

// ── Départs d'un arrêt HAFAS ──────────────────────────────────────
export async function fetchDepartures(stopId, apiKey, maxJourneys = 6) {
  const cacheKey = `dep_${stopId}`;
  const cached = CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < DEPARTURES_TTL) return cached.data;

  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toTimeString().slice(0, 5);
  const url = `${HAFAS_BASE}/departureBoard?accessId=${apiKey}&id=${stopId}&date=${date}&time=${time}&maxJourneys=${maxJourneys}&duration=90&format=json`;

  try {
    const d = await fetchWithRetry(url);
    const departures = (d.Departure || []).map(dep => ({
      line:      dep.name || "?",
      direction: dep.direction || "?",
      time:      dep.time?.slice(0, 5) || "?",
      rtTime:    dep.rtTime?.slice(0, 5) || null,
      stop:      dep.stop || "?",
      cancelled: dep.cancelled === "true",
    }));
    CACHE.set(cacheKey, { ts: Date.now(), data: departures });
    return departures;
  } catch (e) {
    console.warn("[HAFAS] fetchDepartures:", e.message);
    // Retourner cache stale si disponible (meilleur qu'échec total)
    if (cached) return cached.data;
    return null;
  }
}

// ── Arrêts RGTR proches ──────────────────────────────────────────
export async function findNearbyStops(lat, lng, apiKey, radius = 1500) {
  const cacheKey = `nb_${Math.round(lat*100)}_${Math.round(lng*100)}`;
  const cached = CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < NEARBY_TTL) return cached.data;

  const url = `${HAFAS_BASE}/location.nearbystops?accessId=${apiKey}&originCoordLat=${lat}&originCoordLong=${lng}&r=${radius}&maxNo=8&format=json`;
  try {
    const d = await fetchWithRetry(url);
    const stops = (d.stopLocationOrCoordLocation || []).map(s => {
      const sl = s.StopLocation || {};
      const slat = parseFloat(sl.lat || 0);
      const slng = parseFloat(sl.lon || 0);
      const dist = Math.round(Math.sqrt((slat-lat)**2 + (slng-lng)**2) * 111000);
      return { id: sl.extId, name: sl.name, lat: slat, lng: slng, dist };
    }).filter(s => s.id && s.dist < radius)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 4);
    CACHE.set(cacheKey, { ts: Date.now(), data: stops });
    return stops;
  } catch (e) {
    console.warn("[HAFAS] findNearbyStops:", e.message);
    if (cached) return cached.data;
    return [];
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
  return `\nBus RGTR à "${stopName}" :\n${lines.join("\n")}`;
}

// ── Purger les entrées cache expirées ────────────────────────────
function pruneCache() {
  const now = Date.now();
  for (const [key, { ts }] of CACHE) {
    const ttl = key.startsWith("nb_") ? NEARBY_TTL : DEPARTURES_TTL;
    if (now - ts > ttl * 2) CACHE.delete(key); // ×2 pour garder stale un peu
  }
}

// ── Hook React ────────────────────────────────────────────────────
// Fetch au montage + toutes les 2 min tant que GPS + clé présentes
// Relance immédiate si GPS bouge de >300m (~0.003° soit round(×100) diff)
export function useTransit(gpsPos, hafasKey) {
  const [stops,      setStops]      = useState([]);
  const [departures, setDepartures] = useState({});
  const [loading,    setLoading]    = useState(false);
  const fetchingRef = useRef(false);

  // Arrondi GPS pour stable key — ~1km de granularité
  const gpsKey = gpsPos ? `${Math.round(gpsPos.lat * 100)}_${Math.round(gpsPos.lng * 100)}` : null;

  useEffect(() => {
    if (!gpsPos || !hafasKey) {
      setStops([]); setDepartures({}); return;
    }

    let cancelled = false;

    const doFetch = async () => {
      if (fetchingRef.current) return; // évite double-fetch concurrent
      fetchingRef.current = true;
      setLoading(true);

      try {
        const nearby = await findNearbyStops(gpsPos.lat, gpsPos.lng, hafasKey);
        if (cancelled) return;
        setStops(nearby);

        // Limiter à 2 arrêts pour rate limit — 500ms entre appels
        const depsMap = {};
        for (const stop of nearby.slice(0, 2)) {
          if (cancelled) return;
          const deps = await fetchDepartures(stop.id, hafasKey);
          if (deps) depsMap[stop.id] = deps;
          await new Promise(r => setTimeout(r, 500));
        }
        if (!cancelled) setDepartures(depsMap);
      } finally {
        fetchingRef.current = false;
        if (!cancelled) setLoading(false);
      }

      pruneCache();
    };

    // Fetch immédiat
    doFetch();
    // Puis toutes les 2 minutes
    const interval = setInterval(doFetch, DEPARTURES_TTL);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gpsKey, hafasKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { stops, departures, loading };
}
