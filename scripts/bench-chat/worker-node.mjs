#!/usr/bin/env node
// Le VRAI worker de l'application (src/ai/modelWorker.js), sous Node, avec le moteur
// processeur de la WebView (onnxruntime-web, build « wasm ») : chargement, essai à vide,
// calcul anticipé de la consigne (warm), puis une conversation de plusieurs tours, avec
// l'historique que construit AIScreen (seules les réponses libres y entrent).
// Rien n'est recopié du worker : c'est son code qui tourne, cache de consigne compris.
//
//   node scripts/bench-chat/worker-node.mjs [questions séparées par « | »] [dossier-modèles]
import { register } from "node:module";
import fs from "node:fs";
import path from "node:path";
register("data:text/javascript," + encodeURIComponent(`
  const SHIM = ${JSON.stringify(new URL("../../src/ai/ortEngine.js", import.meta.url).href)};
  export async function resolve(spec, ctx, next) {
    if (spec === "@huggingface/transformers") return { url: ${JSON.stringify(new URL("../../node_modules/@huggingface/transformers/dist/transformers.web.js", import.meta.url).href)}, shortCircuit: true };
    if (spec === "onnxruntime-web/webgpu" && /transformers/.test(ctx.parentURL || "")) return { url: SHIM, shortCircuit: true };
    return next(spec, ctx);
  }
  export async function load(url, ctx, next) {
    if (url.endsWith(".json")) return next(url, { ...ctx, importAttributes: { type: "json" } });
    return next(url, ctx);
  }`));
const [qArg = "Bonsoir|Bonjour|Je cherche un vélo près de la gare|Merci", modelsDir = `${process.env.HOME}/.cache/vn-models/`] = process.argv.slice(2);

// Le worker télécharge depuis le Hub (révision épinglée) : servi depuis la copie locale.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const m = /^https:\/\/huggingface\.co\/(.+?)\/resolve\/[^/]+\/(.+)$/.exec(String(url));
  // Binaires d'onnxruntime (file://) : le fetch de Node ne lit pas les fichiers.
  if (String(url).startsWith("file:")) return new Response(fs.readFileSync(new URL(String(url))), { headers: { "content-type": "application/wasm" } });
  if (!m) return realFetch(url, init);
  const f = path.join(modelsDir, m[1], decodeURIComponent(m[2]));
  if (!fs.existsSync(f)) return new Response(null, { status: 404 });
  // TRONQUE=1 : Content-Length annoncé = taille attendue (comme cacheHeaders sur l'appareil)
  // même si le fichier servi est plus court — le cas d'un poids incomplet en cache.
  const expected = process.env.TRONQUE === "1" ? (await import("../../src/ai/modelPolicy.js")).VARIANTS.wasm.bytes[decodeURIComponent(m[2])] : null;
  const size = expected || fs.statSync(f).size;
  return new Response(init?.method === "HEAD" ? null : fs.readFileSync(f), { status: 200, headers: { "content-length": String(size) } });
};

// Le worker parle à `self` ; on écoute ce qu'il poste.
const inbox = [];
let wake = null;
globalThis.self = globalThis;
// FILS=4 : comme la WebView isolée (COOP/COEP), wasmThreads() en donne jusqu’à 4.
if (Number(process.env.FILS) > 1) { globalThis.crossOriginIsolated = true; Object.defineProperty(globalThis.navigator, "hardwareConcurrency", { value: Number(process.env.FILS) + 1, configurable: true }); }
globalThis.postMessage = (m) => { inbox.push(m); wake?.(); };
const next = async (type) => {
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type || m.type === "error");
    if (i >= 0) return inbox.splice(i, 1)[0];
    await new Promise((r) => { wake = r; });
  }
};

const { MODEL, VARIANTS } = await import("../../src/ai/modelPolicy.js");
// transformers.js se croirait sous Node : on le fait passer par son chemin navigateur.
const release = process.release;
Object.defineProperty(process, "release", { value: { name: "browser-like" }, configurable: true });
await import("../../src/ai/modelWorker.js");
const send = (data) => globalThis.onmessage({ data });

const t0 = performance.now();
const loading = send({ type: "load", variant: VARIANTS.wasm, engine: "wasm", attemptId: "q4/wasm", modelId: MODEL.id });
void loading;
const { systemPrompt } = await import("../../src/ai/assistant.js");
const { cleanReply, generationOptions } = await import("../../src/ai/localModel.js");
const { resolveModelOutput } = await import("../../src/ai/assistant.js");
const { answerLocally } = await import("../../src/ai/localAnswers.js");
const { default: fr } = await import("../../src/locales/fr.js");
const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");

const ready = await next("ready");
Object.defineProperty(process, "release", { value: release, configurable: true });
if (ready.type === "error") { console.error("échec du chargement :", ready); process.exit(1); }
console.log(`prêt en ${((performance.now() - t0) / 1000).toFixed(1)} s ; essai à vide ${JSON.stringify(ready.selfTestRaw)}`);

send({ type: "warm", system: systemPrompt(t) });
// HIST='[{"role":"user","content":"Bonsoir"},{"role":"assistant","content":"Bonne nuit"}]' :
// historique hérité (App le garde quand le modèle est rechargé sur une autre voie).
let history = process.env.HIST ? JSON.parse(process.env.HIST) : [], id = 0;
const ctx = { stations: [], t, now: new Date() };
for (const q of qArg.split("|")) {
  const local = answerLocally(q, ctx);
  const hist = [...history, { role: "user", content: q }].slice(-6);
  const a = performance.now();
  send({ type: "generate", id: ++id, messages: [{ role: "system", content: systemPrompt(t) }, ...hist], options: generationOptions({ maxNewTokens: 96 }) });
  const r = await next("result");
  const reply = resolveModelOutput(cleanReply(r.text), ctx, local);
  console.log(`« ${q} » (${hist.length} msg, ${r.tokens} jetons, ${((performance.now() - a) / 1000).toFixed(1)} s)\n  brut    : ${JSON.stringify(r.text ?? r.error)}\n  affiché : [${reply.source}] ${JSON.stringify(reply.text)}`);
  if (reply.source === "model") history = [...hist, { role: "assistant", content: reply.text }];
}
process.exit(0);
