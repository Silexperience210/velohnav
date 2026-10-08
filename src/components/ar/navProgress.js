// ── navProgress.js — progression dans les étapes (pur, testé) ───────
// Partagé par RouteOverlay (HUD, flèches) et utilisable par l'audio : une
// seule définition de « l'étape courante ».
import { haversine } from "../../utils.js";

/** Distance (m) sous laquelle un point de manœuvre est considéré franchi. */
export const STEP_PASS_M = 25;

/**
 * Avance l'index d'étape tant que le point courant est franchi (plusieurs d'un
 * coup si le GPS a sauté). Ne dépasse jamais le dernier point (l'arrivée).
 */
export function advanceStep(waypoints, step, pos, passM = STEP_PASS_M) {
  if (!waypoints?.length || !pos) return 0;
  let i = Math.min(Math.max(0, step | 0), waypoints.length - 1);
  while (i < waypoints.length - 1 &&
         haversine(pos.lat, pos.lng, waypoints[i].lat, waypoints[i].lng) < passM) i++;
  return i;
}

/**
 * Réducteur de progression : `state = { route, step }`.
 * Quand l'itinéraire est REMPLACÉ (recalcul hors-route, rafraîchissement tous
 * les 60 m, bascule de station), l'ancien index ne veut plus rien dire : le
 * nouveau tracé part de la position actuelle, on repart donc de 0. Avant, un
 * index 3 appliqué à un nouveau tracé de 2 points donnait `waypoints[3]`
 * indéfini (HUD « 0 m CONTINUEZ ») ou sautait des manœuvres.
 */
export function progressFor(state, route, pos, passM = STEP_PASS_M) {
  const base = state?.route === route ? state.step : 0;
  if (!route?.waypoints?.length) return { route, step: 0 };
  return { route, step: advanceStep(route.waypoints, base, pos, passM) };
}

/** Clé stable d'un point de manœuvre (indépendante de son index dans la route). */
export function waypointKey(wp) {
  return `${wp.lat.toFixed(5)},${wp.lng.toFixed(5)}`;
}

/**
 * Distance restante (m) le long du tracé : de la position au sommet le plus
 * proche, puis le reste de la polyligne. `fromIdx` limite la recherche du
 * sommet le plus proche à la partie non parcourue (tracés qui se recroisent).
 */
export function remainingAlongRoute(coords, pos, fromIdx = 0) {
  if (!coords?.length || !pos) return null;
  let best = Infinity, bi = fromIdx;
  for (let i = fromIdx; i < coords.length; i++) {
    const d = haversine(pos.lat, pos.lng, coords[i].lat, coords[i].lng);
    if (d < best) { best = d; bi = i; }
  }
  let rest = 0;
  for (let i = bi; i < coords.length - 1; i++)
    rest += haversine(coords[i].lat, coords[i].lng, coords[i + 1].lat, coords[i + 1].lng);
  return best + rest;
}
