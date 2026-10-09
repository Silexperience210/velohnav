#!/usr/bin/env node
// Banc d'essai « appel d'outils » : charge un modèle ONNX avec la version de
// @huggingface/transformers installée (Node, onnxruntime-node, CPU), pose des
// questions types de l'application et affiche la sortie BRUTE (jetons spéciaux
// compris) + le pic de mémoire résidente du processus.
//
//   node scripts/bench-tools.mjs <dépôt> <dtype> [révision] [dossier-cache]
//   ex. node scripts/bench-tools.mjs onnx-community/LFM2-350M-ONNX q4 5bc4b3e8cf
//
// Les outils sont une copie figée des six outils de l'application (mêmes noms et schémas),
// recopiés ici pour que le script n'importe rien de src/.

import { AutoTokenizer, AutoModelForCausalLM, env } from "@huggingface/transformers";

const [repo, dtype = "q4", revision = "main", cacheDir = `${process.env.HOME}/.cache/velohnav-bench`] = process.argv.slice(2);
if (!repo) {
  console.error("usage : bench-tools.mjs <dépôt> <dtype> [révision] [cache]");
  process.exit(2);
}
env.cacheDir = cacheDir;

const fn = (name, description, properties, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});
const TOOLS = [
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
  fn("weather", "Current weather, rain forecast for the next hours and the cycling score (is it a good time to ride).", {}),
  fn("route",
    "How far and how long it takes to get to a place by bike or on foot.",
    { destination: { type: "string", description: "Place name" }, mode: { type: "string", enum: ["bicycling", "walking"] } },
    ["destination"]),
  fn("start_navigation",
    "Start AR turn-by-turn guidance to a place, when the user asks to be guided, taken or brought somewhere.",
    { destination: { type: "string", description: "Place name" }, mode: { type: "string", enum: ["bicycling", "walking"] } },
    ["destination"]),
];

// [question, outil attendu (null = aucun appel attendu)]
// [question, outil attendu (null = aucun appel attendu), valeurs d'arguments exigées]
const CASES = [
  ["Où est-ce que je peux prendre un vélo électrique ?", "find_station", ["ebike"]],
  ["Il reste des places pour rendre mon vélo à la station Hamilius ?", "find_station", ["Hamilius", "dock"]],
  ["Y a-t-il des vélos à la station Gare ?", "find_station", ["Gare"]],
  ["C'est quand le prochain tram ?", "next_departures", ["tram"]],
  ["Le bus passe quand à l'arrêt Royal ?", "next_departures", ["bus", "Royal"]],
  ["Est-ce qu'il va pleuvoir cet après-midi ?", "weather", []],
  ["Il fait assez beau pour rouler ?", "weather", []],
  ["Combien de temps à vélo jusqu'à la Gare ?", "route", ["Gare"]],
  ["C'est loin à pied le Kirchberg ?", "route", ["Kirchberg", "walking"]],
  ["Guide-moi jusqu'au Glacis à vélo", "start_navigation", ["Glacis"]],
  ["Montre-moi les 3 stations les plus proches", "list_stations", ["3"]],
  ["Bonjour, merci pour ton aide !", null, []],
];

// Un nom d'outil ne compte que dans une syntaxe d'appel : `name(`, `call:name{`,
// `"name": "name"` — pas cité dans une phrase (« weather updates »).
const calledTools = (text) => TOOLS.map((x) => x.function.name).filter((name) =>
  new RegExp(`(?:\\b${name}\\s*[({]|call:${name}\\b|"name"\\s*:\\s*"${name}")`).test(text));

let peak = 0;
const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
const timer = setInterval(sample, 50);
const mb = (b) => (b / 1e6).toFixed(0);

const rss0 = process.memoryUsage().rss;
const t0 = Date.now();
const tokenizer = await AutoTokenizer.from_pretrained(repo, { revision });
const model = await AutoModelForCausalLM.from_pretrained(repo, { dtype, device: "cpu", revision });
sample();
console.log(`# ${repo}@${revision} (${dtype}) — chargé en ${((Date.now() - t0) / 1000).toFixed(1)} s, RSS après chargement ${mb(process.memoryUsage().rss)} Mo (départ ${mb(rss0)} Mo)`);

let hits = 0;
for (const [q, expected, values] of CASES) {
  const messages = [
    { role: "system", content: "You are the assistant of a bike navigation app in Luxembourg. Call a tool when one matches the question." },
    { role: "user", content: q },
  ];
  const inputs = tokenizer.apply_chat_template(messages, {
    tools: TOOLS, add_generation_prompt: true, return_dict: true,
    enable_thinking: false, // Qwen3 : pas de bloc <think> (ignoré par les autres gabarits)
  });
  const t = Date.now();
  const out = await model.generate({ ...inputs, max_new_tokens: 48, do_sample: false });
  const n = inputs.input_ids.dims.at(-1);
  const text = tokenizer.decode(out.slice(null, [n, null])[0], { skip_special_tokens: false });
  sample();
  const called = calledTools(text);
  const ok = expected
    ? called.length === 1 && called[0] === expected && values.every((v) => text.includes(v))
    : called.length === 0;
  if (ok) hits++;
  console.log(`\n[${ok ? "OK " : "KO "}] ${q}  (prompt ${n} jetons, ${Date.now() - t} ms)\n  attendu : ${expected ?? "aucun appel"} ${values.join(", ")}\n  sortie  : ${JSON.stringify(text)}`);
}
clearInterval(timer);
console.log(`\n# score ${hits}/${CASES.length} — pic RSS ${mb(peak)} Mo`);
