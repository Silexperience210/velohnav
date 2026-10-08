// Boussole : cap de la caméra et lissage circulaire.
import { describe, it, expect } from "vitest";
import { headingFromOrientation, emaHeadingStep, publishHeading } from "./useCompass.js";

describe("headingFromOrientation — cap visé par la caméra arrière", () => {
  it("téléphone tenu droit : 360 − alpha (nord, est, sud, ouest)", () => {
    expect(headingFromOrientation(0, 90, 0)).toBeCloseTo(0, 6);
    expect(headingFromOrientation(270, 90, 0)).toBeCloseTo(90, 6);
    expect(headingFromOrientation(180, 90, 0)).toBeCloseTo(180, 6);
    expect(headingFromOrientation(90, 90, 0)).toBeCloseTo(270, 6);
  });
  it("blocage de cardan : le lacet porté par gamma est compté (défaut corrigé)", () => {
    // Tenu droit, 30° de lacet attribués à gamma : la caméra vise 330°.
    // L'ancien calcul (360 − alpha) affichait 0° — toute la scène décalée de 30°.
    const ancien = (360 - 0 + 360) % 360;
    expect(ancien).toBe(0);
    expect(headingFromOrientation(0, 90, 30)).toBeCloseTo(330, 6);
    // Même lacet total réparti autrement → même cap
    expect(headingFromOrientation(10, 90, 20)).toBeCloseTo(330, 6);
  });
  it("légèrement incliné vers l'avant, la caméra vise toujours le même cap", () => {
    expect(headingFromOrientation(270, 70, 0)).toBeCloseTo(90, 6);
  });
  it("caméra vers le sol (téléphone à plat) : cap indéfini → null", () => {
    expect(headingFromOrientation(123, 0, 0)).toBeNull();
  });
});

describe("emaHeadingStep — lissage circulaire", () => {
  it("passe 359°→1° par le plus court chemin", () => {
    const s = emaHeadingStep(359, 1, 0.5, 0);
    expect(s).toBeCloseTo(0, 6);                 // et non 180
  });
  it("ignore les variations sous la zone morte", () => {
    expect(emaHeadingStep(100, 101, 0.08, 1.5)).toBe(100);
  });
  it("reste dans [0, 360) après plusieurs tours vers la gauche (défaut corrigé)", () => {
    // Ancien état non borné : last = last + diff·α → −370 après un tour, et le
    // cap publié Math.round((−370 + 360) % 360) valait −10.
    let ancien = 0, last = 0;
    for (let tour = 0; tour < 2; tour++)
      for (let h = 350; h >= 0; h -= 10) {
        for (let i = 0; i < 60; i++) {
          const d = ((h - ancien + 540) % 360) - 180;
          if (Math.abs(d) >= 1.5) ancien = ancien + d * 0.08;
          last = emaHeadingStep(last, h);
        }
      }
    expect(Math.round((ancien + 360) % 360)).toBeLessThan(0);   // le défaut, reproduit
    expect(last).toBeGreaterThanOrEqual(0);
    expect(last).toBeLessThan(360);
    expect(publishHeading(last)).toBeGreaterThanOrEqual(0);
  });
});

describe("publishHeading", () => {
  it("359,7° est publié 0°, pas 360°", () => {
    expect(publishHeading(359.7)).toBe(0);
    expect(publishHeading(12.4)).toBe(12);
  });
});
