// Tests de la géométrie AR — chaque cas correspond à un défaut réel corrigé.
import { describe, it, expect } from "vitest";
import {
  pinX, pinY, relBearing, effectiveHFov, LENS_HFOV_DEG, compassOffsetPx, compassLabelWidth, compassLabelIndexAtMarker, detourVia, alternativeRadius,
  AR_RADIUS, HORIZON_PCT, BAS_PCT, COMPASS_STEP_DEG, PX_PER_DEG, COMPASS_VIEW_W,
} from "./arProjection.js";

describe("pinX — projection horizontale (sténopé)", () => {
  it("place le centre quand l'écart de cap est nul", () => {
    expect(pinX(0, 68)).toBe(50);
  });
  it("atteint les bords au demi-FOV", () => {
    expect(pinX(34, 68)).toBeCloseTo(100, 9);
    expect(pinX(-34, 68)).toBeCloseTo(0, 9);
  });
  it("suit tan(écart) comme la caméra, pas l'angle (défaut corrigé)", () => {
    // Objectif rectilinéaire : à 20° sur un champ de 68°, l'objet est à
    // 50 − 50·tan20/tan34 = 23,0 % — l'interpolation linéaire donnait 20,6 %.
    expect(pinX(-20, 68)).toBeCloseTo(23.02, 1);
  });
  it("reste fini au-delà de 90° (clampé)", () => {
    expect(Number.isFinite(pinX(120, 40))).toBe(true);
  });
});

describe("relBearing — écart signé cap → relèvement", () => {
  it("nord, est, sud, ouest vus d'un cap nord", () => {
    expect(relBearing(0, 0)).toBe(0);
    expect(relBearing(90, 0)).toBe(90);
    expect(relBearing(270, 0)).toBe(-90);
    expect(Math.abs(relBearing(180, 0))).toBe(180);
  });
  it("passage 359°→1° : relèvement 350° vu à 10° → −20°, jamais +340°", () => {
    expect(relBearing(350, 10)).toBe(-20);
    expect(relBearing(10, 350)).toBe(20);
  });
  it("accepte des caps hors de 0..360 (y compris très négatifs)", () => {
    expect(relBearing(10, -350)).toBe(0);
    expect(relBearing(10, -710)).toBe(0);
    expect(relBearing(10, 730)).toBe(0);
  });
});

describe("effectiveHFov — champ réellement affiché", () => {
  it("paysage 4:3 sans rognage : le champ de l'objectif", () => {
    expect(effectiveHFov({ viewW: 800, viewH: 600, videoW: 640, videoH: 480 })).toBeCloseTo(68, 6);
  });
  it("portrait 19,5:9 avec flux 3:4 : ~39°, pas 68° (défaut corrigé)", () => {
    const f = effectiveHFov({ viewW: 390, viewH: 735, videoW: 480, videoH: 640 });
    expect(f).toBeGreaterThan(37);
    expect(f).toBeLessThan(41);
  });
  it("sans dimensions de flux : suppose un flux 4:3 orienté comme l'écran", () => {
    expect(effectiveHFov({ viewW: 390, viewH: 735 }))
      .toBeCloseTo(effectiveHFov({ viewW: 390, viewH: 735, videoW: 3, videoH: 4 }), 9);
  });
  it("sans vue mesurée : le champ de l'objectif", () => {
    expect(effectiveHFov({})).toBe(LENS_HFOV_DEG);
  });
  it("un objet au bord du flux visible tombe au bord de l'écran", () => {
    // Portrait 390×735, flux 480×640 → l'image est mise à l'échelle par la
    // hauteur ; un objet à un pixel-flux du bord visible doit tomber à ~100 %.
    const fov = effectiveHFov({ viewW: 390, viewH: 735, videoW: 480, videoH: 640 });
    const f = 320 / Math.tan(34 * Math.PI / 180);             // focale (px flux)
    const visibleHalf = (390 / (735 / 640)) / 2;              // demi-largeur visible (px flux)
    const angle = Math.atan(visibleHalf / f) * 180 / Math.PI;
    expect(pinX(angle, fov)).toBeCloseTo(100, 6);
    expect(pinX(angle, 68)).toBeLessThan(80);                  // l'ancienne échelle le mettait vers 77 %
  });
});

describe("pinY — projection verticale (proche → bas, loin → horizon)", () => {
  it("met un objet au pied de l'utilisateur en bas de l'écran", () => {
    expect(pinY(0)).toBe(BAS_PCT);
  });
  it("met un objet à la limite du rayon sur l'horizon", () => {
    expect(pinY(AR_RADIUS)).toBe(HORIZON_PCT);
  });
  it("décroît de façon monotone avec la distance", () => {
    const ys = [0, 100, 400, 800].map(d => pinY(d));
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1]);
  });
  it("au-delà du rayon, reste sur l'horizon (pas de débordement)", () => {
    expect(pinY(5000)).toBe(HORIZON_PCT);
  });
  it("un objet proche est plus bas qu'un objet lointain (le défaut corrigé)", () => {
    expect(pinY(50)).toBeGreaterThan(pinY(600));
  });
});

describe("compassOffsetPx — bandeau boussole", () => {
  const LABELS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  const sous = hdg => LABELS[compassLabelIndexAtMarker(compassOffsetPx(hdg))];

  it("montre sous le repère l'étiquette du cap réel (défaut corrigé : toujours N ou NE)", () => {
    // Avant : décalage = −(cap % 45) × px sur un bandeau qui commence par N →
    // cap 180° affichait « N », cap 45° affichait « N » aussi.
    expect(sous(0)).toBe("N");
    expect(sous(45)).toBe("NE");
    expect(sous(90)).toBe("E");
    expect(sous(180)).toBe("S");
    expect(sous(270)).toBe("O");
    expect(sous(315)).toBe("NO");
  });
  it("centre exactement l'étiquette sur un multiple du pas", () => {
    const w = compassLabelWidth();
    for (const h of [0, 45, 180, 315]) {
      const off = compassOffsetPx(h);
      const k = Math.round((COMPASS_VIEW_W / 2 - off) / w - 0.5);
      expect(off + (k + 0.5) * w).toBeCloseTo(COMPASS_VIEW_W / 2, 6);
    }
  });
  it("se déplace de pas × px/° entre deux caps voisins (pas de saut à 60°)", () => {
    expect(compassOffsetPx(61) - compassOffsetPx(59)).toBeCloseTo(-2 * PX_PER_DEG, 6);
  });
  it("le passage 359°→0° ne décale que d'1° à une période près (image continue)", () => {
    const periode = 8 * compassLabelWidth();
    // 359,5° → 0,5° : le bandeau saute d'une période (invisible : il est périodique)
    // moins 1° d'avance — exactement comme entre 10,5° et 11,5°.
    expect(compassOffsetPx(0.5) - compassOffsetPx(359.5) - periode).toBeCloseTo(-PX_PER_DEG, 6);
    expect(sous(359.6)).toBe("N");
    expect(compassOffsetPx(360)).toBe(compassOffsetPx(0));
  });
  it("garde toujours des étiquettes de part et d'autre du repère", () => {
    const total = 24 * compassLabelWidth();
    for (let h = 0; h < 360; h += 7.5) {
      const off = compassOffsetPx(h);
      expect(off).toBeLessThanOrEqual(0);                     // le bandeau couvre le bord gauche
      expect(off + total).toBeGreaterThanOrEqual(COMPASS_VIEW_W); // … et le bord droit
    }
  });
  it("la largeur d'étiquette correspond au pas géométrique", () => {
    expect(compassLabelWidth()).toBeCloseTo(COMPASS_STEP_DEG * PX_PER_DEG, 6);
  });
});

describe("detourVia — détour réel d'une alternative", () => {
  it("compte aussi le trajet de l'alternative vers la destination", () => {
    // Utilisateur → alternative 300 m, alternative → destination 900 m, direct 1000 m
    expect(detourVia(300, 900, 1000)).toBe(200);
  });
  it("annonce un détour nul pour une alternative parfaitement sur le chemin", () => {
    expect(detourVia(400, 600, 1000)).toBe(0);
  });
  it("ne sous-estime pas une alternative à 90° (défaut corrigé : il donnait ~0)", () => {
    expect(detourVia(700, 700, 1000)).toBe(400);
  });
});

describe("alternativeRadius — budget de détour borné", () => {
  it("borne par le haut au lieu d'élargir", () => {
    expect(alternativeRadius(5000)).toBe(2500);   // était 7500
  });
  it("garde un plancher pour les trajets courts", () => {
    expect(alternativeRadius(100)).toBe(700);
  });
  it("suit le budget quand il tient dans les bornes", () => {
    expect(alternativeRadius(1000)).toBe(1500);
  });
});
