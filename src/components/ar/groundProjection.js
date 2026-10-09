// ── groundProjection.js — projection perspective des points AU SOL ──────────
// Ce qui doit se superposer à la chaussée (tracé, flèches de virage, pied du pin
// de destination, fantôme, obstacles) passe par ici, et par rien d'autre.
//
// Défaut corrigé (« le marquage n'est pas du tout sur la route ») : le tracé
// était placé verticalement par pinY(distance) — une convention d'étiquette
// (« proche en bas, loin vers une ligne fixe à 46 % ») qui ignore l'inclinaison
// du téléphone et la hauteur de la caméra. Mesuré (tests) : un point de la route
// à 10 m droit devant, téléphone vertical, est à 60,4 % de la hauteur d'écran ;
// pinY le dessinait à 67,3 % (≈ 50 px plus bas), et à 100 m l'écart montait à
// 10 % d'écran. Téléphone penché vers la chaussée, tout le tracé glissait encore.
// De plus, le tracé partait de la position GPS brute : 6 m d'erreur latérale
// (courant en ville) suffisent à sortir de l'écran la route à 10 m devant.
//
// Modèle : sténopé centré (object-fit: cover rogne symétriquement, le point
// principal reste au centre de l'écran), focale déduite du champ horizontal
// affiché (arProjection.effectiveHFov), pixels carrés. Caméra à CAM_HEIGHT_M
// au-dessus d'un sol plat ; cap = direction de visée de la caméra arrière ;
// inclinaison = élévation de l'axe de visée. Roulis ignoré (téléphone tenu
// droit) ; pente de la rue ignorée (voir LIMITES dans le rapport).

const RAD = Math.PI / 180;
const R_EARTH = 6371008.8;

/** Hauteur (m) de l'objectif au-dessus de la chaussée : téléphone tenu devant soi. */
export const CAM_HEIGHT_M = 1.4;
/** Plan proche (m) : en deçà, un point n'est pas dessinable (il est sous l'objectif). */
export const NEAR_M = 0.5;
/** Recalage sur le tracé : au-delà, on considère l'utilisateur hors itinéraire. */
export const SNAP_MAX_M = 20;

/** Décalage local est/nord (m) de `to` vu de `from` — exact à mieux que 0,1 % sous 1 km. */
export function enuOffset(from, to) {
  const lat0 = ((from.lat + to.lat) / 2) * RAD;
  return {
    e: (to.lng - from.lng) * RAD * R_EARTH * Math.cos(lat0),
    n: (to.lat - from.lat) * RAD * R_EARTH,
  };
}

/**
 * Élévation (degrés) de l'axe de la caméra arrière à partir de DeviceOrientation
 * (repère W3C, même convention que useCompass.headingFromOrientation : la caméra
 * vise −z). 0 = téléphone vertical, négatif = caméra penchée vers le sol.
 */
export function pitchFromOrientation(beta, gamma) {
  if (beta == null || gamma == null) return null;
  const up = -Math.cos(beta * RAD) * Math.cos(gamma * RAD);
  return Math.asin(Math.max(-1, Math.min(1, up))) / RAD;
}

/** Focale (px) d'une vue de `viewW` px montrant `hfov` degrés en largeur. */
export function focalPx(viewW, hfov) {
  return (viewW / 2) / Math.tan((hfov / 2) * RAD);
}

/**
 * Vecteur local (e, n, u en m) → repère caméra (x droite, y haut, z profondeur).
 * @param heading cap de visée (°, 0 = nord) ; @param pitch élévation de visée (°)
 */
export function toCamera({ e, n, u }, heading, pitch = 0) {
  const h = heading * RAD, p = pitch * RAD;
  const sh = Math.sin(h), ch = Math.cos(h), sp = Math.sin(p), cp = Math.cos(p);
  return {
    x: e * ch - n * sh,
    y: -e * sh * sp - n * ch * sp + u * cp,
    z: e * sh * cp + n * ch * cp + u * sp,
  };
}

/** Repère caméra → pixels d'écran. `cam` = { viewW, viewH, hfov }. */
export function cameraToScreen(c, cam) {
  const f = focalPx(cam.viewW, cam.hfov);
  return { x: cam.viewW / 2 + f * c.x / c.z, y: cam.viewH / 2 - f * c.y / c.z };
}

const groundVec = (from, to, cam) => {
  const { e, n } = enuOffset(from, to);
  return { e, n, u: -(cam.camHeight ?? CAM_HEIGHT_M) };
};

/**
 * Pixel d'écran d'un point au sol, ou null s'il est derrière / sous l'objectif.
 * @param from position de la caméra {lat,lng} ; @param to point au sol {lat,lng}
 * @param cam { heading, pitch, hfov, viewW, viewH, camHeight? }
 * @returns {{x:number, y:number, depth:number, onScreen:boolean} | null}
 */
export function projectGround(from, to, cam) {
  const c = toCamera(groundVec(from, to, cam), cam.heading, cam.pitch ?? 0);
  if (!(c.z >= NEAR_M)) return null;
  const s = cameraToScreen(c, cam);
  return { ...s, depth: c.z, onScreen: s.x >= 0 && s.x <= cam.viewW && s.y >= 0 && s.y <= cam.viewH };
}

/**
 * Polyligne au sol → polylignes d'écran, découpées au plan proche (un segment qui
 * passe sous l'objectif est coupé là où il y entre, au lieu d'être replié aux
 * bords comme avant). Les droites restent droites : c'est une vraie perspective.
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function projectGroundPath(from, points, cam) {
  const out = [];
  let cur = null, prev = null;
  const toScreen = (c) => cameraToScreen(c, cam);
  for (const p of points) {
    const c = toCamera(groundVec(from, p, cam), cam.heading, cam.pitch ?? 0);
    const vis = c.z >= NEAR_M;
    if (prev) {
      const pvis = prev.z >= NEAR_M;
      if (pvis !== vis) {
        const t = (NEAR_M - prev.z) / (c.z - prev.z);
        const k = { x: prev.x + t * (c.x - prev.x), y: prev.y + t * (c.y - prev.y), z: NEAR_M };
        if (vis) { cur = [toScreen(k)]; }
        else if (cur) { cur.push(toScreen(k)); out.push(cur); cur = null; }
      }
    }
    if (vis) { (cur ??= []).push(toScreen(c)); }
    prev = c;
  }
  if (cur?.length) out.push(cur);
  return out.filter(l => l.length >= 2);
}

/**
 * Recale la position sur le tracé : projection orthogonale sur le segment le plus
 * proche. Le tracé AR part alors des pieds de l'utilisateur et suit l'axe de la
 * rue, au lieu d'hériter de l'erreur latérale du GPS.
 * @returns {{lat:number, lng:number, index:number, offsetM:number} | null}
 *          index = indice du sommet qui COMMENCE le segment retenu ; null si
 *          le tracé est à plus de `maxM` (l'utilisateur n'est pas dessus).
 */
export function snapToRoute(coords, pos, maxM = SNAP_MAX_M) {
  if (!coords?.length || !pos) return null;
  let best = null;
  const consider = (i, q, d) => { if (!best || d < best.offsetM) best = { lat: q.lat, lng: q.lng, index: i, offsetM: d }; };
  if (coords.length === 1) {
    const o = enuOffset(pos, coords[0]);
    consider(0, coords[0], Math.hypot(o.e, o.n));
  }
  for (let i = 0; i < coords.length - 1; i++) {
    const a = enuOffset(pos, coords[i]), b = enuOffset(pos, coords[i + 1]);
    const dx = b.e - a.e, dy = b.n - a.n, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, -(a.e * dx + a.n * dy) / L2)) : 0;
    const pe = a.e + t * dx, pn = a.n + t * dy;
    const q = {
      lat: coords[i].lat + t * (coords[i + 1].lat - coords[i].lat),
      lng: coords[i].lng + t * (coords[i + 1].lng - coords[i].lng),
    };
    consider(i, q, Math.hypot(pe, pn));
  }
  return best && best.offsetM <= maxM ? best : null;
}

/**
 * Portion du tracé à dessiner : du point recalé (ou du sommet le plus proche si
 * le recalage échoue) jusqu'à `maxM` mètres le long du tracé. Avant, tout le
 * tracé était projeté depuis le départ, partie déjà parcourue comprise.
 * @returns {{origin:{lat:number,lng:number}, path:Array<{lat:number,lng:number}>, snapped:boolean}}
 */
export function routeAhead(coords, pos, maxM = 500) {
  if (!coords?.length || !pos) return { origin: pos, path: [], snapped: false };
  const snap = snapToRoute(coords, pos);
  let origin = pos, path;
  if (snap) {
    origin = { lat: snap.lat, lng: snap.lng };
    path = [origin, ...coords.slice(snap.index + 1)];
  } else {
    let bi = 0, bd = Infinity;
    coords.forEach((c, i) => { const o = enuOffset(pos, c); const d = Math.hypot(o.e, o.n); if (d < bd) { bd = d; bi = i; } });
    path = coords.slice(bi);
  }
  const out = [path[0]];
  let acc = 0;
  for (let i = 1; i < path.length && acc < maxM; i++) {
    const o = enuOffset(path[i - 1], path[i]);
    acc += Math.hypot(o.e, o.n);
    out.push(path[i]);
  }
  return { origin, path: out, snapped: !!snap };
}
