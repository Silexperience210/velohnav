// Conversation libre avec un petit modèle qui se trompe souvent (6/12 au banc) :
// validation stricte des appels d'outil, rejet de tout appel douteux, et repli sur
// l'assistant déterministe dès que le modèle échoue ou dit n'importe quoi.
import { describe, it, expect, vi } from "vitest";
import { TOOLS, TOOL_NAMES, parseToolCalls, validateCall, readModelOutput } from "./tools.js";
import { executeTool, checkFreeText, resolveModelOutput, systemPrompt, explainFallback, replyLanguage } from "./assistant.js";
import fr from "../locales/fr.js";
import en from "../locales/en.js";
import { answerLocally } from "./localAnswers.js";

// Traduction factice : on vérifie les DONNÉES transmises aux phrases, pas la prose.
const t = (key, vars) => (vars ? key + " " + JSON.stringify(vars) : key);

const stations = [
  { id: "1", name: "Theater Plaza", lat: 49.6101, lng: 6.1300, dist: 140, bikes: 9, elec: 9, docks: 0, status: "OPEN" },
  { id: "2", name: "Hamilius",      lat: 49.6118, lng: 6.1299, dist: 520, bikes: 4, elec: 4, docks: 3, status: "OPEN" },
  { id: "3", name: "Glacis",        lat: 49.6162, lng: 6.1255, dist: 900, bikes: 0, elec: 0, docks: 20, status: "OPEN" },
  { id: "4", name: "Fermée",        lat: 49.6000, lng: 6.1200, dist: 950, bikes: 7, elec: 7, docks: 7, status: "CLOSED" },
];
const transitStops = [{ id: "s1", name: "Royal", dist: 120 }, { id: "s2", name: "Hamilius", dist: 300 }];
const transitDeps = {
  s1: [{ line: "19", direction: "Strassen", time: "08:41" }],
  s2: [{ line: "T1", direction: "Stadion", time: "08:39" }, { line: "16", direction: "Kirchberg", time: "08:44" }],
};
const ctx = {
  stations, nearest: stations[0], nearestReturn: stations[1], deps: [],
  weather: { code: 1, temp: 14, wind: 10, rain: 0 }, forecast: [], score: 8,
  gpsPos: { lat: 49.6116, lng: 6.1319 }, transitStops, transitDeps, t,
  now: new Date("2026-10-08T06:30:00Z"),   // jeudi 08:30 à Luxembourg (horaire T1 embarqué)
};
const help = answerLocally("bonjour, tu vas bien ?", ctx);   // ce que l'assistant déterministe répond

describe("outils exposés au modèle", () => {
  it("six outils, tous adossés à une fonction existante de l'application", () => {
    expect(TOOL_NAMES).toEqual(["find_station", "list_stations", "next_departures", "weather", "route", "start_navigation"]);
    for (const name of TOOL_NAMES) {
      const args = name === "route" || name === "start_navigation" ? { destination: "Glacis" } : {};
      expect(executeTool({ name, args }, ctx), name).toMatchObject({ text: expect.any(String) });
    }
  });
  it("la consigne interdit au modèle d'avancer une valeur", () => {
    expect(systemPrompt(tr(fr))).toMatch(/N'écris jamais de nombre/);
    expect(systemPrompt(tr(en))).toMatch(/Never write a number/);
  });
});

// Vraie traduction (et non la factice) : la consigne et la langue sont de la prose.
const tr = (dict) => (k, p = {}) => String(dict[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");

describe("langue de réponse (retour du téléphone : réponse en anglais dans une application française)", () => {
  it("la consigne est dans la langue de l'interface, et la langue SUIT la liste des outils", () => {
    const s = systemPrompt(tr(fr));
    expect(s.startsWith(fr["ui.ai.sys"])).toBe(true);
    const tools = s.indexOf("List of tools: [");
    expect(tools).toBeGreaterThan(0);
    expect(s.lastIndexOf(fr["ui.ai.sys_lang"])).toBeGreaterThan(tools);
    expect(s.endsWith(fr["ui.ai.sys_lang"])).toBe(true);
    expect(systemPrompt(tr(en)).endsWith(en["ui.ai.sys_lang"])).toBe(true);
  });
  it("liste des outils au format du gabarit du modèle (tojson à la Python), chaque outil une fois", () => {
    const s = systemPrompt(tr(fr));
    expect(s).toContain('{"type": "function", "function": {"name": "find_station", ');
    for (const name of TOOL_NAMES) expect(s.split(`"name": "${name}"`).length - 1, name).toBe(1);
  });
  it("reconnaît le français et l'anglais des sorties réelles du banc", () => {
    expect(replyLanguage("Hello! How can I assist you today?")).toBe("en");
    expect(replyLanguage("I don't speak French, but I can help you.")).toBe("en");
    expect(replyLanguage("Bonjour ! Comment puis-je vous aider aujourd'hui ?")).toBe("fr");
    expect(replyLanguage("Je peux t'aider à résoudre ton problème !")).toBe("fr");
    expect(replyLanguage("Hello! Bien sûr, je parle français. Comment puis-je vous aider aujourd'hui ?")).toBe("fr");
  });
  it("indécidable : texte trop court ou sans mot-outil — rien n'est rejeté sur ce motif", () => {
    expect(replyLanguage("Coucou ! Bon voyage !")).toBe("?");
    expect(replyLanguage("Pourquoi ?")).toBe("?");
  });
  it("une réponse anglaise dans l'interface française n'est pas montrée : repli, raison dite", () => {
    expect(checkFreeText("Hello! How can I assist you today?", "fr")).toEqual({ ok: false, reason: "language" });
    expect(checkFreeText("Bonjour ! Comment puis-je vous aider aujourd'hui ?", "fr").ok).toBe(true);
    expect(checkFreeText("Bonjour ! Comment puis-je vous aider aujourd'hui ?", "en")).toEqual({ ok: false, reason: "language" });
    const r = resolveModelOutput("Hello! How can I assist you today?<|im_end|>", { ...ctx, lang: "fr" }, help);
    expect(r).toMatchObject({ source: "fallback", reason: "language" });
    expect(explainFallback(r.reason).key).toBe("ui.ai.diag.why.language");
    expect(fr["ui.ai.diag.why.language"]).toBeTruthy();
    expect(en["ui.ai.diag.why.language"]).toBeTruthy();
  });
  it("sans langue connue (appel ancien), le texte n'est pas jugé sur sa langue", () => {
    expect(checkFreeText("Hello! How can I assist you today?").ok).toBe(true);
  });
});

describe("lecture des appels (formats réellement produits)", () => {
  it("LFM2.5 : appel pythonique entre jetons spéciaux (sortie réelle du modèle)", () => {
    const raw = '<|tool_call_start|>[start_navigation(destination="Glacis", mode="bicycling")]<|tool_call_end|>';
    expect(readModelOutput(raw)).toEqual({ kind: "call", call: { name: "start_navigation", args: { destination: "Glacis", mode: "bicycling" } } });
  });
  it("même appel sans les jetons (décodage qui les retire)", () => {
    expect(readModelOutput('[weather()]')).toEqual({ kind: "call", call: { name: "weather", args: {} } });
  });
  it("format JSON <tool_call>", () => {
    expect(parseToolCalls('<tool_call>{"name":"list_stations","arguments":{"limit":2}}</tool_call>'))
      .toEqual([{ name: "list_stations", args: { limit: 2 } }]);
  });
  it("aucun code n'est évalué : une expression n'est pas un littéral", () => {
    expect(readModelOutput('<|tool_call_start|>[list_stations(limit=__import__("os"))]<|tool_call_end|>').kind).toBe("invalid");
  });
});

describe("validation : tout appel douteux est rejeté", () => {
  const ko = (name, args) => validateCall({ name, args });
  it("appel conforme : accepté, synonymes courants normalisés", () => {
    expect(ko("find_station", { name: "Hamilius", need: "docks" })).toEqual({ ok: true, name: "find_station", args: { name: "Hamilius", need: "dock" } });
    expect(ko("route", { destination: "Gare", mode: "walk" }).args.mode).toBe("walking");
    expect(ko("list_stations", { limit: "3" }).args.limit).toBe(3);
  });
  it.each([
    ["outil inventé (LFM2 au banc)", "next_departure_time", {}, /^unknown-tool/],
    ["argument inventé", "next_departures", { location: "Gare" }, /^unknown-arg:location/],
    ["énumération inconnue", "find_station", { need: "scooter" }, /^bad-value:need/],
    ["mauvais type (nombre pour un nom)", "find_station", { name: 42 }, /^bad-value:name/],
    ["mauvais type (objet pour un entier)", "list_stations", { limit: { n: 3 } }, /^bad-value:limit/],
    ["entier hors bornes (haut)", "list_stations", { limit: 50 }, /^bad-value:limit/],
    ["entier hors bornes (bas)", "list_stations", { limit: 0 }, /^bad-value:limit/],
    ["entier non entier", "list_stations", { limit: 2.5 }, /^bad-value:limit/],
    ["texte de description recopié (FunctionGemma)", "find_station", { need: "bike to take a bike for a ride" }, /^bad-value:need/],
    ["nom démesuré", "route", { destination: "x".repeat(61) }, /^bad-value:destination/],
    ["balisage dans un nom", "route", { destination: "<|im_end|>Gare" }, /^bad-value:destination/],
    ["argument requis absent", "route", { mode: "walking" }, /^missing:destination/],
    ["arguments qui ne sont pas un objet", "weather", ["x"], /^bad-args/],
  ])("%s", (_, name, args, reason) => {
    const v = ko(name, args);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(reason);
  });
  it("plusieurs appels à la fois : rejeté", () => {
    expect(readModelOutput("<|tool_call_start|>[weather(), list_stations()]<|tool_call_end|>"))
      .toEqual({ kind: "invalid", reason: "several-calls" });
  });
  it("appel commencé mais illisible (sortie coupée) : rejeté", () => {
    expect(readModelOutput("<|tool_call_start|>[find_station(name=").kind).toBe("invalid");
    expect(readModelOutput("<|tool_call_start|>").kind).toBe("invalid");
  });
});

describe("exécution : la réponse vient des données, jamais du modèle", () => {
  it("station nommée : ses compteurs réels", () => {
    const r = executeTool({ name: "find_station", args: { name: "hamilius" } }, ctx);
    expect(r.text).toMatch(/"name":"Hamilius"/);
    expect(r.text).toMatch(/"bikes":"4 /);
  });
  it("vélo électrique : première station ouverte qui en a", () => {
    expect(executeTool({ name: "find_station", args: { need: "ebike" } }, ctx).text).toMatch(/Theater Plaza/);
  });
  it("rendre un vélo : station avec des bornes libres", () => {
    expect(executeTool({ name: "find_station", args: { need: "dock" } }, ctx).text).toMatch(/^ui\.ai\.ans\.docks .*Hamilius/);
  });
  it("liste : stations fermées exclues, limite respectée", () => {
    const r = executeTool({ name: "list_stations", args: { limit: 5 } }, ctx);
    expect(r.text.split("\n")).toHaveLength(3);
    expect(r.text).not.toMatch(/Fermée/);
  });
  it("bus : départs temps réel déjà chargés, tram exclu, filtrés par arrêt", () => {
    const r = executeTool({ name: "next_departures", args: { mode: "bus", stop: "Hamilius" } }, ctx);
    expect(r.text).toMatch(/"line":"16"/);
    expect(r.text).not.toMatch(/"line":"T1"/);
  });
  it("tram : horaire officiel du T1 embarqué, arrêt le plus proche", () => {
    const r = executeTool({ name: "next_departures", args: { mode: "tram" } }, ctx);
    expect(r.text).toMatch(/^ui\.ai\.tool\.tram .*"time":"\d\d:\d\d"/);
  });
  it("trajet à pied : distance à vol d'oiseau et temps de marche, cible de navigation", () => {
    const r = executeTool({ name: "route", args: { destination: "Glacis", mode: "walking" } }, ctx);
    expect(r.text).toMatch(/^ui\.ai\.tool\.route_walk .*"name":"Glacis".*"min":"\d+ min"/);
    expect(r.nav).toMatchObject({ name: "Glacis", mode: "walking" });
  });
  it("trajet à vélo : distance seulement (aucune vitesse inventée)", () => {
    const r = executeTool({ name: "route", args: { destination: "Glacis" } }, ctx);
    expect(r.text).toMatch(/^ui\.ai\.tool\.route_bike /);
    expect(r.text).not.toMatch(/"min"/);
  });
  it("navigation : coordonnées prises dans les données, pas dans la sortie du modèle", () => {
    const r = executeTool({ name: "start_navigation", args: { destination: "glacis", mode: "bicycling" } }, ctx);
    expect(r.nav).toEqual({ lat: 49.6162, lng: 6.1255, name: "Glacis", mode: "bicycling" });
  });
  it.each([
    ["station inconnue", { name: "find_station", args: { name: "Atlantis" } }],
    ["lieu inconnu", { name: "start_navigation", args: { destination: "Atlantis" } }],
    ["arrêt de bus inconnu", { name: "next_departures", args: { mode: "bus", stop: "Atlantis" } }],
    ["outil inconnu", { name: "rm_rf", args: {} }],
  ])("%s : aucune réponse (on ne devine pas)", (_, call) => {
    expect(executeTool(call, ctx)).toBeNull();
  });
  it("outil qui lève une exception : aucune réponse, pas de plantage", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(executeTool({ name: "list_stations", args: {} }, { ...ctx, stations: null, t: () => { throw new Error("x"); } })).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("texte libre : jamais une valeur que le modèle n'a pas obtenue d'un outil", () => {
  it.each([
    ["Bonjour ! Comment puis-je vous aider aujourd'hui ?", true],
    ["Avec plaisir, bonne route !", true],
    ["Le prochain tram passe dans 10 minutes.", false],             // Qwen3 au banc : donnée inventée
    ["Il reste trois vélos à la Gare.", false],
    ["Il fait vingt degrés.", false],
    ["C'est à quelques km.", false],
    ["C'est le prochain tram qui arrivera à Luxembourg le [date].", false],   // sortie réelle de LFM2.5
    ["", false],
    ["<|im_end|>", false],
    ["find_station(name=\"Gare\") voilà", false],
    ["ok ok ok ok ok ok ok ok ok ok ok ok ok ok", false],
    ["a".repeat(600), false],
    // Sorties dégénérées observées sur téléphone (APK du 9 octobre)
    ["地黎", false],
    ['talk"talk"', false],
    ["buck", false],
    ["Bonjour 地黎 !", false],
    ["Oui.", false],
    ["Voici une blague : « Pourquoi le vélo tombe-t-il ? Parce qu'il est crevé ! » 😄", true],
  ])("%j → montré : %s", (text, shown) => {
    expect(checkFreeText(text).ok).toBe(shown);
  });
});

describe("repli : l'assistant déterministe répond dès que le modèle flanche", () => {
  const resolve = (raw) => resolveModelOutput(raw, ctx, help);

  it("appel valide exécuté : réponse de l'outil", () => {
    const r = resolve("<|tool_call_start|>[weather()]<|tool_call_end|>");
    expect(r).toMatchObject({ source: "tool", tool: "weather" });
    expect(r.text).toMatch(/^ui\.ai\.ans\.wx /);
  });
  it.each([
    ["outil inventé", '<|tool_call_start|>[next_departure_time(location="Gare")]<|tool_call_end|>'],
    ["arguments faux", '<|tool_call_start|>[list_stations(limit=99)]<|tool_call_end|>'],
    ["lieu introuvable", '<|tool_call_start|>[start_navigation(destination="Atlantis")]<|tool_call_end|>'],
    ["valeur inventée", "Le prochain bus passe dans 4 minutes."],
    ["muet", ""],
    ["balisage seul", "<|im_end|>"],
  ])("%s → réponse de l'assistant local, telle quelle", (_, raw) => {
    const r = resolve(raw);
    expect(r.source).toBe("fallback");
    expect(r.text).toBe(help.text);
    expect(r.reason).toBeTruthy();
  });
  it("Markdown du modèle retiré avant affichage (sortie réelle)", () => {
    expect(resolve("**Pourquoi les chiens portent-ils des lunettes ?**  \n*Pour mieux voir !*").text)
      .toBe("Pourquoi les chiens portent-ils des lunettes ?\nPour mieux voir !");
  });
  it.each([
    ["autre écriture", "地黎", "script"],
    ["fragment", 'talk"talk"', "fragment"],
    ["mot isolé", "buck", "fragment"],
  ])("%s (sortie du téléphone) → réponse de l'assistant local", (_, raw, reason) => {
    expect(resolve(raw)).toMatchObject({ source: "fallback", text: help.text, reason });
  });
  it("aucune valeur numérique sans outil : « EDELECK (19 km) » écrit par le modèle n'est jamais montré", () => {
    expect(resolve("La station la plus proche est EDELECK (19 km), 3 vélos, 12 bornes.")).toMatchObject({ source: "fallback", reason: "number" });
    expect(resolve("La plus proche est EDELECK, à dix-neuf kilomètres.")).toMatchObject({ source: "fallback" });
  });
  it("texte libre sans valeur : montré", () => {
    expect(resolve("Bonjour ! Comment puis-je vous aider ?")).toEqual({ text: "Bonjour ! Comment puis-je vous aider ?", source: "model" });
  });
  it("les schémas transmis au modèle restent ceux du banc (nom, paramètres)", () => {
    expect(TOOLS.map((x) => Object.keys(x.function.parameters.properties))).toEqual([
      ["name", "need"], ["limit"], ["mode", "stop"], [], ["destination", "mode"], ["destination", "mode"],
    ]);
  });
});

describe("explainFallback : un repli avec le modèle prêt se dit, avec sa raison", () => {
  // Toutes les raisons que produisent resolveModelOutput, validateCall et la façade.
  const reasons = [
    "empty", "too-long", "markup", "number", "unit", "script", "fragment", "repetition",
    "several-calls", "unparsable-call", "malformed", "bad-args", "unknown-tool:fly", "unknown-arg:x",
    "bad-value:mode", "missing:destination", "no-data:route", "generate", "generate_timeout",
  ];
  it("chaque raison connue a une explication propre, traduite en français et en anglais", () => {
    for (const r of reasons) {
      const e = explainFallback(r);
      expect(e.key, r).not.toBe("ui.ai.diag.why.other");
      expect(fr[e.key], r).toBeTruthy();
      expect(en[e.key], r).toBeTruthy();
      expect(e.code).toBe(r);   // le code exact reste visible
    }
    for (const k of ["ui.ai.ans.help_model", "ui.ai.diag.title_error", "ui.ai.diag.title_rejected",
                     "ui.ai.diag.raw", "ui.ai.diag.raw_hidden", "ui.ai.diag.raw_empty", "ui.ai.diag.detail", "ui.ai.diag.why.other"]) {
      expect(fr[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
    }
  });
  it("raison inconnue : dite comme telle, jamais masquée", () => {
    expect(explainFallback("quelque-chose")).toMatchObject({ key: "ui.ai.diag.why.other", code: "quelque-chose" });
    expect(explainFallback(undefined)).toMatchObject({ key: "ui.ai.diag.why.error", code: "generate" });
  });
  it("outil sans donnée : l'outil est nommé", () => {
    expect(explainFallback("no-data:find_station")).toMatchObject({ key: "ui.ai.diag.why.no_data", tool: "find_station" });
  });
  it("valeur inventée : la sortie brute reste consultable mais repliée", () => {
    expect(explainFallback("number").hideRaw).toBe(true);
    expect(explainFallback("unit").hideRaw).toBe(true);
    expect(explainFallback("markup").hideRaw).toBe(false);
  });
  it("le texte d'aide affiché quand le modèle est prêt ne prétend pas qu'il n'y a pas de modèle", () => {
    expect(fr["ui.ai.ans.help_model"]).not.toMatch(/sans modèle|activez/i);
    expect(en["ui.ai.ans.help_model"]).not.toMatch(/without a model|enable/i);
    expect(fr["ui.ai.ans.help_model"]).not.toMatch(/\d/);
  });
});
