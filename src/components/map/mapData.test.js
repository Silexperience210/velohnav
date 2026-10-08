// Tests données carte — style OpenFreeMap « dark » réel (08/10/2026) + stations GBFS réelles
import { describe, it, expect } from "vitest";
import darkStyle from "../../__fixtures__/openfreemap_dark_style.json";
import info   from "../../__fixtures__/gbfs_station_information.json";
import status from "../../__fixtures__/gbfs_station_status.json";
import { parseGBFS } from "../../utils/gbfs.js";
import { themeDarkStyle, stationsToGeoJSON, routeToGeoJSON, boundsOf, FALLBACK_STYLE } from "./mapData.js";

const paint = (style, id) => style.layers.find(l => l.id === id)?.paint;

describe("themeDarkStyle", () => {
  const themed = themeDarkStyle(darkStyle);
  it("garde sources, glyphes, sprite et nombre de couches", () => {
    expect(themed.sources).toBe(darkStyle.sources);
    expect(themed.glyphs).toBe(darkStyle.glyphs);
    expect(themed.sprite).toBe(darkStyle.sprite);
    expect(themed.layers).toHaveLength(darkStyle.layers.length);
  });
  it("applique le fond de la charte et éclaircit les rues", () => {
    expect(paint(themed, "background")["background-color"]).toBe("#080c0f");
    expect(paint(themed, "highway_minor")["line-color"]).not.toBe(paint(darkStyle, "highway_minor")["line-color"]);
    expect(paint(themed, "highway_motorway_casing")["line-color"]).toMatch(/245,130,13/); // accent orange
  });
  it("préserve les autres propriétés de peinture et ne mute pas l'original", () => {
    expect(paint(themed, "highway_minor")["line-width"]).toEqual(paint(darkStyle, "highway_minor")["line-width"]);
    expect(paint(darkStyle, "background")["background-color"]).toBe("rgb(12,12,12)");
  });
  it("toutes les sources pointent vers tiles.openfreemap.org (seul domaine à autoriser)", () => {
    const urls = [themed.glyphs, themed.sprite, ...Object.values(themed.sources).flatMap(s => [s.url, ...(s.tiles || [])])].filter(Boolean);
    urls.forEach(u => expect(new URL(u.replace(/[{}]/g, "")).hostname).toBe("tiles.openfreemap.org"));
  });
  it("retire le motif « wood-pattern » absent du sprite", () => {
    expect(paint(darkStyle, "landcover_wood")["fill-pattern"]).toBe("wood-pattern");
    expect(paint(themed, "landcover_wood")["fill-pattern"]).toBeUndefined();
  });
  it("tolère une entrée invalide ; le style de repli est valide", () => {
    expect(themeDarkStyle(null)).toBeNull();
    expect(FALLBACK_STYLE.version).toBe(8);
  });
});

describe("stationsToGeoJSON", () => {
  const stations = parseGBFS(info, status);
  const fc = stationsToGeoJSON(stations);
  it("une feature Point [lng,lat] par station", () => {
    expect(fc.features).toHaveLength(stations.length);
    const f = fc.features.find(x => x.properties.sid === "1");
    expect(f.geometry.coordinates).toEqual([6.137526, 49.598211]);
  });
  it("propriétés : couleur de dispo, compteurs, id string", () => {
    const p = fc.features.find(x => x.properties.sid === "1").properties;
    expect(p).toMatchObject({ name: "LEON XIII", bikes: 12, elec: 12, docks: 2, col: "#2ECC8F", closed: false });
    const empty = fc.features.find(x => x.properties.bikes === 0 && !x.properties.closed);
    expect(empty.properties.col).toBe("#E03E3E");
  });
  it("ignore les stations sans coordonnées", () => {
    expect(stationsToGeoJSON([{ id: 1, name: "x" }]).features).toHaveLength(0);
  });
});

describe("routeToGeoJSON / boundsOf", () => {
  const coords = [{ lat: 49.60, lng: 6.13 }, { lat: 49.61, lng: 6.14 }, { lat: 49.605, lng: 6.12 }];
  it("LineString en [lng,lat]", () => {
    const fc = routeToGeoJSON(coords);
    expect(fc.features[0].geometry.coordinates[0]).toEqual([6.13, 49.60]);
  });
  it("moins de 2 points → collection vide", () => {
    expect(routeToGeoJSON([coords[0]]).features).toHaveLength(0);
    expect(routeToGeoJSON(null).features).toHaveLength(0);
  });
  it("emprise min/max", () => {
    expect(boundsOf(coords)).toEqual([[6.12, 49.60], [6.14, 49.61]]);
    expect(boundsOf([])).toBeNull();
  });
});
