// ── useRoute — calcul d'itinéraire OSRM + fallback Google ─────────
// FIX BUG-3 : détection off-route + recalcul forcé quand on dévie de >35m
//             du tracé pendant >5s. Avant : recalcul aveugle tous les 11m
//             via les deps GPS arrondies, pas de re-route ciblé.
import { useState, useEffect, useRef, useCallback } from "react";
import { haversine } from "../utils.js";
import { distanceToRoute } from "../components/ar/projection.js";

const OSRM_BASE = "https://router.project-osrm.org/route/v1";
const CACHE_TTL = 30 * 60 * 1000;          // 30min (avant 24h — trop long si circulation change)
const OFF_ROUTE_THRESHOLD_M  = 35;          // m — au-delà : on considère qu'on a dévié
const OFF_ROUTE_HOLD_MS      = 4000;        // ms — combien de temps on doit rester off avant re-route
                                            // (évite de re-router à cause d'un seul jitter GPS)
const REROUTE_COOLDOWN_MS    = 8000;        // ms — délai mini entre deux re-routes
const ON_ROUTE_REFETCH_M     = 60;          // m — déplacement mini pour refresh "calme" (sur la route)

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
export async function fetchOSRM(fromLat, fromLng, toLat, toLng, mode = "cycling", { skipCache = false } = {}) {
  const profile = mode === "walking" ? "foot" : mode === "driving" ? "car" : "cycling";
  const key = cacheKey(fromLat, fromLng, toLat, toLng, mode);
  if (!skipCache) {
    const cached = getCache(key);
    if (cached) return cached;
  }
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
      computedAt: Date.now(),
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
      computedAt: Date.now(),
    };
  } catch { return null; }
}

// ── Hook React useRoute ───────────────────────────────────────────
// gpsPos   : { lat, lng } | null
// station  : { lat, lng, id, name } | null  (null = navigation inactive)
// mode     : "cycling" | "walking" | "driving"
// mapsKey  : string (optionnel, fallback Google)
// → { route, loading, error, offRoute, recalculating, manualRecalc }
//
// FIX BUG-3 : - Détection off-route : si distance(gps, polyline) > 35m pendant 4s,
//               on déclenche un re-route forcé (skipCache).
//             - Re-route en cooldown : pas plus d'un toutes les 8s.
//             - Refetch "calme" sur la route : seulement si déplacement > 60m
//               depuis le dernier calcul (au lieu de tous les 11m).
//             - manualRecalc() exposé pour bouton UI.
export function useRoute(gpsPos, station, mode = "cycling", mapsKey = "") {
  const [route,   setRoute]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [offRoute, setOffRoute] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const abortRef    = useRef(null);
  const lastFetchPosRef  = useRef(null);   // GPS au moment du dernier fetch — pour le seuil 60m
  const lastRerouteAtRef = useRef(0);      // timestamp du dernier re-route (cooldown)
  const offRouteSinceRef = useRef(null);   // timestamp où la déviation a commencé
  const routeRef         = useRef(null);   // route courante (pour les calculs offRoute)
  useEffect(() => { routeRef.current = route; }, [route]);

  const loadRoute = useCallback(async (pos, dest, m, key, { force = false } = {}) => {
    if (force) setRecalculating(true); else setLoading(true);
    setError(null);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      let r = await fetchOSRM(pos.lat, pos.lng, dest.lat, dest.lng, m, { skipCache: force });
      if (!r && key) r = await fetchGoogleRoute(pos.lat, pos.lng, dest.lat, dest.lng, m, key);
      if (ctrl.signal.aborted) return;
      if (r) {
        setRoute(r);
        setError(null);
        setOffRoute(false);
        offRouteSinceRef.current = null;
        lastFetchPosRef.current  = { lat: pos.lat, lng: pos.lng };
        if (force) lastRerouteAtRef.current = Date.now();
      } else {
        setError("Itinéraire introuvable — vérifiez votre connexion");
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e.message);
    } finally {
      if (!ctrl.signal.aborted) {
        setLoading(false);
        setRecalculating(false);
      }
    }
  }, []);

  // Déclencheur initial — chaque fois que la station change ou qu'on commence
  // une nouvelle nav. Ne dépend PAS de gpsPos (sinon refetch tous les 11m).
  useEffect(() => {
    if (!gpsPos || !station) {
      setRoute(null);
      setLoading(false);
      setOffRoute(false);
      offRouteSinceRef.current = null;
      lastFetchPosRef.current  = null;
      return;
    }
    // Premier calcul — ou si la station a changé.
    loadRoute(gpsPos, station, mode, mapsKey);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station?.id, mode]);

  // Surveillance : off-route + refetch calme tous les 60m.
  // Séparé du déclencheur initial pour ne pas re-fetch à chaque tick GPS.
  useEffect(() => {
    if (!gpsPos || !station || !routeRef.current) return;

    const now = Date.now();
    const distFromRoute = distanceToRoute(routeRef.current.coords, gpsPos.lat, gpsPos.lng);

    // ── 1. Détection off-route ─────────────────────────────────────
    if (distFromRoute > OFF_ROUTE_THRESHOLD_M) {
      if (offRouteSinceRef.current == null) {
        offRouteSinceRef.current = now;
      }
      const offDuration = now - offRouteSinceRef.current;
      if (!offRoute && offDuration > 1500) setOffRoute(true);

      // Re-route automatique si :
      //   - on dévie depuis > OFF_ROUTE_HOLD_MS (4s, pas un jitter)
      //   - cooldown respecté
      //   - pas déjà en cours de recalcul
      if (offDuration >= OFF_ROUTE_HOLD_MS &&
          (now - lastRerouteAtRef.current) >= REROUTE_COOLDOWN_MS &&
          !recalculating) {
        loadRoute(gpsPos, station, mode, mapsKey, { force: true });
      }
    } else {
      // Retour sur la route — reset du timer
      if (offRouteSinceRef.current != null) offRouteSinceRef.current = null;
      if (offRoute) setOffRoute(false);

      // ── 2. Refetch calme : si on a bougé > 60m depuis le dernier calcul ──
      // (pour avoir des waypoints à jour relatifs à la position courante).
      const lastFetch = lastFetchPosRef.current;
      if (lastFetch) {
        const movedSince = haversine(lastFetch.lat, lastFetch.lng, gpsPos.lat, gpsPos.lng);
        if (movedSince > ON_ROUTE_REFETCH_M &&
            (now - lastRerouteAtRef.current) >= REROUTE_COOLDOWN_MS &&
            !loading && !recalculating) {
          // Refetch silencieux (pas de flag offRoute)
          lastFetchPosRef.current = { lat: gpsPos.lat, lng: gpsPos.lng };
          fetchOSRM(gpsPos.lat, gpsPos.lng, station.lat, station.lng, mode)
            .then(r => { if (r) setRoute(r); });
        }
      }
    }
  }, [
    gpsPos ? Math.round(gpsPos.lat * 100000) : null, // ~1.1m precision pour le check off-route
    gpsPos ? Math.round(gpsPos.lng * 100000) : null,
    station?.id, mode, mapsKey, offRoute, recalculating, loading, loadRoute
  ]);

  // Action manuelle — bouton "Recalculer" dans l'UI
  const manualRecalc = useCallback(() => {
    if (!gpsPos || !station) return;
    if (recalculating) return;
    loadRoute(gpsPos, station, mode, mapsKey, { force: true });
  }, [gpsPos, station, mode, mapsKey, recalculating, loadRoute]);

  return { route, loading, error, offRoute, recalculating, manualRecalc };
}
