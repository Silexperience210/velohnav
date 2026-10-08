// Valeurs du HUD de navigation (NavHud.hudFigures) — pures.
import { describe, it, expect } from "vitest";
import { hudFigures } from "./NavHud.jsx";

const P = i => ({ lat: 49.61 + i * 0.001, lng: 6.13 });   // ~111 m vers le nord par pas
const route = {
  coords: [P(0), P(1), P(2), P(3), P(4)],
  waypoints: [{ ...P(2), modifier: "left" }, { ...P(4), modifier: "straight" }],
  totalDist: 445, totalTime: 120, totalAscent: null, provider: "brouter",
};

describe("hudFigures", () => {
  it("restant = le long du tracé et décroît en avançant (défaut corrigé : total figé)", () => {
    const debut = hudFigures({ route, step: 0, gpsPos: P(0), mode: "cycling" });
    const milieu = hudFigures({ route, step: 1, gpsPos: P(2), mode: "cycling" });
    expect(debut.remainingM).toBeCloseTo(445, -1);
    expect(milieu.remainingM).toBeCloseTo(222, -1);
    expect(milieu.baseMin).toBeLessThan(debut.baseMin);          // durée au prorata
  });
  it("arrivée : dernier point à moins de 30 m", () => {
    expect(hudFigures({ route, step: 1, gpsPos: { lat: P(4).lat - 0.0001, lng: 6.13 }, mode: "cycling" }).arriving).toBe(true);
    expect(hudFigures({ route, step: 0, gpsPos: P(2), mode: "cycling" }).arriving).toBe(false);
  });
  it("vent : facteur borné 0,85–1,35 en vélo, neutre à pied", () => {
    const tempete = { wind: 200, windDir: 0 };                  // vent du nord, on roule vers le nord
    const v = hudFigures({ route, step: 0, gpsPos: P(0), mode: "cycling", weather: tempete });
    expect(v.windFactor).toBe(1.35);
    const dos = hudFigures({ route, step: 0, gpsPos: P(0), mode: "cycling", weather: { wind: 200, windDir: 180 } });
    expect(dos.windFactor).toBe(0.85);
    expect(hudFigures({ route, step: 0, gpsPos: P(0), mode: "walking", weather: tempete }).windFactor).toBe(1);
  });
  it("pente : appliquée aux seuls temps « plats » (OSRM/Google), jamais à BRouter", () => {
    const osrm = { ...route, provider: "osrm", totalAscent: 60 };
    expect(hudFigures({ route: osrm, step: 0, gpsPos: P(0), mode: "cycling" }).climbFactor).toBeGreaterThan(1);
    expect(hudFigures({ route: { ...route, totalAscent: 60 }, step: 0, gpsPos: P(0), mode: "cycling" }).climbFactor).toBe(1);
  });
});
