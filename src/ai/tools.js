// Outils exposés au modèle conversationnel — définitions et lecture des appels.
//
// Principe : le modèle ne calcule plus rien, il DEMANDE. Mesuré : même des modèles
// plus gros inventent des compteurs de vélos et des horaires de bus quand on leur
// donne les données en vrac dans le prompt. Ici le modèle n'écrit qu'un nom d'outil
// et des arguments ; l'application exécute l'outil sur ses propres données
// (toolExec.js) et rédige la réponse elle-même, avec t(). Un chiffre affiché ne
// passe donc jamais par le modèle.
//
// Module PUR : aucune dépendance au navigateur, testable tel quel.

/**
 * Schémas au format « function calling » (JSON Schema), transmis tels quels au
 * gabarit de conversation du modèle (apply_chat_template({ tools })).
 * Descriptions en anglais, courtes : c'est la langue d'entraînement des petits
 * modèles à outils ; les questions, elles, peuvent être en français.
 * Paramètres réduits au strict nécessaire — chaque jeton de prompt coûte sur un
 * modèle de 350 M paramètres, et chaque argument est une occasion de se tromper.
 */
export const TOOLS = Object.freeze([
  fn("find_station",
    "Vel'OH! bike-share station: bikes, e-bikes and free docks. With name: that station. Without name: the nearest one having what the user needs.",
    {
      name: { type: "string", description: "Station name if the user gave one, e.g. Gare, Hamilius" },
      need: { type: "string", enum: ["bike", "ebike", "dock"], description: "bike to take a bike, ebike for an electric bike, dock to return or park a bike" },
    }),
  fn("list_stations",
    "List the closest Vel'OH! stations with their bikes and docks.",
    { limit: { type: "integer", description: "How many stations (1-5)" } }),
  fn("next_departures",
    "Next public transport departures (bus or tram) at a stop near the user, real-time when available. Not for travel time.",
    { mode: { type: "string", enum: ["bus", "tram"] }, stop: { type: "string", description: "Stop name, if the user gave one" } }),
  fn("weather",
    "Current weather, rain forecast for the next hours and the cycling score (is it a good time to ride).",
    {}),
  fn("route",
    "How far and how long it takes to get to a place by bike or on foot.",
    { destination: { type: "string", description: "Place name" }, mode: { type: "string", enum: ["bicycling", "walking"] } },
    ["destination"]),
  fn("start_navigation",
    "Start AR turn-by-turn guidance to a place, when the user asks to be guided, taken or brought somewhere.",
    { destination: { type: "string", description: "Place name" }, mode: { type: "string", enum: ["bicycling", "walking"] } },
    ["destination"]),
]);

function fn(name, description, properties, required = []) {
  return Object.freeze({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  });
}

const BY_NAME = new Map(TOOLS.map((t) => [t.function.name, t.function]));
export const TOOL_NAMES = Object.freeze([...BY_NAME.keys()]);

// Synonymes tolérés pour les valeurs énumérées : un petit modèle écrit volontiers
// « walk » ou « e-bike ». On normalise plutôt que de rejeter un appel juste.
const ENUM_ALIASES = {
  bicycle: "bicycling", bike: "bicycling", cycling: "bicycling", velo: "bicycling",
  walk: "walking", foot: "walking", pied: "walking",
  "e-bike": "ebike", electric: "ebike", elec: "ebike",
  docks: "dock", return: "dock", parking: "dock", borne: "dock",
  bikes: "bike", trams: "tram", buses: "bus",
};

/**
 * Extrait les appels d'outils d'une sortie brute. Formats reconnus :
 *   - Hermes / Granite / Qwen : <tool_call>{"name": …, "arguments": {…}}</tool_call>
 *   - LFM2 (pythonique)       : <|tool_call_start|>[f(a="x"), g()]<|tool_call_end|>
 *   - à défaut, un objet JSON {"name", "arguments"} isolé dans le texte.
 * @returns {Array<{name: string, args: object}>} appels bruts (non validés)
 */
export function parseToolCalls(text) {
  const s = String(text ?? "");
  const calls = [];
  for (const m of s.matchAll(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g)) {
    const c = jsonCall(m[1]);
    if (c) calls.push(c);
  }
  if (calls.length) return calls;
  for (const m of s.matchAll(/<\|tool_call_start\|>\s*([\s\S]*?)\s*(?:<\|tool_call_end\|>|$)/g)) {
    const body = m[1].trim();
    calls.push(...(body.startsWith("{") || body.startsWith("[{") ? jsonCalls(body) : pythonCalls(body)));
  }
  if (calls.length) return calls;
  // Liste pythonique nue : `[weather()]`. C'est ce que rend transformers.js pour
  // LFM2, qui décode en retirant les jetons spéciaux — balises comprises. On
  // l'exige en tête de réponse et sur un nom d'outil connu : une liste entre
  // crochets au milieu d'une phrase n'est pas un appel.
  const bare = /^\s*\[\s*([A-Za-z_]\w*)\s*\(/.exec(s);
  if (bare && BY_NAME.has(bare[1])) {
    const end = s.indexOf("]", s.lastIndexOf(")"));
    return pythonCalls(s.slice(s.indexOf("["), end >= 0 ? end + 1 : undefined));
  }
  // Repli : un objet JSON {"name": …} nu, que certains modèles écrivent sans balises.
  const brace = s.indexOf("{");
  if (brace >= 0 && /"name"\s*:/.test(s)) {
    const c = jsonCall(s.slice(brace, s.lastIndexOf("}") + 1));
    if (c) calls.push(c);
  }
  return calls;
}

function jsonCall(src) {
  try {
    const o = JSON.parse(src);
    return toCall(o);
  } catch {
    return null;
  }
}
function jsonCalls(src) {
  try {
    const o = JSON.parse(src);
    return (Array.isArray(o) ? o : [o]).map(toCall).filter(Boolean);
  } catch {
    return [];
  }
}
function toCall(o) {
  if (!o || typeof o !== "object") return null;
  const name = o.name ?? o.function?.name;
  let args = o.arguments ?? o.parameters ?? o.function?.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  return typeof name === "string" ? { name, args: args && typeof args === "object" ? args : {} } : null;
}

/**
 * Appels au format pythonique : `[f(a="x", b=2), g()]`. Analyse à la main — aucune
 * évaluation de code : seuls des littéraux (chaîne, nombre, booléen, None) sont admis.
 */
export function pythonCalls(src) {
  const out = [];
  let i = 0;
  const s = src.trim().replace(/^\[/, "").replace(/\]$/, "");
  const ws = () => { while (i < s.length && /[\s,]/.test(s[i])) i++; };
  const ident = () => {
    const m = /^[A-Za-z_][\w.]*/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const literal = () => {
    const q = s[i];
    if (q === '"' || q === "'") {
      let v = "";
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\" && i + 1 < s.length) { v += s[i + 1]; i += 2; } else v += s[i++];
      }
      i++;
      return v;
    }
    const m = /^-?\d+(\.\d+)?|^(True|False|None|true|false|null)/.exec(s.slice(i));
    if (!m) return undefined;
    i += m[0].length;
    if (m[2]) return /^(True|true)$/.test(m[2]) ? true : /^(False|false)$/.test(m[2]) ? false : null;
    return Number(m[0]);
  };
  while (i < s.length) {
    ws();
    const name = ident();
    if (!name) break;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== "(") break;
    i++;
    const args = {};
    for (;;) {
      ws();
      if (i >= s.length) break;
      if (s[i] === ")") { i++; break; }
      const k = ident();
      if (!k) { i = s.length; break; }
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] !== "=") { i = s.length; break; }
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      const v = literal();
      if (v === undefined) { i = s.length; break; }
      args[k] = v;
    }
    out.push({ name: name.split(".").pop(), args });
  }
  return out;
}

/**
 * Valide un appel contre son schéma : outil connu, arguments requis présents,
 * valeurs énumérées reconnues (synonymes tolérés), arguments inconnus retirés.
 * @returns {{ ok: true, name: string, args: object } | { ok: false, reason: string }}
 */
export function validateCall(call) {
  const def = call && BY_NAME.get(call.name);
  if (!def) return { ok: false, reason: `unknown-tool:${call?.name ?? "?"}` };
  const props = def.parameters.properties;
  const args = {};
  for (const [k, spec] of Object.entries(props)) {
    let v = call.args?.[k];
    if (v === undefined || v === null || v === "") continue;
    if (spec.enum) {
      const low = String(v).toLowerCase().trim();
      v = spec.enum.includes(low) ? low : spec.enum.includes(ENUM_ALIASES[low]) ? ENUM_ALIASES[low] : undefined;
      if (v === undefined) continue; // valeur fantaisiste : on l'ignore plutôt que de refuser l'appel
    } else if (spec.type === "integer") {
      v = Math.round(Number(v));
      if (!Number.isFinite(v)) continue;
    } else if (spec.type === "string") {
      v = String(v).trim().slice(0, 80);
      if (!v) continue;
    }
    args[k] = v;
  }
  for (const k of def.parameters.required) {
    if (args[k] === undefined) return { ok: false, reason: `missing:${k}` };
  }
  return { ok: true, name: call.name, args };
}

/** Premier appel valide d'une sortie brute, ou null (le modèle a répondu en texte). */
export function firstValidCall(text) {
  for (const c of parseToolCalls(text)) {
    const v = validateCall(c);
    if (v.ok) return v;
  }
  return null;
}

/** Texte du modèle débarrassé de tout fragment d'appel d'outil (pour l'afficher). */
export function stripToolMarkup(text) {
  return String(text ?? "")
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, "")
    .replace(/<\|tool_call_start\|>[\s\S]*?(<\|tool_call_end\|>|$)/g, "")
    .replace(/^\s*\[\s*[A-Za-z_]\w*\s*\([\s\S]*?\)\s*\]/, "")
    .replace(/<\|[a-z_]+\|>/g, "")
    .trim();
}
