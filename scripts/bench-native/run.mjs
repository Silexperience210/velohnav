#!/usr/bin/env node
// Banc du moteur natif (llama.cpp) sur PC : mêmes questions et même consigne que
// l'application, gabarit formatChat (src/ai/chatTemplate.js), même lecture de la sortie
// (cleanReply → resolveModelOutput). Compare les moteurs : jetons/s, langue, verdict.
//
//   scripts/bench-native/build.sh
//   node scripts/bench-native/run.mjs <modèle.gguf> [cpu,vulkan] [fr|en] [threads=4]
//
// Mesure faite sur PC : elle valide la chaîne (gabarit, état de la consigne, langue) et
// compare les moteurs ENTRE EUX ; les jetons/s d'un téléphone sont à mesurer sur lui.
import { writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  export async function load(url, ctx, next) {
    if (url.endsWith(".json")) return next(url, { ...ctx, importAttributes: { type: "json" } });
    return next(url, ctx);
  }`));
const { splitPrompt } = await import("../../src/ai/chatTemplate.js");
const { systemPrompt, resolveModelOutput, replyLanguage } = await import("../../src/ai/assistant.js");
const { cleanReply } = await import("../../src/ai/localModel.js");
const { NATIVE_SELF_TEST, selfTestVerdict } = await import("../../src/ai/modelPolicy.js");
const { QUESTIONS } = await import("../bench-chat/cases.js");
const dicts = { fr: (await import("../../src/locales/fr.js")).default, en: (await import("../../src/locales/en.js")).default };

const [model, backends = "cpu,vulkan", lang = "fr", threads = "4"] = process.argv.slice(2);
if (!model) { console.error("usage: run.mjs <modèle.gguf> [cpu,vulkan] [fr|en] [threads]"); process.exit(2); }
const t = (k, p = {}) => String(dicts[lang][k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");
const sys = { role: "system", content: systemPrompt(t) };

// Cas : l'essai à vide du chargement natif, puis les questions libres du banc de conversation.
const cases = [
  { q: "(essai à vide)", messages: NATIVE_SELF_TEST.messages, selfTest: true },
  ...QUESTIONS.map((q) => ({ q, messages: [sys, { role: "user", content: q }] })),
];
const dir = mkdtempSync(join(tmpdir(), "vh-native-"));
const file = join(dir, "cases.bin");
writeFileSync(file, cases.map((c) => { const { prefix, rest } = splitPrompt(c.messages); return `${prefix}\x1f${rest}`; }).join("\x1e"));
const bin = new URL("./vh_llm_bench", import.meta.url).pathname;

for (const backend of backends.split(",")) {
  const lines = execFileSync(bin, [model, backend, file, "96", threads], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] })
    .trim().split("\n").map((l) => JSON.parse(l));
  const info = lines.find((l) => l.info)?.info;
  const err = lines.find((l) => l.error !== undefined && l.ok === undefined);
  console.log(`\n══ ${backend} ══ ${info ? `${info.device} ${info.description} · chargé en ${info.loadMs} ms` : `ÉCHEC : ${err?.error}`}`);
  if (!info) continue;
  const res = lines.filter((l) => l.ok !== undefined);
  let fr = 0, shown = 0, genT = 0, genMs = 0, prT = 0, prMs = 0;
  res.forEach((r, i) => {
    const c = cases[i];
    const text = cleanReply(r.text);
    if (c.selfTest) {
      console.log(`  essai à vide : ${JSON.stringify(text)} → ${selfTestVerdict(text).reason} · ${r.genTokens} jetons, ${(r.genTokens / (r.genMs / 1000)).toFixed(1)} j/s`);
      return;
    }
    const v = resolveModelOutput(r.text, { t, lang, stations: [], now: new Date() }, { text: "(repli)" });
    const said = replyLanguage(text);
    if (said === lang) fr++;
    if (v.source === "model") shown++;
    genT += r.genTokens; genMs += r.genMs;
    prT += r.promptTokens - r.reused; prMs += r.promptMs;
    console.log(`  ${c.q}\n    → ${JSON.stringify(text.slice(0, 140))} [langue ${said}, ${v.source}${v.reason ? ` ${v.reason}` : ""}] `
      + `${r.genTokens} j en ${(r.genMs / 1000).toFixed(2)} s · prompt ${r.promptTokens} j dont ${r.reused} repris, ${r.promptMs.toFixed(0)} ms`);
  });
  const n = res.length - 1;
  console.log(`  ── ${backend} : génération ${(genT / (genMs / 1000)).toFixed(1)} j/s · prompt ${(prT / (prMs / 1000)).toFixed(0)} j/s (hors consigne reprise)`
    + ` · réponses en ${lang} ${fr}/${n} · affichées ${shown}/${n}`);
}
