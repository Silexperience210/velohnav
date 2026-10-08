import { describe, it, expect } from "vitest";
import { answerLocally, upcoming, norm, approxDist } from "./localAnswers.js";

// Traduction factice : on vérifie les DONNÉES transmises aux phrases, pas la prose.
// C'est ce qui compte : un compteur faux est un bug, une formulation est un détail.
const t = (key, vars) => (vars ? key + " " + JSON.stringify(vars) : key);

const stations = [
  { id: "1", name: "Theater Plaza", lat: 49.6101, lng: 6.1300, dist: 140, bikes: 9, elec: 9, docks: 12, status: "OPEN" },
  { id: "2", name: "Hamilius",      lat: 49.6118, lng: 6.1299, dist: 520, bikes: 4, elec: 4, docks: 3,  status: "OPEN" },
];
const nearest = stations[0];
const deps = [
  { stop: "Gare Centrale", dist: 120, line: "T1", dir: "Kirchberg, Luxexpo", time: "4 min", late: false },
  { stop: "Theater Plaza", dist: 400, line: "19", dir: "Strassen",          time: "7 min", late: true  },
];
const weather = { code: 61, temp: 10, rain: 0.6, wind: 12, windDir: 225 };
const forecast = [{ h: 1, temp: 11, rain: 0.8, rainProb: 65 }, { h: 2, temp: 11, rain: 0.4, rainProb: 40 }];
const base = { stations, nearest, deps, weather, forecast, score: 6, gpsPos: { lat: 49.6116, lng: 6.1319 }, t };

describe("normalisation", () => {
  it("ignore les accents et la casse", () => {
    expect(norm("Où est la station ?")).toBe("ou est la station ?");
    expect(norm("VÉLO")).toBe("velo");
    expect(norm(undefined)).toBe("");
  });
  it("mesure une distance en mètres", () => {
    expect(Math.round(approxDist({ lat: 49.6116, lng: 6.1319 }, { lat: 49.6116, lng: 6.1319 }))).toBe(0);
    expect(approxDist({ lat: 49.6116, lng: 6.1319 }, { lat: 49.6216, lng: 6.1319 })).toBeGreaterThan(1000);
  });
});

describe("départs à venir", () => {
  const stops = [{ id: "a", name: "A", dist: 100 }, { id: "b", name: "B", dist: 200 }];
  const table = {
    a: [{ line: "T1", direction: "X", time: "1 min" }, { line: "T2", direction: "Y", time: "9 min" }],
    b: [{ cancelled: true, line: "9" }, { line: "19", direction: "Z", rtTime: "3 min", time: "5 min" }],
  };
  it("retient un seul départ par arrêt, en sautant les annulés", () => {
    const out = upcoming(stops, table, 5);
    expect(out).toHaveLength(2);
    expect(out[0].line).toBe("T1");
    expect(out[1].line).toBe("19");          // le 9 est annulé
    expect(out[1].time).toBe("3 min");       // heure temps réel prioritaire
    expect(out[1].late).toBe(true);
  });
  it("respecte la limite demandée", () => {
    expect(upcoming(stops, table, 1)).toHaveLength(1);
  });
  it("ne casse pas sur des données absentes", () => {
    expect(upcoming(undefined, undefined)).toEqual([]);
    expect(upcoming([{ id: "x" }], {})).toEqual([]);
  });
});

describe("réponses factuelles — les chiffres viennent des données", () => {
  it("station la plus proche : nom, distance, vélos, électriques, bornes", () => {
    const r = answerLocally("quelle est la station la plus proche ?", base);
    expect(r.text).toContain("Theater Plaza");
    expect(r.text).toContain("9");     // vélos
    expect(r.text).toContain("12");    // bornes libres
    expect(r.nav).toBeUndefined();
  });

  it("peut-on prendre un vélo : dit oui quand la météo le permet", () => {
    const r = answerLocally("Bonjour, il pleut un peu. Je peux prendre un vélo maintenant ?", base);
    expect(r.text).toContain("ui.ai.ans.verdict_ok");
  });

  it("peut-on prendre un vélo : dit non quand le conseil est le tram", () => {
    const r = answerLocally("je peux prendre un velo maintenant ?",
      { ...base, advice: { mode: "transit", reason: "storm" } });
    expect(r.text).toContain("ui.ai.ans.verdict_no");
  });

  it("départs : reprend la ligne, la direction et l'heure réelle", () => {
    const r = answerLocally("mon bus pour Kirchberg passe quand ?", base);
    expect(r.text).toContain("T1");
    expect(r.text).toContain("4 min");
  });

  it("départs : message dédié quand rien n'est disponible", () => {
    expect(answerLocally("prochain bus ?", { ...base, deps: [] }).text).toContain("ui.ai.ans.bus_none");
  });

  it("météo : température, vent et score", () => {
    const r = answerLocally("quel temps fait-il ?", base);
    expect(r.text).toContain("10");
    expect(r.text).toContain("12");
    expect(r.text).toContain("6");
  });

  it("bornes : donne le nombre de bornes libres de la station la plus proche", () => {
    expect(answerLocally("où rendre mon vélo ?", base).text).toContain("12");
  });

  it("électriques : compte les vélos électriques", () => {
    expect(answerLocally("y a-t-il des vélos électriques ?", base).text).toContain("9");
  });

  it("sans station disponible : le dit au lieu d'inventer", () => {
    const r = answerLocally("station la plus proche ?", { ...base, nearest: null });
    expect(r.text).toContain("ui.ai.ans.no_station");
  });
});

describe("guidage — le lieu est cherché dans les données, jamais inventé", () => {
  it("trouve une station par son nom et renvoie ses coordonnées exactes", () => {
    const r = answerLocally("emmène-moi à Hamilius", base);
    expect(r.nav).toBeDefined();
    expect(r.nav.name).toBe("Hamilius");
    expect(r.nav.lat).toBeCloseTo(49.6118, 4);
    expect(r.nav.lng).toBeCloseTo(6.1299, 4);
    expect(r.nav.mode).toBe("bicycling");
  });

  it("trouve un arrêt de tram connu", () => {
    const r = answerLocally("guide-moi vers Luxexpo", base);
    expect(r.nav).toBeDefined();
    expect(typeof r.nav.lat).toBe("number");
    expect(typeof r.nav.lng).toBe("number");
  });

  it("n'invente pas de destination inconnue", () => {
    const r = answerLocally("emmène-moi à Trifouillis-les-Oies", base);
    expect(r.nav).toBeUndefined();
    expect(r.text).toContain("ui.ai.ans.nav_unknown");
  });
});

describe("formulation du verdict", () => {
  it("sans raison fournie : pas de parenthèses vides", () => {
    const r = answerLocally("Puis-je prendre un vélo ?", { ...base, advice: { mode: "bike", reason: null } });
    expect(r.text).toContain("ui.ai.ans.verdict_ok_simple");
    expect(r.text).not.toContain("()");
  });
  it("avec raison fournie : elle est reprise", () => {
    const r = answerLocally("Puis-je prendre un vélo ?", { ...base, advice: { mode: "bike", reason: "rain" } });
    expect(r.text).toContain("ui.ai.ans.verdict_ok");
    expect(r.text).not.toContain("simple");
  });
});

describe("confusions corrigées (constatées dans le navigateur)", () => {
  it("« prendre » ne doit pas être pris pour « rendre » : la question du vélo donne le verdict", () => {
    const r = answerLocally("Puis-je prendre un vélo ?", base);
    expect(r.text).toContain("ui.ai.ans.verdict_ok");
    expect(r.text).not.toContain("ui.ai.ans.docks");
  });

  it("« bus près de moi » est une question de bus, pas de proximité", () => {
    const r = answerLocally("Prochains bus près de moi ?", base);
    expect(r.text).toContain("ui.ai.ans.bus");
    expect(r.text).toContain("T1");
  });

  it("« déposer mon vélo » reste une question de bornes", () => {
    const r = answerLocally("Où déposer mon vélo ?", base);
    expect(r.text).toContain("ui.ai.ans.docks");
  });

  it("les questions rapides de l'interface obtiennent toutes une réponse spécifique", () => {
    const attendu = {
      "Puis-je prendre un vélo ?": "verdict_ok",
      "Station la plus proche ?": "ans.nearest",
      "Conditions vélo maintenant ?": "verdict",
      "Prochains bus près de moi ?": "ans.bus",
      "Où déposer mon vélo ?": "ans.docks",
    };
    for (const [q, attenduCle] of Object.entries(attendu)) {
      const r = answerLocally(q, base);
      expect(r.text, q).toContain(attenduCle);
      expect(r.text, q).not.toContain("ui.ai.ans.help");
    }
  });
});

describe("question non reconnue", () => {
  it("explique ce qui est disponible sans modèle", () => {
    const r = answerLocally("raconte-moi une blague", base);
    expect(r.text).toContain("ui.ai.ans.help");
    expect(r.nav).toBeUndefined();
  });
});

describe("robustesse", () => {
  it("ne lève jamais, même sans aucune donnée", () => {
    for (const q of ["", "  ", "où est la station", "emmène-moi", "vélo maintenant", "bus", "météo"])
      expect(() => answerLocally(q, { t })).not.toThrow();
  });
});
