// Moteur natif (llama.cpp, GPU Vulkan) vu depuis l'application : le greffon Capacitor
// « LocalLlm » (android/…/llm/LocalLlmPlugin.kt), qui fait tourner le modèle dans le
// processus isolé « :llm ». localModel.js le tente AVANT l'échelle WebGPU / processeur ;
// ce module ne décide rien de l'ordre (modelPolicy.js : planNative) et ne lève jamais
// d'erreur pour un moteur simplement absent : APK construite sans -PvhNative, navigateur,
// appareil incompatible → `nativeStatus()` rend null ou { supported: false }.
//
// Une réponse du moteur est un JSON (vh_llm_jni.cpp) : { ok, error, log } ou { ok, info } /
// { ok, text, stats }. Un plantage du processus :llm (pilote GPU) rejette avec le code
// « crash ». Toutes ces erreurs remontent telles quelles, journal du moteur compris.
import { NATIVE_MODEL, NATIVE_SELF_TEST, selfTestVerdict, withTimeout } from "./modelPolicy.js";
import { splitPrompt } from "./chatTemplate.js";

let plugin;   // undefined : pas encore cherché ; null : absent

/** Pour les tests : greffon factice (null : absent). */
export function setNativePlugin(p) { plugin = p; }

async function getPlugin() {
  if (plugin !== undefined) return plugin;
  plugin = null;
  try {
    const cap = globalThis.Capacitor;
    if (!cap?.isNativePlatform?.() || cap.isPluginAvailable?.("LocalLlm") === false) return null;
    const { registerPlugin } = await import("@capacitor/core");
    plugin = registerPlugin("LocalLlm");
  } catch { plugin = null; }
  return plugin;
}

/** Erreur du moteur natif : `code` (load, selftest, crash, network…), message exact du moteur. */
export class NativeError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "NativeError";
    this.code = code;
    this.detail = detail;
  }
}

// Réponse du greffon → objet du moteur ; { ok: false } devient une NativeError.
function parse(res, code) {
  let r;
  try { r = JSON.parse(res?.result ?? "null"); } catch { throw new NativeError(code, `bad json: ${String(res?.result).slice(0, 200)}`); }
  if (!r?.ok) {
    const log = r?.log ? ` | ${String(r.log).split("\n").filter(Boolean).slice(-4).join(" | ")}` : "";
    throw new NativeError(code, `${r?.error || "no answer"}${log}`.slice(0, 600));
  }
  return r;
}
// Rejet du greffon (processus :llm mort, liaison refusée…) : son code est gardé.
const rethrow = (code) => (e) => {
  if (e instanceof NativeError) throw e;
  throw new NativeError(e?.code === "crash" ? "crash" : code, e?.message || String(e));
};

/**
 * Ce que dit l'appareil du moteur natif, ou null sans greffon (navigateur).
 * @returns {Promise<null | {supported: boolean, reason: string, device: string, soc: string, modelExists?: boolean}>}
 */
export async function nativeStatus() {
  const p = await getPlugin();
  if (!p) return null;
  try { return await withTimeout(p.status({ file: NATIVE_MODEL.file }), 5000, "native status"); } catch { return null; }
}

/**
 * Télécharge le GGUF (repris s'il était interrompu, taille et SHA-256 vérifiées par le
 * greffon). `onProgress(pct)`. Rien à faire s'il est déjà là.
 */
export async function downloadNative(onProgress) {
  const p = await getPlugin();
  const sub = await p.addListener?.("downloadProgress", (ev) => {
    if (ev?.total > 0) onProgress?.(Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
  });
  try {
    const url = `https://huggingface.co/${NATIVE_MODEL.id}/resolve/${NATIVE_MODEL.revision}/${NATIVE_MODEL.file}`;
    await p.download({ file: NATIVE_MODEL.file, url, bytes: NATIVE_MODEL.bytes, sha256: NATIVE_MODEL.sha256 });
    onProgress?.(100);
  } catch (e) {
    throw new NativeError(e?.code === "cancelled" ? "cancelled" : "network", e?.message || String(e));
  } finally {
    sub?.remove?.();
  }
}

/** Annule un téléchargement en cours (sans effet sinon). */
export async function cancelNativeDownload() {
  try { await (await getPlugin())?.cancelDownload(); } catch { /* rien en cours */ }
}

/**
 * Charge le modèle sur `backend` (« vulkan » ou « cpu ») puis fait l'essai à vide : une
 * phrase française courte (NATIVE_SELF_TEST), jugée par selfTestVerdict. Un GPU qui se
 * charge mais calcule faux (sortie « 鹰 » sur WebGPU Adreno) est donc écarté ici.
 * @returns {Promise<{ info: object, selfTest: string, loadMs: number }>}
 */
export async function loadNative(backend, timeoutMs) {
  const p = await getPlugin();
  const t0 = Date.now();
  const run = async () => {
    const r = parse(await p.load({ file: NATIVE_MODEL.file, backend, nCtx: 4096 }).catch(rethrow("load")), "load");
    const { prefix, rest } = splitPrompt(NATIVE_SELF_TEST.messages);
    const g = parse(await p.generate({ prefix, rest, maxTokens: NATIVE_SELF_TEST.maxNewTokens }).catch(rethrow("selftest")), "selftest");
    const said = String(g.text ?? "").split("<|im_end|>")[0].replace(/<\|[a-z_]+\|>/g, "").trim();
    const v = selfTestVerdict(said);
    if (!v.ok) throw new NativeError("selftest", `${v.reason}: ${JSON.stringify(g.text)}`);
    return { info: r.info || {}, selfTest: said, loadMs: Date.now() - t0 };
  };
  try {
    return await withTimeout(run(), timeoutMs, "native load", () => { unloadNative(); });
  } catch (e) {
    if (e?.timedOut) throw new NativeError("timeout", e.message);
    throw e;
  }
}

/** Calcule d'avance l'état du modèle sur la consigne (jamais d'erreur). */
export async function warmNative(messages, tools) {
  try {
    const { prefix } = splitPrompt(messages, { tools });
    if (prefix) await (await getPlugin())?.warm({ prefix });
  } catch { /* au pire la question calcule la consigne elle-même */ }
}

/**
 * Une réponse. Même gabarit que la voie WebGPU (chatTemplate.js reproduit celui du
 * tokenizer) ; la consigne est reprise d'un appel à l'autre par le moteur.
 * @returns {Promise<{ raw: string, stats: { promptTokens: number, reusedTokens: number, genTokens: number, promptMs: number, genMs: number } }>}
 */
export async function generateNative(messages, { tools, maxNewTokens = 256 } = {}) {
  const p = await getPlugin();
  const { prefix, rest } = splitPrompt(messages, { tools });
  const r = parse(await p.generate({ prefix, rest, maxTokens: maxNewTokens }).catch(rethrow("generate")), "generate");
  // La fin de tour n'est pas rendue en texte par le moteur : la remettre, sans quoi
  // cleanReply prendrait une réponse complète pour une réponse coupée.
  const text = String(r.text ?? "");
  return { raw: r.stats?.eog && !text.includes("<|im_end|>") ? `${text}<|im_end|>` : text, stats: r.stats || {} };
}

/** Interrompt une génération en cours. */
export async function cancelNative() {
  try { await (await getPlugin())?.cancel(); } catch { /* rien en cours */ }
}

/** Arrête le processus :llm : toute sa mémoire (poids, tampons du pilote) est rendue. */
export async function unloadNative() {
  try { await (await getPlugin())?.unload(); } catch { /* déjà arrêté */ }
}

/** Efface le GGUF (et un téléchargement partiel) : un seul modèle sur l'appareil. */
export async function deleteNativeModel() {
  try { await (await getPlugin())?.deleteModels({ keep: "" }); } catch { /* rien à effacer */ }
}
