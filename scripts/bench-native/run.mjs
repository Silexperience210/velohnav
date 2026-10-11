#!/usr/bin/env node
// Banc du moteur natif (llama.cpp) sur PC : mêmes questions et même consigne que
// l'application, gabarit formatChat (src/ai/chatTemplate.js), même lecture de la sortie
// (cleanReply → resolveModelOutput). Compare les moteurs : jetons/s, langue, verdict.
//
//   scripts/bench-native/build.sh
//   node scripts/bench-native/run.mjs <modèle.gguf> [cpu,vulkan] [fr|en] [threads=4]
//
// Mesure faite sur PC : elle valide la chaîne (gabarit, état de la consigne, langue) et
// compare les moteurs ENTRE EUX ; les jetons/s d'un téléphone sont à mesurer sur lui :
// ADB=1 lance le même banc SUR LE TÉLÉPHONE branché (binaire de android.sh, envoyé avec le
// modèle dans /data/local/tmp/vh par adb).
//
// SELFTEST=1 : l'essai à vide de l'application, à l'identique (nativeModel.loadNative :
// deux tours, mêmes verdicts) — c'est le banc fixe dont la ligne d'état affiche la vitesse.
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { benchRun } from "./exec.mjs";
register("data:text/javascript," + encodeURIComponent(`
  export async function load(url, ctx, next) {
    if (url.endsWith(".json")) return next(url, { ...ctx, importAttributes: { type: "json" } });
    return next(url, ctx);
  }`));
const { splitPrompt } = await import("../../src/ai/chatTemplate.js");
const { systemPrompt, resolveModelOutput, replyLanguage } = await import("../../src/ai/assistant.js");
const { cleanReply } = await import("../../src/ai/localModel.js");
const { NATIVE_SELF_TEST, SECOND_TURN, secondTurn, selfTestVerdict, selfTestBench } = await import("../../src/ai/modelPolicy.js");
const { QUESTIONS } = await import("../bench-chat/cases.js");
const dicts = { fr: (await import("../../src/locales/fr.js")).default, en: (await import("../../src/locales/en.js")).default };

const [model, backends = "cpu,vulkan", lang = "fr", threads = "4"] = process.argv.slice(2);
if (!model) { console.error("usage: run.mjs <modèle.gguf> [cpu,vulkan] [fr|en] [threads]"); process.exit(2); }
const t = (k, p = {}) => String(dicts[lang][k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");
const sys = { role: "system", content: systemPrompt(t) };

// Cas : l'essai à vide du chargement natif, puis les questions libres du banc de conversation.
const cases = [
  { q: "(essai à vide)", messages: NATIVE_SELF_TEST.messages, selfTest: true },
  ...QUESTIONS.slice(0, Number(process.env.N) || undefined).map((q) => ({ q, messages: [sys, { role: "user", content: q }] })),
];
const dir = mkdtempSync(join(tmpdir(), "vh-native-"));
const file = join(dir, "cases.bin");
writeFileSync(file, cases.map((c) => { const { prefix, rest } = splitPrompt(c.messages); return `${prefix}\x1f${rest}`; }).join("\x1e"));
const bin = new URL("./vh_llm_bench", import.meta.url).pathname;
const runBin = (backend, path, max = process.env.MAX || "96") => benchRun({ bin, model, backend, cases: path, max, threads });

// CONV=1 : la conversation relevée sur le téléphone (« Bonsoir », « Je suis Silex »,
// « Salut », « Bonjour »), chaque tour reprenant les réponses BRUTES du modèle aux tours
// précédents — comme l'application. Sorties brutes affichées : c'est la dégradation au fil
// des tours (première réponse juste, puis un mot faux et la fin) qui est recherchée.
// VH_GPU_EXACT=0 : cache clés-valeurs fp16 et flash attention auto (réglage d'avant).
if (process.env.SELFTEST) {
  const said = (raw) => raw.split("<|im_end|>")[0].replace(/<\|[a-z_]+\|>/g, "").trim();
  for (const backend of backends.split(",")) {
    const turn = (messages, max) => {
      const { prefix, rest } = splitPrompt(messages);
      writeFileSync(file, `${prefix}\x1f${rest}`);
      const lines = runBin(backend, file, String(max));
      const r = lines.find((l) => l.ok !== undefined);
      return { info: lines.find((l) => l.info)?.info, r, err: lines.find((l) => l.error && l.ok === undefined)?.error };
    };
    // Deux appels séparés, comme l'application : le second tour dépend de la sortie du premier.
    const a = turn(NATIVE_SELF_TEST.messages, NATIVE_SELF_TEST.maxNewTokens);
    if (!a.r) { console.log(`══ ${backend} ══ ÉCHEC : ${a.err}`); continue; }
    const b = turn(secondTurn(NATIVE_SELF_TEST.messages, said(a.r.text)), NATIVE_SELF_TEST.secondMaxNewTokens);
    const v1 = selfTestVerdict(said(a.r.text)), v2 = selfTestVerdict(said(b.r.text), { minWords: SECOND_TURN.minWords });
    const bench = selfTestBench(a.info, [a.r, b.r]);
    console.log(`══ ${backend} ══ ${a.info.device} · ${a.info.threads} fils, cœurs ${a.info.cpus || "?"} (permis ${a.info.allowedCpus || "?"}, ${a.info.cpuset || "?"}) · calibrage j/s par fils ${JSON.stringify(a.info.threadsTps || {})}`);
    console.log(`  tour 1 : ${JSON.stringify(a.r.text)} → ${v1.ok ? "ok" : v1.reason}`);
    console.log(`  tour 2 : ${JSON.stringify(b.r.text)} → ${v2.ok ? "ok" : v2.reason}`);
    console.log(`  banc fixe : chargement ${bench.loadMs} ms · 1er jeton ${bench.firstMs} ms · ${bench.tokens} jetons à ${bench.tps} j/s · cible ≥ ${bench.target} j/s : ${bench.met ? "ATTEINTE" : "non atteinte"}`);
  }
  process.exit(0);
}

if (process.env.CONV) {
  for (const backend of backends.split(",")) {
    const history = [sys];
    console.log(`\n══ ${backend} · conversation · gpu_exact=${process.env.VH_GPU_EXACT ?? "1"} ══`);
    for (const q of ["Bonsoir", "Je suis Silex", "Salut", "Bonjour", "Quel temps fait-il pour rouler ?"]) {
      history.push({ role: "user", content: q });
      const { prefix, rest } = splitPrompt(history);
      writeFileSync(file, `${prefix}\x1f${rest}`);
      const lines = runBin(backend, file);
      const info = lines.find((l) => l.info)?.info;
      const r = lines.find((l) => l.ok !== undefined);
      if (!info || !r) { console.log(`  ÉCHEC : ${lines.find((l) => l.error)?.error}`); break; }
      console.log(`  ${q} → brut ${JSON.stringify(r.text.slice(0, 160))} · ${r.genTokens} j, ${(r.genTokens / (r.genMs / 1000)).toFixed(1)} j/s · prompt ${r.promptTokens} j · kv ${info.kv}`);
      history.push({ role: "assistant", content: cleanReply(r.text) });
    }
  }
  process.exit(0);
}

for (const backend of backends.split(",")) {
  const lines = runBin(backend, file);
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
  const mem = lines.find((l) => l.mem)?.mem;
  console.log(`  ── ${backend} : génération ${(genT / (genMs / 1000)).toFixed(1)} j/s · prompt ${(prT / (prMs / 1000)).toFixed(0)} j/s (hors consigne reprise)`
    + ` · réponses en ${lang} ${fr}/${n} · affichées ${shown}/${n}`
    + `${mem ? ` · mémoire résidente ${Math.round(mem.rssKb / 1024)} Mio, pic ${Math.round(mem.hwmKb / 1024)} Mio` : ""}`);
}
