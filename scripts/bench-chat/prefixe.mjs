#!/usr/bin/env node
// Banc du cache de préfixe (src/ai/promptCache.js) : mêmes questions, avec et sans
// réutilisation de l'état calculé sur la consigne + les outils. Vérifie que la sortie
// gloutonne est IDENTIQUE et mesure le temps gagné.
//
//   node scripts/bench-chat/prefixe.mjs [dtype=q4] [device=cpu]
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  export async function load(url, ctx, next) {
    if (url.endsWith(".json")) return next(url, { ...ctx, importAttributes: { type: "json" } });
    return next(url, ctx);
  }`));
const { AutoTokenizer, AutoModelForCausalLM, env } = await import("@huggingface/transformers");
const { TOOLS } = await import("../../src/ai/tools.js");
const { systemPrompt } = await import("../../src/ai/assistant.js");
const { generationOptions } = await import("../../src/ai/localModel.js");
const { MODEL } = await import("../../src/ai/modelPolicy.js");
const { reusablePrefix, prefixMessages, shareable, copyCache } = await import("../../src/ai/promptCache.js");
const { default: fr } = await import("../../src/locales/fr.js");

const [dtype = "q4", device = "cpu"] = process.argv.slice(2);
env.allowRemoteModels = false;
env.localModelPath = `${process.env.HOME}/.cache/vn-models/`;
const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");
const tok = await AutoTokenizer.from_pretrained(MODEL.id);
const model = await AutoModelForCausalLM.from_pretrained(MODEL.id, { dtype, device, session_options: { intraOpNumThreads: 1 } });
const tools = TOOLS;
const system = { role: "system", content: systemPrompt(t) };
const enc = (messages, gen) => tok.apply_chat_template(messages, { tools, add_generation_prompt: gen, return_dict: true });

// Même construction que modelWorker.complete : état pris à la fin du préfixe.
let a = performance.now();
const pre = enc(prefixMessages([system, { role: "user", content: "x" }]), false);
const { past_key_values: prefix } = await model.generate({ ...pre, max_new_tokens: 1, do_sample: false, return_dict_in_generate: true });
console.log(`préfixe : ${pre.input_ids.dims[1]} jetons calculés en ${((performance.now() - a) / 1000).toFixed(1)} s, partageable : ${shareable(prefix)}`);

const QUESTIONS = ["Bonjour", "Est-ce que tu sais parler français ?", "Je suis Silex", "Quel temps fait-il pour rouler ?", "Merci beaucoup !"];
let same = 0, tNo = 0, tYes = 0;
for (const q of QUESTIONS) {
  const inputs = enc([system, { role: "user", content: q }], true);
  const n = inputs.input_ids.dims[1];
  const opts = generationOptions({ maxNewTokens: 48 });
  a = performance.now();
  const plain = await model.generate({ ...inputs, ...opts });
  const dNo = performance.now() - a;
  const reuse = reusablePrefix(Array.from(inputs.input_ids.data), Array.from(pre.input_ids.data));
  a = performance.now();
  const cached = await model.generate({ ...inputs, ...opts, ...(reuse ? { past_key_values: copyCache(prefix) } : {}) });
  const dYes = performance.now() - a;
  const x = tok.decode(plain.slice(null, [n, null])[0], { skip_special_tokens: false });
  const y = tok.decode(cached.slice(null, [n, null])[0], { skip_special_tokens: false });
  same += x === y; tNo += dNo; tYes += dYes;
  console.log(`${q}\n   réutilisé ${reuse}/${n} jetons — sans cache ${(dNo / 1000).toFixed(1)} s, avec ${(dYes / 1000).toFixed(1)} s, ${x === y ? "sortie identique" : "SORTIE DIFFÉRENTE"}`
    + `\n   ${JSON.stringify(x).slice(0, 120)}${x === y ? "" : `\n   ${JSON.stringify(y).slice(0, 120)}`}`);
}
console.log(`\n${same}/${QUESTIONS.length} sorties identiques ; total ${(tNo / 1000).toFixed(1)} s sans cache, ${(tYes / 1000).toFixed(1)} s avec`);
