// ── Projection GPS → Canvas AR ─────────────────────────────────────
// Convertit un point GPS en coordonnées canvas via bearing + distance.
// Utilisé par RouteOverlay pour projeter le tracé de route en AR.
import { haversine, getBearing } from "../../utils.js";
import { AR_RADIUS, LENS_HFOV_DEG, pinX, pinY, relBearing } from "./arProjection.js";

// Constantes — ajustées pour visibilité sans dérive excessive.
const PROJ_MAX_DIST    = 500;  // m — au-delà : invisible (bruit GPS dominant)
const PROJ_BEHIND_MAX  = 90;   // ±90° = limite physique : tout ce qui est au-delà est DERRIÈRE
                                // → on ne projette JAMAIS un point derrière (sinon le tracé
                                //    se replie aux bords et donne l'illusion d'un virage).

/**
 * Projette un point GPS sur le canvas AR via bearing + distance.
 * Même géométrie que les pins (arProjection.pinX/pinY) : avant, le tracé
 * utilisait ±50° (100° sur la largeur) et les pins 68° — à 20° de cap, le
 * tracé et le pin de la même destination étaient à 35 px l'un de l'autre.
 * @param {boolean} clamp — si true, projette quand même les points hors champ visible
 *                          (utile pour relier la ligne sans coupures brutales) — MAIS
 *                          jamais au-delà de ±90° (point physiquement derrière).
 * @param {number} fov — champ horizontal affiché (arProjection.effectiveHFov)
 * @returns {{x:number, y:number, inFov:boolean, behind:boolean, relBear:number, dist:number} | null}
 *          - null    : point au-delà de PROJ_MAX_DIST OU strictement derrière (>90°)
 *          - inFov   : true si dans le champ visible (FOV)
 *          - behind  : true si latéral (entre FOV et 90°) — le caller peut décider
 *                      de l'afficher en "edge marker" plutôt qu'en tracé continu.
 */
export function projectPoint(fromLat, fromLng, heading, toLat, toLng, W, H, clamp = false, fov = LENS_HFOV_DEG) {
  const dist = haversine(fromLat, fromLng, toLat, toLng);
  if (dist > PROJ_MAX_DIST) return null;

  const bear    = getBearing(fromLat, fromLng, toLat, toLng);
  const relBear = relBearing(bear, heading); // -180..+180
  const absRel  = Math.abs(relBear);

  // FIX BUG-1 : un point physiquement derrière la caméra (>90° de la direction)
  // ne DOIT PAS être projeté. L'ancien code clampait à ±75° (FOV*1.5), ce qui
  // projetait les points derrière sur les bords de l'écran et donnait l'illusion
  // que la route partait à gauche/droite alors qu'elle revenait derrière soi.
  if (absRel > PROJ_BEHIND_MAX) return null;

  const half   = fov / 2;
  const inFov  = absRel <= half;
  const behind = !inFov; // entre FOV et 90° = visible en bord d'écran mais pas devant

  if (!inFov && !clamp) return null;

  // Les points entre le bord du champ et 90° sont « collés » au bord d'écran :
  // ils indiquent la direction sans laisser le tracé sortir de l'écran.
  const clamped = Math.max(-half, Math.min(half, relBear));
  const x = W * pinX(clamped, fov) / 100;
  const y = H * pinY(dist, AR_RADIUS) / 100;

  return { x, y, inFov, behind, relBear, dist };
}

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
