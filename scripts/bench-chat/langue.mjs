#!/usr/bin/env node
// Banc « langue de réponse » : le modèle répond-il dans la langue de l'interface ?
// Retour du téléphone : à une question en français, il a répondu EN ANGLAIS qu'il ne
// savait pas parler français. Ce banc compare des consignes système sur des messages
// courts ou ambigus (ceux qui font dériver un petit modèle), en mono-tour et dans une
// conversation, avec les outils et les options de l'application.
//
//   node scripts/bench-chat/langue.mjs [dtype=q4] [device=cpu] [consigne,consigne…]
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  export async function load(url, ctx, next) {
    if (url.endsWith(".json")) return next(url, { ...ctx, importAttributes: { type: "json" } });
    return next(url, ctx);
  }`));
const { AutoTokenizer, AutoModelForCausalLM, env } = await import("@huggingface/transformers");
const { TOOLS, readModelOutput } = await import("../../src/ai/tools.js");
const { systemPrompt, replyLanguage } = await import("../../src/ai/assistant.js");
const { cleanReply, generationOptions } = await import("../../src/ai/localModel.js");
const { MODEL } = await import("../../src/ai/modelPolicy.js");
const { default: fr } = await import("../../src/locales/fr.js");
const { default: en } = await import("../../src/locales/en.js");

const [dtype = "q4", device = "cpu", only = ""] = process.argv.slice(2);
env.allowRemoteModels = false;
env.localModelPath = `${process.env.HOME}/.cache/vn-models/`;
const tr = (dict) => (k, p = {}) => String(dict[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");

// Consignes comparées. « app » : celle de l'application (systemPrompt), quelle qu'elle soit.
const PROMPTS = {
  // Outils inclus dans la consigne (systemPrompt) : le gabarit ne doit pas les rajouter.
  app: (t) => ({ system: systemPrompt(t), tools: false }),
  // Consigne d'avant ce banc : corps anglais, langue en dernière phrase (puis la liste
  // des outils, en anglais, ajoutée par le gabarit du modèle).
  avant: (t) => "You are the assistant of a bike navigation app in Luxembourg. Call a tool when one matches the question. "
    + "Never state a number, time, distance or count yourself: only tools know them. " + t("ui.ai.sys_lang_old"),
};
// Candidates, entièrement dans la langue de l'interface, la langue en tête.
PROMPTS.fr_court = () => "Tu es l'assistant d'une application de vélo au Luxembourg. Tu parles français et tu réponds TOUJOURS en français, "
  + "même si on t'écrit en anglais. Appelle un outil quand la question correspond. N'écris jamais de nombre, d'heure ni de distance : "
  + "seuls les outils les connaissent. Réponds en une ou deux phrases.";
PROMPTS.fr_tete = () => "Langue de réponse : français, uniquement. "
  + "Tu es l'assistant d'une application de vélo au Luxembourg. Appelle un outil quand la question correspond. "
  + "N'écris jamais de nombre, d'heure ni de distance : seuls les outils les connaissent. Réponds brièvement, en français.";
// La langue AU PLUS PRÈS de la génération. Le gabarit du modèle ajoute la liste des
// outils (plusieurs centaines de jetons d'anglais) APRÈS la consigne : la consigne de
// langue se retrouve loin du tour à produire.
//   fr_apres : liste des outils écrite par nous, au format du gabarit, puis la langue ;
//   fr_user  : rappel de langue accolé au dernier message de l'utilisateur.
// tojson du gabarit : séparateurs « , » et « : » espacés, comme en Python.
const tojson = (v) => (Array.isArray(v) ? "[" + v.map(tojson).join(", ") + "]"
  : v && typeof v === "object" ? "{" + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ": " + tojson(x)).join(", ") + "}"
  : JSON.stringify(v));
const toolList = () => "List of tools: [" + TOOLS.map(tojson).join(", ") + "]";
PROMPTS.fr_apres = () => ({ system: PROMPTS.fr_court() + "\n" + toolList() + "\nRéponds toujours en français.", tools: false });
PROMPTS.fr_user = () => ({ system: PROMPTS.fr_court(), userSuffix: "\n\n(Réponds en français.)" });
const OLD = { "ui.ai.sys_lang_old": "Réponds en français, concis (4-5 lignes). Sois direct et utile." };

const MONO = [
  "Tu parles français ?",
  "Est-ce que tu sais parler français ?",
  "Salut",
  "Bonjour",
  "Coucou !",
  "ok",
  "Merci",
  "Je suis Silex",
  "Pourquoi ?",
  "Tu es qui ?",
  "Hello",
  "Raconte-moi une blague.",
  "Que peux-tu faire ?",
  "Il fait beau aujourd'hui, non ?",
];
// Questions à outil (mêmes que scripts/bench-tools.mjs) : une consigne qui gagne en
// langue ne doit pas perdre les appels d'outil. [question, outil attendu]
const TOOL_CASES = [
  ["Où est-ce que je peux prendre un vélo électrique ?", "find_station"],
  ["Il reste des places pour rendre mon vélo à la station Hamilius ?", "find_station"],
  ["Y a-t-il des vélos à la station Gare ?", "find_station"],
  ["C'est quand le prochain tram ?", "next_departures"],
  ["Le bus passe quand à l'arrêt Royal ?", "next_departures"],
  ["Est-ce qu'il va pleuvoir cet après-midi ?", "weather"],
  ["Il fait assez beau pour rouler ?", "weather"],
  ["Combien de temps à vélo jusqu'à la Gare ?", "route"],
  ["C'est loin à pied le Kirchberg ?", "route"],
  ["Guide-moi jusqu'au Glacis à vélo", "start_navigation"],
  ["Montre-moi les 3 stations les plus proches", "list_stations"],
];
const CONV = ["Bonjour", "Je suis Silex", "Tu parles français ?", "Tu te souviens de mon prénom ?", "Merci, à plus !"];

const tok = await AutoTokenizer.from_pretrained(MODEL.id);
const model = await AutoModelForCausalLM.from_pretrained(MODEL.id, { dtype, device });

async function ask(p, history) {
  const { system, tools = true, userSuffix = "" } = typeof p === "string" ? { system: p } : p;
  const last = history.length - 1;
  const msgs = history.map((m, i) => (i === last && userSuffix ? { ...m, content: m.content + userSuffix } : m));
  const inputs = tok.apply_chat_template([{ role: "system", content: system }, ...msgs],
    { ...(tools ? { tools: TOOLS } : {}), add_generation_prompt: true, return_dict: true });
  const t0 = performance.now();
  const out = await model.generate({ ...inputs, ...generationOptions({ maxNewTokens: 96 }) });
  const n = inputs.input_ids.dims.at(-1);
  const raw = tok.decode(out.slice(null, [n, null])[0], { skip_special_tokens: false });
  const generated = out.dims.at(-1) - n;
  return { raw, ms: performance.now() - t0, promptTokens: n, generated };
}

const summary = [];
for (const [lang, dict] of [["fr", { ...fr, ...OLD }], ["en", { ...en, "ui.ai.sys_lang_old": en["ui.ai.sys_lang"] }]]) {
  const t = tr(dict);
  for (const [id, make] of Object.entries(PROMPTS)) {
    if (only && !only.split(",").includes(id)) continue;
    // En anglais, seules quelques questions : vérifier que la consigne suit bien la langue.
    const mono = lang === "fr" ? MONO : ["Do you speak English?", "Hi", "Who are you?", "Tell me a joke."];
    const conv = lang === "fr" ? CONV : [];
    const system = make(t);
    let ok = 0, bad = 0, calls = 0, ms = 0, toks = 0;
    const tally = (q, r) => {
      const out = readModelOutput(cleanReply(r.raw));
      const text = out.kind === "text" ? out.text : "";
      const got = out.kind !== "text" ? "outil" : replyLanguage(text);
      if (out.kind !== "text") calls++; else if (got === lang) ok++; else bad++;
      ms += r.ms; toks += r.generated;
      console.log(`[${lang}/${id}] ${q}\n   → ${got.padEnd(5)} ${Math.round(r.ms)} ms, ${r.generated} jetons (prompt ${r.promptTokens}) : ${JSON.stringify(cleanReply(r.raw)).slice(0, 160)}`);
    };
    for (const q of mono) tally(q, await ask(system, [{ role: "user", content: q }]));
    const hist = [];
    for (const q of conv) {
      hist.push({ role: "user", content: q });
      const r = await ask(system, hist);
      tally(`(conversation) ${q}`, r);
      hist.push({ role: "assistant", content: cleanReply(r.raw) });
    }
    let toolOk = 0;
    if (lang === "fr") {
      for (const [q, want] of TOOL_CASES) {
        const r = await ask(system, [{ role: "user", content: q }]);
        const out = readModelOutput(cleanReply(r.raw));
        const got = out.kind === "call" ? out.call.name : out.kind;
        if (got === want) toolOk++;
        console.log(`[${lang}/${id}] outil ${q}\n   → ${got === want ? "juste" : "FAUX "} ${got} : ${JSON.stringify(cleanReply(r.raw)).slice(0, 120)}`);
      }
    }
    summary.push(`${lang}/${id.padEnd(8)} dans la langue ${ok}/${ok + bad} réponses texte (${calls} appels d'outil)`
      + (lang === "fr" ? `, outils justes ${toolOk}/${TOOL_CASES.length}` : "") + " — "
      + `${(toks / (ms / 1000)).toFixed(1)} jetons/s, ${Math.round(ms / (mono.length + conv.length))} ms par réponse`);
  }
}
console.log(`\nRésumé ${dtype}/${device}\n  ` + summary.join("\n  "));
