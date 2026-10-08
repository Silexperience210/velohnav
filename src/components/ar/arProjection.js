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
 * Champ de vision de l'objectif le long du GRAND côté du capteur (degrés).
 * 68° ≈ capteur 4:3 derrière un objectif de ~26 mm équivalent 24×36 (caméra
 * principale typique). Ce n'est PAS le champ visible à l'écran : en portrait,
 * l'écran est aligné sur le PETIT côté du capteur, et `object-fit: cover`
 * recadre encore le flux — voir effectiveHFov().
 */
export const LENS_HFOV_DEG = 68;

const RAD = Math.PI / 180;

/** Écart signé (−180..180) entre un relèvement et le cap ; 350° vu à 10° → −20°. */
export function relBearing(bearing, heading) {
  return ((((bearing - heading) % 360) + 540) % 360) - 180;
}

/**
 * Champ de vision horizontal RÉELLEMENT affiché (degrés), pour un flux caméra
 * de videoW×videoH montré en `object-fit: cover` dans une vue viewW×viewH.
 * Sans dimensions de flux (caméra pas encore prête, mode dégradé), on suppose
 * un flux 4:3 orienté comme l'écran — c'est ce que livrent Chrome et Safari.
 *
 * Exemple : portrait 390×735 px, flux 3:4 → ≈ 39°, et non 68°. Avec 68°, un
 * objet à 17° à droite était dessiné au quart de l'écran au lieu du bord.
 */
export function effectiveHFov({ viewW, viewH, videoW, videoH, lensFov = LENS_HFOV_DEG } = {}) {
  if (!(viewW > 0) || !(viewH > 0)) return lensFov;
  if (!(videoW > 0) || !(videoH > 0)) {
    [videoW, videoH] = viewH > viewW ? [3, 4] : [4, 3];
  }
  // Focale en pixels du flux, déduite du champ le long de son grand côté
  const f = (Math.max(videoW, videoH) / 2) / Math.tan((lensFov / 2) * RAD);
  // object-fit: cover → mise à l'échelle par le plus grand rapport, le reste est rogné
  const scale = Math.max(viewW / videoW, viewH / videoH);
  const visibleW = viewW / scale;               // largeur visible, en pixels du flux
  return 2 * Math.atan((visibleW / 2) / f) / RAD;
}

/**
 * Position horizontale d'un élément, en % de la largeur d'écran.
 * Projection perspective (sténopé) : x ∝ tan(écart), comme la caméra elle-même —
 * une interpolation linéaire en angle décalait les objets intermédiaires.
 * @param rel  écart de cap signé, en degrés (−180..180), 0 = plein centre
 * @param fov  champ de vision horizontal affiché, en degrés
 */
export function pinX(rel, fov) {
  const r = Math.max(-89, Math.min(89, rel));
  return 50 + 50 * Math.tan(r * RAD) / Math.tan((fov / 2) * RAD);
}

/**
 * Position verticale d'un élément, en % de la hauteur d'écran.
 * Convention du produit : **proche → bas de l'écran, loin → vers l'horizon**.
 * Courbe en racine (effet de perspective) — la MÊME pour les pins et le tracé,
 * sinon le pin de destination flottait à 10 % sous le bout du tracé.
 * @param dist    distance en mètres
 * @param radius  distance (m) projetée sur l'horizon ; au-delà, l'élément y reste
 */
export function pinY(dist, radius = AR_RADIUS) {
  const t = Math.sqrt(Math.max(0, Math.min(dist, radius)) / radius);
  return BAS_PCT + t * (HORIZON_PCT - BAS_PCT);
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
