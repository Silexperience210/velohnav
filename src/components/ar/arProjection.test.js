// Tests de la géométrie AR — chaque cas correspond à un défaut réel corrigé.
import { describe, it, expect } from "vitest";
import {
  pinX, pinY, compassOffsetPx, compassLabelWidth, compassLabelIndexAtMarker, detourVia, alternativeRadius,
  AR_RADIUS, HORIZON_PCT, BAS_PCT, COMPASS_STEP_DEG, PX_PER_DEG, COMPASS_VIEW_W,
} from "./arProjection.js";

describe("pinX — projection horizontale", () => {
  it("place le centre quand l'écart de cap est nul", () => {
    expect(pinX(0, 68)).toBe(50);
  });
  it("atteint les bords au demi-FOV", () => {
    expect(pinX(34, 68)).toBe(100);
    expect(pinX(-34, 68)).toBe(0);
  });
  it("reste cohérent après le passage 359°→1°", () => {
    // L'appelant doit fournir un écart signé (−180..180), pas un cap brut :
    // 350° vu avec un cap de 10° donne −20°, jamais +340°.
    expect(pinX(-20, 68)).toBeCloseTo(20.59, 1);
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
