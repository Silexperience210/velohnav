import { useState, useEffect } from "react";
import { WMO_LABEL, WMO_ICON } from "../constants.js";

function useWeather(gpsPos) {
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(()=>{
    if (!gpsPos) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const w = await fetchWeather(gpsPos.lat, gpsPos.lng);
      if (!cancelled) { setWeather(w); setLoading(false); }
    };
    load();
    const t = setInterval(load, 10 * 60 * 1000); // refresh 10min
    return () => { cancelled = true; clearInterval(t); };
  // Dep: arrondi à 0.01° (~1km) pour éviter des re-fetches inutiles
  }, [gpsPos ? Math.round(gpsPos.lat * 100) : null, gpsPos ? Math.round(gpsPos.lng * 100) : null]);

  return { weather, loading };
}

// ── ARRÊTS TRAM & BUS MAJEURS — Luxembourg-Ville ─────────────────
// Source : mobiliteit.lu — 22 arrêts stratégiques couvrant le réseau
const TRANSIT_STOPS = [
  // Tram ligne 1
  { id:"T01", name:"Luxexpo",            lat:49.6267, lng:6.1651, lines:["T1"],         type:"tram" },
  { id:"T02", name:"Kirchberg P+R",      lat:49.6248, lng:6.1588, lines:["T1"],         type:"tram" },
  { id:"T03", name:"Philharmonie MUDAM", lat:49.6219, lng:6.1520, lines:["T1"],         type:"tram" },
  { id:"T04", name:"Européen",           lat:49.6183, lng:6.1432, lines:["T1"],         type:"tram" },
  { id:"T05", name:"Alphonse Weicker",   lat:49.6154, lng:6.1378, lines:["T1"],         type:"tram" },
  { id:"T06", name:"Hamilius",           lat:49.6118, lng:6.1299, lines:["T1","1","2"], type:"tram" },
  { id:"T07", name:"Place de Paris",     lat:49.6073, lng:6.1285, lines:["T1","16"],    type:"tram" },
  { id:"T08", name:"Stade de Lux.",      lat:49.6019, lng:6.1260, lines:["T1"],         type:"tram" },
  { id:"T09", name:"Lycée Bouneweg",     lat:49.5979, lng:6.1252, lines:["T1"],         type:"tram" },
  { id:"T10", name:"Gare Centrale",      lat:49.5998, lng:6.1340, lines:["T1","bus"],   type:"tram" },
  // Bus + Gare
  { id:"B01", name:"Gare Routière",      lat:49.6005, lng:6.1320, lines:["1","2","3","4","5","16","18"],type:"bus" },
  { id:"B02", name:"Cloche d'Or",        lat:49.5817, lng:6.1333, lines:["1","25"],     type:"bus" },
  { id:"B03", name:"Limpertsberg",       lat:49.6153, lng:6.1243, lines:["3","4"],      type:"bus" },
  { id:"B04", name:"Belair Résidence",   lat:49.6092, lng:6.1175, lines:["5"],          type:"bus" },
  { id:"B05", name:"Clausen Bierger",    lat:49.6107, lng:6.1442, lines:["9"],          type:"bus" },
  { id:"B06", name:"Bonnevoie Hollerich",lat:49.5948, lng:6.1322, lines:["2"],          type:"bus" },
  { id:"B07", name:"Merl Betzenberg",    lat:49.6078, lng:6.1082, lines:["6"],          type:"bus" },
  { id:"B08", name:"Cents Schleed",      lat:49.6152, lng:6.1624, lines:["14"],         type:"bus" },
  { id:"B09", name:"Kirchberg Campus",   lat:49.6196, lng:6.1558, lines:["27"],         type:"bus" },
  { id:"B10", name:"Grund Pfaffenthal",  lat:49.6082, lng:6.1394, lines:["9"],          type:"bus" },
  { id:"B11", name:"Verlorenkost",       lat:49.6133, lng:6.1205, lines:["4"],          type:"bus" },
  { id:"B12", name:"Cessange",           lat:49.5905, lng:6.1204, lines:["1","4"],      type:"bus" },
];

// Trouver l'arrêt TC le plus proche d'une position
function nearestStop(lat, lng) {
  let best = null, bestDist = Infinity;
  TRANSIT_STOPS.forEach(s => {
    const d = Math.sqrt((s.lat-lat)**2 + (s.lng-lng)**2) * 111000; // approx mètres
    if (d < bestDist) { bestDist = d; best = { ...s, distM: Math.round(d) }; }
  });
  return best;
}


export { useWeather, fetchWeather, getWeatherAdvice };
