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

// ── v4 phase 3 : Google Directions et commandes BRouter ───────────────
import { googleToRoute, googleManeuverToModifier, brouterHintToModifier } from "./useRoute.js";

describe("googleManeuverToModifier", () => {
  it("distingue demi-tour, légère et serrée (défaut corrigé : tout devenait left/right)", () => {
    expect(googleManeuverToModifier("uturn-left")).toBe("uturn");
    expect(googleManeuverToModifier("uturn-right")).toBe("uturn");
    expect(googleManeuverToModifier("turn-slight-left")).toBe("slight left");
    expect(googleManeuverToModifier("turn-sharp-right")).toBe("sharp right");
    expect(googleManeuverToModifier("keep-right")).toBe("slight right");
    expect(googleManeuverToModifier("turn-left")).toBe("left");
    expect(googleManeuverToModifier("roundabout-right")).toBe("right");
    expect(googleManeuverToModifier("straight")).toBe("straight");
    expect(googleManeuverToModifier(undefined)).toBe("straight");
  });
});

describe("googleToRoute", () => {
  const P = (lat, lng) => ({ lat, lng });
  const DATA = { routes: [{ overview_polyline: { points: "" }, legs: [{
    distance: { value: 600 }, duration: { value: 150 }, end_location: P(49.62, 6.14),
    steps: [
      { start_location: P(49.60, 6.13), end_location: P(49.61, 6.13), distance: { value: 200 } },             // départ
      { start_location: P(49.61, 6.13), end_location: P(49.61, 6.14), distance: { value: 200 }, maneuver: "turn-left" },
      { start_location: P(49.61, 6.14), end_location: P(49.62, 6.14), distance: { value: 200 }, maneuver: "uturn-right" },
    ],
  }] }] };

  it("place chaque manœuvre à son point de départ (défaut corrigé : une étape de retard)", () => {
    const r = googleToRoute(DATA);
    // « à gauche » se fait en (49.61, 6.13) — l'ancien code la plaçait en (49.61, 6.14)
    expect(r.waypoints[0]).toMatchObject({ lat: 49.61, lng: 6.13, modifier: "left" });
    expect(r.waypoints[1]).toMatchObject({ lat: 49.61, lng: 6.14, modifier: "uturn" });
  });
  it("termine sur la destination", () => {
    const r = googleToRoute(DATA);
    expect(r.waypoints.at(-1)).toMatchObject({ lat: 49.62, lng: 6.14, instruction: "arrive" });
    expect(r.waypoints).toHaveLength(3);
    expect(r.totalDist).toBe(600);
  });
  it("réponse vide → null", () => {
    expect(googleToRoute({ routes: [] })).toBeNull();
  });
});

describe("brouterHintToModifier", () => {
  it("suit la commande BRouter quand elle existe (mesuré : 54° = légère droite)", () => {
    expect(angleToModifier(54)).toBe("right");                // l'angle seul
    expect(brouterHintToModifier(6, 54)).toBe("slight right"); // la commande BRouter
    expect(brouterHintToModifier(4, -126)).toBe("sharp left");
    expect(brouterHintToModifier(11, 0)).toBe("uturn");
  });
  it("retombe sur l'angle pour les commandes sans direction (rond-point…)", () => {
    expect(brouterHintToModifier(14, -90)).toBe("left");
  });
});

// Réponse BRouter RÉELLE (brouter.de, 08/10/2026, trekking, Hamilius → Amelie).
import { readFileSync } from "node:fs";
import { getBearing } from "../utils.js";

describe("convention de signe BRouter — vérifiée sur une réponse réelle", () => {
  const geo = JSON.parse(readFileSync(new URL("../__fixtures__/brouter_hamilius_amelie.json", import.meta.url), "utf8"));
  const c = geo.features[0].geometry.coordinates;
  const hints = geo.features[0].properties.voicehints;

  it("angle négatif = virage géométrique à gauche, positif = à droite", () => {
    let verifies = 0;
    for (const [i, , , , angle] of hints) {
      if (i < 1 || i >= c.length - 1 || Math.abs(angle) < 20) continue;
      const avant = getBearing(c[i - 1][1], c[i - 1][0], c[i][1], c[i][0]);
      const apres = getBearing(c[i][1], c[i][0], c[i + 1][1], c[i + 1][0]);
      const virage = ((apres - avant + 540) % 360) - 180;          // + = sens horaire = droite
      expect(Math.sign(virage)).toBe(Math.sign(angle));
      verifies++;
    }
    expect(verifies).toBeGreaterThanOrEqual(6);
  });
  it("la route convertie garde ces sens", () => {
    const r = brouterToRoute(geo);
    expect(r.waypoints[0].modifier).toBe("left");                 // cmd 2, −108°
    expect(r.waypoints.some(w => w.modifier === "slight right")).toBe(true);
  });
});
