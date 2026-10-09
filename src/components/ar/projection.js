// ── Tracé AR : « mauvais sens » et distance au tracé ───────────────
// La projection à l'écran des points au sol vit dans groundProjection.js
// (l'ancienne projectPoint plaçait le tracé selon la convention des étiquettes
// pinY — sans inclinaison ni hauteur de caméra — et a été retirée).
import { haversine, getBearing } from "../../utils.js";
import { relBearing } from "./arProjection.js";

/**
 * Détermine si la PROCHAINE portion utile d'un itinéraire est principalement
 * DERRIÈRE l'utilisateur — auquel cas un tracé AR continu n'a pas de sens et
 * il vaut mieux afficher un overlay "FAITES DEMI-TOUR".
 *
 * Heuristique : on regarde les premiers points de la polyline (~150m devant
 * en distance accumulée le long du tracé). Si la majorité a relBear > 90°,
 * on considère que l'utilisateur regarde dans le mauvais sens.
 *
 * @param {Array<{lat:number,lng:number}>} coords — polyline route
 * @param {{lat:number,lng:number}} gpsPos
 * @param {number} heading — cap actuel (degrés, 0=N)
 * @param {number} sampleMeters — distance le long de la polyline à analyser (défaut 150m)
 * @returns {{wrongWay:boolean, ratio:number, sampleSize:number}}
 */
export function detectWrongWay(coords, gpsPos, heading, sampleMeters = 150) {
  if (!coords?.length || !gpsPos || heading == null) {
    return { wrongWay: false, ratio: 0, sampleSize: 0 };
  }
  let total = 0, behind = 0, accDist = 0;
  let prev = { lat: gpsPos.lat, lng: gpsPos.lng };
  for (const p of coords) {
    const seg = haversine(prev.lat, prev.lng, p.lat, p.lng);
    accDist += seg;
    prev = p;
    if (accDist < 5) continue; // ignorer les points trop proches (bruit GPS)
    total++;
    const bear = getBearing(gpsPos.lat, gpsPos.lng, p.lat, p.lng);
    if (Math.abs(relBearing(bear, heading)) > 90) behind++;
    if (accDist >= sampleMeters) break;
  }
  if (total === 0) return { wrongWay: false, ratio: 0, sampleSize: 0 };
  const ratio = behind / total;
  return { wrongWay: ratio >= 0.6, ratio, sampleSize: total };
}

/** Seuils d'hystérésis du « mauvais sens » : on entre à 60 %, on ne sort que sous 40 %. */
export const WRONG_WAY_ON  = 0.6;
export const WRONG_WAY_OFF = 0.4;

/**
 * État « mauvais sens » avec hystérésis. Avec un seuil unique (0,6), un cap
 * qui oscille de quelques degrés autour de la frontière faisait clignoter
 * l'écran entre le tracé et l'overlay plein écran « DEMI-TOUR ».
 * @param {boolean} prev  état précédent
 * @param {{ratio:number, sampleSize:number}} ww  résultat de detectWrongWay
 */
export function wrongWayHysteresis(prev, ww) {
  if (!ww || ww.sampleSize === 0) return false;
  return prev ? ww.ratio >= WRONG_WAY_OFF : ww.ratio >= WRONG_WAY_ON;
}

/**
 * Calcule la distance minimum entre un point GPS et la polyline d'itinéraire.
 * Utilisé pour la détection off-route et le re-routing automatique.
 *
 * Approximation : distance au sommet le plus proche (pas de projection segment
 * exacte). Suffisant pour détecter un écart > 25-30m, ce qui est notre seuil
 * de déclenchement re-route.
 *
 * @returns {number} distance en mètres (Infinity si polyline vide)
 */
export function distanceToRoute(coords, lat, lng) {
  if (!coords?.length) return Infinity;
  let best = Infinity;
  for (const p of coords) {
    const d = haversine(lat, lng, p.lat, p.lng);
    if (d < best) best = d;
  }
  return best;
}
