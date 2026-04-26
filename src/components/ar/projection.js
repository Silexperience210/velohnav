// ── Projection GPS → Canvas AR ─────────────────────────────────────
// Convertit un point GPS en coordonnées canvas via bearing + distance.
// Utilisé par RouteOverlay pour projeter le tracé de route en AR.
import { haversine, getBearing } from "../../utils.js";

// Constantes — ajustées pour visibilité sans dérive excessive.
const PROJ_MAX_DIST = 500;  // m — au-delà : invisible (bruit GPS dominant)
const PROJ_FOV_H    = 50;   // demi-FOV horizontal ±50° (plus large = plus de pts visibles)

/**
 * Projette un point GPS sur le canvas AR via bearing + distance.
 * @param {boolean} clamp — si true, projette quand même les points hors champ
 *                          (utile pour relier la ligne sans coupures brutales)
 * @returns {{x: number, y: number, inFov: boolean} | null}
 */
export function projectPoint(fromLat, fromLng, heading, toLat, toLng, W, H, clamp = false) {
  const dist = haversine(fromLat, fromLng, toLat, toLng);
  if (dist > PROJ_MAX_DIST) return null;

  const bear    = getBearing(fromLat, fromLng, toLat, toLng);
  const relBear = ((bear - heading + 540) % 360) - 180; // -180..+180

  const inFov = Math.abs(relBear) <= PROJ_FOV_H;
  if (!inFov && !clamp) return null;

  // Clamp horizontal aux bords du FOV pour les points proches mais hors champ
  // (évite les sauts brutaux de la ligne quand on tourne la tête)
  const clamped = Math.max(-PROJ_FOV_H * 1.5, Math.min(PROJ_FOV_H * 1.5, relBear));
  const x = W / 2 + (clamped / PROJ_FOV_H) * (W / 2);

  // Proche = bas de l'écran (y grand), lointain = horizon (~30% du haut)
  // Courbe non linéaire (sqrt) : effet perspective plus naturel.
  const t = Math.sqrt(dist / PROJ_MAX_DIST); // 0..1
  const y = H * (0.92 - t * 0.62);           // 92% → 30% du haut

  return { x, y, inFov };
}
