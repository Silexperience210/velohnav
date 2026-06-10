// ── Tests v3.3 — fusion de cap, ETA dénivelé, nearestStop cos(lat) ─────
import { describe, it, expect } from "vitest";
import { angleDiff, blendHeadings, speedWeight } from "./hooks/useFusedHeading.js";
import { computeAscentDescent, climbEtaFactor, brouterToRoute } from "./hooks/useRoute.js";
import { nearestStop } from "./utils.js";
import { timeBucket, bucketKey } from "./hooks/useAvailability.js";

describe("useFusedHeading — math circulaire", () => {
  it("angleDiff prend le chemin le plus court à travers 0°", () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
    expect(angleDiff(0, 180)).toBe(-180); // ambigu → un seul des deux côtés
    expect(angleDiff(90, 90)).toBe(0);
  });

  it("blendHeadings traverse correctement le nord (350° + 50% vers 10° = 0°)", () => {
    expect(blendHeadings(350, 10, 0.5)).toBe(0);
    expect(blendHeadings(10, 350, 0.5)).toBe(0);
  });

  it("blendHeadings : w=0 → magnéto pur, w=1 → course pure", () => {
    expect(blendHeadings(100, 200, 0)).toBe(100);
    expect(blendHeadings(100, 200, 1)).toBe(200);
  });

  it("blendHeadings tolère les null (dégradé gracieux)", () => {
    expect(blendHeadings(null, null, 0.5)).toBe(null);
    expect(blendHeadings(120, null, 0.5)).toBe(120);  // pas de course GPS → magnéto
    expect(blendHeadings(null, 80, 0.5)).toBe(80);    // pas de magnéto → course
  });

  it("speedWeight : 0 à l'arrêt, plafonné à 0.85 à vélo", () => {
    expect(speedWeight(0)).toBe(0);
    expect(speedWeight(1.5)).toBe(0);          // marche lente
    expect(speedWeight(10)).toBe(0.85);        // 36 km/h
    const mid = speedWeight(3);                // entre les deux
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(0.85);
    expect(speedWeight(NaN)).toBe(0);
  });
});

describe("ETA dénivelé", () => {
  it("computeAscentDescent ignore le bruit altimétrique < seuil", () => {
    // Oscillation ±1m sur du plat — D+ doit rester 0
    const flat = [200, 201, 200, 201, 200, 201, 200];
    expect(computeAscentDescent(flat)).toEqual({ ascent: 0, descent: 0 });
  });

  it("computeAscentDescent : Ville Haute → Grund → Ville Haute", () => {
    // Descente de 70m puis remontée de 70m
    const profil = [300, 280, 260, 240, 230, 240, 260, 280, 300];
    const { ascent, descent } = computeAscentDescent(profil);
    expect(ascent).toBe(70);
    expect(descent).toBe(70);
  });

  it("climbEtaFactor : neutre sur du plat, clampé en montagne", () => {
    expect(climbEtaFactor(0, 2000)).toBe(1);
    expect(climbEtaFactor(null, 2000)).toBe(1);
    // 70m de D+ sur 1.5 km vélo ≈ +42%
    const f = climbEtaFactor(70, 1500, "cycling");
    expect(f).toBeCloseTo(1.42, 2);
    // Clamp : 500m de D+ sur 1km ne donne pas ×5.5
    expect(climbEtaFactor(500, 1000, "cycling")).toBe(1.6);
    expect(climbEtaFactor(500, 1000, "walking")).toBe(1.5);
  });

  it("brouterToRoute extrait le D+ depuis les coordonnées 3D", () => {
    const geojson = {
      features: [{
        geometry: { coordinates: [
          [6.13, 49.60, 280], [6.131, 49.601, 290], [6.132, 49.602, 310],
        ]},
        properties: { "track-length": "400", "total-time": "120", voicehints: [] },
      }],
    };
    const r = brouterToRoute(geojson);
    expect(r.totalAscent).toBe(30);
    expect(r.totalDescent).toBe(0);
    expect(r.provider).toBe("brouter");
  });

  it("brouterToRoute sans élévation → totalAscent null (pas de faux 0)", () => {
    const geojson = {
      features: [{
        geometry: { coordinates: [[6.13, 49.60], [6.131, 49.601]] },
        properties: { "track-length": "150", "total-time": "40", voicehints: [] },
      }],
    };
    expect(brouterToRoute(geojson).totalAscent).toBe(null);
  });
});

describe("nearestStop — FIX cos(lat)", () => {
  it("ne surestime plus les distances est-ouest à 49.6°N", () => {
    const user = { lat: 49.6000, lng: 6.1300 };
    // Deux arrêts à ~325m réels : un plein nord, un plein est.
    // Plein nord : 325m / 111km par degré ≈ 0.00293° de lat
    // Plein est  : 325m / (111km × cos 49.6°) ≈ 0.00452° de lng
    const stops = [
      { id: "N", name: "Nord", lat: user.lat + 0.00293, lng: user.lng },
      { id: "E", name: "Est",  lat: user.lat, lng: user.lng + 0.00452 },
    ];
    const best = nearestStop(user.lat, user.lng, stops);
    // Les deux sont à ~325m — l'écart doit être < 15m (avant le fix,
    // l'arrêt Est était calculé à ~502m, soit +54%)
    const dN = Math.abs(0.00293) * 111000;
    expect(Math.abs(best.distM - Math.round(dN))).toBeLessThan(15);
  });

  it("choisit le bon arrêt quand l'est-ouest est réellement plus proche", () => {
    const user = { lat: 49.6000, lng: 6.1300 };
    const stops = [
      { id: "N", name: "Nord 400m", lat: user.lat + 0.00360, lng: user.lng },
      { id: "E", name: "Est 300m",  lat: user.lat, lng: user.lng + 0.00417 },
    ];
    // Avant le fix : Est était évalué à 0.00417×111000 = 463m → Nord gagnait à tort.
    expect(nearestStop(user.lat, user.lng, stops).id).toBe("E");
  });
});

describe("useAvailability — buckets temporels", () => {
  it("bucketise par jour de semaine et quart d'heure", () => {
    const d = new Date(2026, 5, 9, 17, 47); // mardi 9 juin 2026 17h47
    const { dow, qh } = timeBucket(d);
    expect(dow).toBe(2);            // mardi
    expect(qh).toBe(17 * 4 + 3);    // 17h45-18h00
    expect(bucketKey(42, dow, qh)).toBe("42_2_71");
  });
  it("minuit pile = bucket 0", () => {
    expect(timeBucket(new Date(2026, 5, 7, 0, 0)).qh).toBe(0);
  });
});
