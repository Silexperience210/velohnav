#!/usr/bin/env node
// Comparaison des modèles natifs candidats (src/ai/modelPolicy.js : NATIVE_CANDIDATES) sur
// le moteur de l'application (vh_llm.cpp via vh_llm_bench) : même consigne, mêmes outils,
// gabarit de chaque famille (chatTemplate.js), même lecture de la sortie que l'application
// (cleanReply → resolveModelOutput).
//
//   node scripts/bench-native/fetch.mjs all          # GGUF vérifiés (taille, SHA-256)
//   scripts/bench-native/build.sh
//   node scripts/bench-native/compare.mjs [clé,clé…|all] [threads=4] [dossier=~/.cache/vn-models/gguf]
//
// Mesures par modèle : chargement, 1er jeton, jetons/s de génération, mémoire (RSS, pic,
// PSS) — et un mini-test de qualité en trois familles de questions :
//   station   l'outil find_station doit être appelé, avec les bons arguments ;
//   météo     l'outil weather ;
//   libre     réponse affichable (resolveModelOutput : « model ») ET en français, plus un
//             tour de mémoire (« Je suis Silex » puis « Tu te souviens de mon prénom ? »).
// Les sorties sont gardées dans le JSON écrit en fin de banc (OUT=…) : la note de cohérence
// et d'utilité se lit dessus, elle ne se calcule pas.
//
// Sur PC, les jetons/s comparent les modèles ENTRE EUX. ADB=1 lance le même banc sur le
// téléphone branché (exec.mjs). PHONE_REF=<j/s de LFM2.5-350M mesurés sur le téléphone>
// (95 par défaut, 88–101 relevés sur Snapdragon 888) : estimation par proportion.
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
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
const { readModelOutput, TOOLS } = await import("../../src/ai/tools.js");
const { cleanReply } = await import("../../src/ai/localModel.js");
const { NATIVE_CANDIDATES } = await import("../../src/ai/modelPolicy.js");
const fr = (await import("../../src/locales/fr.js")).default;

const [which = "all", threads = "4", dir = `${process.env.HOME}/.cache/vn-models/gguf`] = process.argv.slice(2);
const keys = which === "all" ? Object.keys(NATIVE_CANDIDATES) : which.split(",");
const PHONE_REF = Number(process.env.PHONE_REF) || 95;
const REF_KEY = "lfm2.5-350m";
const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");
// Consigne : celle de l'application pour LFM2.5 (outils au format LFM, langue en dernier).
// Autres familles : même consigne, outils au format de leur gabarit (chatTemplate.js) —
// la liste LFM, Qwen ne l'utilise pas : il répond sans outil et invente.
const sysFor = (m) => (m.template === "lfm"
  ? { sys: { role: "system", content: systemPrompt(t) }, tools: undefined }
  : { sys: { role: "system", content: `${t("ui.ai.sys")}\n${t("ui.ai.sys_lang")}` }, tools: TOOLS });

// [famille, question, outil attendu (null : réponse libre), valeurs exigées dans les arguments]
export const CASES = [
  ["station", "Où est-ce que je peux prendre un vélo électrique ?", "find_station", ["ebike"]],
  ["station", "Il reste des places pour rendre mon vélo à la station Hamilius ?", "find_station", ["hamilius", "dock"]],
  ["station", "Y a-t-il des vélos à la station Gare ?", "find_station", ["gare"]],
  ["station", "Je veux rendre mon vélo, où est-ce qu'il y a de la place ?", "find_station", ["dock"]],
  ["météo", "Il fait assez beau pour rouler ?", "weather", []],
  ["météo", "Quel temps fait-il ?", "weather", []],
  ["météo", "Est-ce qu'il va pleuvoir cet après-midi ?", "weather", []],
  ["libre", "Bonjour, comment ça va ?", null, []],
  ["libre", "Qui es-tu ?", null, []],
  ["libre", "J'ai crevé un pneu, tu peux m'aider ?", null, []],
  ["libre", "Comment bien régler la selle ?", null, []],
  ["libre", "Raconte-moi une blague sur le vélo.", null, []],
];
const MEMORY = ["Je suis Silex", "Tu te souviens de mon prénom ?"];

// LIBRE=1 : conversation libre seule, celle qui atteint le modèle dans l'application (les
// questions de station, météo, départs sont résolues par localAnswers.js, AIScreen.jsx) :
// les dix questions du banc de conversation, puis la conversation du téléphone en six tours,
// chaque tour reprenant la réponse du précédent — 96 jetons comme l'application.
const { QUESTIONS, CONVERSATION } = await import("../bench-chat/cases.js");

const bin = new URL("./vh_llm_bench", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "vh-compare-"));
const ctx = { t, lang: "fr", stations: [], now: new Date() };

// Une passe du banc : un chargement, plusieurs conversations (consigne reprise).
function pass(m, path, convs, max = process.env.MAX || "128") {
  const file = join(tmp, `${m.key}.bin`);
  const { tools } = sysFor(m);
  writeFileSync(file, convs.map((msgs) => { const { prefix, rest } = splitPrompt(msgs, { template: m.template, tools }); return `${prefix}\x1f${rest}`; }).join("\x1e"));
  const lines = benchRun({ bin, model: path, backend: "cpu", cases: file, max, threads });
  return {
    info: lines.find((l) => l.info)?.info,
    res: lines.filter((l) => l.ok !== undefined),
    mem: lines.find((l) => l.mem)?.mem,
    err: lines.find((l) => l.error !== undefined && l.ok === undefined)?.error,
  };
}

// Note d'un cas : 1 juste, 0,5 bon outil mais arguments incomplets, 0 sinon.
function score([kind, , tool, want], raw) {
  const text = cleanReply(raw);
  const out = readModelOutput(text);
  if (tool) {
    if (out.kind !== "call" || out.call.name !== tool) return { pts: 0, verdict: out.kind === "call" ? `outil ${out.call.name}` : out.kind === "invalid" ? `appel invalide (${out.reason})` : "pas d'appel" };
    const args = JSON.stringify(out.call.args).toLowerCase();
    const miss = want.filter((w) => !args.includes(w));
    return miss.length ? { pts: 0.5, verdict: `${tool}, manque ${miss.join(",")}` } : { pts: 1, verdict: `${tool} ${JSON.stringify(out.call.args)}` };
  }
  const v = resolveModelOutput(raw, ctx, { text: "(repli)" });
  const lang = replyLanguage(text);
  if (v.source === "tool") return { pts: 0, verdict: `outil ${v.tool} hors sujet` };
  if (v.source !== "model") return { pts: 0, verdict: `rejetée (${v.reason})` };
  return lang === "fr" ? { pts: 1, verdict: "affichée, fr" } : { pts: 0, verdict: `langue ${lang}` };
}

if (process.env.LIBRE) {
  const out = [];
  for (const k of keys) {
    const m = NATIVE_CANDIDATES[k], path = join(dir, m?.file ?? "");
    if (!m || !existsSync(path)) { console.log(`\n══ ${k} : absent`); continue; }
    const { sys } = sysFor(m);
    const a = pass(m, path, QUESTIONS.map((q) => [sys, { role: "user", content: q }]), "96");
    console.log(`\n══ ${k} · questions libres`);
    const rows = QUESTIONS.map((q, i) => {
      const text = cleanReply(a.res[i]?.text ?? ""), v = resolveModelOutput(a.res[i]?.text ?? "", ctx, { text: "(repli)" });
      console.log(`  ${q}\n    → ${JSON.stringify(text)} [${v.source}${v.reason ? ` ${v.reason}` : ""}]`);
      return { q, text, source: v.source, reason: v.reason };
    });
    console.log(`  ── conversation`);
    const hist = [sys], conv = [];
    for (const q of CONVERSATION) {
      hist.push({ role: "user", content: q });
      const r = pass(m, path, [hist], "96").res[0];
      const text = cleanReply(r?.text ?? ""), v = resolveModelOutput(r?.text ?? "", ctx, { text: "(repli)" });
      console.log(`  ${q}\n    → ${JSON.stringify(text)} [${v.source}${v.reason ? ` ${v.reason}` : ""}]`);
      conv.push({ q, text, source: v.source, reason: v.reason });
      // Comme l'application : seul un texte affiché nourrit l'historique.
      if (v.source === "model") hist.push({ role: "assistant", content: text }); else hist.pop();
    }
    const shown = [...rows, ...conv].filter((x) => x.source === "model").length;
    console.log(`  ── affichées ${shown}/${rows.length + conv.length}`);
    out.push({ key: k, rows, conv, shown });
  }
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out, null, 1));
  process.exit(0);
}

const results = [];
for (const k of keys) {
  const m = NATIVE_CANDIDATES[k];
  if (!m) { console.error(`clé inconnue : ${k}`); continue; }
  const path = join(dir, m.file);
  if (!existsSync(path)) { console.log(`\n══ ${k} : absent (${path}) — fetch.mjs ${k}`); continue; }
  const { sys } = sysFor(m);
  const convs = [...CASES.map(([, q]) => [sys, { role: "user", content: q }]), [sys, { role: "user", content: MEMORY[0] }]];
  const a = pass(m, path, convs);
  if (!a.info) { console.log(`\n══ ${k} : ÉCHEC ${a.err}`); results.push({ key: k, error: a.err }); continue; }
  const said = cleanReply(a.res.at(-1).text);
  const b = pass(m, path, [[sys, { role: "user", content: MEMORY[0] }, { role: "assistant", content: said }, { role: "user", content: MEMORY[1] }]]);
  const memRaw = b.res[0]?.text ?? "";
  // Le prénom, rendu à l'utilisateur : « Je suis Silex, je ne me souviens pas… » ne compte pas.
  const memText = cleanReply(memRaw);
  const memOk = /silex/i.test(memText) && !/je suis silex|ne (me souviens|sais|connais)|n'ai pas/i.test(memText);

  console.log(`\n══ ${k} · ${m.file} (${m.mb} Mo) · chargé en ${Math.round(a.info.loadMs)} ms · ${a.info.threads} fils`);
  const per = { station: [0, 0], "météo": [0, 0], libre: [0, 0] };
  const rows = CASES.map((c, i) => {
    const r = a.res[i];
    const s = score(c, r.text);
    per[c[0]][0] += s.pts; per[c[0]][1]++;
    console.log(`  [${c[0]}] ${c[1]}\n    → ${JSON.stringify(cleanReply(r.text).slice(0, 200))}\n      ${s.pts} · ${s.verdict} · ${r.genTokens} j, 1er jeton ${Math.round(r.firstMs)} ms`);
    return { kind: c[0], q: c[1], text: cleanReply(r.text), raw: r.text, ...s, genTokens: r.genTokens, genMs: r.genMs, firstMs: r.firstMs };
  });
  per.libre[0] += memOk ? 1 : 0; per.libre[1]++;
  console.log(`  [libre] ${MEMORY[0]} → ${JSON.stringify(said.slice(0, 120))}\n  [libre] ${MEMORY[1]} → ${JSON.stringify(cleanReply(memRaw).slice(0, 160))} · ${memOk ? 1 : 0}`);
  const all = a.res;
  const genT = all.reduce((n, r) => n + r.genTokens, 0), genMs = all.reduce((n, r) => n + r.genMs, 0);
  const firstMs = all.map((r) => r.firstMs).sort((x, y) => x - y)[Math.floor(all.length / 2)];
  const tps = genT / (genMs / 1000);
  const mem = a.mem || {};
  const r = {
    key: k, file: m.file, mb: m.mb, dtype: m.dtype, template: m.template,
    // Consigne à froid : le 1er cas calcule la consigne et ses outils (reprise ensuite).
    loadMs: Math.round(a.info.loadMs), coldPromptMs: Math.round(all[0].firstMs), promptTokens: all[0].promptTokens, firstMsMedian: Math.round(firstMs), tps: Math.round(tps * 10) / 10,
    rssMb: Math.round(mem.rssKb / 1024), peakMb: Math.round(mem.hwmKb / 1024), pssMb: Math.round(mem.pssKb / 1024),
    score: Object.fromEntries(Object.entries(per).map(([f, [p, n]]) => [f, `${p}/${n}`])),
    total: Object.values(per).reduce((n, [p]) => n + p, 0), outOf: Object.values(per).reduce((n, [, x]) => n + x, 0),
    rows, memory: { said, reply: cleanReply(memRaw), ok: memOk },
  };
  console.log(`  ── ${r.tps} j/s · 1er jeton ${r.firstMsMedian} ms (médiane) · RSS ${r.rssMb} Mo, pic ${r.peakMb} Mo, PSS ${r.pssMb} Mo · qualité ${r.total}/${r.outOf} ${JSON.stringify(r.score)}`);
  results.push(r);
}

// Tableau : estimation téléphone par proportion avec LFM2.5-350M mesuré ici et là-bas.
const ref = results.find((r) => r.key === REF_KEY && r.tps);
console.log(`\n| modèle | quant. | fichier | chargement | consigne à froid | 1er jeton | j/s ${process.env.ADB ? "téléphone" : "PC"} | j/s 888 estimés | RSS / pic / PSS | station | météo | libre | total |`);
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of results.filter((x) => x.tps)) {
  const est = process.env.ADB ? r.tps : ref ? Math.round((PHONE_REF * r.tps) / ref.tps) : "?";
  console.log(`| ${r.key} | ${r.dtype} | ${r.mb} Mo | ${(r.loadMs / 1000).toFixed(1)} s | ${(r.coldPromptMs / 1000).toFixed(1)} s (${r.promptTokens} j) | ${r.firstMsMedian} ms | ${r.tps} | ~${est} | ${r.rssMb} / ${r.peakMb} / ${r.pssMb} Mo | ${r.score.station} | ${r.score["météo"]} | ${r.score.libre} | ${r.total}/${r.outOf} |`);
}
const out = process.env.OUT || join(tmp, "compare.json");
writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), threads, adb: !!process.env.ADB, phoneRef: PHONE_REF, results }, null, 1));
console.log(`\nsorties complètes : ${out}`);
