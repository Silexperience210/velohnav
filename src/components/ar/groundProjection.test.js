// Défaut 2 — « le marquage n'est pas du tout sur la route ». Méthode : positions
// écran MESURÉES pour des points connus, comparées à la géométrie d'un sténopé.
import { describe, it, expect } from "vitest";
import {
  enuOffset, pitchFromOrientation, focalPx, toCamera, projectGround, projectGroundPath,
  snapToRoute, routeAhead, CAM_HEIGHT_M, NEAR_M,
} from "./groundProjection.js";
import { effectiveHFov, pinX, pinY, AR_RADIUS } from "./arProjection.js";
import { emaPitchStep } from "../../hooks/useCompass.js";

const RAD = Math.PI / 180;
const R = 6371008.8;
const ME = { lat: 49.6105, lng: 6.1302 };
/** Point à `d` m de `from` au relèvement `b` (°), puis `side` m à droite de cette direction. */
function at(from, d, b, side = 0) {
  const e = d * Math.sin(b * RAD) + side * Math.cos(b * RAD);
  const n = d * Math.cos(b * RAD) - side * Math.sin(b * RAD);
  return { lat: from.lat + n / R / RAD, lng: from.lng + e / (R * Math.cos(from.lat * RAD)) / RAD };
}

// Téléphone 19,5:9 en portrait, flux caméra 3:4 (ce que livre Chrome Android)
const W = 390, H = 735;
const FOV = effectiveHFov({ viewW: W, viewH: H, videoW: 480, videoH: 640 });
const F = focalPx(W, FOV);
const cam = (heading = 0, pitch = 0) => ({ heading, pitch, hfov: FOV, viewW: W, viewH: H });

describe("projectGround — point de la route à 10 m droit devant, cap nord", () => {
  const p = projectGround(ME, at(ME, 10, 0), cam(0, 0));

  it("tombe au centre horizontal exact", () => {
    expect(p.x).toBeCloseTo(W / 2, 6);
  });
  it("tombe sous l'horizon de hauteur caméra / distance (sténopé)", () => {
    // tan(angle sous l'horizon) = 1,4 / 10
    expect(p.y).toBeCloseTo(H / 2 + F * CAM_HEIGHT_M / 10, 3);
    expect(p.y / H * 100).toBeCloseTo(60.4, 1);
  });
  it("l'ancienne convention (pinY) le dessinait ≈ 50 px trop bas (défaut mesuré)", () => {
    const ancien = pinY(10, AR_RADIUS) / 100 * H;
    expect(ancien / H * 100).toBeCloseTo(67.3, 1);
    expect(ancien - p.y).toBeGreaterThan(45);
    // et à 100 m : 10 % d'écran d'écart
    const p100 = projectGround(ME, at(ME, 100, 0), cam(0, 0));
    expect(pinY(100, AR_RADIUS) - p100.y / H * 100).toBeGreaterThan(9.5);
  });
});

describe("projectGround — cap, latéral, inclinaison", () => {
  it("le même point devant soi tombe au même pixel quel que soit le cap", () => {
    for (const h of [0, 37, 90, 181, 270, 359]) {
      const q = projectGround(ME, at(ME, 10, h), cam(h, 0));
      expect(q.x).toBeCloseTo(W / 2, 2);
      expect(q.y).toBeCloseTo(H / 2 + F * CAM_HEIGHT_M / 10, 3);
    }
  });
  it("2 m à droite à 10 m devant : décalé de f·2/10 vers la droite", () => {
    const q = projectGround(ME, at(ME, 10, 0, 2), cam(0, 0));
    expect(q.x).toBeCloseTo(W / 2 + F * 2 / 10, 2);
  });
  it("horizontalement, coïncide avec la projection des pins (pinX) à inclinaison nulle", () => {
    for (const rel of [-15, -5, 0, 8, 18]) {
      const q = projectGround(ME, at(ME, 40, rel), cam(0, 0));
      expect(q.x / W * 100).toBeCloseTo(pinX(rel, FOV), 3);
    }
  });
  it("téléphone penché de 20° vers le sol : l'horizon remonte de f·tan20°, le tracé suit", () => {
    const loin = projectGround(ME, at(ME, 5000, 0), { ...cam(0, -20), viewW: W });
    expect(loin.y).toBeCloseTo(H / 2 - F * Math.tan(20 * RAD), 0);
    // point à 10 m : angle sous l'horizon atan(1,4/10) = 7,97°, soit 12,03° AU-DESSUS de l'axe
    const p10 = projectGround(ME, at(ME, 10, 0), cam(0, -20));
    expect(p10.y).toBeCloseTo(H / 2 - F * Math.tan((20 - Math.atan(1.4 / 10) / RAD) * RAD), 1);
  });
  it("derrière ou sous l'objectif : non projeté", () => {
    expect(projectGround(ME, at(ME, 10, 180), cam(0, 0))).toBeNull();
    expect(projectGround(ME, at(ME, 0.2, 0), cam(0, 0))).toBeNull();
  });
  it("le champ vertical déduit de la même focale est celui de l'objectif (cohérence effectiveHFov)", () => {
    // En portrait, le grand côté du capteur est vertical et entièrement visible : 68°
    expect(2 * Math.atan((H / 2) / F) / RAD).toBeCloseTo(68, 1);
  });
});

describe("pitchFromOrientation — élévation de la caméra arrière", () => {
  it("téléphone vertical : 0° ; penché vers le sol : négatif ; vers le ciel : positif", () => {
    expect(pitchFromOrientation(90, 0)).toBeCloseTo(0, 9);
    expect(pitchFromOrientation(70, 0)).toBeCloseTo(-20, 9);
    expect(pitchFromOrientation(110, 0)).toBeCloseTo(20, 9);
    expect(pitchFromOrientation(0, 0)).toBeCloseTo(-90, 9);   // posé à plat, caméra vers le sol
  });
  it("valeurs absentes : null", () => {
    expect(pitchFromOrientation(null, 0)).toBeNull();
  });
  it("lissage : converge, ignore les valeurs invalides", () => {
    let p = null;
    for (let i = 0; i < 40; i++) p = emaPitchStep(p, -15);
    expect(p).toBeCloseTo(-15, 6);
    expect(emaPitchStep(-15, NaN)).toBe(-15);
  });
});

describe("projectGroundPath — tracé découpé au plan proche", () => {
  it("une rue droite devant soi reste une droite verticale centrée, qui entre par le bas", () => {
    const path = [ME, at(ME, 5, 0), at(ME, 20, 0), at(ME, 80, 0)];
    const lines = projectGroundPath(ME, path, cam(0, 0));
    expect(lines).toHaveLength(1);
    const l = lines[0];
    expect(l).toHaveLength(4);   // ME (sous l'objectif) remplacé par l'entrée dans le plan proche
    for (const q of l) expect(q.x).toBeCloseTo(W / 2, 4);
    expect(l[0].y).toBeCloseTo(H / 2 + F * CAM_HEIGHT_M / NEAR_M, 3);   // sous le bas de l'écran
    for (let i = 1; i < l.length; i++) expect(l[i].y).toBeLessThan(l[i - 1].y);
  });
  it("un tracé qui repart derrière est coupé, pas replié au bord de l'écran", () => {
    const path = [at(ME, 30, 0), at(ME, 30, 0, 10), at(ME, 30, 180, 10)];
    const lines = projectGroundPath(ME, path, cam(0, 0));
    expect(lines).toHaveLength(1);
    const fin = lines[0].at(-1);
    // dernier point = entrée dans le plan proche (profondeur 0,5 m) : très bas, pas collé à x = W
    expect(fin.y).toBeGreaterThan(H);
  });
  it("le pied du pin de destination (projectGround) coïncide avec le bout du tracé", () => {
    const dest = at(ME, 60, 10);
    const path = [ME, at(ME, 30, 0), dest];
    const l = projectGroundPath(ME, path, cam(5, -10))[0];
    const pin = projectGround(ME, dest, cam(5, -10));
    expect(l.at(-1).x).toBeCloseTo(pin.x, 6);
    expect(l.at(-1).y).toBeCloseTo(pin.y, 6);
  });
});

describe("snapToRoute / routeAhead — origine du dessin recalée sur la rue", () => {
  // Rue nord-sud ; le GPS place l'utilisateur 6 m à l'est (erreur courante en ville)
  const rue = [at(ME, 50, 180), ME, at(ME, 50, 0), at(ME, 100, 0)];
  const gps = at(ME, 0, 0, 6);

  it("recale sur le segment le plus proche, à 6 m", () => {
    const s = snapToRoute(rue, gps);
    expect(s.offsetM).toBeCloseTo(6, 2);
    expect(enuOffset(ME, s).e).toBeCloseTo(0, 3);
    expect(s.index).toBe(1);
  });
  it("sans recalage, la rue à 10 m devant sortait de l'écran ; avec, elle est au centre", () => {
    const pt = at(ME, 10, 0);
    const brut = projectGround(gps, pt, cam(0, 0));
    expect(brut.x).toBeLessThan(0);   // atan(6/10) = 31° > demi-champ (19,7°)
    const { origin } = routeAhead(rue, gps);
    expect(projectGround(origin, pt, cam(0, 0)).x).toBeCloseTo(W / 2, 3);
  });
  it("ne dessine que la partie devant soi, bornée en distance", () => {
    const { path, snapped } = routeAhead(rue, gps, 60);
    expect(snapped).toBe(true);
    expect(path).toHaveLength(3);   // origine recalée, +50 m, +100 m (dépasse 60 m : dernier gardé)
    expect(path.some(p => p.lat < ME.lat - 1e-6)).toBe(false);   // rien de la partie parcourue
  });
  it("hors itinéraire (> 20 m) : pas de recalage, GPS brut", () => {
    const loin = at(ME, 0, 0, 40);
    expect(snapToRoute(rue, loin)).toBeNull();
    expect(routeAhead(rue, loin).origin).toBe(loin);
  });
});

describe("toCamera — repère", () => {
  it("droite / haut / profondeur pour un cap est", () => {
    const c = toCamera({ e: 10, n: 0, u: 0 }, 90, 0);
    expect(c.z).toBeCloseTo(10, 9);
    expect(c.x).toBeCloseTo(0, 9);
    const s = toCamera({ e: 0, n: -3, u: 0 }, 90, 0);   // au sud quand on regarde l'est : à droite
    expect(s.x).toBeCloseTo(3, 9);
  });
});

// Flèches ARCore natives (GeospatialManager.arrowYawQuaternion) : vérification de la
// CONVENTION qui fonde le correctif Kotlin — non exécutable ici, la formule l'est.
describe("convention EUS des ancres ARCore (flèche pointe en −Z)", () => {
  // Rotation d'un vecteur par un quaternion autour de Y : q = (0, sin(a/2), 0, cos(a/2))
  const rotY = (v, a) => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
  const bearingOf = (v) => ((Math.atan2(v[0], -v[2]) / RAD) + 360) % 360;   // X est, −Z nord
  it("+θ autour de +Y envoie le nord vers l'ouest : il faut −relèvement", () => {
    expect(bearingOf(rotY([0, 0, -1], 90 * RAD))).toBeCloseTo(270, 6);    // ancien code : miroir
    for (const b of [0, 45, 90, 200, 300])
      expect(bearingOf(rotY([0, 0, -1], -b * RAD))).toBeCloseTo(b, 6);    // correctif
  });
});
