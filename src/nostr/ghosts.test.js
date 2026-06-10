// ── Tests src/nostr/ghosts.js — plausibilité (anti-cheat) ──────────────
import { describe, it, expect } from "vitest";
import { isPlausibleRun, downsamplePoints } from "./ghosts.js";

// Génère un run synthétique Gare→Hamilius (~1.3 km) à vitesse constante
function makeRun({ speedMs = 5, n = 30, durationMs = null } = {}) {
  // ~1.3 km plein nord depuis la Gare (1° lat ≈ 111 km)
  const totalDist = 1300;
  const dur = durationMs ?? (totalDist / speedMs) * 1000;
  const points = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    points.push({
      lat: 49.59995 + (totalDist * f) / 111000,
      lng: 6.13385,
      t: Math.round(dur * f),
    });
  }
  return { points, totalTime: Math.round(dur) };
}

describe("isPlausibleRun", () => {
  it("accepte un run vélo réaliste (18 km/h)", () => {
    const { points, totalTime } = makeRun({ speedMs: 5 });
    expect(isPlausibleRun({ points, totalTime, mode: "cycling" })).toBe(true);
  });

  it("accepte un run marche réaliste (5 km/h)", () => {
    const { points, totalTime } = makeRun({ speedMs: 1.4 });
    expect(isPlausibleRun({ points, totalTime, mode: "walking" })).toBe(true);
  });

  it("CHEAT : rejette un run vélo à 50 km/h de moyenne", () => {
    const { points, totalTime } = makeRun({ speedMs: 14 });
    expect(isPlausibleRun({ points, totalTime, mode: "cycling" })).toBe(false);
  });

  it("CHEAT : rejette une marche à 20 km/h", () => {
    const { points, totalTime } = makeRun({ speedMs: 5.5 });
    expect(isPlausibleRun({ points, totalTime, mode: "walking" })).toBe(false);
  });

  it("CHEAT : rejette une téléportation (segment > vitesse max)", () => {
    const { points, totalTime } = makeRun({ speedMs: 5 });
    // Décale brutalement un point de ~800m → segment impossible
    points[15] = { ...points[15], lng: points[15].lng + 0.011 };
    expect(isPlausibleRun({ points, totalTime, mode: "cycling" })).toBe(false);
  });

  it("CHEAT : rejette un totalTime déclaré incohérent avec les timestamps", () => {
    const { points } = makeRun({ speedMs: 5 });
    const realDur = points[points.length - 1].t;
    expect(isPlausibleRun({ points, totalTime: Math.round(realDur * 0.5), mode: "cycling" })).toBe(false);
  });

  it("rejette les runs hors du Luxembourg (bbox)", () => {
    const { points, totalTime } = makeRun({ speedMs: 5 });
    const tokyo = points.map(p => ({ ...p, lat: p.lat - 14, lng: p.lng + 133 }));
    expect(isPlausibleRun({ points: tokyo, totalTime, mode: "cycling" })).toBe(false);
  });

  it("rejette timestamps non croissants et t0 ≠ 0", () => {
    const { points, totalTime } = makeRun({ speedMs: 5 });
    const swapped = [...points];
    [swapped[10].t, swapped[11].t] = [swapped[11].t, swapped[10].t];
    expect(isPlausibleRun({ points: swapped, totalTime, mode: "cycling" })).toBe(false);
    const shifted = points.map(p => ({ ...p, t: p.t + 100 }));
    expect(isPlausibleRun({ points: shifted, totalTime, mode: "cycling" })).toBe(false);
  });

  it("rejette les runs trop courts (durée < 30s ou distance < 100m)", () => {
    const { points, totalTime } = makeRun({ speedMs: 5, durationMs: 20000 });
    expect(isPlausibleRun({ points, totalTime, mode: "cycling" })).toBe(false);
  });
});

describe("downsamplePoints", () => {
  it("préserve premier et dernier points", () => {
    const pts = Array.from({ length: 1000 }, (_, i) => ({ lat: i, lng: i, t: i }));
    const out = downsamplePoints(pts, 250);
    expect(out.length).toBe(250);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });
  it("ne touche pas un run déjà court", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ lat: i, lng: i, t: i }));
    expect(downsamplePoints(pts, 250)).toBe(pts);
  });
});
