#!/usr/bin/env node
// Reproduction ciblée : la conversation libre du téléphone tenait sur PLUSIEURS tours,
// alors que le banc ne testait qu'un seul échange. Mêmes fichiers, mêmes options que
// l'application (max_new_tokens 256, do_sample false, outils), mais avec un historique.
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  export async function load(url, ctx, next) {
    if (url.endsWith(".json")) return next(url, { ...ctx, importAttributes: { type: "json" } });
    return next(url, ctx);
  }`));
const { AutoTokenizer, AutoModelForCausalLM, env } = await import("@huggingface/transformers");
const { systemPrompt } = await import("../../src/ai/assistant.js");
const { cleanReply } = await import("../../src/ai/localModel.js");
const { MODEL } = await import("../../src/ai/modelPolicy.js");
const { default: fr } = await import("../../src/locales/fr.js");

env.allowRemoteModels = false;
env.localModelPath = `${process.env.HOME}/.cache/vn-models/`;
const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");

const tok = await AutoTokenizer.from_pretrained(MODEL.id);
const model = await AutoModelForCausalLM.from_pretrained(MODEL.id, { dtype: "q4", device: "cpu" });

const ask = async (history, label) => {
  const inputs = tok.apply_chat_template([{ role: "system", content: systemPrompt(t) }, ...history],
    { add_generation_prompt: true, return_dict: true });
  const t0 = Date.now();
  const out = await model.generate({ ...inputs, max_new_tokens: 256, do_sample: false });
  const n = inputs.input_ids.dims.at(-1);
  const raw = tok.decode(out.slice(null, [n, null])[0], { skip_special_tokens: false });
  const shown = cleanReply(raw);
  console.log(`[${label}] ${history.length} msg, ${Date.now() - t0} ms\n  brut    : ${JSON.stringify(raw)}\n  affiché : ${JSON.stringify(shown)}`);
  return shown;
};

await ask([{ role: "user", content: "Bonjour, comment ça va ?" }], "mono-tour");

const history = [];
const qs = [
  "Bonjour, comment ça va ?", "Qui es-tu ?", "Raconte-moi une blague sur le vélo.",
  "Merci beaucoup pour ton aide !", "Comment fonctionne le Vel'OH! ?",
  "Faut-il un casque pour circuler en ville ?", "Comment bien régler la selle ?",
];
for (const q of qs) {
  history.push({ role: "user", content: q });
  const a = await ask(history, `tour ${Math.ceil(history.length / 2)}`);
  history.push({ role: "assistant", content: a });
}
console.log("[fin]");
