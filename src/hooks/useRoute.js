// ── useRoute — calcul d'itinéraire BRouter (vélo réel) + fallbacks ─────────
// Primaire : BRouter (vrais profils vélo/piéton). Fallbacks : OSRM (serveur
// public = routage voiture, dépannage) puis Google Directions (si clé).
// FIX BUG-3 : détection off-route + recalcul forcé quand on dévie de >35m
//             du tracé pendant >5s. Avant : recalcul aveugle tous les 11m
//             via les deps GPS arrondies, pas de re-route ciblé.
import { useState, useEffect, useRef, useCallback } from "react";
import { haversine } from "../utils.js";
import { distanceToRoute } from "../components/ar/projection.js";
import { saveRoute, loadRoute } from "./useStationsCache.js";

const OSRM_BASE = "https://router.project-osrm.org/route/v1";
// BRouter — routeur libre orienté vélo/piéton (vrais profils, contrairement au
// serveur OSRM public qui ne route qu'en voiture). Gratuit, sans clé, CORS *.
const BROUTER_BASE = "https://brouter.de/brouter";
const BROUTER_PROFILE = { cycling: "trekking", walking: "hiking-beta", driving: "car-fast" };
const CACHE_TTL = 30 * 60 * 1000;          // 30min (avant 24h — trop long si circulation change)
const OFF_ROUTE_THRESHOLD_M  = 35;          // m — au-delà : on considère qu'on a dévié
const OFF_ROUTE_HOLD_MS      = 4000;        // ms — combien de temps on doit rester off avant re-route
                                            // (évite de re-router à cause d'un seul jitter GPS)
const REROUTE_COOLDOWN_MS    = 8000;        // ms — délai mini entre deux re-routes
const ON_ROUTE_REFETCH_M     = 60;          // m — déplacement mini pour refresh "calme" (sur la route)

// ── Cache IndexedDB (clé préfixée par fournisseur pour ne pas mélanger
//    un tracé BRouter vélo avec un tracé OSRM voiture) ──────────────
function cacheKey(provider, fLat, fLng, tLat, tLng, mode) {
  return `${provider}_${fLat.toFixed(4)}_${fLng.toFixed(4)}_${tLat.toFixed(4)}_${tLng.toFixed(4)}_${mode}`;
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
  const key = cacheKey("osrm", fromLat, fromLng, toLat, toLng, mode);
  if (!skipCache) {
    const cached = await loadRoute(key, CACHE_TTL);
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
      totalAscent: null, totalDescent: null, // OSRM public : pas d'élévation
      provider: "osrm",
      computedAt: Date.now(),
    };
    saveRoute(key, result).catch(() => {});
    return result;
  } catch {
    // Réseau indisponible — tenter le cache expiré en dernier recours
    try { const expired = await loadRoute(key, Infinity); if (expired) return expired; } catch {}
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
      totalAscent: null, totalDescent: null,
      provider: "google",
      computedAt: Date.now(),
    };
  } catch { return null; }
}

// ── BRouter (vélo réel, gratuit, sans clé) ────────────────────────
// Angle de virage BRouter (élément [4] des voicehints) → modifier textuel
// compatible avec useSpatialAudio / RouteOverlay. Négatif = gauche, positif =
// droite (convention BRouter). Pure + testée.
export function angleToModifier(angle) {
  const a = Number(angle) || 0;
  const abs = Math.abs(a);
  if (abs < 18) return "straight";
  const side = a < 0 ? "left" : "right";
  if (abs >= 160) return "uturn";
  if (abs >= 110) return `sharp ${side}`;
  if (abs < 40) return `slight ${side}`;
  return side;
}

const BROUTER_CMD_LABEL = {
  1: "continue", 2: "left", 3: "slight-left", 4: "sharp-left",
  5: "right", 6: "slight-right", 7: "sharp-right", 8: "keep-left",
  9: "keep-right", 10: "uturn", 11: "uturn", 12: "uturn",
  13: "off-route", 14: "roundabout",
};

// Convertit une réponse GeoJSON BRouter en route ({waypoints, coords, ...}).
// Pure + testée — pas d'I/O, prend l'objet déjà parsé.
// ── Dénivelé : accumulateur à hystérésis ───────────────────────────
// Somme les montées/descentes en ignorant le bruit altimétrique < threshold.
// (Les données SRTM de BRouter oscillent de ±1-2m — sans hystérésis, un
// trajet plat afficherait 30m de D+ fantôme.) Pure + testée.
export function computeAscentDescent(elevs, threshold = 2) {
  if (!Array.isArray(elevs) || elevs.length < 2) return { ascent: 0, descent: 0 };
  let ascent = 0, descent = 0, anchor = elevs[0];
  for (let i = 1; i < elevs.length; i++) {
    const e = elevs[i];
    if (!Number.isFinite(e)) continue;
    const delta = e - anchor;
    if (delta >= threshold)       { ascent  += delta;  anchor = e; }
    else if (delta <= -threshold) { descent += -delta; anchor = e; }
  }
  return { ascent: Math.round(ascent), descent: Math.round(descent) };
}

// ── Facteur ETA dénivelé ───────────────────────────────────────────
// Luxembourg-Ville : 70m entre la Ville Haute et le Grund. Un temps "plat"
// y est une fiction. Équivalence classique : 1m de D+ ≈ 8-9m de distance
// plate supplémentaire (Naismith pour la marche ; ordre de grandeur
// comparable pour un Vel'OH mécanique en montée urbaine).
// Appliqué UNIQUEMENT aux routes OSRM/Google (temps plats) — BRouter
// intègre déjà la pente dans son total-time. Pure + testée.
export function climbEtaFactor(ascentM, distM, mode = "cycling") {
  if (!Number.isFinite(ascentM) || !Number.isFinite(distM) || distM <= 0 || ascentM <= 0) return 1;
  const FLAT_EQUIV = mode === "walking" ? 8 : 9; // m de plat par m de D+
  const CLAMP_MAX  = mode === "walking" ? 1.5 : 1.6;
  return Math.min(CLAMP_MAX, (distM + ascentM * FLAT_EQUIV) / distM);
}

// D+ au-delà duquel on recommande un vélo électrique (mode cycling)
export const EBIKE_ASCENT_THRESHOLD_M = 40;

export function brouterToRoute(geojson) {
  const f = geojson?.features?.[0];
  const rawCoords = f?.geometry?.coordinates;
  if (!Array.isArray(rawCoords) || rawCoords.length === 0) return null;
  // BRouter renvoie [lng, lat, elevation] — l'altitude alimente le D+/D-.
  const coords = rawCoords.map(([lng, lat]) => ({ lat, lng }));
  const elevs  = rawCoords.map(c => c[2]).filter(e => Number.isFinite(e));
  const { ascent, descent } = computeAscentDescent(elevs);
  const p = f.properties || {};
  const totalDist = parseInt(p["track-length"] ?? "0", 10) || 0;
  const totalTime = parseInt(p["total-time"] ?? "0", 10) || 0;
  const hints = Array.isArray(p.voicehints) ? p.voicehints : [];

  let waypoints = hints.map((h) => {
    const idx = Math.min(Math.max(0, (h[0] | 0)), coords.length - 1);
    const pt = coords[idx];
    return {
      lat: pt.lat, lng: pt.lng,
      instruction: BROUTER_CMD_LABEL[h[1] | 0] || "continue",
      modifier: angleToModifier(h[4]),
      distMeters: Math.round(Number(h[3] ?? 0)),
      streetName: "",
    };
  });

  // Garantir un waypoint final sur la destination (le dernier hint n'y est pas
  // toujours) — RouteOverlay s'appuie sur le dernier waypoint pour "arrivée".
  const last = coords[coords.length - 1];
  if (!waypoints.length) {
    waypoints = [{ lat: last.lat, lng: last.lng, instruction: "arrive", modifier: "straight", distMeters: totalDist, streetName: "" }];
  } else {
    const lw = waypoints[waypoints.length - 1];
    if (haversine(lw.lat, lw.lng, last.lat, last.lng) > 20) {
      waypoints.push({ lat: last.lat, lng: last.lng, instruction: "arrive", modifier: "straight", distMeters: 0, streetName: "" });
    }
  }
  return {
    waypoints, coords, totalDist, totalTime,
    totalAscent: elevs.length >= 2 ? ascent : null,
    totalDescent: elevs.length >= 2 ? descent : null,
    provider: "brouter",
    computedAt: Date.now(),
  };
}

export async function fetchBRouter(fromLat, fromLng, toLat, toLng, mode = "cycling", { skipCache = false } = {}) {
  const profile = BROUTER_PROFILE[mode] || BROUTER_PROFILE.cycling;
  const key = cacheKey("brouter", fromLat, fromLng, toLat, toLng, mode);
  if (!skipCache) {
    const cached = await loadRoute(key, CACHE_TTL);
    if (cached) return cached;
  }
  const lonlats = `${fromLng.toFixed(6)},${fromLat.toFixed(6)}%7C${toLng.toFixed(6)},${toLat.toFixed(6)}`;
  const url = `${BROUTER_BASE}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson&timode=2`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const result = brouterToRoute(data);
    if (!result) return null;
    saveRoute(key, result).catch(() => {});
    return result;
  } catch {
    try { const expired = await loadRoute(key, Infinity); if (expired) return expired; } catch {}
    return null;
  }
}

// ── Orchestrateur : BRouter (vélo réel) → OSRM (dépannage) → Google ──
export async function fetchRoute(fromLat, fromLng, toLat, toLng, mode = "cycling", { skipCache = false, mapsKey = "" } = {}) {
  let r = await fetchBRouter(fromLat, fromLng, toLat, toLng, mode, { skipCache });
  if (!r) r = await fetchOSRM(fromLat, fromLng, toLat, toLng, mode, { skipCache });
  if (!r && mapsKey) r = await fetchGoogleRoute(fromLat, fromLng, toLat, toLng, mode, mapsKey);
  return r;
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
      const r = await fetchRoute(pos.lat, pos.lng, dest.lat, dest.lng, m, { skipCache: force, mapsKey: key });
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
          // Refetch silencieux (pas de flag offRoute) — même chaîne BRouter→OSRM.
          lastFetchPosRef.current = { lat: gpsPos.lat, lng: gpsPos.lng };
          fetchRoute(gpsPos.lat, gpsPos.lng, station.lat, station.lng, mode)
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
