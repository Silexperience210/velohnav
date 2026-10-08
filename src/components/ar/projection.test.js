// Tracé AR (projection.js) : même géométrie que les pins — sinon le pin de
// destination et le bout du tracé ne tombent pas au même endroit.
import { describe, it, expect } from "vitest";
import { projectPoint } from "./projection.js";
import { pinX, pinY, AR_RADIUS } from "./arProjection.js";
import { getBearing, haversine } from "../../utils.js";

const ME = { lat: 49.6105, lng: 6.1302 };
// Point à ~150 m au nord-est (relèvement ~45°)
const P = { lat: 49.61145, lng: 6.13166 };

describe("projectPoint — cohérence avec les pins", () => {
  it("tombe au même x et au même y que pinX/pinY pour le même point (défaut corrigé)", () => {
    const W = 390, H = 735, fov = 39, heading = 30;
    const rel = getBearing(ME.lat, ME.lng, P.lat, P.lng) - heading;   // ~15°, dans le champ
    const p = projectPoint(ME.lat, ME.lng, heading, P.lat, P.lng, W, H, false, fov);
    expect(p.inFov).toBe(true);
    expect(p.x / W * 100).toBeCloseTo(pinX(rel, fov), 6);
    expect(p.y / H * 100).toBeCloseTo(pinY(haversine(ME.lat, ME.lng, P.lat, P.lng), AR_RADIUS), 6);
    // Ancienne échelle du tracé : ±50° → x = 50 + rel/50·50 ; écart avec le pin :
    const ancien = 50 + rel;
    expect(Math.abs(ancien - pinX(rel, fov))).toBeGreaterThan(10);   // > 10 % d'écran
  });
  it("ne projette jamais un point derrière (> 90°)", () => {
    expect(projectPoint(ME.lat, ME.lng, 225, P.lat, P.lng, 390, 735, true, 39)).toBeNull();
  });
  it("colle au bord un point latéral hors champ (mode clamp)", () => {
    const p = projectPoint(ME.lat, ME.lng, 45 - 60, P.lat, P.lng, 390, 735, true, 39);
    expect(p.inFov).toBe(false);
    expect(p.x).toBeCloseTo(390, 6);
    expect(projectPoint(ME.lat, ME.lng, 45 - 60, P.lat, P.lng, 390, 735, false, 39)).toBeNull();
  });
});
