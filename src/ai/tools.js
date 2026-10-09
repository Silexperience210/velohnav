// Outils exposés au modèle conversationnel — définitions et lecture des appels.
//
// Principe : le modèle ne calcule plus rien, il DEMANDE. Mesuré : même des modèles
// plus gros inventent des compteurs de vélos et des horaires de bus quand on leur
// donne les données en vrac dans le prompt. Ici le modèle n'écrit qu'un nom d'outil
// et des arguments ; l'application valide l'appel (validateCall), exécute l'outil sur
// ses propres données (assistant.js) et rédige la réponse elle-même, avec t(). Un chiffre affiché ne
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
    { limit: { type: "integer", minimum: 1, maximum: 5, description: "How many stations (1-5)" } }),
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
      if (i >= s.length) return undefined;   // chaîne jamais refermée (sortie coupée)
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
    let closed = false;   // « ) » atteinte sans erreur : sinon l'appel est mal formé
    for (;;) {
      ws();
      if (i >= s.length) break;
      if (s[i] === ")") { i++; closed = true; break; }
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
    // Un appel tronqué ou contenant autre chose que des littéraux est rendu MARQUÉ
    // (validateCall le rejette) plutôt qu'avec des arguments partiels.
    out.push(closed ? { name: name.split(".").pop(), args } : { name: name.split(".").pop(), args, malformed: true });
  }
  return out;
}

// Longueur maximale d'un nom (station, arrêt, lieu) : au-delà, ce n'est plus un nom.
const MAX_STRING = 60;

/**
 * Valide un appel contre son schéma. STRICT : le modèle se trompe souvent (6/12 au banc),
 * et un appel douteux ne doit rien déclencher. Rejeté si :
 *   - l'outil est inconnu, ou les arguments ne sont pas un objet ;
 *   - un argument n'existe pas dans le schéma (argument inventé) ;
 *   - une valeur n'a pas le bon type, sort de son énumération (synonymes courants
 *     tolérés : « walk », « e-bike »…) ou de ses bornes (minimum / maximum) ;
 *   - une chaîne est vide, trop longue ou contient du balisage ;
 *   - un argument requis manque.
 * Un appel rejeté est ignoré : l'application répond alors sans le modèle.
 * @returns {{ ok: true, name: string, args: object } | { ok: false, reason: string }}
 */
export function validateCall(call) {
  const def = call && BY_NAME.get(call.name);
  if (!def) return { ok: false, reason: `unknown-tool:${call?.name ?? "?"}` };
  if (call.malformed) return { ok: false, reason: "malformed" };
  const raw = call.args ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "bad-args" };
  const props = def.parameters.properties;
  const args = {};
  for (const [k, v0] of Object.entries(raw)) {
    const spec = props[k];
    if (!spec) return { ok: false, reason: `unknown-arg:${k}` };
    if (v0 === undefined || v0 === null || v0 === "") continue;   // absent = valeur par défaut
    const v = checkValue(spec, v0);
    if (v === undefined) return { ok: false, reason: `bad-value:${k}` };
    args[k] = v;
  }
  for (const k of def.parameters.required) {
    if (args[k] === undefined) return { ok: false, reason: `missing:${k}` };
  }
  return { ok: true, name: call.name, args };
}

/** Valeur conforme au schéma (normalisée), ou undefined si elle ne l'est pas. */
function checkValue(spec, v) {
  if (spec.enum) {
    if (typeof v !== "string") return undefined;
    const low = v.toLowerCase().trim();
    if (spec.enum.includes(low)) return low;
    return spec.enum.includes(ENUM_ALIASES[low]) ? ENUM_ALIASES[low] : undefined;
  }
  if (spec.type === "integer") {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n)) return undefined;
    if (spec.minimum !== undefined && n < spec.minimum) return undefined;
    if (spec.maximum !== undefined && n > spec.maximum) return undefined;
    return n;
  }
  if (spec.type === "string") {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    if (!t || t.length > MAX_STRING || /[<>{}[\]|\\\u0000-\u001f]/.test(t)) return undefined;
    return t;
  }
  return undefined;
}

/**
 * Lecture d'une sortie brute du modèle, sans rien exécuter :
 *   - { kind: "call", call }        un et un seul appel, valide ;
 *   - { kind: "invalid", reason }   tentative d'appel inutilisable (inconnu, mal formé,
 *                                   arguments faux, plusieurs appels à la fois) ;
 *   - { kind: "text", text }        pas d'appel : le modèle a répondu en texte.
 */
export function readModelOutput(text) {
  const s = String(text ?? "");
  const calls = parseToolCalls(s);
  const attempted = calls.length > 0 || /<\|tool_call_start\|>|<tool_call>/.test(s);
  if (!attempted) return { kind: "text", text: stripToolMarkup(s) };
  if (calls.length !== 1) return { kind: "invalid", reason: calls.length ? "several-calls" : "unparsable-call" };
  const v = validateCall(calls[0]);
  return v.ok ? { kind: "call", call: { name: v.name, args: v.args } } : { kind: "invalid", reason: v.reason };
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
