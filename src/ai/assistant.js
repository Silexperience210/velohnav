// Conversation libre : ce que l'application fait d'une sortie du modèle.
//
// Le modèle (LFM2.5-350M) se trompe souvent : 6 appels d'outil justes sur 12 au banc
// (docs/MODELE.md). Il n'a donc AUCUNE autorité sur les faits :
//   - il choisit un outil ; l'appel est validé (tools.js) puis exécuté ICI, sur les
//     données déjà présentes dans l'application, et la phrase est écrite avec t() ;
//   - le résultat d'un outil ne lui est jamais renvoyé : il ne peut pas le recopier
//     de travers ;
//   - s'il répond en texte, ce texte n'est montré que s'il ne contient aucune valeur
//     (chiffre, nombre écrit, unité) — il n'en a obtenu d'aucun outil, il l'inventerait ;
//   - tout le reste (appel invalide, outil sans donnée, texte suspect, erreur, silence)
//     retombe sur l'assistant déterministe (localAnswers.js).
// Aucune donnée nouvelle, aucun appel réseau : seules les fonctions existantes servent.
//
// Module pur (traduction et données injectées), testable sans navigateur.
import { TRAM, nextDepartures, shortStopName } from "../utils/tram.js";
import { fmtDuration, walkMinutes, stationView } from "../ui/format.js";
import { readModelOutput, TOOLS } from "./tools.js";
import {
  norm, approxDist, upcoming, distLabel, findPlace, navAnswer, stationDetails,
  answerNearest, answerDocks, answerDepartures, answerWeather,
} from "./localAnswers.js";

// tojson du gabarit de LFM2.5 : séparateurs « , » et « : » espacés, comme en Python.
import { pyJson as tojson } from "./chatTemplate.js";

/**
 * Consigne système, outils compris, dans la langue de l'interface.
 *
 * Retour du téléphone : à « tu parles français ? », le modèle a répondu en anglais qu'il
 * ne savait pas. La consigne était en anglais, la langue en dernière phrase, et le gabarit
 * du modèle ajoutait ENSUITE la liste des outils (≈ 600 jetons d'anglais) : la langue se
 * retrouvait loin du tour à produire. Banc (scripts/bench-chat/langue.mjs, q4, glouton) :
 * 10 réponses françaises sur 17. La liste des outils est donc écrite ici, au format exact
 * du gabarit (« List of tools: [...] », vérifié identique), et la langue la SUIT :
 * 16/18, et 8 outils justes sur 11 au lieu de 7. Les appels passent donc SANS l'option
 * `tools` (le gabarit l'ajouterait une seconde fois).
 */
export function systemPrompt(t, tools = TOOLS) {
  return t("ui.ai.sys") + "\nList of tools: [" + tools.map(tojson).join(", ") + "]\n" + t("ui.ai.sys_lang");
}

// ── Exécution des outils ─────────────────────────────────────────────

// Mots d'un nom de lieu donné par le modèle, comparables aux noms connus.
const STOPWORDS = new Set(["station", "arret", "stop", "velo", "veloh", "tram", "bus"]);
const placeWords = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));

/** Station connue dont le nom correspond à `name` (sinon null : on ne devine pas). */
function stationNamed(stations, name) {
  const q = norm(name).trim();
  if (q.length < 3) return null;
  return stations.find((s) => norm(s.name) === q)
    ?? stations.find((s) => norm(s.name).includes(q))
    ?? null;
}

const open = (stations) => stations.filter((s) => s.status !== "CLOSED");

function findStation(ctx, { name, need }) {
  const { stations = [] } = ctx;
  if (name) {
    const st = stationNamed(stations, name);
    return st ? { text: stationDetails(ctx, st) } : null;
  }
  if (need === "dock") return answerDocks(ctx);
  if (need === "ebike") {
    const st = open(stations).find((s) => stationView(s).elec > 0);
    return { text: st ? stationDetails(ctx, st) : ctx.t("ui.ai.ans.no_station") };
  }
  return answerNearest(ctx);
}

function listStations(ctx, { limit = 3 }) {
  const list = open(ctx.stations || []).slice(0, limit);
  if (!list.length) return { text: ctx.t("ui.ai.ans.no_station") };
  return { text: list.map((s) => stationDetails(ctx, s)).join("\n") };
}

/** T1 : horaire officiel embarqué (utils/tram.js), à l'arrêt nommé ou au plus proche. */
function tramDepartures(ctx, stopName) {
  const { gpsPos = null, now = new Date() } = ctx;
  let stop = null;
  if (stopName) {
    const q = norm(stopName);
    stop = TRAM.stops.find((s) => norm(s.name).includes(q) || norm(shortStopName(s.name)) === q) ?? null;
  } else if (gpsPos) {
    stop = TRAM.stops.reduce((b, s) => (!b || approxDist(s, gpsPos) < approxDist(b, gpsPos) ? s : b), null);
  }
  if (!stop) return null;
  const { dirs } = nextDepartures(stop.idx, now, { limit: 1 });
  const lines = [...dirs[0], ...dirs[1]].map((d) =>
    ctx.t("ui.ai.tool.tram", { stop: shortStopName(stop.name), dir: shortStopName(d.headsign), time: d.time }));
  return { text: lines.length ? lines.join(" ") : ctx.t("ui.ai.tool.tram_none", { stop: shortStopName(stop.name) }) };
}

/** Bus (et tram) temps réel : départs Transitous déjà chargés par l'application. */
function liveDepartures(ctx, { mode, stop }) {
  const { transitStops = [], transitDeps = {} } = ctx;
  let stops = transitStops;
  if (stop) {
    const q = norm(stop);
    stops = transitStops.filter((s) => norm(s.name).includes(q));
    if (!stops.length) return null;   // arrêt inconnu ici : on ne devine pas
  }
  const isTram = (d) => /^t\d/i.test(String(d.line));
  const deps = upcoming(stops, filterDeps(transitDeps, mode === "bus" ? (d) => !isTram(d) : () => true), 3);
  return answerDepartures({ ...ctx, deps });
}

const filterDeps = (table, keep) =>
  Object.fromEntries(Object.entries(table || {}).map(([k, list]) => [k, (list || []).filter(keep)]));

function departures(ctx, { mode, stop }) {
  if (mode === "tram") return tramDepartures(ctx, stop);
  if (!mode && stop) {
    // Arrêt du T1 nommé sans préciser le mode : l'horaire du tram répond.
    const tram = tramDepartures(ctx, stop);
    if (tram) return tram;
  }
  return liveDepartures(ctx, { mode, stop });
}

/** Lieu connu (station ou arrêt du tram) désigné par le modèle, distance comprise. */
function place(ctx, destination) {
  const words = placeWords(destination);
  if (!words.length) return null;
  const p = findPlace(words, ctx);
  if (!p) return null;
  const dist = ctx.gpsPos ? approxDist(p, ctx.gpsPos) : p.dist;
  return { ...p, dist: Number.isFinite(dist) ? dist : null };
}

function route(ctx, { destination, mode }) {
  const p = place(ctx, destination);
  if (!p || p.dist == null) return null;
  const walking = mode === "walking";
  const nav = { lat: p.lat, lng: p.lng, name: p.name, mode: walking ? "walking" : "bicycling" };
  // Distance à vol d'oiseau, dite comme telle ; le temps n'est donné qu'à pied
  // (80 m/min, la règle de l'application). Le trajet exact est celui de la navigation.
  return walking
    ? { text: ctx.t("ui.ai.tool.route_walk", { name: p.name, dist: distLabel(ctx, p.dist), min: fmtDuration(walkMinutes(p.dist)) }), nav }
    : { text: ctx.t("ui.ai.tool.route_bike", { name: p.name, dist: distLabel(ctx, p.dist) }), nav };
}

function startNavigation(ctx, { destination, mode }) {
  const p = place(ctx, destination);
  if (!p) return null;
  const r = navAnswer(ctx, p);
  return mode ? { ...r, nav: { ...r.nav, mode } } : r;
}

const EXEC = {
  find_station: findStation,
  list_stations: listStations,
  next_departures: departures,
  weather: (ctx) => answerWeather(ctx),
  route,
  start_navigation: startNavigation,
};

/**
 * Exécute un appel DÉJÀ VALIDÉ (tools.validateCall) sur les données de l'application.
 * @returns {null | {text: string, nav?: object}} null : l'outil n'a pas de quoi répondre
 *   (station ou lieu inconnu…) — l'appelant retombe alors sur l'assistant déterministe.
 */
export function executeTool(call, ctx) {
  const fn = EXEC[call?.name];
  if (!fn) return null;
  try {
    return fn(ctx, call.args || {}) ?? null;
  } catch (e) {
    console.warn(`[IA] outil ${call.name} en échec :`, e?.message || e);
    return null;
  }
}

// ── Texte libre du modèle ────────────────────────────────────────────

const NUMBER_WORDS = new RegExp("\\b(" + [
  "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize",
  "quatorze", "quinze", "seize", "vingt", "trente", "quarante", "cinquante", "soixante", "cent", "cents",
  "mille", "demie?", "quart",
  "two", "three", "four", "five", "seven", "eight", "nine", "ten", "eleven", "twelve", "fifteen",
  "twenty", "thirty", "forty", "fifty", "sixty", "hundred", "thousand", "half", "quarter", "dozen",
].join("|") + ")\\b", "i");
const UNITS = /(\bkm\b|kilom|\bminutes?\b|\bmin\b|\bm[eè]tres?\b|\bmeters?\b|°|\bdegr|%|\bheures?\b|\bhours?\b|\bmm\b)/i;

/** Longueur maximale montrée (le modèle est borné à 96 jetons pour le texte libre). */
export const MAX_FREE_TEXT = 500;

/**
 * Le texte du modèle peut-il être montré ? Non s'il contient une valeur (il n'en a
 * obtenu d'aucun outil), du balisage, une autre écriture que la latine, un fragment,
 * une boucle ou rien du tout.
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkFreeText(text, lang = null) {
  const s = String(text ?? "").trim();
  if (s.length < 2) return { ok: false, reason: "empty" };
  if (s.length > MAX_FREE_TEXT) return { ok: false, reason: "too-long" };
  if (/<\|?|\|>|[[\]{}]|\w+\s*\(\s*\w+\s*=/.test(s)) return { ok: false, reason: "markup" };
  if (/\d/.test(s) || NUMBER_WORDS.test(norm(s))) return { ok: false, reason: "number" };
  if (UNITS.test(s)) return { ok: false, reason: "unit" };
  // Sorties dégénérées relevées sur téléphone : « 地黎 », « talk"talk" », « buck ».
  // La consigne demande du français (ou de l'anglais) : une lettre d'une autre écriture
  // trahit une génération qui a dérivé.
  if (/(?=\p{L})\P{Script=Latin}/u.test(s)) return { ok: false, reason: "script" };
  // Langue : un texte reconnu comme l'AUTRE langue de l'application n'est pas montré
  // (au banc, « Salut » ou « Merci » obtenaient encore parfois « Hello! How can I assist
  // you today? »). Un texte indécidable (« Coucou ! Bon voyage ! ») passe.
  const said = lang ? replyLanguage(s) : "?";
  if (said !== "?" && said !== lang) return { ok: false, reason: "language" };
  // Fragment : moins de deux mots, ou des guillemets collés entre deux lettres.
  if ((s.match(/\p{L}{2,}/gu) || []).length < 2 || /\p{L}["“”]\p{L}/u.test(s)) return { ok: false, reason: "fragment" };
  // Boucle : la même suite de quatre mots trois fois ou plus.
  const w = norm(s).split(/\s+/);
  const seen = new Map();
  for (let i = 0; i + 4 <= w.length; i++) {
    const k = w.slice(i, i + 4).join(" ");
    const n = (seen.get(k) || 0) + 1;
    if (n >= 3) return { ok: false, reason: "repetition" };
    seen.set(k, n);
  }
  return { ok: true, reason: "ok" };
}

// Mots-outils fréquents, propres à une langue (les mots communs aux deux — « on »,
// « a », « me »… — sont écartés : ils ne départagent rien).
const FUNCTION_WORDS = {
  fr: new Set(("je tu il elle nous vous ils elles le la les un une des du de et est sont suis es "
    + "pas ne que qui quoi pour avec dans sur ce cette ces mon ma mes ton ta tes votre vos au aux "
    + "mais ou donc oui non bonjour merci peux puis veux sais parle comment pourquoi tres bien "
    + "aussi avez vais etre fait faire voici quel quelle").split(" ")),
  en: new Set(("i you he she we they it the an and is are am was not don't can't cannot that "
    + "what who which for with this these my your our their of to in at do does how why "
    + "yes no hello hi thanks thank please can could would will speak sorry here there very "
    + "help have has be just").split(" ")),
};

/**
 * Langue d'un texte libre du modèle, par ses mots-outils : "fr", "en", ou "?" si le
 * texte est trop court ou trop mêlé pour trancher (rien n'est alors rejeté sur ce motif).
 * @returns {"fr" | "en" | "?"}
 */
export function replyLanguage(text) {
  const words = norm(String(text ?? "")).replace(/[’]/g, "'").split(/[^a-z']+/)
    .flatMap((w) => (FUNCTION_WORDS.en.has(w) ? [w] : w.split("'"))).filter(Boolean);
  let fr = 0, en = 0;
  for (const w of words) {
    if (FUNCTION_WORDS.fr.has(w)) fr++;
    else if (FUNCTION_WORDS.en.has(w)) en++;
  }
  if (fr + en < 2) return "?";
  if (fr >= 2 * en) return "fr";
  if (en >= 2 * fr) return "en";
  return "?";
}

/** Le modèle écrit volontiers du Markdown (**gras**, # titres) : la bulle affiche du texte brut. */
export const plainText = (s) => String(s ?? "").replace(/[*#`]+/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/**
 * Décide de la réponse à afficher pour une sortie brute du modèle.
 * @param {string} raw sortie du modèle (jetons d'appel d'outil compris)
 * @param {object} ctx données de l'application (mêmes champs que localAnswers + transitStops,
 *   transitDeps, now), avec `t`
 * @param {{text: string}} fallback réponse de l'assistant déterministe
 * @returns {{text: string, nav?: object, source: "tool"|"model"|"fallback", reason?: string, tool?: string}}
 */
export function resolveModelOutput(raw, ctx, fallback) {
  const out = readModelOutput(raw);
  const fall = (reason) => ({ ...fallback, source: "fallback", reason });
  if (out.kind === "invalid") return fall(out.reason);
  if (out.kind === "call") {
    const r = executeTool(out.call, ctx);
    return r?.text ? { ...r, source: "tool", tool: out.call.name } : fall(`no-data:${out.call.name}`);
  }
  const text = plainText(out.text);
  const chk = checkFreeText(text, ctx.lang ?? null);
  return chk.ok ? { text, source: "model" } : fall(chk.reason);
}

// ── Repli alors que le modèle est prêt : le dire ────────────────────

// Raisons de validation d'un appel d'outil (tools.validateCall / readModelOutput).
const CALL_REASONS = new Set([
  "several-calls", "unparsable-call", "malformed", "bad-args", "unknown-tool", "unknown-arg", "bad-value", "missing",
]);
const WHY = {
  empty: "empty", "too-long": "too_long", language: "language", markup: "markup", number: "number", unit: "unit", script: "script",
  fragment: "fragment", repetition: "repetition", "no-data": "no_data", generate: "error", generate_timeout: "timeout",
  webgpu_generate: "error",
};

/**
 * Pourquoi la réponse du modèle n'a pas été montrée, en clé traduisible.
 * Avant, le repli était muet : la bulle disait « Sans modèle… » alors que le modèle
 * était chargé, et personne ne pouvait savoir s'il avait échoué ou été rejeté.
 * @param {string} reason raison rendue par resolveModelOutput, ou code d'erreur (ModelError)
 * @returns {{ key: string, code: string, tool?: string, hideRaw: boolean }}
 *   `hideRaw` : la sortie contient une valeur que le modèle a
 *   inventée (aucun outil ne la lui a donnée) — elle reste consultable, repliée.
 */
export function explainFallback(reason) {
  const code = String(reason || "generate");
  const [family, detail] = code.split(":");
  const why = WHY[family] ?? (CALL_REASONS.has(family) ? "call" : "other");
  return {
    key: `ui.ai.diag.why.${why}`,
    code,
    ...(family === "no-data" && detail ? { tool: detail } : {}),
    hideRaw: why === "number" || why === "unit",
  };
}
