// ── useWeather — hook météo OpenMeteo ─────────────────────────────
import { useState, useEffect } from "react";

// WMO weather codes
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

// Fetch météo OpenMeteo — gratuit, sans clé, CORS-friendly
export async function fetchWeather(lat, lng) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,weather_code` +
      `&wind_speed_unit=kmh&precipitation_unit=mm&timezone=Europe/Luxembourg&forecast_days=1`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const c = data.current;
    return {
      temp:    Math.round(c.temperature_2m),
      rain:    c.precipitation,
      wind:    Math.round(c.wind_speed_10m),
      windDir: Math.round(c.wind_direction_10m ?? 0), // 0..359 — direction d'OÙ vient le vent
      code:    c.weather_code,
      label:   WMO_LABEL[c.weather_code] ?? "Météo inconnue",
      icon:    WMO_ICON[c.weather_code]  ?? "🌡",
    };
  } catch { return null; }
}

// ── Wind-aware ETA ────────────────────────────────────────────────
// Calcule le facteur de correction ETA selon l'angle entre la direction
// de déplacement (bearing) et la direction d'OÙ vient le vent (windDir).
// Retourne { factor, label, headWindKmh } où factor multiplie l'ETA.
//
// Modèle simplifié : vélo à 18 km/h, résistance air ∝ v_relative²
// - vent de face (180°) : ETA × ~1.20 à 25 km/h vent
// - vent dos    (0°)    : ETA × ~0.92 à 25 km/h vent
// - vent travers       : ~ neutre
export function windImpact(bearingDeg, windDir, windKmh) {
  if (windKmh < 5) return { factor: 1, label: null, headWindKmh: 0 };
  // Direction VERS laquelle le vent souffle
  const windToward = (windDir + 180) % 360;
  // Angle entre direction de déplacement et direction du vent
  // 0° = vent dans le dos, 180° = vent de face
  let rel = Math.abs(((windToward - bearingDeg + 540) % 360) - 180);
  // Composante de face (positive) ou dos (négative) du vent
  const headWind = Math.cos((180 - rel) * Math.PI / 180) * windKmh;
  // Facteur ETA : sensibilité ~0.6%/km/h vent de face
  const factor = Math.max(0.85, Math.min(1.35, 1 + headWind * 0.006));
  let label = null;
  if (headWind > 8)        label = "vent de face";
  else if (headWind < -8)  label = "vent dans le dos";
  else if (windKmh > 15)   label = "vent travers";
  return { factor, label, headWindKmh: Math.round(headWind) };
}

// Logique de décision : bike | mixed | transit
// Seuils : pluie > 0.5mm/h | vent > 35km/h | neige | orage
export function getWeatherAdvice(weather) {
  if (!weather) return { mode:"bike", reason:null };
  const { rain, wind, code } = weather;
  const isStorm    = code >= 95;
  const isSnow     = (code >= 71 && code <= 77) || code === 85 || code === 86;
  const heavyRain  = rain > 2.0;
  const lightRain  = rain > 0.5;
  const strongWind = wind > 35;
  const mildWind   = wind > 25;
  if (isStorm || isSnow || heavyRain || (strongWind && lightRain))
    return { mode:"transit", reason: isStorm?"orage": isSnow?"neige": heavyRain?"pluie forte":"vent fort + pluie" };
  if (lightRain || mildWind)
    return { mode:"mixed", reason: lightRain?"pluie légère":"vent modéré" };
  return { mode:"bike", reason:null };
}

// Hook React — rafraîchit toutes les 10min, se re-déclenche si GPS bouge de >1km
export function useWeather(gpsPos) {
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!gpsPos) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const w = await fetchWeather(gpsPos.lat, gpsPos.lng);
      if (!cancelled) { setWeather(w); setLoading(false); }
    };
    load();
    const t = setInterval(load, 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(t); };
  // Arrondi à 0.01° (~1km) pour éviter des re-fetches inutiles
  }, [gpsPos ? Math.round(gpsPos.lat * 100) : null,
      gpsPos ? Math.round(gpsPos.lng * 100) : null]);

  return { weather, loading };
}
