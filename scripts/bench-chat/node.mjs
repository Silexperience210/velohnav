#!/usr/bin/env node
// Banc « conversation libre » sous Node (onnxruntime-node) : mêmes questions, mêmes
// configurations et même chemin d'affichage que la page navigateur (run.mjs), mais
// sur CPU (q4, q8…) ou WebGPU natif (q4f16). Complète run.mjs, qui ne peut pas
// exécuter q4f16 sans « shader-f16 » ni q4 en WASM (GatherBlockQuantized absent).
//
//   node scripts/bench-chat/node.mjs [dtype=q4] [device=cpu] [config,config…] [dossier-modèle]
import { register } from "node:module";
// tram.js importe un JSON sans attribut d'import (Vite l'accepte, Node non).
register("data:text/javascript," + encodeURIComponent(`
  export async function load(url, ctx, next) {
    if (url.endsWith(".json")) return next(url, { ...ctx, importAttributes: { type: "json" } });
    return next(url, ctx);
  }`));
const { AutoTokenizer, AutoModelForCausalLM, env } = await import("@huggingface/transformers");
const { TOOLS } = await import("../../src/ai/tools.js");
const { systemPrompt, resolveModelOutput } = await import("../../src/ai/assistant.js");
const { answerLocally } = await import("../../src/ai/localAnswers.js");
const { cleanReply } = await import("../../src/ai/localModel.js");
const { MODEL } = await import("../../src/ai/modelPolicy.js");
const { default: fr } = await import("../../src/locales/fr.js");
const { QUESTIONS, CONFIGS } = await import("./cases.js");

const [dtype = "q4", device = "cpu", configs = "", modelsDir = `${process.env.HOME}/.cache/vn-models/`] = process.argv.slice(2);
env.allowRemoteModels = false;
env.localModelPath = modelsDir;
const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");

let peak = 0;
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
const tok = await AutoTokenizer.from_pretrained(MODEL.id);
const model = await AutoModelForCausalLM.from_pretrained(MODEL.id, { dtype, device });
const ctx = { stations: [], t, now: new Date() };
const rows = [];
for (const cfg of CONFIGS.filter((c) => !configs || configs.split(",").includes(c.id))) {
  for (const q of QUESTIONS) {
    if (answerLocally(q, { t, stations: [] }).unknown !== true) throw new Error(`question traitée sans modèle : ${q}`);
    // Exactement ce que fait le worker (modelWorker.complete) avec les options de localModel.generate.
    const inputs = tok.apply_chat_template([{ role: "system", content: systemPrompt(t) }, { role: "user", content: q }],
      { tools: TOOLS, add_generation_prompt: true, return_dict: true });
    const out = await model.generate({ ...inputs, max_new_tokens: 96, ...cfg.options });
    const n = inputs.input_ids.dims.at(-1);
    const raw = tok.decode(out.slice(null, [n, null])[0], { skip_special_tokens: false });
    const shown = resolveModelOutput(cleanReply(raw), ctx, { text: "<repli local>" });
    rows.push({ cfg: cfg.id, q, raw, ...shown });
    console.log(`[${cfg.id}] ${q}\n   brut    : ${JSON.stringify(raw)}\n   affiché : ${shown.source}${shown.reason ? ":" + shown.reason : ""} ${shown.source === "model" ? JSON.stringify(shown.text) : ""}`);
  }
}
clearInterval(timer);
console.log(`\nRésumé ${dtype}/${device} — pic RSS ${(peak / 1e6).toFixed(0)} Mo`);
for (const cfg of CONFIGS) {
  const list = rows.filter((r) => r.cfg === cfg.id);
  if (!list.length) continue;
  const fin = list.filter((r) => r.raw.includes("<|im_end|>")).length;
  const reasons = list.filter((r) => r.source !== "model").map((r) => r.reason).join(", ");
  console.log(`  ${cfg.label.padEnd(42)} montrées ${list.filter((r) => r.source === "model").length}/${list.length}, terminées ${fin}/${list.length}${reasons ? " — repli : " + reasons : ""}`);
}
