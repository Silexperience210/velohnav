#!/usr/bin/env node
// Reproduction EXACTE du cas d'usage réel : conversation libre, modèle chargé, questions
// non reconnues par l'assistant déterministe (dont « Je suis Silex »). Même chemin que
// AIScreen.sendText : historique (CHAT_TURNS, seules les réponses libres du modèle y
// entrent), consigne système, outils, options de localModel.generate, puis cleanReply et
// resolveModelOutput. Chaque étape est affichée : sortie brute (marqueurs compris), texte
// nettoyé, lecture (texte / appel / invalide), verdict, réponse finale et raison du repli.
//
//   node scripts/bench-chat/repro-conversation.mjs [dtype=q4] [device=cpu] [max_new_tokens=96] [dossier-modèle]
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  export async function load(url, ctx, next) {
    if (url.endsWith(".json")) return next(url, { ...ctx, importAttributes: { type: "json" } });
    return next(url, ctx);
  }`));
const { AutoTokenizer, AutoModelForCausalLM, env } = await import("@huggingface/transformers");
const { TOOLS, readModelOutput } = await import("../../src/ai/tools.js");
const { systemPrompt, resolveModelOutput, checkFreeText, plainText } = await import("../../src/ai/assistant.js");
const { answerLocally } = await import("../../src/ai/localAnswers.js");
const { cleanReply, generationOptions } = await import("../../src/ai/localModel.js");
const { MODEL } = await import("../../src/ai/modelPolicy.js");
const { default: fr } = await import("../../src/locales/fr.js");
const { CONVERSATION } = await import("./cases.js");

const [dtype = "q4", device = "cpu", maxArg = "", modelsDir = `${process.env.HOME}/.cache/vn-models/`] = process.argv.slice(2);
env.allowRemoteModels = false;
env.localModelPath = modelsDir;
const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");
const CHAT_TURNS = 6;   // AIScreen.jsx

const tok = await AutoTokenizer.from_pretrained(MODEL.id);
const model = await AutoModelForCausalLM.from_pretrained(MODEL.id, { dtype, device });
const ctx = { stations: [], t, now: new Date() };
// 96 : valeur passée par AIScreen.sendText.
const options = generationOptions({ maxNewTokens: Number(maxArg) || 96 });
console.log(`[repro] ${dtype}/${device}, options ${JSON.stringify(options)}\n`);

let aiHistory = [];
const summary = [];
for (const q of CONVERSATION) {
  const local = answerLocally(q, ctx);
  if (local.unknown !== true) { console.log(`« ${q} » → reconnu sans modèle, ignoré`); continue; }
  const hist = [...aiHistory, { role: "user", content: q }].slice(-CHAT_TURNS);
  const inputs = tok.apply_chat_template([{ role: "system", content: systemPrompt(t) }, ...hist],
    { tools: TOOLS, add_generation_prompt: true, return_dict: true });
  const t0 = Date.now();
  const out = await model.generate({ ...inputs, ...options });
  const n = inputs.input_ids.dims.at(-1);
  const ids = out.slice(null, [n, null]).tolist()[0];
  const raw = tok.decode(out.slice(null, [n, null])[0], { skip_special_tokens: false });
  const cleaned = cleanReply(raw);
  const read = readModelOutput(cleaned);
  const chk = read.kind === "text" ? checkFreeText(plainText(read.text)) : null;
  const shown = resolveModelOutput(cleaned, ctx, local);
  const ended = raw.includes("<|im_end|>");
  console.log(`« ${q} »  (${hist.length} msg, ${ids.length} jetons générés${ended ? ", fin de tour" : ", COUPÉ par max_new_tokens"}, ${Date.now() - t0} ms)`);
  console.log(`   brut       : ${JSON.stringify(raw)}`);
  console.log(`   nettoyé    : ${JSON.stringify(cleaned)}`);
  console.log(`   lecture    : ${read.kind}${read.kind === "text" ? ` ${JSON.stringify(read.text)}` : read.kind === "call" ? ` ${JSON.stringify(read.call)}` : ` (${read.reason})`}`);
  if (chk) console.log(`   contrôle   : ${chk.ok ? "accepté" : `REJETÉ (${chk.reason})`}`);
  console.log(`   affiché    : [${shown.source}${shown.reason ? ":" + shown.reason : ""}] ${JSON.stringify(shown.text.slice(0, 120))}\n`);
  summary.push({ q, source: shown.source, reason: shown.reason, ended, tokens: ids.length });
  if (shown.source === "model") aiHistory = [...hist, { role: "assistant", content: shown.text }];
}
console.log("Résumé :");
for (const r of summary) console.log(`  ${r.source.padEnd(8)} ${(r.reason || "").padEnd(16)} ${String(r.tokens).padStart(3)} jetons${r.ended ? "" : " (coupé)"}  « ${r.q} »`);
