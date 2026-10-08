// ── arProjection.js — géométrie pure de l'écran AR (aucune dépendance React) ──
// Extrait de ARScreen.jsx pour être testable : c'est ici que se règlent la
// projection écran et le décalage du bandeau boussole.

/** Cadre de référence vertical : l'horizon, puis le sol au pied de l'utilisateur. */
export const HORIZON_PCT = 46;   // % de hauteur d'écran où se trouve l'horizon
export const BAS_PCT     = 70;   // % de hauteur pour un objet à distance nulle

/** Rayon (m) au-delà duquel un élément n'est plus projeté en AR. */
export const AR_RADIUS = 800;

/** Boussole : étiquettes tous les 45°, échelle alignée sur le FOV (68° sur la largeur). */
export const COMPASS_STEP_DEG = 45;
export const PX_PER_DEG       = 2.8;

/**
 * Position horizontale d'un élément, en % de la largeur d'écran.
 * @param rel  écart de cap signé, en degrés (−180..180), 0 = plein centre
 * @param fov  champ de vision horizontal en degrés
 */
export function pinX(rel, fov) {
  return 50 + (rel / (fov / 2)) * 50;
}

/**
 * Position verticale d'un élément, en % de la hauteur d'écran.
 * Convention du produit : **proche → bas de l'écran, loin → vers l'horizon**.
 * @param dist    distance en mètres
 * @param radius  rayon de projection (m) ; au-delà, l'élément est à l'horizon
 */
export function pinY(dist, radius = AR_RADIUS) {
  const dc = Math.max(0, Math.min(dist, radius));
  return HORIZON_PCT + (1 - dc / radius) * (BAS_PCT - HORIZON_PCT);
}

/**
 * Décalage du bandeau boussole, en pixels.
 * Les étiquettes sont espacées de COMPASS_STEP_DEG : le décalage doit donc être
 * calculé sur CE pas (et non sur un 60° arbitraire, qui les faisait sauter).
 * @param hdg cap en degrés (0..360)
 */
export function compassOffsetPx(hdg, pxPerDeg = PX_PER_DEG) {
  const a = ((Number(hdg) % 360) + 360) % 360;
  // `|| 0` : évite de renvoyer -0 sur un multiple exact du pas (et c'est plus propre en CSS)
  return -(a % COMPASS_STEP_DEG) * pxPerDeg || 0;
}

/** Largeur d'une étiquette du bandeau : le pas des étiquettes × l'échelle. */
export function compassLabelWidth(pxPerDeg = PX_PER_DEG) {
  return COMPASS_STEP_DEG * pxPerDeg;
}

/**
 * Détour réel d'une alternative : il faut rejoindre l'alternative PUIS sa destination.
 * (Avant : seule la distance à l'alternative était comptée, donc un détour à 90°
 * était annoncé comme quasi nul.)
 */
export function detourVia(distUserToAlt, distAltToDest, distUserToDest) {
  return Math.round(distUserToAlt + distAltToDest - distUserToDest);
}

/**
 * Rayon de recherche d'une alternative : budget de détour, borné des deux côtés.
 * (Avant : Math.max élargissait sans limite — 7,5 km de recherche pour un trajet de 5 km.)
 */
export function alternativeRadius(distToOriginal, { factor = 1.5, min = 700, max = 2500 } = {}) {
  return Math.min(Math.max(distToOriginal * factor, min), max);
}
