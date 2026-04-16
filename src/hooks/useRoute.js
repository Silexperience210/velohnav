import { useState, useEffect } from "react";

// ── Cache OSRM offline ─────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useI18n, t } from "./i18n.js";

// ── ROUTING — OSRM (gratuit) + fallback Google Directions ────────
const OSRM_BASE = "https://router.project-osrm.org/route/v1";
// Clé de cache localStorage : "velohnav_route_{from}_{to}_{mode}"
const ROUTE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

function routeCacheKey(fromLat, fromLng, toLat, toLng, mode) {
  // Arrondi à 4 décimales (~11m de précision) pour éviter des clés trop granulaires
  return `velohnav_route_${fromLat.toFixed(4)}_${fromLng.toFixed(4)}_${toLat.toFixed(4)}_${toLng.toFixed(4)}_${mode}`;
}
function getRouteCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > ROUTE_CACHE_TTL) { localStorage.removeItem(key); return null; }
    return data;
  } catch { return null; }
}
function setRouteCache(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

async function fetchOSRM(fromLat, fromLng, toLat, toLng, mode="cycling") {
  const profile = mode==="walking" ? "foot" : mode==="driving" ? "car" : "cycling";
  const cacheKey = routeCacheKey(fromLat, fromLng, toLat, toLng, mode);
  // Vérifier le cache local d'abord (itinéraires valides 24h)
  const cached = getRouteCache(cacheKey);
  if (cached) return cached;

  const url = `${OSRM_BASE}/${profile}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson&steps=true`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    if (data.code !== "Ok") return null;
    const leg = data.routes[0].legs[0];
    const waypoints = leg.steps.map(s=>({
      lat: s.maneuver.location[1],
      lng: s.maneuver.location[0],
      instruction: s.maneuver.type,
      modifier:    s.maneuver.modifier ?? "straight",
      distMeters:  Math.round(s.distance),
    }));
    const coords = data.routes[0].geometry.coordinates.map(([lng,lat])=>({lat,lng}));
    const result = { waypoints, coords,
      totalDist: Math.round(data.routes[0].distance),
      totalTime: Math.round(data.routes[0].duration) };
    // Mettre en cache pour utilisation offline
    setRouteCache(cacheKey, result);
    return result;
  } catch {
    // Réseau indisponible → tenter le cache expiré en dernier recours
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) return JSON.parse(raw).data;
    } catch {}
    return null;
  }
}

async function fetchGoogleRoute(fromLat, fromLng, toLat, toLng, mode="bicycling", apiKey) {
  if (!apiKey) return null;
  const modeMap = { cycling:"bicycling", walking:"walking", driving:"driving" };
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${fromLat},${fromLng}&destination=${toLat},${toLng}&mode=${modeMap[mode]||"bicycling"}&key=${apiKey}`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== "OK") return null;
    const leg = data.routes[0].legs[0];
    const waypoints = leg.steps.map((s,i)=>({
      lat: s.end_location.lat,
      lng: s.end_location.lng,
      instruction: s.maneuver || "straight",
      modifier: s.maneuver?.includes("left")?"left":s.maneuver?.includes("right")?"right":"straight",
      distMeters: s.distance.value,
    }));
    // Décoder la polyline encodée de Google
    const coords = decodePolyline(data.routes[0].overview_polyline.points);
    return { waypoints, coords,
      totalDist: leg.distance.value,
      totalTime: leg.duration.value };
  } catch { return null; }
}

// Décodeur polyline Google
function decodePolyline(encoded) {
  const pts=[]; let idx=0, lat=0, lng=0;
  while(idx<encoded.length){
    let b,shift=0,result=0;
    do{ b=encoded.charCodeAt(idx++)-63; result|=(b&0x1f)<<shift; shift+=5; } while(b>=0x20);
    lat+=result&1?~(result>>1):(result>>1);
    shift=0; result=0;
    do{ b=encoded.charCodeAt(idx++)-63; result|=(b&0x1f)<<shift; shift+=5; } while(b>=0x20);
    lng+=result&1?~(result>>1):(result>>1);
    pts.push({lat:lat/1e5, lng:lng/1e5});
  }
  return pts;
}

// ── MÉTÉO + RECOMMANDATION MULTIMODALE ───────────────────────────
// OpenMeteo : gratuit, sans clé, CORS-friendly, précision ~1km Luxembourg.
// WMO weather codes : 0-3 clair, 45-48 brouillard, 51-67 pluie, 71-77 neige,
//                     80-82 averses, 85-86 averses neige, 95-99 orage
const WMO_LABEL = {
  0:"Ciel clair", 1:"Peu nuageux", 2:"Partiellement nuageux", 3:"Couvert",
  45:"Brouillard", 48:"Brouillard givrant",
  51:"Bruine légère", 53:"Bruine modérée", 55:"Bruine dense",
  61:"Pluie légère", 63:"Pluie modérée", 65:"Pluie forte",
  71:"Neige légère", 73:"Neige modérée", 75:"Neige forte",
  80:"Averses légères", 81:"Averses modérées", 82:"Averses violentes",
  85:"Averses de neige légères", 86:"Averses de neige fortes",
  95:"Orage", 96:"Orage avec grêle", 99:"Orage violent avec grêle",
};
const WMO_ICON = {
  0:"☀️", 1:"🌤", 2:"⛅", 3:"☁️", 45:"🌫", 48:"🌫",
  51:"🌦", 53:"🌦", 55:"🌧", 61:"🌧", 63:"🌧", 65:"🌧",
  71:"🌨", 73:"❄️", 75:"❄️", 80:"🌦", 81:"🌧", 82:"⛈",
  85:"🌨", 86:"❄️", 95:"⛈", 96:"⛈", 99:"⛈",
};

async function fetchWeather(lat, lng) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,precipitation,wind_speed_10m,weather_code` +
      `&wind_speed_unit=kmh&precipitation_unit=mm&timezone=Europe/Luxembourg&forecast_days=1`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const c = data.current;
    return {
      temp:   Math.round(c.temperature_2m),
      rain:   c.precipitation,           // mm dans l'heure courante
      wind:   Math.round(c.wind_speed_10m),
      code:   c.weather_code,
      label:  WMO_LABEL[c.weather_code] ?? "Météo inconnue",
      icon:   WMO_ICON[c.weather_code]  ?? "🌡",
    };
  } catch { return null; }
}

// Logique de décision : bike | transit | mixed
// Seuils : pluie > 0.5mm/h OU vent > 35km/h OU neige OU orage
function getWeatherAdvice(weather) {
  if (!weather) return { mode:"bike", reason:null };
  const { rain, wind, code } = weather;
  const isStorm = code >= 95;
  const isSnow  = (code >= 71 && code <= 77) || code === 85 || code === 86;
  const heavyRain = rain > 2.0;
  const lightRain = rain > 0.5;
  const strongWind = wind > 35;
  const mildWind   = wind > 25;

  if (isStorm || isSnow || heavyRain || (strongWind && lightRain)) {
    return { mode:"transit", reason: isStorm?"orage": isSnow?"neige": heavyRain?"pluie forte":"vent fort + pluie" };
  }
  if (lightRain || mildWind) {
    return { mode:"mixed", reason: lightRain?"pluie légère":"vent modéré" };
  }
  return { mode:"bike", reason:null };
}


export { useRoute, fetchOSRM };
