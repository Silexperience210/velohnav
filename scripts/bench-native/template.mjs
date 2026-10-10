#!/usr/bin/env node
// Preuve que formatChat (src/ai/chatTemplate.js, voie native) produit EXACTEMENT le
// prompt de apply_chat_template (transformers.js, voie WebGPU / processeur) : mêmes
// conversations, comparaison caractère pour caractère. Écrit les cas et le texte attendu
// dans src/__fixtures__/lfm25_chat_template.json, que chatTemplate.test.js rejoue sans
// transformers.js ni modèle.
//
//   node scripts/bench-native/template.mjs [dossier-modèles=~/.cache/vn-models/]
import { writeFileSync } from "node:fs";
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  export async function load(url, ctx, next) {
    if (url.endsWith(".json")) return next(url, { ...ctx, importAttributes: { type: "json" } });
    return next(url, ctx);
  }`));
const { AutoTokenizer, env } = await import("@huggingface/transformers");
const { formatChat } = await import("../../src/ai/chatTemplate.js");
const { systemPrompt } = await import("../../src/ai/assistant.js");
const { TOOLS } = await import("../../src/ai/tools.js");
const { MODEL } = await import("../../src/ai/modelPolicy.js");
const { default: fr } = await import("../../src/locales/fr.js");

const [modelsDir = `${process.env.HOME}/.cache/vn-models/`] = process.argv.slice(2);
env.allowRemoteModels = false;
env.localModelPath = modelsDir;
const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");
const tok = await AutoTokenizer.from_pretrained(MODEL.id);

const sys = { role: "system", content: systemPrompt(t) };
const CASES = [
  { name: "consigne de l'application + question", messages: [sys, { role: "user", content: "bonjour" }] },
  { name: "multi-tours", messages: [sys, { role: "user", content: "Je suis Silex" }, { role: "assistant", content: "Enchanté !" }, { role: "user", content: "il pleut ?" }] },
  { name: "réflexion retirée des anciens tours", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "<think>x</think> b" }, { role: "user", content: "c" }, { role: "assistant", content: "<think>y</think>d" }] },
  { name: "option tools du gabarit", messages: [{ role: "system", content: "Sois bref." }, { role: "user", content: "vélo ?" }], tools: TOOLS },
  { name: "tools sans consigne", messages: [{ role: "user", content: "vélo ?" }], tools: TOOLS.slice(0, 2) },
  { name: "sans invite de génération", messages: [sys], addGenerationPrompt: false },
  { name: "rôle tool", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "<|tool_call_start|>[weather()]<|tool_call_end|>" }, { role: "tool", content: "{\"ok\": true}" }] },
];

let ko = 0;
const out = [];
for (const c of CASES) {
  const addGenerationPrompt = c.addGenerationPrompt ?? true;
  const expected = tok.apply_chat_template(c.messages, { tokenize: false, add_generation_prompt: addGenerationPrompt, ...(c.tools ? { tools: c.tools } : {}) });
  const got = formatChat(c.messages, { tools: c.tools, addGenerationPrompt });
  const same = got === expected;
  if (!same) ko++;
  console.log(`${same ? "identique" : "DIFFÉRENT"} · ${c.name} (${expected.length} caractères)`);
  if (!same) {
    const i = [...expected].findIndex((ch, k) => ch !== got[k]);
    console.log("  attendu :", JSON.stringify(expected.slice(Math.max(0, i - 40), i + 40)));
    console.log("  obtenu  :", JSON.stringify(got.slice(Math.max(0, i - 40), i + 40)));
  }
  out.push({ ...c, addGenerationPrompt, expected });
}
writeFileSync(new URL("../../src/__fixtures__/lfm25_chat_template.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`${CASES.length - ko}/${CASES.length} identiques`);
process.exit(ko ? 1 : 0);
