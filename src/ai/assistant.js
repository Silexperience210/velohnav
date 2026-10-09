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
import { fmtDist, fmtDuration, walkMinutes, stationView } from "../ui/format.js";
import { readModelOutput } from "./tools.js";
import {
  norm, approxDist, upcoming, findPlace, navAnswer, stationDetails,
  answerNearest, answerDocks, answerDepartures, answerWeather,
} from "./localAnswers.js";

/**
 * Consigne système. Celle du banc d'essai (les scores mesurés valent pour elle),
 * plus l'interdiction d'avancer une valeur et la langue de réponse.
 */
export function systemPrompt(t) {
  return "You are the assistant of a bike navigation app in Luxembourg. Call a tool when one matches the question. "
    + "Never state a number, time, distance or count yourself: only tools know them. "
    + t("ui.ai.sys_lang");
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
    ? { text: ctx.t("ui.ai.tool.route_walk", { name: p.name, dist: fmtDist(p.dist), min: fmtDuration(walkMinutes(p.dist)) }), nav }
    : { text: ctx.t("ui.ai.tool.route_bike", { name: p.name, dist: fmtDist(p.dist) }), nav };
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
 * obtenu d'aucun outil), du balisage, une boucle ou rien du tout.
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkFreeText(text) {
  const s = String(text ?? "").trim();
  if (s.length < 2) return { ok: false, reason: "empty" };
  if (s.length > MAX_FREE_TEXT) return { ok: false, reason: "too-long" };
  if (/<\|?|\|>|[[\]{}]|\w+\s*\(\s*\w+\s*=/.test(s)) return { ok: false, reason: "markup" };
  if (/\d/.test(s) || NUMBER_WORDS.test(norm(s))) return { ok: false, reason: "number" };
  if (UNITS.test(s)) return { ok: false, reason: "unit" };
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
  const chk = checkFreeText(text);
  return chk.ok ? { text, source: "model" } : fall(chk.reason);
}
