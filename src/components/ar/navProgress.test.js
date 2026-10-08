// Progression dans les étapes : franchissement, remplacement d'itinéraire.
import { describe, it, expect } from "vitest";
import { advanceStep, progressFor, remainingAlongRoute, waypointKey, STEP_PASS_M } from "./navProgress.js";

// Points espacés de ~111 m vers le nord (0,001° de latitude)
const wp = i => ({ lat: 49.61 + i * 0.001, lng: 6.13, modifier: "left" });
const A = { waypoints: [wp(1), wp(2), wp(3), wp(4), wp(5)], coords: [wp(0), wp(1), wp(2), wp(3), wp(4), wp(5)] };

describe("advanceStep", () => {
  it("n'avance pas loin d'un point", () => {
    expect(advanceStep(A.waypoints, 0, wp(0))).toBe(0);
  });
  it("avance quand le point courant est à moins du seuil", () => {
    expect(advanceStep(A.waypoints, 0, { lat: wp(1).lat - 0.0001, lng: 6.13 })).toBe(1);
  });
  it("ne dépasse jamais le dernier point (arrivée)", () => {
    expect(advanceStep(A.waypoints, 4, wp(5))).toBe(4);
    expect(advanceStep(A.waypoints, 99, wp(0))).toBe(4);
  });
  it("le seuil est bien de 25 m", () => {
    expect(STEP_PASS_M).toBe(25);
  });
});

describe("progressFor — itinéraire remplacé", () => {
  it("repart de 0 sur un nouvel itinéraire (défaut corrigé)", () => {
    // Avant : `step` survivait au remplacement de `route` (même station, même
    // `key` React). Étape 3 + nouveau tracé de 2 points → waypoints[3] indéfini.
    const B = { waypoints: [wp(4), wp(5)] };
    const etat = { route: A, step: 3 };
    expect(B.waypoints[etat.step]).toBeUndefined();          // le défaut, reproduit
    const n = progressFor(etat, B, wp(3));
    expect(n.route).toBe(B);
    expect(n.step).toBe(0);
    expect(B.waypoints[n.step]).toBeDefined();
  });
  it("conserve l'étape tant que l'itinéraire est le même", () => {
    expect(progressFor({ route: A, step: 2 }, A, wp(0)).step).toBe(2);
  });
  it("sur un nouvel itinéraire, saute d'emblée les points déjà sous les roues", () => {
    const B = { waypoints: [wp(3), wp(4), wp(5)] };
    expect(progressFor({ route: A, step: 0 }, B, wp(3)).step).toBe(1);
  });
});

describe("remainingAlongRoute", () => {
  it("distance le long du tracé, pas à vol d'oiseau", () => {
    const r = remainingAlongRoute(A.coords, wp(2));
    expect(r).toBeGreaterThan(330);
    expect(r).toBeLessThan(336);   // 3 × 111,2 m
  });
  it("null sans tracé", () => {
    expect(remainingAlongRoute([], wp(0))).toBeNull();
  });
});

describe("waypointKey", () => {
  it("identique pour le même point, quel que soit son index", () => {
    expect(waypointKey({ lat: 49.6123456, lng: 6.1301 })).toBe(waypointKey({ lat: 49.6123459, lng: 6.13010001 }));
  });
});
