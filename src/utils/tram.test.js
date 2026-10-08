import { describe, it, expect } from "vitest";
import {
  TRAM, TRAM_VALID_UNTIL, TRAM_STOPS, TRAM_TERMINI, pointAt, luxClock, serviceDay, tripPosition,
  tramPositions, nextDepartures, mergeRealtime, shortStopName, tramStopsGeoJSON,
} from "./tram.js";

// Instants de référence (données GTFS du 07/10/2026 au 12/12/2026)
const THU_0830 = new Date("2026-10-08T06:30:00Z");   // jeudi 08:30 à Luxembourg (CEST)
const THU_0300 = new Date("2026-10-08T01:00:00Z");   // 03:00, aucun service
const SAT_0020 = new Date("2026-10-09T22:20:00Z");   // samedi 00:20 — courses du vendredi
const GARE = TRAM.stops.findIndex(s => s.name.includes("Gare Centrale"));
const STADION = TRAM.stops.length - 1;

describe("tram T1 — données extraites", () => {
  it("24 arrêts ordonnés Findel → Stadion, distances croissantes", () => {
    expect(TRAM.stops).toHaveLength(24);
    expect(TRAM.stops[0].name).toMatch(/Findel/);
    expect(TRAM.stops[STADION].name).toMatch(/Stadion/);
    for (let i = 1; i < TRAM.stops.length; i++) expect(TRAM.stops[i].d).toBeGreaterThan(TRAM.stops[i - 1].d);
  });

  it("tracé ≈ 16 km, dans le Grand-Duché, arrêts posés sur le tracé", () => {
    expect(TRAM.length).toBeGreaterThan(15500);
    expect(TRAM.length).toBeLessThan(17000);
    for (const p of TRAM.coords) {
      expect(p.lat).toBeGreaterThan(49.5); expect(p.lat).toBeLessThan(49.7);
      expect(p.lng).toBeGreaterThan(6.0); expect(p.lng).toBeLessThan(6.3);
    }
    for (const s of TRAM.stops) {
      const p = pointAt(s.d);
      const dm = Math.hypot((p.lat - s.lat) * 111000, (p.lng - s.lng) * 72000);
      expect(dm).toBeLessThan(60);
    }
  });

  it("chaque profil suit l'ordre des arrêts dans sa direction", () => {
    for (const p of TRAM.profiles) {
      for (let i = 1; i < p.stops.length; i++) {
        if (p.dir === 0) expect(p.stops[i]).toBeGreaterThan(p.stops[i - 1]);
        else expect(p.stops[i]).toBeLessThan(p.stops[i - 1]);
        expect(p.arr[i]).toBeGreaterThanOrEqual(p.dep[i - 1]);
      }
    }
  });

  it("format historique des arrêts (remplace la liste codée à la main)", () => {
    expect(TRAM_STOPS[0]).toMatchObject({ lines: ["T1"] });
    expect(TRAM_STOPS.every(s => Number.isFinite(s.lat) && s.id && s.name)).toBe(true);
  });

  it("nom court et GeoJSON des arrêts", () => {
    expect(shortStopName("Kirchberg, Coque")).toBe("Coque");
    expect(shortStopName("Hamilius-Centre (Tram)")).toBe("Hamilius-Centre");
    expect(shortStopName("Kirchberg, Europaparlament / Parlement Européen")).toBe("Europaparlament / Parlement Européen");
    expect(tramStopsGeoJSON().features[GARE].properties).toEqual({ idx: GARE, name: "Gare Centrale" });
  });
});

describe("luxClock — heure de Luxembourg quelle que soit la zone du téléphone", () => {
  it("été (UTC+2) et hiver (UTC+1)", () => {
    expect(luxClock(THU_0830)).toEqual({ ymd: "20261008", sec: 8.5 * 3600 });
    expect(luxClock(new Date("2026-12-01T23:30:00Z"))).toEqual({ ymd: "20261202", sec: 30 * 60 });
  });
});

describe("serviceDay", () => {
  it("dans la période publiée : horaire exact", () => {
    const d = serviceDay("20261008");
    expect(d.estimated).toBe(false);
    expect(d.trips.length).toBeGreaterThan(200);
  });
  it("hors période : horaire du même jour de semaine, signalé estimé", () => {
    expect(TRAM_VALID_UNTIL).toBe("20261212");
    const d = serviceDay("20270105"); // mardi
    expect(d.estimated).toBe(true);
    expect(d.trips.length).toBeGreaterThan(200);
  });
});

describe("tripPosition", () => {
  const full0 = TRAM.profiles.find(p => p.dir === 0 && p.stops.length === 24);
  const full1 = TRAM.profiles.find(p => p.dir === 1 && p.stops.length === 24);

  it("au départ : à quai au premier arrêt", () => {
    const p = tripPosition(full0, 0);
    expect(p.atStop).toBe(full0.stops[0]);
    expect(p.next).toBe(full0.stops[1]);
  });

  it("entre deux arrêts : position intermédiaire, pas à quai", () => {
    const mid = (full0.dep[5] + full0.arr[6]) / 2;
    const p = tripPosition(full0, mid);
    expect(p.atStop).toBeNull();
    expect(p.next).toBe(full0.stops[6]);
    const a = TRAM.stops[full0.stops[5]], b = TRAM.stops[full0.stops[6]];
    expect(p.lat).toBeLessThan(Math.max(a.lat, b.lat) + 0.002);
    expect(p.lat).toBeGreaterThan(Math.min(a.lat, b.lat) - 0.002);
  });

  it("sens retour : cap retourné (vers le nord-est au Kirchberg)", () => {
    // Universitéit → Nationalbibliothéik : on remonte vers Luxexpo, cap ~NE
    const k = full1.stops.indexOf(TRAM.stops.findIndex(s => s.name.includes("Universitéit")));
    const p = tripPosition(full1, (full1.dep[k] + full1.arr[k + 1]) / 2);
    expect(p.bearing).toBeGreaterThan(0);
    expect(p.bearing).toBeLessThan(90);
  });

  it("hors course : null", () => {
    expect(tripPosition(full0, -1)).toBeNull();
    expect(tripPosition(full0, full0.arr[23] + 1)).toBeNull();
  });
});

describe("tramPositions", () => {
  it("heure de pointe : une vingtaine de trams, tous sur la ligne", () => {
    const list = tramPositions(THU_0830);
    expect(list.length).toBeGreaterThan(12);
    expect(list.length).toBeLessThan(40);
    expect(new Set(list.map(t => t.id)).size).toBe(list.length);
    expect(list.every(t => t.estimated === false)).toBe(true);
  });
  it("03:00 : aucun tram", () => {
    expect(tramPositions(THU_0300)).toEqual([]);
  });
  it("après minuit : les courses du jour de service précédent circulent encore", () => {
    const list = tramPositions(SAT_0020);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every(t => t.id.startsWith("0_"))).toBe(true); // fenêtre « veille »
  });
});

describe("nextDepartures", () => {
  it("Gare Centrale : deux directions, triées, fréquence de pointe", () => {
    const { estimated, dirs } = nextDepartures(GARE, THU_0830);
    expect(estimated).toBe(false);
    for (const d of [0, 1]) {
      expect(dirs[d]).toHaveLength(3);
      expect(dirs[d][0].min).toBeLessThanOrEqual(8);
      for (let i = 1; i < 3; i++) expect(dirs[d][i].min).toBeGreaterThanOrEqual(dirs[d][i - 1].min);
      expect(dirs[d][0].time).toMatch(/^\d\d:\d\d$/);
    }
  });
  it("terminus : aucun départ dans le sens qui s'y termine", () => {
    const { dirs } = nextDepartures(STADION, THU_0830);
    expect(dirs[0]).toEqual([]);
    expect(dirs[1].length).toBeGreaterThan(0);
  });
  it("concorde avec Transitous (Coque, jeudi 08/10 23:42) : courses partielles vers Luxexpo", () => {
    // Relevé api.transitous.org/api/v6/stoptimes le 08/10/2026 :
    // 23:49 Findel, 23:50 Stadion, 23:59 Luxexpo, 00:05 Stadion, 00:14 Luxexpo, 00:20 Stadion
    const coque = TRAM.stops.findIndex(s => s.name === "Kirchberg, Coque");
    const { dirs } = nextDepartures(coque, new Date("2026-10-08T21:42:00Z"));
    expect(dirs[0].map(d => d.time)).toEqual(["23:50", "00:05", "00:20"]);
    expect(dirs[1].map(d => [d.time, shortStopName(d.headsign)])).toEqual([
      ["23:49", "Findel - Luxembourg Airport"], ["23:59", "Luxexpo"], ["00:14", "Luxexpo"],
    ]);
    expect(TRAM_TERMINI).toEqual({ 0: "Gasperich, Stadion", 1: "Findel - Luxembourg Airport" });
  });
  it("après minuit : heure affichée modulo 24 h", () => {
    const { dirs } = nextDepartures(GARE, SAT_0020);
    const all = [...dirs[0], ...dirs[1]];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every(d => d.time.startsWith("00:") || d.time.startsWith("01:"))).toBe(true);
  });
});

describe("mergeRealtime", () => {
  const deps = [
    { time: "08:32", min: 2, headsign: "Gasperich, Stadion" },
    { time: "08:36", min: 6, headsign: "Bonnevoie, Lycée Bouneweg (Tram)" },
    { time: "23:59", min: 9, headsign: "Gasperich, Stadion" },
  ];
  it("applique retard et suppression à la course de même heure et destination", () => {
    const out = mergeRealtime(deps, [
      { line: "T1", direction: "Gasperich, Stadion", time: "08:32", rtTime: "08:35", cancelled: false },
      { line: "T1", direction: "Bonnevoie, Lycée Bouneweg", time: "08:36", rtTime: null, cancelled: true },
    ]);
    expect(out[0]).toMatchObject({ delay: 3, min: 5, live: true, cancelled: false });
    expect(out[1]).toMatchObject({ cancelled: true, live: true, delay: null });
    expect(out[2]).toEqual(deps[2]);
  });
  it("ignore les autres lignes et les destinations différentes", () => {
    const out = mergeRealtime(deps, [
      { line: "16", direction: "Gasperich, Stadion", time: "08:32", rtTime: "08:40" },
      { line: "T1", direction: "Findel - Luxembourg Airport", time: "08:32", rtTime: "08:40" },
    ]);
    expect(out).toEqual(deps);
  });
  it("retard à cheval sur minuit", () => {
    const out = mergeRealtime(deps, [{ line: "T1", direction: "", time: "23:59", rtTime: "00:02" }]);
    expect(out[2].delay).toBe(3);
  });
  it("sans données : inchangé", () => {
    expect(mergeRealtime(deps, null)).toEqual(deps);
  });
});
