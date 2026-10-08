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
//
// v4 — source primaire : planification Transitous (plan « bike & ride »
// position → destination). Contrairement à l'heuristique locale, elle sait
// si la ligne VA vers la destination. Une seule requête par fenêtre de
// PLAN_COOLDOWN_MS (le routage est coûteux pour Transitous). Repli sur
// l'heuristique arrêts/départs proches si le plan échoue ou ne donne rien.

import { useState, useEffect, useRef, useCallback } from "react";
import { haversine } from "../utils.js";
import { fetchWeather } from "./useWeather.js";
import { fetchPlan, isTransitLeg, itineraryLines, toHHMM } from "../utils/transitous.js";

const POLL_INTERVAL_MS = 90_000;       // recheck météo toutes les 90s pendant nav
const MIN_RAIN_TRIGGER = 0.4;          // mm/h — seuil pluie légère
const STORM_TRIGGER    = 1.5;          // mm/h — seuil pluie forte (suggest immédiat)
const MIN_TRIP_LENGTH  = 1500;         // m — pas de switch si trajet court
const COOLDOWN_MS      = 5 * 60_000;   // 5 min entre 2 suggestions
const PLAN_COOLDOWN_MS = 5 * 60_000;   // 5 min entre 2 requêtes plan Transitous
const PIVOT_MAX_STOP_DIST = 250;       // m — station de dépôt ↔ arrêt d'embarquement
const WALK_M_PER_MIN   = 80;
const MAX_WAIT_MIN     = 15;           // itinéraire qui part trop tard = pas une bascule

/**
 * Calcule les minutes restantes jusqu'à l'heure HH:MM (gère le passage à minuit).
 * Retourne NaN si le format est invalide.
 */
function minutesUntilTime(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return NaN;
  const parts = timeStr.split(":");
  if (parts.length < 2) return NaN;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return NaN;
  const now = new Date();
  const targetMin = h * 60 + m;
  const nowMin    = now.getHours() * 60 + now.getMinutes();
  let diff = targetMin - nowMin;
  // Si l'écart est négatif (≤ -2h), c'est probablement le lendemain
  if (diff < -120) diff += 24 * 60;
  return diff;
}

/**
 * Score un point de pivot — combinaison station vélo + arrêt bus proche.
 * On veut: station avec docks libres + arrêt bus < 200m + bus dans 2-15 min.
 */
function scorePivot({ station, busStop, departure, distFromUser }) {
  if (!departure) return -Infinity;
  const minutesToBus = minutesUntilTime(departure.rtTime || departure.time);
  if (isNaN(minutesToBus) || minutesToBus < 2 || minutesToBus > 15) return -Infinity;
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

/**
 * Choisit le meilleur itinéraire « bike & ride » d'un plan Transitous parsé
 * (utils/transitous.parsePlan) et le traduit en suggestion de pivot au même
 * format que l'heuristique locale (pivotStation, busStop, busLine, busTime…).
 *
 * MOTIS optimise l'accès vélo jusqu'à l'arrêt mais ignore les bornes Vel'OH! :
 * on exige une station avec ≥1 borne libre à ≤250 m de l'arrêt d'embarquement,
 * et que la marche station → arrêt tienne dans la marge avant le départ.
 * Pure — exportée pour les tests.
 */
export function planToSwitchSuggestion(plan, { stations, gpsPos, now = Date.now() }) {
  if (!plan?.itineraries?.length || !stations?.length || !gpsPos) return null;
  const bikeDirect = plan.direct?.find(it => it.legs.every(l => l.mode === "BIKE"));
  let best = null;
  for (const it of plan.itineraries) {
    const ti = it.legs.findIndex(isTransitLeg);
    if (ti < 0) continue;
    const tLeg = it.legs[ti];
    if (tLeg.cancelled) continue;
    const board = tLeg.from;
    if (!board || !Number.isFinite(board.lat)) continue;
    // MOTIS décale le départ de l'itinéraire pour que l'accès finisse pile au
    // passage du bus : la marge réelle se mesure depuis MAINTENANT.
    const departAt = Date.parse(tLeg.startTime);
    const leaveInMin = (Date.parse(it.startTime) - now) / 60000;
    if (!Number.isFinite(departAt) || !Number.isFinite(leaveInMin)) continue;
    if (leaveInMin < -1 || leaveInMin > MAX_WAIT_MIN) continue;
    const accessMin = it.legs.slice(0, ti).reduce((n, l) => n + (l.duration || 0), 0) / 60;
    const slackMin = (departAt - now) / 60000 - accessMin;

    let pivot = null, pivotDist = Infinity;
    for (const s of stations) {
      if ((s.docks ?? 0) < 1 || s.status === "CLOSED" || !s.lat) continue;
      const d = haversine(s.lat, s.lng, board.lat, board.lng);
      if (d <= PIVOT_MAX_STOP_DIST && d < pivotDist) { pivot = s; pivotDist = d; }
    }
    if (!pivot) continue;
    if (pivotDist / WALK_M_PER_MIN > slackMin) continue; // bus raté

    // Score = durée totale (min) + pénalité correspondances + marche au pivot
    const score = it.duration / 60 + it.transfers * 3 + pivotDist / WALK_M_PER_MIN;
    if (!best || score < best.score) best = { it, tLeg, board, pivot, pivotDist, score };
  }
  if (!best) return null;
  const { it, tLeg, board, pivot, pivotDist } = best;
  return {
    pivotStation: pivot,
    busStop: { id: board.stopId, name: board.name, lat: board.lat, lng: board.lng },
    busLine: tLeg.line || tLeg.mode,
    busDirection: tLeg.headsign || tLeg.to?.name || "",
    busTime: toHHMM(tLeg.startTime),
    distFromUser: haversine(gpsPos.lat, gpsPos.lng, pivot.lat, pivot.lng),
    stopDistFromStation: Math.round(pivotDist),
    lines: itineraryLines(it),
    totalMinutes: Math.round(it.duration / 60),
    bikeMinutes: bikeDirect ? Math.round(bikeDirect.duration / 60) : null,
    source: "transitous",
  };
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
  planFetcher = fetchPlan,   // injectable (tests) — null = heuristique seule
}) {
  const [suggestion, setSuggestion] = useState(null);
  const lastTriggerRef = useRef(0);
  const lastWeatherRef = useRef(null);
  const lastPlanAtRef  = useRef(0);
  const planInFlightRef = useRef(false);

  // Polling météo "now" pendant nav active (overrides global useWeather avec
  // une fréquence plus rapide — 90s vs 10min).
  // La position est lue par référence : la mettre en dépendance recréait
  // l'intervalle à chaque tick GPS et rappelait la météo toutes les secondes.
  const gpsRef = useRef(gpsPos);
  useEffect(() => { gpsRef.current = gpsPos; }, [gpsPos]);

  useEffect(() => {
    if (!active || !gpsRef.current || navMode !== "cycling") return;
    let cancelled = false;
    const tick = async () => {
      const pos = gpsRef.current;
      if (!pos) return;
      const fresh = await fetchWeather(pos.lat, pos.lng);
      if (cancelled || !fresh) return;
      lastWeatherRef.current = fresh;
      evaluateSwitch(fresh);
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, navMode]);

  // Heuristique historique : station pivot proche d'un arrêt avec un départ
  // imminent. Ne connaît pas la direction des lignes → repli uniquement.
  const heuristicSwitch = useCallback((reason, remainDist) => {
    if (!stations?.length || !transitStops?.length || !gpsPos || !navStation) return;

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
      reason,
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
      source: "heuristic",
    });
  }, [gpsPos, navStation, stations, transitStops, transitDepartures]);

  // Évalue si on doit déclencher une suggestion
  const evaluateSwitch = useCallback((currentWeather) => {
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

    const reason = isStorm ? "Orage en approche"
                 : isHeavyRain ? `Pluie forte (${rain.toFixed(1)}mm/h)`
                 : `Pluie (${rain.toFixed(1)}mm/h)`;

    // ── 1. Plan Transitous (bike & ride → destination) ────────────────
    if (planFetcher && !planInFlightRef.current &&
        Date.now() - lastPlanAtRef.current >= PLAN_COOLDOWN_MS) {
      planInFlightRef.current = true;
      lastPlanAtRef.current = Date.now();
      planFetcher(gpsPos, navStation)
        .then(plan => {
          const s = planToSwitchSuggestion(plan, { stations, gpsPos });
          if (s) {
            lastTriggerRef.current = Date.now();
            setSuggestion({ ...s, reason });
          } else {
            heuristicSwitch(reason, remainDist);
          }
        })
        .catch(e => {
          console.warn("[Multimodal] plan Transitous:", e?.message || e);
          heuristicSwitch(reason, remainDist);
        })
        .finally(() => { planInFlightRef.current = false; });
      return;
    }
    if (planInFlightRef.current) return;

    // ── 2. Heuristique locale (arrêts + départs proches) ──────────────
    heuristicSwitch(reason, remainDist);
  }, [active, gpsPos, navStation, navMode, stations, planFetcher, heuristicSwitch]);


  // Re-évaluer si la météo prop change (le hook global useWeather)
  useEffect(() => {
    if (weather && active) evaluateSwitch(weather);
  }, [weather, active, navStation?.id, evaluateSwitch]);

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
