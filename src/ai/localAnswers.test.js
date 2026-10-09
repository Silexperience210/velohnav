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

describe("accord des compteurs", () => {
  // On injecte un pluriel espion : on vérifie que le module demande bien la bonne
  // forme au bon endroit, sans dépendre du moteur de traduction.
  const espion = () => {
    const appels = [];
    const tn = (key, n) => { appels.push([key, n]); return `${n}·${key}`; };
    return { tn, appels };
  };

  it("station : chaque compteur est accordé séparément", () => {
    const { tn, appels } = espion();
    const r = answerLocally("station la plus proche ?", { ...base, tn });
    expect(r.text).toContain("ui.ai.unit.bike");
    expect(r.text).toContain("ui.ai.unit.elec");
    expect(r.text).toContain("ui.ai.unit.dock");
    expect(appels).toContainEqual(["ui.ai.unit.bike", 9]);
    expect(appels).toContainEqual(["ui.ai.unit.dock", 12]);
  });

  it("une seule unité est annoncée au singulier", () => {
    const { tn, appels } = espion();
    const une = { id: "9", name: "Solo", lat: 49.61, lng: 6.13, dist: 90, bikes: 1, elec: 1, docks: 1, status: "OPEN" };
    answerLocally("station la plus proche ?", { ...base, nearest: une, tn });
    expect(appels.find(a => a[0] === "ui.ai.unit.bike")[1]).toBe(1);
    expect(appels.find(a => a[0] === "ui.ai.unit.dock")[1]).toBe(1);
  });

  it("bornes : le compteur de la station de retour est accordé", () => {
    const { tn, appels } = espion();
    answerLocally("où rendre mon vélo ?", { ...base, tn });
    expect(appels).toContainEqual(["ui.ai.unit.dock", 12]);
  });

  it("électriques et conseil : compteurs accordés eux aussi", () => {
    const a = espion(); answerLocally("des vélos électriques ?", { ...base, tn: a.tn });
    expect(a.appels).toContainEqual(["ui.ai.unit.elec", 9]);
    const b = espion(); answerLocally("où aller maintenant ?", { ...base, tn: b.tn });
    expect(b.appels).toContainEqual(["ui.ai.unit.bike", 9]);
  });

  it("sans pluriel injecté, le module ne lève pas et se rabat sur un compteur brut", () => {
    expect(() => answerLocally("station la plus proche ?", base)).not.toThrow();
    expect(answerLocally("station la plus proche ?", base).text).toContain("9");
  });
});

describe("relecture Kimi — défauts confirmés et corrigés", () => {
  it("« je ramène le vélo » ne doit pas être pris pour un guidage (amene ⊂ ramene)", () => {
    const r = answerLocally("je ramène le vélo à la station", base);
    expect(r.nav).toBeUndefined();
    expect(r.text).not.toContain("nav_unknown");
  });

  it("« se promener » ne doit pas déclencher la règle de guidage (mener ⊂ promener)", () => {
    const r = answerLocally("je vais me promener", base);
    expect(r.nav).toBeUndefined();
  });

  it("« la prochaine station » répond une station, pas des départs", () => {
    const r = answerLocally("quelle est la prochaine station ?", base);
    expect(r.text).toContain("ui.ai.ans.nearest");
    expect(r.text).not.toContain("ans.bus");
  });

  it("« souvent » ne déclenche plus la météo (vent ⊂ souvent)", () => {
    const r = answerLocally("je passe souvent ici", base);
    expect(r.text).not.toContain("ans.wx");
  });

  it("« je veux prendre un vélo » obtient le verdict", () => {
    expect(answerLocally("je veux prendre un vélo", base).text).toContain("verdict_ok");
  });

  it("« je vais à la gare » lance un guidage, à pied vers un arrêt", () => {
    const r = answerLocally("je vais à la gare centrale", base);
    expect(r.nav).toBeDefined();
    expect(r.nav.mode).toBe("walking");       // un arrêt se rejoint à pied
  });

  it("vers une station Vel'OH, le guidage reste à vélo", () => {
    expect(answerLocally("emmène-moi à Hamilius", base).nav.mode).toBe("bicycling");
  });

  it("pour rendre un vélo, la réponse vise une station avec des bornes libres", () => {
    const pleine = { id: "3", name: "Pleine", lat: 49.61, lng: 6.13, dist: 50, bikes: 12, elec: 12, docks: 0, status: "OPEN" };
    const r = answerLocally("où rendre mon vélo ?", { ...base, nearest: pleine, nearestReturn: base.nearest });
    expect(r.text).toContain("Theater Plaza");   // celle qui a des bornes
    expect(r.text).not.toContain("Pleine");
  });

  it("météo sans prévisions : pas de point orphelin", () => {
    const r = answerLocally("quel temps fait-il ?", { ...base, forecast: null });
    expect(r.text).not.toMatch(/\.\s*$/);
    expect(r.text).not.toContain("()");
  });

  it("le repli est signalé comme non reconnu, pour que l'écran sache quand appeler le modèle", () => {
    expect(answerLocally("raconte-moi une blague", base).unknown).toBe(true);
    expect(answerLocally("station la plus proche ?", base).unknown).toBeUndefined();
  });
});

describe("anglais — la première puce rapide ne doit pas tomber sur le repli", () => {
  const cas = {
    "Can I take a bike?": "verdict_ok",
    "Where is the nearest station?": "ans.nearest",
    "Next bus?": "ans.bus",
    "Where can I return my bike?": "ans.docks",
    "Do you have electric bikes?": "ans.elec",
    "What is the weather?": "ans.wx",
  };
  for (const [q, attendu] of Object.entries(cas)) {
    it(`« ${q} » → ${attendu}`, () => {
      const r = answerLocally(q, base);
      expect(r.text).toContain(attendu);
      expect(r.text).not.toContain("ans.help");
    });
  }
  it("« Take me to Hamilius » lance un guidage", () => {
    const r = answerLocally("Take me to Hamilius", base);
    expect(r.nav).toBeDefined();
    expect(r.nav.name).toBe("Hamilius");
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

// Défaut signalé sur téléphone : « Station la plus proche ? » → « EDELECK (19 km) » alors
// que l'accueil annonçait « METZER PLAZ, 150 m ». Coordonnées réelles (GBFS Vel'OH!) :
// la question est traitée ici, sans modèle ; les deux réponses sont justes pour leur
// point de départ — 150 m est la distance au point de référence du centre-ville
// (constants.REF), utilisé tant que le GPS n'a pas répondu ; 19 km celle à une position
// GPS au sud du réseau. Le défaut : la première était présentée comme la distance à
// l'utilisateur, et l'accueil restait figé dessus.
describe("station la plus proche : avec et sans position GPS", async () => {
  const { enrich } = await import("../utils.js");
  const { REF } = await import("../constants.js");
  const { default: fr } = await import("../locales/fr.js");
  const tFr = (k, v = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => v[n] ?? "");
  const tn = (k, n) => `${n} ${fr[k + (n === 1 ? ".one" : ".many")] ?? k}`;
  const raw = [
    { id: 8,   name: "METZER PLAZ", lat: 49.607346, lng: 6.12762,  bikes: 2, elec: 0, docks: 18, status: "OPEN" },
    { id: 108, name: "EDELECK",     lat: 49.565477, lng: 6.079436, bikes: 3, elec: 0, docks: 12, status: "OPEN" },
  ];
  const ask = (pos) => {
    const stations = enrich(raw, pos);
    const nearest = stations.find((s) => s.bikes > 0);
    return answerLocally("Station la plus proche ?", { stations, nearest, t: tFr, tn, gpsPos: pos, located: !!pos });
  };

  it("sans GPS : distance depuis le centre-ville, dite comme telle", () => {
    const r = ask(null);
    expect(r.unknown).toBeUndefined();          // aucun modèle sollicité
    expect(r.text).toMatch(/^METZER PLAZ \(150 m du centre-ville\)/);
    expect(enrich(raw, REF)[0].dist).toBe(154);
  });
  it("avec GPS à 19 km au sud : EDELECK, et la distance est la vraie", () => {
    const r = ask({ lat: 49.395, lng: 6.079 });
    expect(r.text).toMatch(/^EDELECK \(19 km\)/);
    expect(r.text).not.toMatch(/centre-ville/);
  });
});
