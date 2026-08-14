// IA embarquée 100% locale (zéro clé API, zéro requête réseau après le
// téléchargement initial du modèle, données 100% sur l'appareil).
// Basé sur @huggingface/transformers (transformers.js v3).
import { pipeline } from "@huggingface/transformers";

// Modèle instruct ONNX quantifié int4 (~1 Go). Bon suivi d'instructions, bon français.
// (Alternative plus puissante : "onnx-community/Qwen2.5-3B-Instruct".)
const MODEL_ID = "onnx-community/Qwen2.5-1.5B-Instruct";

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
export function loadModel(onProgress) {
  if (generator) return Promise.resolve(generator);
  if (loadPromise) return loadPromise;
  loadPromise = pipeline("text-generation", MODEL_ID, {
    dtype: "q4",
    device: "webgpu", // WebGPU si dispo ; fallback WASM automatique
    progress_callback: (p) => {
      if (p?.status === "progress" && onProgress) {
        onProgress(Math.round(p.progress ?? 0));
      }
    },
  })
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
