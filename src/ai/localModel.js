// IA embarquée 100% locale (zéro clé API, zéro requête réseau après le
// téléchargement initial du modèle, données 100% sur l'appareil).
// Basé sur @huggingface/transformers (transformers.js v3), exécuté dans un worker
// dédié (modelWorker.js) que cette façade surveille.
//
// Défaut corrigé : sur téléphone, « Chargement du modèle · 100 % » restait affiché
// indéfiniment. 100 % = fin du téléchargement seulement ; l'initialisation qui suit
// (cache, moteur onnxruntime, session WebGPU) n'avait aucun délai et pouvait ne jamais
// rendre la main. Ici : chaque phase est bornée par un chien de garde, le worker est tué
// s'il se bloque, et l'échec est rapporté avec sa raison. Les décisions (variante,
// délais, repli) sont des fonctions pures dans modelPolicy.js.
import {
  VARIANTS, chooseVariant, assessWebGPU, planLoad, LIMITS, watchdog,
  initialProgress, progressReducer, decideAfterFailure, withTimeout,
} from "./modelPolicy.js";

export { chooseVariant };

// Mémorise qu'un chargement WebGPU a déjà échoué sur cet appareil : les tentatives
// suivantes passent directement par WASM (sans re-sonder un chemin qui a bloqué).
const WEBGPU_KO_KEY = "velohnav_ai_webgpu_ko";

function webgpuKnownBroken() {
  try { return !!globalThis.localStorage?.getItem(WEBGPU_KO_KEY); } catch { return false; }
}
function markWebGPUBroken(reason) {
  try { globalThis.localStorage?.setItem(WEBGPU_KO_KEY, reason || "1"); } catch { /* mode privé */ }
}

/** Échec de chargement ou de génération, avec un code traduisible côté interface. */
export class ModelError extends Error {
  constructor(code, { detail = "", seconds = 0, mb = 0 } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ModelError";
    this.code = code;
    this.detail = detail;
    this.seconds = seconds;
    this.mb = mb;
  }
}

// Variante retenue (ou celle que la prochaine tentative utilisera), pour que
// l'interface annonce la bonne taille.
let chosen = null;
export const chatModelMB = () => (chosen ? chosen.mb : VARIANTS.wasm.mb);

let worker = null;
let ready = false;
let loadPromise = null;
let seq = 0;
const pending = new Map(); // id de génération → { resolve, reject }

/** Le modèle est-il chargé et prêt à générer ? */
export function isModelReady() {
  return ready;
}

/** Arrête le worker (libère la mémoire et tout ce qui y était bloqué). */
function killWorker(err) {
  if (worker) worker.terminate();
  worker = null;
  ready = false;
  for (const { reject } of pending.values()) reject(err || new ModelError("generate"));
  pending.clear();
}

// Après un échec WebGPU, le fichier q4f16 (1,17 Go) ne servira plus sur cet appareil :
// on le retire du cache de transformers.js pour laisser la place à la variante WASM.
async function purgeCachedVariant(dtype) {
  try {
    if (typeof caches === "undefined") return;
    const cache = await withTimeout(caches.open("transformers-cache"), 5000, "cache");
    const keys = await withTimeout(cache.keys(), 5000, "cache");
    await Promise.all(keys.filter((r) => r.url.includes(`model_${dtype}.onnx`)).map((r) => cache.delete(r)));
  } catch { /* au pire l'espace n'est pas libéré */ }
}

function onRuntimeMessage({ data }) {
  if (data?.type !== "result") return;
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.error) p.reject(new ModelError("generate", { detail: data.error }));
  else p.resolve(data.text);
}

function runLoad(onProgress, onPhase) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./modelWorker.js", import.meta.url), { type: "module" });
    worker = w;
    let st = initialProgress(Date.now());
    let device = null;
    let settled = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      if (err) reject(err);
      else resolve();
    };

    const fail = (phase, { timedOut = false, seconds = 0, detail = "" } = {}) => {
      if (settled) return;
      const d = decideAfterFailure({ device: device || "wasm", phase, timedOut });
      killWorker();
      if (d.markWebGPUBroken) {
        markWebGPUBroken(detail || d.code);
        purgeCachedVariant(d.purgeDtype);
      }
      chosen = d.next; // la prochaine tentative (« Réessayer ») et sa taille
      console.warn(`[IA] échec ${d.code} (${device || "?"}, phase ${phase}) :`, detail);
      done(new ModelError(d.code, { detail, seconds, mb: d.next.mb }));
    };

    const start = (probe) => {
      const known = webgpuKnownBroken();
      const plan = planLoad({ webgpuKnownBroken: known, assessment: known ? null : assessWebGPU(probe) });
      chosen = plan.variant;
      device = plan.variant.device;
      console.info(`[IA] variante ${plan.variant.dtype}/${device} (${plan.reason})`);
      onPhase?.({ phase: "download", device });
      w.postMessage({ type: "load", variant: plan.variant });
    };

    // Le chien de garde : la seule chose qui voit un blocage (une attente qui ne se
    // résout jamais ne lève pas d'exception).
    const tick = setInterval(() => {
      const v = watchdog({ ...st, device: device || "wasm" }, Date.now());
      if (v) fail(v.phase, { timedOut: true, seconds: v.seconds, detail: `timeout ${v.seconds} s` });
    }, 1000);

    w.onerror = (e) => fail(st.phase, { detail: e?.message || "worker error" });
    w.onmessage = ({ data }) => {
      if (settled || !data) return;
      if (data.type === "probe") start(data.probe);
      else if (data.type === "progress") {
        const prev = st.phase;
        st = progressReducer(st, data.ev, Date.now());
        onProgress?.(st.pct);
        if (st.phase !== prev && st.phase === "init") onPhase?.({ phase: "init", device });
      } else if (data.type === "ready") {
        w.onmessage = onRuntimeMessage;
        w.onerror = (e) => killWorker(new ModelError("generate", { detail: e?.message || "worker error" }));
        ready = true;
        done();
      } else if (data.type === "error") {
        fail(st.phase, { detail: data.message });
      }
    };

    if (webgpuKnownBroken()) start(null);
    else w.postMessage({ type: "probe" });
  });
}

/**
 * Charge le modèle une seule fois (cache en mémoire, pas de re-téléchargement).
 * Ne peut pas rester en attente indéfiniment : chaque phase est bornée (LIMITS).
 * @param {(pct: number) => void} [onProgress] progression du téléchargement (0-100)
 * @param {(p: {phase: "download"|"init", device: string}) => void} [onPhase]
 * @returns {Promise<void>}
 */
export function loadModel(onProgress, onPhase) {
  if (ready && worker) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = runLoad(onProgress, onPhase).finally(() => {
    loadPromise = null; // succès : `ready` prend le relais ; échec : retry possible
  });
  return loadPromise;
}

// ── Template de chat Qwen2.5 Instruct ────────────────────────────
const IM_START = "<|im_start|>";
const IM_END = "<|im_end|>";

function buildPrompt(system, history) {
  const parts = [];
  if (system) parts.push(`${IM_START}system\n${system}${IM_END}\n`);
  for (const m of history) {
    if (m.role === "user") parts.push(`${IM_START}user\n${m.content}${IM_END}\n`);
    else if (m.role === "assistant") parts.push(`${IM_START}assistant\n${m.content}${IM_END}\n`);
  }
  parts.push(`${IM_START}assistant\n`);
  return parts.join("");
}

// Nettoie les éventuels tokens spéciaux résiduels en fin de réponse.
function cleanReply(text) {
  return text
    .replace(/<\|im_end\|>/g, "")
    .replace(/<\|im_start\|>/g, "")
    .trim();
}

/**
 * Génère une réponse à partir du system prompt + historique de conversation.
 * Bornée dans le temps : au-delà de LIMITS.generateMs, le worker est arrêté (il sera
 * recréé, depuis le cache, à la prochaine demande).
 * @param {string} system
 * @param {Array<{role:string, content:string}>} history
 * @param {{maxNewTokens?: number, temperature?: number}} [opts]
 * @returns {Promise<string>}
 */
export async function generate(system, history, opts = {}) {
  await loadModel();
  const prompt = buildPrompt(system, history);
  const id = ++seq;
  const seconds = Math.round(LIMITS.generateMs / 1000);
  const full = await withTimeout(
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({
        type: "generate",
        id,
        prompt,
        options: {
          max_new_tokens: opts.maxNewTokens ?? 256,
          temperature: opts.temperature ?? 0.2,
          top_p: 0.9,
          do_sample: false, // greedy = déterministe, fiable pour la balise [NAV:…]
        },
      });
    }),
    LIMITS.generateMs,
    "generate",
    () => killWorker(new ModelError("generate_timeout", { seconds })),
  );
  return cleanReply(full.slice(prompt.length));
}
