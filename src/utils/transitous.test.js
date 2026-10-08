// Tests Transitous (MOTIS v6) — fixtures réelles téléchargées le 08/10/2026
import { describe, it, expect } from "vitest";
import stopsJson    from "../__fixtures__/transitous_map_stops.json";
import stoptimes    from "../__fixtures__/transitous_stoptimes.json";
import planJson     from "../__fixtures__/transitous_plan.json";
import planBikeRide from "../__fixtures__/transitous_plan_bikeride.json";
import {
  decodePolyline, bboxAround, toHHMM, parseStops, parseStopTimes, parsePlan,
  itineraryLines, isTransitLeg, ATP_FEED_PREFIX,
} from "./transitous.js";

const GARE = { lat: 49.5999, lng: 6.1337 };

describe("decodePolyline — précision variable", () => {
  it("précision 5 (Google) : point de référence", () => {
    const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
    expect(pts).toHaveLength(3);
    expect(pts[0].lat).toBeCloseTo(38.5, 5);
    expect(pts[0].lng).toBeCloseTo(-120.2, 5);
  });
  it("précision 6 (MOTIS v6) : le tracé du tram reste au Luxembourg", () => {
    const leg = planJson.itineraries[0].legs.find(l => l.mode === "TRAM");
    expect(leg.legGeometry.precision).toBe(6);
    const pts = decodePolyline(leg.legGeometry.points, 6);
    expect(pts.length).toBe(leg.legGeometry.length);
    pts.forEach(p => {
      expect(p.lat).toBeGreaterThan(49.5); expect(p.lat).toBeLessThan(49.7);
      expect(p.lng).toBeGreaterThan(6.0);  expect(p.lng).toBeLessThan(6.3);
    });
  });
  it("chaîne vide / absente → []", () => {
    expect(decodePolyline("")).toEqual([]);
    expect(decodePolyline(undefined)).toEqual([]);
  });
});

describe("bboxAround", () => {
  it("encadre le point au format lat,lon", () => {
    const { min, max } = bboxAround(GARE.lat, GARE.lng, 1000);
    const [la0, ln0] = min.split(",").map(Number);
    const [la1, ln1] = max.split(",").map(Number);
    expect(la0).toBeLessThan(GARE.lat); expect(la1).toBeGreaterThan(GARE.lat);
    expect(ln0).toBeLessThan(GARE.lng); expect(ln1).toBeGreaterThan(GARE.lng);
    // ~1 km : 0.009° de latitude, ~0.0139° de longitude à 49.6°N
    expect(la1 - GARE.lat).toBeCloseTo(0.009, 3);
    expect(ln1 - GARE.lng).toBeCloseTo(0.0139, 3);
  });
});

describe("parseStops — map/stops", () => {
  it("la fixture brute contient 19 arrêts, tous flux confondus", () => {
    expect(stopsJson).toHaveLength(19);
  });
  it("ne garde que le flux officiel ATP quand il est présent", () => {
    const stops = parseStops(stopsJson, GARE, { limit: 50 });
    expect(stops.length).toBeGreaterThan(5);
    expect(stops.every(s => s.id.startsWith(ATP_FEED_PREFIX))).toBe(true);
  });
  it("filtre par mode BUS/TRAM (exclut train seul, car longue distance)", () => {
    const stops = parseStops(stopsJson, GARE, { limit: 50 });
    expect(stops.find(s => s.name === "Luxembourg, Gare Centrale")).toBeUndefined(); // REGIONAL_RAIL seul
    expect(stops.find(s => s.name === "Luxembourg, Gare Centrale (Tram)")).toBeDefined();
  });
  it("contrat { id, name, lat, lng, dist } trié par distance et limité", () => {
    const stops = parseStops(stopsJson, GARE, { limit: 4 });
    expect(stops).toHaveLength(4);
    stops.forEach(s => {
      expect(typeof s.id).toBe("string");
      expect(typeof s.name).toBe("string");
      expect(Number.isFinite(s.lat) && Number.isFinite(s.lng)).toBe(true);
    });
    for (let i = 1; i < stops.length; i++) expect(stops[i].dist).toBeGreaterThanOrEqual(stops[i - 1].dist);
    expect(stops[0].dist).toBeLessThan(100);
  });
  it("sans arrêt ATP : dédoublonne par nom", () => {
    const foreign = stopsJson.filter(s => !s.stopId.startsWith(ATP_FEED_PREFIX));
    const stops = parseStops(foreign, GARE, { limit: 50 });
    const names = stops.map(s => s.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
  it("respecte le rayon et tolère une entrée invalide", () => {
    expect(parseStops(stopsJson, GARE, { radius: 10 })).toEqual([]);
    expect(parseStops(null, GARE)).toEqual([]);
  });
});

describe("parseStopTimes — départs", () => {
  const deps = parseStopTimes(stoptimes);
  it("6 départs au format attendu par useMultimodalSwitch", () => {
    expect(deps).toHaveLength(6);
    deps.forEach(d => {
      expect(d.time).toMatch(/^\d{2}:\d{2}$/);
      expect(typeof d.line).toBe("string");
      expect(typeof d.direction).toBe("string");
      expect(typeof d.cancelled).toBe("boolean");
    });
  });
  it("premier départ : tram T1 vers Kirchberg, Luxexpo", () => {
    expect(deps[0]).toMatchObject({
      line: "T1", direction: "Kirchberg, Luxexpo", mode: "TRAM",
      stop: "Luxembourg, Gare Centrale (Tram)", cancelled: false, agency: "Luxtram",
    });
    expect(deps[0].time).toBe(toHHMM("2026-10-08T16:16:00Z"));
    expect(deps[0].departureAt).toBe(Date.parse("2026-10-08T16:16:00Z"));
  });
  it("rtTime null sans temps réel (realTime=false dans la fixture)", () => {
    expect(stoptimes.stopTimes.every(s => s.realTime === false)).toBe(true);
    expect(deps.every(d => d.rtTime === null)).toBe(true);
  });
  it("temps réel : rtTime = départ effectif, annulation détectée", () => {
    const [d] = parseStopTimes({ stopTimes: [{
      routeShortName: "16", headsign: "Aéroport", mode: "BUS", realTime: true, tripCancelled: true,
      place: { name: "X", departure: "2026-10-08T10:05:00Z", scheduledDeparture: "2026-10-08T10:02:00Z" },
    }] });
    expect(d.time).toBe(toHHMM("2026-10-08T10:02:00Z"));
    expect(d.rtTime).toBe(toHHMM("2026-10-08T10:05:00Z"));
    expect(d.cancelled).toBe(true);
  });
  it("entrée invalide → []", () => {
    expect(parseStopTimes({})).toEqual([]);
  });
});

describe("parsePlan — planification intermodale", () => {
  const plan = parsePlan(planJson);

  it("itinéraire vélo direct (directModes=BIKE)", () => {
    expect(plan.direct).toHaveLength(1);
    expect(plan.direct[0].legs.map(l => l.mode)).toEqual(["BIKE"]);
    expect(plan.direct[0].duration).toBe(1349);
    expect(plan.direct[0].legs[0].coords.length).toBeGreaterThan(10);
  });

  it("itinéraires TC : tram T1 en 34 min, bus 23 → 26 en 29 min", () => {
    expect(plan.itineraries.length).toBeGreaterThanOrEqual(2);
    const tram = plan.itineraries[0];
    expect(tram.duration).toBe(2040);
    expect(itineraryLines(tram)).toBe("T1");
    expect(tram.legs.map(l => l.mode)).toEqual(["WALK", "TRAM", "WALK"]);
    const bus = plan.itineraries.find(it => itineraryLines(it) === "23 → 26");
    expect(bus.duration).toBe(1740);
    expect(bus.transfers).toBe(1);
    expect(bus.transitLegs).toBe(2);
  });

  it("chaque étape a mode, durée, lieux et géométrie décodée", () => {
    plan.itineraries.forEach(it => it.legs.forEach(l => {
      expect(typeof l.mode).toBe("string");
      expect(Number.isFinite(l.duration)).toBe(true);
      expect(Number.isFinite(l.from.lat) && Number.isFinite(l.to.lng)).toBe(true);
      expect(Array.isArray(l.coords)).toBe(true);
    }));
    const tramLeg = plan.itineraries[0].legs[1];
    expect(tramLeg).toMatchObject({ line: "T1", agency: "Luxtram" });
    expect(tramLeg.from.stopId.startsWith(ATP_FEED_PREFIX)).toBe(true);
  });

  it("bike & ride : la 1re étape est à vélo jusqu'à un arrêt", () => {
    const br = parsePlan(planBikeRide);
    const it = br.itineraries[0];
    expect(it.legs[0].mode).toBe("BIKE");
    expect(isTransitLeg(it.legs[1])).toBe(true);
    expect(it.legs[1].line).toBe("26");
    expect(it.legs[1].from.name).toBe("Pfaffenthal, Vauban");
  });

  it("réponse vide → listes vides", () => {
    expect(parsePlan(null)).toEqual({ direct: [], itineraries: [] });
  });
});
