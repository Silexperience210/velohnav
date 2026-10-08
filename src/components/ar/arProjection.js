// ── arProjection.js — géométrie pure de l'écran AR (aucune dépendance React) ──
// Extrait de ARScreen.jsx pour être testable : c'est ici que se règlent la
// projection écran et le décalage du bandeau boussole.

/** Cadre de référence vertical : l'horizon, puis le sol au pied de l'utilisateur. */
export const HORIZON_PCT = 46;   // % de hauteur d'écran où se trouve l'horizon
export const BAS_PCT     = 70;   // % de hauteur pour un objet à distance nulle

/** Rayon (m) au-delà duquel un élément n'est plus projeté en AR. */
export const AR_RADIUS = 800;

/** Bandeau boussole : une étiquette tous les 45°, 1,2 px par degré (≈ ±65° visibles). */
export const COMPASS_STEP_DEG = 45;
export const PX_PER_DEG       = 1.2;
/** Largeur (px) de la fenêtre visible du bandeau ; le repère ▾ est en son centre. */
export const COMPASS_VIEW_W   = 160;

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
 * Décalage (px) du bandeau boussole pour que le cap `hdg` tombe sous le repère.
 * Le bandeau contient les 8 étiquettes répétées 3 fois (N … NO, N … NO, N … NO) ;
 * l'étiquette k est centrée à (k + 0,5) × largeur. On vise la copie du milieu,
 * ce qui laisse toujours une étiquette de part et d'autre du repère.
 *
 * (Avant : seul `hdg % pas` était utilisé, sur un bandeau qui commence toujours
 * par « N » — le repère montrait N ou NE quel que soit le cap, S compris.)
 * @param hdg     cap en degrés (n'importe quel réel, normalisé ici)
 * @param viewW   largeur de la fenêtre visible (px)
 */
export function compassOffsetPx(hdg, viewW = COMPASS_VIEW_W, pxPerDeg = PX_PER_DEG) {
  const a = ((Number(hdg) % 360) + 360) % 360;
  const labelW = compassLabelWidth(pxPerDeg);
  const pos = (8 + a / COMPASS_STEP_DEG + 0.5) * labelW; // position du cap dans la copie du milieu
  return viewW / 2 - pos;
}

/** Largeur d'une étiquette du bandeau : le pas des étiquettes × l'échelle. */
export function compassLabelWidth(pxPerDeg = PX_PER_DEG) {
  return COMPASS_STEP_DEG * pxPerDeg;
}

/**
 * Indice (0..7) de l'étiquette dont le centre est le plus proche du repère,
 * pour un décalage donné — sert aux tests et à l'accessibilité.
 */
export function compassLabelIndexAtMarker(offsetPx, viewW = COMPASS_VIEW_W, pxPerDeg = PX_PER_DEG) {
  const labelW = compassLabelWidth(pxPerDeg);
  const k = Math.round((viewW / 2 - offsetPx) / labelW - 0.5);
  return ((k % 8) + 8) % 8;
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
