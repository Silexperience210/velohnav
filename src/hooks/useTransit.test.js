import { describe, it, expect } from "vitest";
import { relocateStops } from "./useTransit.js";
import { haversine } from "../utils.js";

// Arrêts tels que renvoyés par findNearbyStops, téléchargés à l'arrêt même (dist figée).
const AM_BRILL = { lat: 49.52114, lng: 6.010636 };
const fetched = [
  { id: "lu-atp_000220802003", name: "Foetz, Am Brill",       lat: 49.52114, lng: 6.010636, dist: 0 },
  { id: "lu-atp_000220802004", name: "Foetz, Am Butterbrill", lat: 49.52209, lng: 6.009481, dist: 135 },
];

describe("arrêts proches : distance depuis la position courante", () => {
  it("recalculée à chaque position, triée, comme celle des stations", () => {
    const pos = { lat: AM_BRILL.lat - 0.0018, lng: AM_BRILL.lng };   // ~200 m au sud
    const r = relocateStops(fetched, pos);
    expect(r.map((s) => s.name)).toEqual(["Foetz, Am Brill", "Foetz, Am Butterbrill"]);
    expect(r[0].dist).toBe(haversine(pos.lat, pos.lng, AM_BRILL.lat, AM_BRILL.lng));
    expect(r[0].dist).toBeGreaterThan(190);
    expect(r[0].dist).toBeLessThan(210);
  });

  it("position partie à 12 km : plus d'arrêt « à 200 m » affiché à côté d'une station à 19 km", () => {
    expect(relocateStops(fetched, { lat: 49.42, lng: 5.95 })).toEqual([]);
  });

  it("sans position : liste inchangée", () => {
    expect(relocateStops(fetched, null)).toBe(fetched);
    expect(relocateStops(undefined, AM_BRILL)).toEqual([]);
  });
});
