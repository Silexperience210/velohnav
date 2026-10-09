// IA embarquée 100% locale (zéro clé API, zéro requête réseau après le
// téléchargement initial du modèle, données 100% sur l'appareil).
// Basé sur @huggingface/transformers (transformers.js v4), exécuté dans un worker
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
  memoryVerdict, heaviestVariant, LEGACY_MODEL_DIRS,
} from "./modelPolicy.js";
import { readMemoryInfo } from "./deviceMemory.js";

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
  constructor(code, { detail = "", seconds = 0, mb = 0, needMB = 0, availMB = 0 } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ModelError";
    this.code = code;
    this.detail = detail;
    this.seconds = seconds;
    this.mb = mb;
    this.needMB = needMB;     // code "memory" : mémoire libre exigée…
    this.availMB = availMB;   // … et mémoire libre constatée
  }
}

// Variante retenue (ou celle que la prochaine tentative utilisera), pour que
// l'interface annonce la bonne taille.
let chosen = null;
export const chatModelMB = () => (chosen ? chosen.mb : VARIANTS.wasm.mb);

let worker = null;
let ready = false;
let loadPromise = null;
let abortLoad = null;   // interrompt le chargement en cours (unloadModel)
let generation = 0;     // incrémenté par unloadModel : invalide un chargement pas encore parti
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

// Après un échec WebGPU, les fichiers q4f16 (255 Mo) ne serviront plus sur cet appareil :
// on le retire du cache de transformers.js pour laisser la place à la variante WASM.
async function purgeCache(match) {
  try {
    if (typeof caches === "undefined") return;
    const cache = await withTimeout(caches.open("transformers-cache"), 5000, "cache");
    const keys = await withTimeout(cache.keys(), 5000, "cache");
    await Promise.all(keys.filter((r) => match(r.url)).map((r) => cache.delete(r)));
  } catch { /* au pire l'espace n'est pas libéré */ }
}
// `model_q4f16.onnx` couvre aussi `model_q4f16.onnx_data`, où sont les poids.
const purgeCachedVariant = (dtype) => purgeCache((u) => u.includes(`model_${dtype}.onnx`));
// L'ancien modèle 1.5B (1,2 à 1,8 Go de stockage) ne sert plus : une seule fois par session.
let legacyPurged = false;
function purgeLegacyModels() {
  if (legacyPurged) return;
  legacyPurged = true;
  purgeCache((u) => LEGACY_MODEL_DIRS.some((d) => u.includes(`/${d}/`)));
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
      abortLoad = null;
      clearInterval(tick);
      if (err) reject(err);
      else resolve();
    };
    // Désactivation pendant le chargement : le worker meurt avec tout ce qu'il tenait
    abortLoad = () => { killWorker(); done(new ModelError("cancelled")); };

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
      st = { ...st, expect: plan.variant.files };   // init seulement quand les POIDS sont là
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
  const gen = generation;
  loadPromise = checkMemory().then(() => {
    // Désactivé pendant le contrôle mémoire : ne rien démarrer
    if (gen !== generation) throw new ModelError("cancelled");
    return runLoad(onProgress, onPhase);
  }).finally(() => {
    loadPromise = null; // succès : `ready` prend le relais ; échec : retry possible
  });
  return loadPromise;
}

/**
 * Contrôle AVANT tout engagement (aucun worker créé, rien téléchargé) : si
 * l'appareil n'a pas la mémoire libre pour le pic de chargement, refus avec un
 * code traduisible plutôt qu'un WebView tué par le système.
 */
async function checkMemory() {
  purgeLegacyModels();
  const info = await readMemoryInfo();
  const v = memoryVerdict(info, heaviestVariant());
  console.info(`[IA] mémoire : ${v.reason} (besoin ≈ ${v.needMB} Mo, disponible ${v.availMB ?? "?"} Mo)`);
  if (!v.ok) throw new ModelError("memory", { detail: v.reason, needMB: v.needMB, availMB: v.availMB ?? 0 });
}

/**
 * Arrête le modèle et rend la mémoire : le worker est terminé (son tas WASM, ses
 * tampons GPU et le fichier lu partent avec lui), un chargement en cours est
 * interrompu. Appelé quand l'utilisateur désactive la conversation libre ou
 * quitte l'écran. Avant : le worker restait en vie pour la durée de l'application
 * — plus d'1 Go résident pendant la carte et la caméra AR.
 */
export function unloadModel() {
  generation++;
  if (abortLoad) abortLoad();
  else if (worker) killWorker(new ModelError("cancelled"));
}

// Le gabarit de conversation n'est plus écrit ici à la main (il était propre à Qwen) :
// le worker applique celui du tokenizer du modèle (apply_chat_template), seul à
// connaître ses jetons de rôle et sa façon de présenter les outils.
// Jetons de structure résiduels (fin de tour, début de texte) retirés de la réponse.
function cleanReply(text) {
  return String(text ?? "")
    .replace(/<\|(im_end|im_start|startoftext|endoftext)\|>/g, "")
    .trim();
}

/**
 * Génère une réponse à partir du system prompt + historique de conversation.
 * Bornée dans le temps : au-delà de LIMITS.generateMs, le worker est arrêté (il sera
 * recréé, depuis le cache, à la prochaine demande).
 * @param {string} system
 * @param {Array<{role:string, content:string}>} history
 * @param {{maxNewTokens?: number, tools?: object[]}} [opts] `tools` : schémas d'outils
 *   transmis au gabarit du modèle (voir tools.js)
 * @returns {Promise<string>} texte produit après le prompt, jetons d'appel d'outil compris
 */
export async function generate(system, history, opts = {}) {
  await loadModel();
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...history.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool"),
  ];
  const id = ++seq;
  const seconds = Math.round(LIMITS.generateMs / 1000);
  const full = await withTimeout(
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({
        type: "generate",
        id,
        messages,
        tools: opts.tools,
        options: {
          max_new_tokens: opts.maxNewTokens ?? 256,
          do_sample: false, // greedy = déterministe, fiable pour les appels d'outils
        },
      });
    }),
    LIMITS.generateMs,
    "generate",
    () => killWorker(new ModelError("generate_timeout", { seconds })),
  );
  return cleanReply(full);
}
