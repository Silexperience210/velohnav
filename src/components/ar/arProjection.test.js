// Tests de la géométrie AR — chaque cas correspond à un défaut réel corrigé.
import { describe, it, expect } from "vitest";
import {
  pinX, pinY, compassOffsetPx, compassLabelWidth, detourVia, alternativeRadius,
  AR_RADIUS, HORIZON_PCT, BAS_PCT, COMPASS_STEP_DEG, PX_PER_DEG,
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
  it("ne bouge pas sur un multiple du pas", () => {
    expect(compassOffsetPx(0)).toBe(0);
    expect(compassOffsetPx(45)).toBe(0);
    expect(compassOffsetPx(90)).toBe(0);
  });
  it("avance d'un pas complet entre deux étiquettes", () => {
    expect(compassOffsetPx(45) - compassOffsetPx(0)).toBe(0);
    expect(compassOffsetPx(44.9)).toBeCloseTo(-44.9 * PX_PER_DEG, 6);
  });
  it("ne saute pas au passage d'un multiple de 60 (défaut corrigé)", () => {
    const avant = compassOffsetPx(59.9);
    const apres = compassOffsetPx(60.1);
    expect(Math.abs(apres - avant)).toBeLessThan(PX_PER_DEG); // était ~168 px
  });
  it("est continu autour de 360", () => {
    expect(compassOffsetPx(359.9)).toBeCloseTo(-359.9 % COMPASS_STEP_DEG * PX_PER_DEG, 6);
    expect(compassOffsetPx(360)).toBe(compassOffsetPx(0));
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
