// ── Projection GPS → Canvas AR ─────────────────────────────────────
// Convertit un point GPS en coordonnées canvas via bearing + distance.
// Utilisé par RouteOverlay pour projeter le tracé de route en AR.
import { haversine, getBearing } from "../../utils.js";

/**
 * Projette un point GPS sur le canvas AR via bearing + distance.
 * @returns {{x: number, y: number} | null} coords canvas, ou null si hors champ
 */
export function projectPoint(fromLat, fromLng, heading, toLat, toLng, W, H) {
  const dist = haversine(fromLat, fromLng, toLat, toLng);
  if (dist > 300) return null;                    // limite à 300m — au-delà trop imprécis
  const bear    = getBearing(fromLat, fromLng, toLat, toLng);
  const relBear = ((bear - heading + 540) % 360) - 180; // -180..+180
  const FOV_H   = 45;                             // demi-FOV horizontal ±45°
  if (Math.abs(relBear) > FOV_H) return null;
  const x = W / 2 + (relBear / FOV_H) * (W / 2);
  // Proche = bas de l'écran (y grand), lointain = horizon (~35% du haut)
  const t = dist / 300;                           // 0=ici, 1=300m
  const y = H * (0.9 - t * 0.55);                 // 90%→35% du haut
  return { x, y };
}
