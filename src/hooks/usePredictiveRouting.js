// ── usePredictiveRouting — re-route automatique sur saturation station ─────
// Surveille la station de destination en arrière-plan pendant la navigation.
// Si la station devient inutilisable (0 vélos en mode pickup, 0 docks en mode
// dropoff), trouve la meilleure alternative dans un rayon raisonnable et
// propose à l'utilisateur de basculer.
//
// Usage:
//   const { suggestion, dismiss, accept } = usePredictiveRouting({
//     stations, navStation, gpsPos, navMode,    // état nav actuel
//     intent: "pickup" | "dropoff",             // pourquoi on va à cette station
//     active: navMode !== null,                 // surveillance ON/OFF
//   });
//
// Quand `suggestion` n'est pas null, l'UI peut afficher une bannière
// "Station saturée → alternative à 340m" + boutons accept/dismiss.

import { useState, useEffect, useRef } from "react";
import { haversine } from "../utils.js";
import { predictAvailability } from "./useAvailability.js";

// Rayon max de recherche d'alternative (m)
const ALT_RADIUS_M = 700;
// Détour maximum accepté vs trajet original (facteur)
const MAX_DETOUR_FACTOR = 1.5;
// Délai après lequel on peut re-suggérer (ms) — évite spam
const RESUGGEST_COOLDOWN_MS = 60_000;

/**
 * Évalue si une station est utilisable selon l'intention
 * @param {object} s — station avec bikes, docks
 * @param {string} intent — "pickup" (besoin de vélo) | "dropoff" (besoin de dock)
 * @returns {boolean}
 */
function isUsable(s, intent) {
  if (!s) return false;
  if (intent === "dropoff") return (s.docks ?? 0) >= 1;
  // Default pickup
  return (s.bikes ?? 0) >= 1;
}

/**
 * Score une station alternative (plus haut = mieux).
 * Combine: dispo (vélos/docks), distance depuis position user, distance
 * vs destination originale (préférer une station "sur le chemin").
 */
function scoreAlternative(s, intent, gpsPos, originalDest) {
  const stock = intent === "dropoff" ? (s.docks ?? 0) : (s.bikes ?? 0);
  if (stock < 1) return -Infinity;
  const distFromUser = haversine(gpsPos.lat, gpsPos.lng, s.lat, s.lng);
  const distFromOrig = haversine(originalDest.lat, originalDest.lng, s.lat, s.lng);
  // Bonus si la station a beaucoup de stock (résilient à un autre user qui prend juste avant nous)
  const stockBonus = Math.min(stock / 5, 1) * 100;
  // Pénalité distance — proche du user ET proche de la destination originale = bon
  return stockBonus - distFromUser * 0.3 - distFromOrig * 0.5;
}

// Seuils du mode PRÉDICTIF (v3.3) : on alerte AVANT la saturation si
// l'historique de dispo indique que la station sera probablement vide/pleine
// à l'heure d'arrivée. Garde-fous stricts pour éviter les fausses alertes :
const PRED_MIN_SAMPLES   = 8;     // historique mini avant de prédire
const PRED_STOCK_THRESH  = 0.8;   // dispo moyenne prédite < 0.8 = risque
const PRED_NOW_MAX_STOCK = 2;     // ne prédit que si la station est DÉJÀ basse
const PRED_MIN_ETA_S     = 240;   // inutile de prédire à <4 min de l'arrivée

/** Sélectionne la meilleure station alternative (partagé réactif/prédictif). */
function findBestAlternative({ stations, navStation, gpsPos, intent, dismissedIds }) {
  const distToOriginal = haversine(gpsPos.lat, gpsPos.lng, navStation.lat, navStation.lng);
  const candidates = stations
    .filter(s =>
      s.id !== navStation.id &&
      !dismissedIds.has(s.id) &&
      isUsable(s, intent) &&
      haversine(gpsPos.lat, gpsPos.lng, s.lat, s.lng) <= Math.max(distToOriginal * MAX_DETOUR_FACTOR, ALT_RADIUS_M)
    )
    .map(s => ({
      ...s,
      _score: scoreAlternative(s, intent, gpsPos, navStation),
      _distFromUser: haversine(gpsPos.lat, gpsPos.lng, s.lat, s.lng),
      _detourMeters: Math.round(haversine(gpsPos.lat, gpsPos.lng, s.lat, s.lng) - distToOriginal),
    }))
    .sort((a, b) => b._score - a._score);
  return candidates[0] ?? null;
}

export function usePredictiveRouting({
  stations,
  navStation,
  gpsPos,
  navMode,
  intent = "dropoff",  // par défaut : on va se garer
  active = false,
  etaSeconds = null,   // temps restant estimé (route.totalTime) — mode prédictif
}) {
  const [suggestion, setSuggestion] = useState(null);
  // Timestamps pour cooldown
  const lastSuggestRef = useRef(0);
  // Ne suggère pas la même station 2 fois (l'user l'a refusée)
  const dismissedIdsRef = useRef(new Set());

  useEffect(() => {
    if (!active || !navStation || !gpsPos || !stations?.length) {
      setSuggestion(null);
      return;
    }

    // Trouver la station courante dans le set de stations à jour
    const current = stations.find(s => s.id === navStation.id);
    if (!current) return;

    // ── Branche 1 : station encore utilisable → check PRÉDICTIF ───────
    if (isUsable(current, intent)) {
      // Si on avait une suggestion mais la station originale est revenue dispo
      if (suggestion && current.id === navStation.id) setSuggestion(null);

      // Mode prédictif : la station est OK maintenant, mais le sera-t-elle
      // encore quand on ARRIVE ? Historique de dispo par (jour, quart d'heure).
      const nowStock = intent === "dropoff" ? (current.docks ?? 0) : (current.bikes ?? 0);
      if (etaSeconds && etaSeconds >= PRED_MIN_ETA_S &&
          nowStock <= PRED_NOW_MAX_STOCK &&
          Date.now() - lastSuggestRef.current >= RESUGGEST_COOLDOWN_MS) {
        let cancelled = false;
        predictAvailability(current.id, new Date(Date.now() + etaSeconds * 1000)).then(p => {
          if (cancelled || !p || p.samples < PRED_MIN_SAMPLES) return;
          const predicted = intent === "dropoff" ? p.docks : p.bikes;
          if (predicted >= PRED_STOCK_THRESH) return;
          const best = findBestAlternative({
            stations, navStation, gpsPos, intent,
            dismissedIds: dismissedIdsRef.current,
          });
          if (!best) return;
          lastSuggestRef.current = Date.now();
          setSuggestion({
            station: best,
            reason: intent === "dropoff"
              ? `${navStation.name} : risque de saturation à l'arrivée (~${Math.round(etaSeconds/60)}min)`
              : `${navStation.name} : risque d'être vide à l'arrivée (~${Math.round(etaSeconds/60)}min)`,
            detourMeters: best._detourMeters,
            stockAvailable: intent === "dropoff" ? best.docks : best.bikes,
            intent,
            predictive: true,
          });
        });
        return () => { cancelled = true; };
      }
      return;
    }

    // ── Branche 2 : station saturée MAINTENANT (mode réactif) ─────────
    // Cooldown : ne pas spam des suggestions
    if (Date.now() - lastSuggestRef.current < RESUGGEST_COOLDOWN_MS) return;

    const best = findBestAlternative({
      stations, navStation, gpsPos, intent,
      dismissedIds: dismissedIdsRef.current,
    });
    if (!best) return;

    lastSuggestRef.current = Date.now();
    setSuggestion({
      station: best,
      reason: intent === "dropoff"
        ? `${navStation.name} : 0 dock libre`
        : `${navStation.name} : aucun vélo`,
      detourMeters: best._detourMeters,
      stockAvailable: intent === "dropoff" ? best.docks : best.bikes,
      intent,
    });
  // Surveille uniquement les changements significatifs de la station courante
  // (pas chaque tick GPS — sinon on recalcule à 1Hz pour rien)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active, navStation?.id, intent, etaSeconds == null ? null : Math.round(etaSeconds / 60),
    // Trigger sur changement de stock de la station courante
    stations?.find(s => s.id === navStation?.id)?.bikes,
    stations?.find(s => s.id === navStation?.id)?.docks,
  ]);

  const dismiss = () => {
    if (suggestion) dismissedIdsRef.current.add(suggestion.station.id);
    setSuggestion(null);
  };

  const accept = (onAccept) => {
    if (suggestion && onAccept) onAccept(suggestion.station);
    setSuggestion(null);
  };

  // Reset dismissed quand la nav change (nouvelle destination = nouvelle vie)
  useEffect(() => {
    dismissedIdsRef.current.clear();
    lastSuggestRef.current = 0;
  }, [navStation?.id, active]);

  return { suggestion, dismiss, accept };
}
