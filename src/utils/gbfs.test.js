// Tests GBFS — fixtures réelles cyclocity téléchargées le 08/10/2026
import { describe, it, expect, vi } from "vitest";
import info   from "../__fixtures__/gbfs_station_information.json";
import status from "../__fixtures__/gbfs_station_status.json";
import types  from "../__fixtures__/gbfs_vehicle_types.json";
import { pickLang, cleanStationName, electricTypeIds, parseGBFS } from "./gbfs.js";
import { fetchJSONWithRetry, HttpError } from "./http.js";

describe("pickLang — nom multilingue GBFS v3", () => {
  const name = [
    { text: "#00001-GARE", language: "de" },
    { text: "#00001-GARE FR", language: "fr" },
    { text: "#00001-GARE EN", language: "en" },
  ];
  it("prend le français par défaut", () => {
    expect(pickLang(name)).toBe("#00001-GARE FR");
  });
  it("respecte la langue demandée", () => {
    expect(pickLang(name, "en")).toBe("#00001-GARE EN");
  });
  it("retombe sur la première traduction non vide si la langue manque", () => {
    expect(pickLang([{ text: "", language: "fr" }, { text: "X", language: "de" }])).toBe("X");
  });
  it("accepte une chaîne (GBFS v2) et les valeurs vides", () => {
    expect(pickLang("Hamilius")).toBe("Hamilius");
    expect(pickLang(undefined)).toBe("");
    expect(pickLang([])).toBe("");
  });
});

describe("cleanStationName — préfixe numérique", () => {
  it("retire le préfixe #00001-", () => {
    expect(cleanStationName("#00001-LEON XIII")).toBe("LEON XIII");
    expect(cleanStationName("#00012-HAMILIUS")).toBe("HAMILIUS");
  });
  it("retire aussi le format JCDecaux « 12 - X »", () => {
    expect(cleanStationName("12 - HAMILIUS")).toBe("HAMILIUS");
  });
  it("ne touche pas un nom sans préfixe", () => {
    expect(cleanStationName("BORNE ATELIER LUX")).toBe("BORNE ATELIER LUX");
    expect(cleanStationName("")).toBe("");
  });
});

describe("electricTypeIds — vehicle_types", () => {
  it("détecte le type « electrical » (electric_assist)", () => {
    const ids = electricTypeIds(types);
    expect([...ids]).toEqual(["electrical"]);
  });
  it("ignore les types à propulsion humaine", () => {
    const ids = electricTypeIds({ data: { vehicle_types: [
      { vehicle_type_id: "meca", propulsion_type: "human" },
      { vehicle_type_id: "vae",  propulsion_type: "electric_assist" },
    ] } });
    expect([...ids]).toEqual(["vae"]);
  });
});

describe("parseGBFS — fixtures réelles", () => {
  const stations = parseGBFS(info, status, electricTypeIds(types));

  it("le flux réel contient 146 stations", () => {
    expect(info.data.stations).toHaveLength(146);
    expect(status.data.stations).toHaveLength(146);
  });

  it("exclut les 2 stations fantômes (nom vide, capacité 0) et le dépôt atelier", () => {
    expect(stations).toHaveLength(143);
    expect(stations.find(s => s.id === 49)).toBeUndefined();
    expect(stations.find(s => s.id === 141)).toBeUndefined();
    expect(stations.find(s => /ATELIER/.test(s.name))).toBeUndefined();
  });

  it("produit le modèle interne attendu (station 1 — LEON XIII)", () => {
    const s = stations.find(x => x.id === 1);
    expect(s).toMatchObject({
      id: 1, name: "LEON XIII", lat: 49.598211, lng: 6.137526, cap: 20,
      bikes: 12, elec: 12, meca: 0, docks: 2, status: "OPEN",
      renting: true, returning: true, _mock: false,
    });
  });

  it("aucun nom ne garde le préfixe #000xx-", () => {
    expect(stations.every(s => !/^#?\d+-/.test(s.name))).toBe(true);
  });

  it("compte les électriques via vehicle_types_available", () => {
    const st = status.data.stations.find(x => x.station_id === "1");
    const e = st.vehicle_types_available.find(v => v.vehicle_type_id === "electrical").count;
    expect(stations.find(x => x.id === 1).elec).toBe(e);
    stations.forEach(s => {
      expect(s.elec).toBeLessThanOrEqual(s.bikes);
      expect(s.meca).toBe(s.bikes - s.elec);
    });
  });

  it("station installée mais sans location (is_renting=false) : 0 vélo, reste OPEN pour le retour", () => {
    const s = stations.find(x => x.id === 23);
    expect(s.renting).toBe(false);
    expect(s.returning).toBe(true);
    expect(s.bikes).toBe(0);
    expect(s.status).toBe("OPEN");
  });

  it("toutes les stations ont lat/lng et un statut OPEN|CLOSED", () => {
    stations.forEach(s => {
      expect(Number.isFinite(s.lat)).toBe(true);
      expect(Number.isFinite(s.lng)).toBe(true);
      expect(["OPEN", "CLOSED"]).toContain(s.status);
    });
  });

  it("sans vehicle_types : heuristique sur l'id « electrical »", () => {
    const s = parseGBFS(info, status).find(x => x.id === 1);
    expect(s.elec).toBe(12);
  });

  it("vélos mécaniques + électriques mélangés", () => {
    const i = { data: { stations: [{ station_id: "7", name: [{ text: "#00007-X", language: "fr" }], lat: 49.6, lon: 6.1, capacity: 10 }] } };
    const st = { data: { stations: [{ station_id: "7", num_vehicles_available: 5, num_docks_available: 5,
      vehicle_types_available: [{ vehicle_type_id: "electrical", count: 3 }, { vehicle_type_id: "mechanical", count: 2 }],
      is_installed: true, is_renting: true, is_returning: true }] } };
    expect(parseGBFS(i, st, new Set(["electrical"]))[0]).toMatchObject({ bikes: 5, elec: 3, meca: 2, docks: 5 });
  });

  it("station non installée → CLOSED ; station sans status → CLOSED", () => {
    const i = { data: { stations: [
      { station_id: "8", name: [{ text: "A", language: "fr" }], lat: 49.6, lon: 6.1, capacity: 10 },
      { station_id: "9", name: [{ text: "B", language: "fr" }], lat: 49.6, lon: 6.1, capacity: 10 },
    ] } };
    const st = { data: { stations: [{ station_id: "8", num_vehicles_available: 4, num_docks_available: 6,
      vehicle_types_available: [], is_installed: false, is_renting: false, is_returning: false }] } };
    const out = parseGBFS(i, st);
    expect(out.map(s => s.status)).toEqual(["CLOSED", "CLOSED"]);
    expect(out[0].bikes).toBe(0);
    expect(out[0].docks).toBe(0);
  });

  it("entrées invalides → tableau vide", () => {
    expect(parseGBFS(null, status)).toEqual([]);
    expect(parseGBFS(info, {})).toEqual([]);
  });
});

describe("fetchJSONWithRetry — resets TCP cyclocity", () => {
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  const noSleep = async () => {};

  it("réussit après 2 resets de connexion", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(ok({ a: 1 }));
    await expect(fetchJSONWithRetry("u", { fetchImpl, sleep: noSleep })).resolves.toEqual({ a: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("abandonne après 1 + 3 tentatives", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("reset"));
    await expect(fetchJSONWithRetry("u", { fetchImpl, sleep: noSleep })).rejects.toThrow("reset");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("retente sur 503, pas sur 404", async () => {
    const f503 = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(ok([]));
    await expect(fetchJSONWithRetry("u", { fetchImpl: f503, sleep: noSleep })).resolves.toEqual([]);
    expect(f503).toHaveBeenCalledTimes(2);

    const f404 = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchJSONWithRetry("u", { fetchImpl: f404, sleep: noSleep })).rejects.toBeInstanceOf(HttpError);
    expect(f404).toHaveBeenCalledTimes(1);
  });

  it("applique le backoff court entre tentatives", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("x"))
      .mockRejectedValueOnce(new TypeError("x"))
      .mockResolvedValueOnce(ok(1));
    await fetchJSONWithRetry("u", { fetchImpl, sleep, backoffMs: [100, 200] });
    expect(sleep.mock.calls.map(c => c[0])).toEqual([100, 200]);
  });
});
