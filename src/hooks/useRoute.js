// ── useRoute — calcul d'itinéraire OSRM + fallback Google ─────────
import { useState, useEffect, useRef, useCallback } from "react";

const OSRM_BASE = "https://router.project-osrm.org/route/v1";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// ── Cache localStorage ────────────────────────────────────────────
function cacheKey(fLat, fLng, tLat, tLng, mode) {
  return `velohnav_route_${fLat.toFixed(4)}_${fLng.toFixed(4)}_${tLat.toFixed(4)}_${tLng.toFixed(4)}_${mode}`;
}
function getCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) { localStorage.removeItem(key); return null; }
    return data;
  } catch { return null; }
}
function setCache(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

// ── Décodeur polyline Google ──────────────────────────────────────
function decodePolyline(encoded) {
  const pts = []; let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : (result >> 1);
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

// ── OSRM (gratuit, sans clé) ──────────────────────────────────────
export async function fetchOSRM(fromLat, fromLng, toLat, toLng, mode = "cycling") {
  const profile = mode === "walking" ? "foot" : mode === "driving" ? "car" : "cycling";
  const key = cacheKey(fromLat, fromLng, toLat, toLng, mode);
  const cached = getCache(key);
  if (cached) return cached;
  const url = `${OSRM_BASE}/${profile}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson&steps=true`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    if (data.code !== "Ok") return null;
    const leg = data.routes[0].legs[0];
    const result = {
      waypoints: leg.steps.map(s => ({
        lat: s.maneuver.location[1], lng: s.maneuver.location[0],
        instruction: s.maneuver.type,
        modifier: s.maneuver.modifier ?? "straight",
        distMeters: Math.round(s.distance),
      })),
      coords: data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      totalDist: Math.round(data.routes[0].distance),
      totalTime: Math.round(data.routes[0].duration),
    };
    setCache(key, result);
    return result;
  } catch {
    // Réseau indisponible — tenter le cache expiré en dernier recours
    try { const raw = localStorage.getItem(key); if (raw) return JSON.parse(raw).data; } catch {}
    return null;
  }
}

// ── Google Directions (fallback, clé requise) ─────────────────────
export async function fetchGoogleRoute(fromLat, fromLng, toLat, toLng, mode = "bicycling", apiKey) {
  if (!apiKey) return null;
  const modeMap = { cycling: "bicycling", walking: "walking", driving: "driving" };
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${fromLat},${fromLng}` +
    `&destination=${toLat},${toLng}&mode=${modeMap[mode] || "bicycling"}&key=${apiKey}`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== "OK") return null;
    const leg = data.routes[0].legs[0];
    return {
      waypoints: leg.steps.map(s => ({
        lat: s.end_location.lat, lng: s.end_location.lng,
        instruction: s.maneuver || "straight",
        modifier: s.maneuver?.includes("left") ? "left" : s.maneuver?.includes("right") ? "right" : "straight",
        distMeters: s.distance.value,
      })),
      coords: decodePolyline(data.routes[0].overview_polyline.points),
      totalDist: leg.distance.value,
      totalTime: leg.duration.value,
    };
  } catch { return null; }
}

// ── Hook React useRoute ───────────────────────────────────────────
// gpsPos   : { lat, lng } | null
// station  : { lat, lng, id, name } | null  (null = navigation inactive)
// mode     : "cycling" | "walking" | "driving"
// mapsKey  : string (optionnel, fallback Google)
// → { route, loading, error }
export function useRoute(gpsPos, station, mode = "cycling", mapsKey = "") {
  const [route,   setRoute]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const abortRef = useRef(null);

  const loadRoute = useCallback(async (pos, dest, m, key) => {
    setLoading(true); setError(null);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      let r = await fetchOSRM(pos.lat, pos.lng, dest.lat, dest.lng, m);
      if (!r && key) r = await fetchGoogleRoute(pos.lat, pos.lng, dest.lat, dest.lng, m, key);
      if (ctrl.signal.aborted) return;
      if (r)  { setRoute(r); setError(null); }
      else      setError("Itinéraire introuvable — vérifiez votre connexion");
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e.message);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!gpsPos || !station) { setRoute(null); setLoading(false); return; }
    loadRoute(gpsPos, station, mode, mapsKey);
    return () => abortRef.current?.abort();
  }, [
    // Deps arrondies : GPS ~11m, station par id, mode, clé
    gpsPos  ? Math.round(gpsPos.lat * 10000) : null,
    gpsPos  ? Math.round(gpsPos.lng * 10000) : null,
    station?.id, mode,
  ]);

  return { route, loading, error };
}
