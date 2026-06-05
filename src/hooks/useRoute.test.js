// Tests du parsing BRouter (v3.2.3) — purs, sans réseau.
import { describe, it, expect } from "vitest";
import { angleToModifier, brouterToRoute } from "./useRoute.js";

describe("angleToModifier (BRouter)", () => {
  it("tout droit sous 18°", () => {
    expect(angleToModifier(0)).toBe("straight");
    expect(angleToModifier(-10)).toBe("straight");
  });
  it("négatif = gauche, positif = droite", () => {
    expect(angleToModifier(-36)).toBe("slight left");
    expect(angleToModifier(150)).toBe("sharp right");
    expect(angleToModifier(90)).toBe("right");
    expect(angleToModifier(-120)).toBe("sharp left");
    expect(angleToModifier(-60)).toBe("left");
  });
  it("demi-tour au-delà de 160°", () => {
    expect(angleToModifier(170)).toBe("uturn");
    expect(angleToModifier(-175)).toBe("uturn");
  });
});

const FIXTURE = {
  features: [
    {
      geometry: {
        coordinates: [
          [6.13, 49.59, 280],
          [6.131, 49.595, 281],
          [6.132, 49.6, 282],
          [6.1329, 49.6114, 283],
        ],
      },
      properties: {
        "track-length": "1452",
        "total-time": "346",
        voicehints: [
          [1, 3, 0, 11, -36], // slight left au point 1
          [2, 7, 0, 115, 150], // sharp right au point 2
        ],
      },
    },
  ],
};

describe("brouterToRoute", () => {
  it("convertit géométrie + distance + durée", () => {
    const r = brouterToRoute(FIXTURE);
    expect(r.coords).toHaveLength(4);
    expect(r.coords[0]).toEqual({ lat: 49.59, lng: 6.13 }); // [lng,lat,elev] -> {lat,lng}
    expect(r.totalDist).toBe(1452);
    expect(r.totalTime).toBe(346);
  });

  it("mappe les voicehints en waypoints + ajoute la destination finale", () => {
    const r = brouterToRoute(FIXTURE);
    // 2 hints + destination finale (point 3 éloigné du dernier hint)
    expect(r.waypoints).toHaveLength(3);
    expect(r.waypoints[0].modifier).toBe("slight left");
    expect(r.waypoints[0]).toMatchObject({ lat: 49.595, lng: 6.131 });
    expect(r.waypoints[1].modifier).toBe("sharp right");
    expect(r.waypoints[2]).toMatchObject({ lat: 49.6114, lng: 6.1329, modifier: "straight" });
  });

  it("sans voicehints : un seul waypoint sur la destination", () => {
    const noHints = { features: [{ geometry: FIXTURE.features[0].geometry, properties: { "track-length": "500", "total-time": "120" } }] };
    const r = brouterToRoute(noHints);
    expect(r.waypoints).toHaveLength(1);
    expect(r.waypoints[0]).toMatchObject({ lat: 49.6114, lng: 6.1329 });
  });

  it("géométrie vide ou absente -> null", () => {
    expect(brouterToRoute({ features: [] })).toBe(null);
    expect(brouterToRoute({})).toBe(null);
    expect(brouterToRoute(null)).toBe(null);
  });
});
