#!/usr/bin/env node
// Moteur processeur de l'APPLICATION (onnxruntime-web, build « wasm ») sous Node, avec
// transformers.js dans sa version web : mêmes binaires que dans la WebView, sans
// navigateur. Sert à mesurer le débit (prefill / décodage) et ce qui le limite.
//
//   node scripts/bench-chat/wasm-node.mjs [fils=1] [profil=0] [dtype=q4] [dossier-modèles]
import { register } from "node:module";
import http from "node:http";
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
const [threads = "1", profile = "0", dtype = "q4", modelsDir = `${process.env.HOME}/.cache/vn-models/`] = process.argv.slice(2);

// Le build web lit le modèle par fetch : petit serveur local.
const server = http.createServer((req, res) => {
  const f = path.join(modelsDir, decodeURIComponent(req.url.split("?")[0]));
  if (process.env.DEBUG) console.log("GET", req.url);
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.statusCode = 404; return res.end(); }
    res.setHeader("content-length", st.size);
    fs.createReadStream(f).pipe(res);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const { ENGINE_SLOT, MODEL } = await import("../../src/ai/modelPolicy.js");
const ort = await import("onnxruntime-web/wasm");
globalThis[ENGINE_SLOT] = ort;
// transformers.js se croirait sous Node (fichiers locaux, appareils cpu/cuda) : on le
// fait passer par son chemin navigateur, celui de la WebView.
const release = process.release;
Object.defineProperty(process, "release", { value: { name: "browser-like" }, configurable: true });
const tf = await import("@huggingface/transformers");
Object.defineProperty(process, "release", { value: release, configurable: true });
// Le serveur local tient lieu de Hub (même chemin que les copies de ~/.cache/vn-models).
tf.env.allowLocalModels = false;
tf.env.useBrowserCache = false;
tf.env.remoteHost = `http://127.0.0.1:${server.address().port}/`;
tf.env.remotePathTemplate = "{model}/";
ort.env.wasm.numThreads = Number(threads);
ort.env.wasm.wasmPaths = new URL("../../node_modules/onnxruntime-web/dist/", import.meta.url).href;
const { systemPrompt } = await import("../../src/ai/assistant.js");
const { default: fr } = await import("../../src/locales/fr.js");
const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");

const t0 = performance.now();
const tok = await tf.AutoTokenizer.from_pretrained(MODEL.id);
const model = await tf.AutoModelForCausalLM.from_pretrained(MODEL.id, {
  dtype, device: "wasm", ...(profile === "1" ? { session_options: { enableProfiling: true } } : {}),
});
console.log(`chargé en ${((performance.now() - t0) / 1000).toFixed(1)} s, fils ${threads}`);

async function run(label, messages, n) {
  const inputs = tok.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true });
  const len = inputs.input_ids.dims.at(-1);
  // Prefill seul (1 jeton), puis la génération complète : le décodage se déduit.
  let a = performance.now();
  await model.generate({ ...inputs, max_new_tokens: 1, do_sample: false });
  const prefill = performance.now() - a;
  a = performance.now();
  const out = await model.generate({ ...inputs, max_new_tokens: n, min_new_tokens: n, do_sample: false });
  const total = performance.now() - a;
  const gen = out.dims.at(-1) - len;
  console.log(`${label} : prompt ${len} jetons, prefill ${(prefill / 1000).toFixed(2)} s (${(len / prefill * 1000).toFixed(0)} j/s), `
    + `décodage ${((total - prefill) / Math.max(1, gen - 1)).toFixed(0)} ms/jeton sur ${gen} jetons, total ${(total / 1000).toFixed(1)} s`);
}
await run("court (sans outils)", [{ role: "user", content: "Bonjour" }], 16);
if (profile !== "1") await run("application (consigne + outils)", [{ role: "system", content: systemPrompt(t) }, { role: "user", content: "Bonjour" }], 16);
server.close();
