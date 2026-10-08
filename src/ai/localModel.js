// IA embarquée 100% locale (zéro clé API, zéro requête réseau après le
// téléchargement initial du modèle, données 100% sur l'appareil).
// Basé sur @huggingface/transformers (transformers.js v3).
import { pipeline, env } from "@huggingface/transformers";

// Modèle instruct ONNX quantifié int4 (~1 Go). Bon suivi d'instructions, bon français.
// (Alternative plus puissante : "onnx-community/Qwen2.5-3B-Instruct".)
const MODEL_ID = "onnx-community/Qwen2.5-1.5B-Instruct";
/**
 * Choix de la quantification, décidé sur l'appareil.
 *
 * Mesuré sur le dépôt : q4 = 1,7 Go, q4f16 = 1,17 Go. q4f16 n'est utilisable que sur
 * WebGPU ; sans adaptateur graphique, seule la variante q4 fonctionne (WASM). Un
 * téléphone récent a du WebGPU et télécharge donc 530 Mo de moins ; un appareil sans
 * GPU garde la variante qui marche. Vérifié à la mesure : sans adaptateur, demander
 * q4f16 fait échouer le chargement.
 *
 * Fonction pure, pour être testable : la décision ne dépend que de la présence d'un
 * adaptateur.
 */
export function chooseVariant(hasWebGPUAdapter) {
  return hasWebGPUAdapter
    ? { dtype: "q4f16", device: "webgpu", mb: 1165 }
    : { dtype: "q4",    device: "wasm",   mb: 1704 };
}

// Renseigné au premier chargement, pour que l'interface annonce la bonne taille.
let chosen = null;
export const chatModelMB = () => (chosen ? chosen.mb : 1704);

/** Un adaptateur WebGPU réel est-il disponible sur cet appareil ? */
async function hasWebGPUAdapter() {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu) return false;
    return (await navigator.gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

// Si le modèle est packagé localement (public/models/ via scripts/fetch-model.sh),
// il est chargé depuis l'appareil (zéro téléchargement). Sinon, fallback hub HF.
const LOCAL_DIR = "Qwen2.5-1.5B-Instruct";
const LOCAL_PATH = "/models/";

let generator = null;
let loadPromise = null;

/** Le modèle est-il chargé et prêt à générer ? */
export function isModelReady() {
  return generator !== null;
}

/**
 * Charge le modèle une seule fois (cache en mémoire, pas de re-téléchargement).
 * @param {(pct: number) => void} [onProgress] progression du téléchargement (0-100)
 * @returns {Promise<object>}
 */
async function hasLocalModel() {
  try {
    const r = await fetch(`${LOCAL_PATH}${LOCAL_DIR}/config.json`, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

export function loadModel(onProgress) {
  if (generator) return Promise.resolve(generator);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    let ref = MODEL_ID;
    if (await hasLocalModel()) {
      env.allowLocalModels = true;
      env.localModelPath = LOCAL_PATH;
      ref = LOCAL_DIR;
    }
    chosen = chooseVariant(await hasWebGPUAdapter());
    return pipeline("text-generation", ref, {
      dtype: chosen.dtype,
      device: chosen.device,
      progress_callback: (p) => {
        if (p?.status === "progress" && onProgress) {
          onProgress(Math.round(p.progress ?? 0));
        }
      },
    });
  })()
    .then((g) => {
      generator = g;
      return g;
    })
    .catch((e) => {
      loadPromise = null; // autorise un retry après échec
      throw e;
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
 * @param {string} system
 * @param {Array<{role:string, content:string}>} history
 * @param {{maxNewTokens?: number, temperature?: number}} [opts]
 * @returns {Promise<string>}
 */
export async function generate(system, history, opts = {}) {
  const g = await loadModel();
  const prompt = buildPrompt(system, history);
  const out = await g(prompt, {
    max_new_tokens: opts.maxNewTokens ?? 256,
    temperature: opts.temperature ?? 0.2,
    top_p: 0.9,
    do_sample: false, // greedy = déterministe, fiable pour la balise [NAV:…]
  });
  const full = Array.isArray(out) ? out[0]?.generated_text ?? "" : out?.generated_text ?? "";
  return cleanReply(full.slice(prompt.length));
}
