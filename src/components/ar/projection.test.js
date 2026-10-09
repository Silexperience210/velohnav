import { describe, it, expect } from "vitest";

// ── « Mauvais sens » : hystérésis ─────────────────────────────────────
import { wrongWayHysteresis, WRONG_WAY_ON, WRONG_WAY_OFF } from "./projection.js";

describe("wrongWayHysteresis", () => {
  it("ne clignote pas quand le ratio oscille autour du seuil (défaut corrigé)", () => {
    const ratios = [0.65, 0.55, 0.62, 0.5, 0.61, 0.45];
    // Ancien comportement : seuil unique 0,6 → bascule à chaque échantillon
    const ancien = ratios.map(r => r >= 0.6);
    expect(ancien).toEqual([true, false, true, false, true, false]);
    let etat = false;
    const nouveau = ratios.map(r => (etat = wrongWayHysteresis(etat, { ratio: r, sampleSize: 10 })));
    expect(nouveau).toEqual([true, true, true, true, true, true]);
  });
  it("sort franchement sous le seuil bas, entre au-dessus du seuil haut", () => {
    expect(wrongWayHysteresis(true, { ratio: WRONG_WAY_OFF - 0.01, sampleSize: 5 })).toBe(false);
    expect(wrongWayHysteresis(false, { ratio: WRONG_WAY_ON - 0.01, sampleSize: 5 })).toBe(false);
    expect(wrongWayHysteresis(false, { ratio: WRONG_WAY_ON, sampleSize: 5 })).toBe(true);
  });
  it("sans échantillon : jamais « mauvais sens »", () => {
    expect(wrongWayHysteresis(true, { ratio: 1, sampleSize: 0 })).toBe(false);
  });
});
