#!/usr/bin/env node
// Preuve que formatChat (src/ai/chatTemplate.js) produit, pour chaque famille des candidats
// natifs (chatml, phi3, zephyr), EXACTEMENT le prompt d'apply_chat_template sur le vrai
// tokenizer du modèle (téléchargé du Hub). Écrit les cas et le texte attendu dans
// src/__fixtures__/native_chat_templates.json, que chatTemplate.test.js rejoue hors ligne.
// (LFM2.5 : template.mjs.)
//
//   node scripts/bench-native/template-families.mjs
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
const { default: fr } = await import("../../src/locales/fr.js");

env.cacheDir = `${process.env.HOME}/.cache/velohnav-bench`;
const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");
const sys = { role: "system", content: systemPrompt(t) };
// Dépôts des tokenizers (les GGUF reprennent leur gabarit).
const FAMILIES = {
  chatml: "Qwen/Qwen2.5-0.5B-Instruct",
  phi3: "microsoft/Phi-3-mini-4k-instruct",
  zephyr: "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
};
const CASES = [
  { name: "consigne de l'application + question", messages: [sys, { role: "user", content: "bonjour" }] },
  { name: "multi-tours", messages: [sys, { role: "user", content: "Je suis Silex" }, { role: "assistant", content: "Enchanté !" }, { role: "user", content: "il pleut ?" }] },
  { name: "sans consigne", messages: [{ role: "user", content: "vélo ?" }] },
  // Outils au format du gabarit : seul Qwen en a un (Phi-3, TinyLlama : bloc Qwen, non comparé).
  { name: "outils", only: "chatml", messages: [{ role: "system", content: fr["ui.ai.sys"] }, { role: "user", content: "vélo ?" }], tools: TOOLS },
  { name: "outils sans consigne", only: "chatml", messages: [{ role: "user", content: "vélo ?" }], tools: TOOLS.slice(0, 2) },
];

let ko = 0;
const out = [];
for (const [template, repo] of Object.entries(FAMILIES)) {
  const tok = await AutoTokenizer.from_pretrained(repo);
  for (const c of CASES.filter((x) => !x.only || x.only === template)) {
    let expected = tok.apply_chat_template(c.messages, { tokenize: false, add_generation_prompt: true, ...(c.tools ? { tools: c.tools } : {}) });
    // Le jeton de début est ajouté par le tokenizer (Llama) ou écrit par le gabarit (Phi-3) :
    // le moteur natif ne l'ajoute jamais, formatChat l'écrit toujours.
    if (template !== "chatml" && !expected.startsWith("<s>")) expected = `<s>${expected}`;
    const got = formatChat(c.messages, { template, tools: c.tools });
    const same = got === expected;
    if (!same) ko++;
    console.log(`${same ? "identique" : "DIFFÉRENT"} · ${template} · ${c.name}`);
    if (!same) {
      const i = [...expected].findIndex((ch, k) => ch !== got[k]);
      console.log("  attendu :", JSON.stringify(expected.slice(Math.max(0, i - 40), i + 60)));
      console.log("  obtenu  :", JSON.stringify(got.slice(Math.max(0, i - 40), i + 60)));
    }
    const { only, ...kept } = c;
    out.push({ template, ...kept, expected });
  }
}
writeFileSync(new URL("../../src/__fixtures__/native_chat_templates.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`${out.length - ko}/${out.length} identiques`);
process.exit(ko ? 1 : 0);
