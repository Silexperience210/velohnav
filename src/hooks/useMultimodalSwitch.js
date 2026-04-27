// ── useMultimodalSwitch — bascule vélo→bus→vélo si météo dégrade ──────
// Surveille en temps réel :
// 1. La météo OpenMeteo "now" (radar pluie)
// 2. La nav active (mode + station de destination)
// 3. Les arrêts de bus proches (via useTransit)
//
// Si la pluie démarre / s'intensifie pendant un trajet vélo, l'app calcule
// un itinéraire combiné : vélo jusqu'à la station X (proche du user et
// proche d'un arrêt de bus), prendre le bus N qui passe dans Y min,
// descendre à l'arrêt Z proche de la destination, repartir d'une station
// vélo proche.
//
// Approche pragmatique :
// - On ne re-route pas le tracé OSRM (trop coûteux + complexe)
// - On suggère un point de pivot : "Stop à station X dans Ym, bus N à
//   Z heures, descendre à arrêt B, station Y à 200m"
// - L'user accepte → la nav redirige vers la station X intermédiaire

import { useState, useEffect, useRef } from "react";
import { haversine } from "../utils.js";
import { fetchWeather } from "./useWeather.js";

const POLL_INTERVAL_MS = 90_000;       // recheck météo toutes les 90s pendant nav
const MIN_RAIN_TRIGGER = 0.4;          // mm/h — seuil pluie légère
const STORM_TRIGGER    = 1.5;          // mm/h — seuil pluie forte (suggest immédiat)
const MIN_TRIP_LENGTH  = 1500;         // m — pas de switch si trajet court
const COOLDOWN_MS      = 5 * 60_000;   // 5 min entre 2 suggestions

/**
 * Score un point de pivot — combinaison station vélo + arrêt bus proche.
 * On veut: station avec docks libres + arrêt bus < 200m + bus dans 2-12 min.
 */
function scorePivot({ station, busStop, departure, distFromUser }) {
  if (!departure) return -Infinity;
  const minutesToBus = parseInt(departure.time?.split(":")[0]) * 60 +
                       parseInt(departure.time?.split(":")[1]) -
                       (new Date().getHours() * 60 + new Date().getMinutes());
  if (minutesToBus < 2 || minutesToBus > 15) return -Infinity;
  if (departure.cancelled) return -Infinity;

  const stopDist = haversine(station.lat, station.lng, busStop.lat, busStop.lng);
  if (stopDist > 250) return -Infinity;

  // Bonus: docks libres, bus rapide (mais pas trop proche), station proche user
  const docksBonus = Math.min(station.docks ?? 0, 5) * 8;
  const timingBonus = 30 - Math.abs(minutesToBus - 6);  // sweet spot ~6 min
  const distPenalty = distFromUser * 0.02;
  const stopProxBonus = (250 - stopDist) * 0.3;

  return docksBonus + timingBonus + stopProxBonus - distPenalty;
}

export function useMultimodalSwitch({
  gpsPos,
  weather,
  navStation,
  navMode,
  stations,
  transitStops,
  transitDepartures,
  active = false,
}) {
  const [suggestion, setSuggestion] = useState(null);
  const lastTriggerRef = useRef(0);
  const lastWeatherRef = useRef(null);

  // Polling météo "now" pendant nav active (overrides global useWeather avec
  // une fréquence plus rapide — 90s vs 10min).
  useEffect(() => {
    if (!active || !gpsPos || navMode !== "cycling") return;
    let cancelled = false;
    const tick = async () => {
      const fresh = await fetchWeather(gpsPos.lat, gpsPos.lng);
      if (cancelled || !fresh) return;
      lastWeatherRef.current = fresh;
      evaluateSwitch(fresh);
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, gpsPos?.lat, gpsPos?.lng, navMode]);

  // Évalue si on doit déclencher une suggestion
  const evaluateSwitch = (currentWeather) => {
    if (!currentWeather || !active || !navStation || !gpsPos || navMode !== "cycling") return;
    if (Date.now() - lastTriggerRef.current < COOLDOWN_MS) return;

    const { rain, code } = currentWeather;
    const isStorm = code >= 95;          // orage
    const isHeavyRain = rain >= STORM_TRIGGER;
    const isLightRain = rain >= MIN_RAIN_TRIGGER;

    if (!isStorm && !isHeavyRain && !isLightRain) {
      setSuggestion(null);
      return;
    }

    // Distance restante jusqu'à destination — pas la peine si trajet court
    const remainDist = haversine(gpsPos.lat, gpsPos.lng, navStation.lat, navStation.lng);
    if (remainDist < MIN_TRIP_LENGTH) return;

    // Pluie légère = suggestion seulement si trajet > 3km
    if (isLightRain && !isHeavyRain && !isStorm && remainDist < 3000) return;

    // Trouver le meilleur point de pivot
    if (!stations?.length || !transitStops?.length) return;

    const candidates = [];
    for (const stop of transitStops) {
      const stopDeps = transitDepartures[stop.id];
      if (!stopDeps?.length) continue;
      // Stations vélo proches de cet arrêt avec docks libres
      const nearbyStations = stations.filter(s =>
        (s.docks ?? 0) >= 1 &&
        haversine(s.lat, s.lng, stop.lat, stop.lng) < 250
      );
      for (const station of nearbyStations) {
        const distFromUser = haversine(gpsPos.lat, gpsPos.lng, station.lat, station.lng);
        // Le pivot doit être SUR LE CHEMIN — pas à l'opposé
        const distFromUserToDestViaStation =
          distFromUser + haversine(station.lat, station.lng, navStation.lat, navStation.lng);
        if (distFromUserToDestViaStation > remainDist * 1.4) continue;
        if (distFromUser < 300 || distFromUser > remainDist * 0.7) continue;
        for (const dep of stopDeps.slice(0, 3)) {
          candidates.push({
            station, busStop: stop, departure: dep, distFromUser,
            score: scorePivot({ station, busStop: stop, departure: dep, distFromUser }),
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.score === -Infinity) return;

    lastTriggerRef.current = Date.now();
    setSuggestion({
      reason: isStorm ? "Orage en approche"
            : isHeavyRain ? `Pluie forte (${rain.toFixed(1)}mm/h)`
            : `Pluie (${rain.toFixed(1)}mm/h)`,
      pivotStation: best.station,
      busStop: best.busStop,
      busLine: best.departure.line,
      busDirection: best.departure.direction,
      busTime: best.departure.rtTime || best.departure.time,
      distFromUser: best.distFromUser,
      stopDistFromStation: Math.round(haversine(
        best.station.lat, best.station.lng,
        best.busStop.lat, best.busStop.lng
      )),
    });
  };

  // Re-évaluer si la météo prop change (le hook global useWeather)
  useEffect(() => {
    if (weather && active) evaluateSwitch(weather);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weather?.rain, weather?.code, active, navStation?.id]);

  const dismiss = () => {
    setSuggestion(null);
    lastTriggerRef.current = Date.now();  // freeze cooldown
  };
  const accept = (onAccept) => {
    if (suggestion && onAccept) onAccept(suggestion.pivotStation);
    setSuggestion(null);
  };

  return { mmSuggestion: suggestion, mmDismiss: dismiss, mmAccept: accept };
}
