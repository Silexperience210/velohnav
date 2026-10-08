// Worker dédié au modèle conversationnel.
//
// Le modèle tourne ici et non dans la page pour une raison précise : un blocage
// d'onnxruntime ne se rattrape pas. transformers.js garde la première création de
// session dans une promesse de module (`wasmInitPromise`) qui n'est jamais remise à
// zéro, et onnxruntime-web marque son moteur « en cours » / « abandonné » pour toute la
// vie de la page. Une initialisation qui ne rend jamais la main condamne donc toute
// tentative suivante dans la même page. Un worker, lui, se termine : la façade
// (localModel.js) le tue à l'expiration du délai et en recrée un neuf.
import { pipeline, env } from "@huggingface/transformers";
import { LIMITS, withTimeout } from "./modelPolicy.js";

const MODEL_ID = "onnx-community/Qwen2.5-1.5B-Instruct";
// Copie embarquée éventuelle (public/models/ via scripts/fetch-model.sh).
const LOCAL_DIR = "Qwen2.5-1.5B-Instruct";
const LOCAL_PATH = "/models/";

const ort = env.backends.onnx;
// Un seul fil : sans isolation cross-origin (COOP/COEP, absente de la WebView
// Capacitor) il n'y a pas de SharedArrayBuffer. onnxruntime retombe déjà à 1 fil dans
// ce cas, on le fixe explicitement pour ne dépendre d'aucune heuristique.
ort.wasm.numThreads = 1;
ort.wasm.proxy = false;
// transformers.js force wasmPaths vers cdn.jsdelivr.net : le moteur (21 Mo) était
// retéléchargé à chaque initialisation, hors de tout délai, et l'IA ne démarrait pas
// hors ligne. Le binaire est déjà embarqué par Vite à côté du bundle : on le rend à
// onnxruntime en effaçant la surcharge.
ort.wasm.wasmPaths = undefined;

let generator = null;

const post = (msg) => self.postMessage(msg);

async function hasLocalModel() {
  const ctrl = new AbortController();
  try {
    const r = await withTimeout(
      fetch(`${LOCAL_PATH}${LOCAL_DIR}/config.json`, { method: "HEAD", signal: ctrl.signal }),
      LIMITS.localCheckMs, "local model check", () => ctrl.abort(),
    );
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Sonde WebGPU : pas seulement « un adaptateur existe », mais « un device a été obtenu
 * avec les limites et la fonction shader-f16 qu'exige q4f16 ». Chaque appel est borné.
 * Le verdict est rendu par assessWebGPU (modelPolicy.js), côté façade.
 */
async function probeWebGPU() {
  if (typeof navigator === "undefined" || !navigator.gpu) return null;
  let adapter;
  try {
    adapter = await withTimeout(
      navigator.gpu.requestAdapter({ powerPreference: "high-performance" }),
      LIMITS.probeMs, "requestAdapter",
    );
  } catch (e) {
    return { adapter: false, error: String(e?.message || e) };
  }
  if (!adapter) return { adapter: false };
  const features = [...adapter.features];
  const limits = {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  };
  const out = {
    adapter: true,
    isFallbackAdapter: !!(adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter),
    features,
    limits,
    device: { ok: false, error: "not-requested" },
  };
  if (!features.includes("shader-f16")) return out;
  try {
    const device = await withTimeout(
      adapter.requestDevice({ requiredFeatures: ["shader-f16"], requiredLimits: limits }),
      LIMITS.probeMs, "requestDevice",
    );
    device.destroy();
    out.device = { ok: true };
  } catch (e) {
    out.device = { ok: false, error: String(e?.message || e) };
  }
  return out;
}

async function load({ variant, modelId }) {
  let ref = modelId || MODEL_ID;
  if (!modelId && (await hasLocalModel())) {
    env.allowLocalModels = true;
    env.localModelPath = LOCAL_PATH;
    ref = LOCAL_DIR;
  }
  generator = await pipeline("text-generation", ref, {
    dtype: variant.dtype,
    device: variant.device,
    progress_callback: (p) => {
      if (!p || !p.status) return;
      post({ type: "progress", ev: { status: p.status, file: p.file, loaded: p.loaded, total: p.total } });
    },
  });
}

self.onmessage = async ({ data }) => {
  const msg = data || {};
  if (msg.type === "probe") {
    post({ type: "probe", probe: await probeWebGPU() });
    return;
  }
  if (msg.type === "load") {
    try {
      await load(msg);
      post({ type: "ready" });
    } catch (e) {
      post({ type: "error", message: String(e?.message || e) });
    }
    return;
  }
  if (msg.type === "generate") {
    try {
      if (!generator) throw new Error("model not loaded");
      const out = await generator(msg.prompt, msg.options);
      const text = Array.isArray(out) ? out[0]?.generated_text ?? "" : out?.generated_text ?? "";
      post({ type: "result", id: msg.id, text });
    } catch (e) {
      post({ type: "result", id: msg.id, error: String(e?.message || e) });
    }
  }
};
