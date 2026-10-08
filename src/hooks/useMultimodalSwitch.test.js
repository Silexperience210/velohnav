// Tests planToSwitchSuggestion — plan Transitous réel + stations GBFS réelles
import { describe, it, expect } from "vitest";
import planBikeRide from "../__fixtures__/transitous_plan_bikeride.json";
import info   from "../__fixtures__/gbfs_station_information.json";
import status from "../__fixtures__/gbfs_station_status.json";
import { parsePlan } from "../utils/transitous.js";
import { parseGBFS } from "../utils/gbfs.js";
import { planToSwitchSuggestion } from "./useMultimodalSwitch.js";

const plan = parsePlan(planBikeRide);
const stations = parseGBFS(info, status);
const gpsPos = { lat: 49.5999, lng: 6.1337 };
// Requête faite vers 16:30Z (1er itinéraire : départ 16:32Z)
const now = Date.parse("2026-10-08T16:30:00Z");

describe("planToSwitchSuggestion", () => {
  const s = planToSwitchSuggestion(plan, { stations, gpsPos, now });

  it("propose un pivot avec une station à ≤250 m de l'arrêt d'embarquement", () => {
    expect(s).not.toBeNull();
    expect(s.source).toBe("transitous");
    expect(s.stopDistFromStation).toBeLessThanOrEqual(250);
    expect(s.pivotStation.docks).toBeGreaterThanOrEqual(1);
  });

  it("écarte l'itinéraire le plus rapide si aucune borne n'est assez proche de l'arrêt", () => {
    // Itinéraire n°1 : Pfaffenthal, Vauban — station la plus proche à 330 m
    expect(s.busStop.name).not.toBe("Pfaffenthal, Vauban");
  });

  it("garde le contrat de suggestion consommé par ARScreen", () => {
    expect(s).toMatchObject({
      pivotStation: expect.objectContaining({ id: expect.anything(), name: expect.any(String) }),
      busStop: expect.objectContaining({ name: expect.any(String) }),
      busLine: expect.any(String),
      busDirection: expect.any(String),
      busTime: expect.stringMatching(/^\d{2}:\d{2}$/),
      distFromUser: expect.any(Number),
    });
    expect(s.bikeMinutes).toBe(22);
    expect(s.totalMinutes).toBeGreaterThan(0);
  });

  it("aucune suggestion si les départs sont passés ou trop lointains", () => {
    expect(planToSwitchSuggestion(plan, { stations, gpsPos, now: Date.parse("2026-10-08T17:30:00Z") })).toBeNull();
    expect(planToSwitchSuggestion(plan, { stations, gpsPos, now: Date.parse("2026-10-08T15:00:00Z") })).toBeNull();
  });

  it("aucune suggestion sans station avec borne libre", () => {
    const full = stations.map(st => ({ ...st, docks: 0 }));
    expect(planToSwitchSuggestion(plan, { stations: full, gpsPos, now })).toBeNull();
  });

  it("ignore une course annulée", () => {
    const cancelled = { ...plan, itineraries: plan.itineraries.map(it => ({
      ...it, legs: it.legs.map(l => ({ ...l, cancelled: true })) })) };
    expect(planToSwitchSuggestion(cancelled, { stations, gpsPos, now })).toBeNull();
  });

  it("entrées vides → null", () => {
    expect(planToSwitchSuggestion(null, { stations, gpsPos, now })).toBeNull();
    expect(planToSwitchSuggestion(plan, { stations: [], gpsPos, now })).toBeNull();
  });
});

// ── minutesUntilTime — passage de minuit (cas de la revue) ─────────────
import { minutesUntilTime } from "./useMultimodalSwitch.js";

describe("minutesUntilTime", () => {
  const at = (h, m) => new Date(2026, 9, 8, h, m);
  it("00:05 vu à 23:55 → 10 min (le lendemain)", () => {
    expect(minutesUntilTime("00:05", at(23, 55))).toBe(10);
  });
  it("23:50 vu à 00:10 → départ passé de la veille, hors fenêtre (1420)", () => {
    expect(minutesUntilTime("23:50", at(0, 10))).toBe(1420);
  });
  it("format invalide → NaN", () => {
    expect(minutesUntilTime("bientôt", at(12, 0))).toBeNaN();
  });
});
