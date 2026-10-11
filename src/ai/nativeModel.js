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
import { LIMITS, NATIVE_MODEL, NATIVE_SELF_TEST, SECOND_TURN, secondTurn, selfTestVerdict, selfTestBench, withTimeout } from "./modelPolicy.js";
import { splitPrompt } from "./chatTemplate.js";

let plugin;   // undefined : pas encore cherché ; null : absent

/** Pour les tests : greffon factice (null : absent ; undefined : le chercher à nouveau). */
export function setNativePlugin(p) { plugin = p; }

// Méthodes du greffon (LocalLlmPlugin.kt) appelées d'ici.
const METHODS = ["status", "download", "cancelDownload", "deleteModels", "load", "warm", "generate", "cancel", "unload", "addListener"];

/**
 * Le greffon, dans un objet ordinaire. JAMAIS le proxy de registerPlugin tel quel : une
 * fonction async qui le rend le fait passer pour une promesse — `await` lit `.then`, le
 * proxy en fait un appel natif « LocalLlm.then() » qui n'appelle jamais ses rappels, et
 * l'attente ne finit pas. Relevé sur le téléphone : « native status: no answer after 5 s »
 * à chaque lancement, le moteur natif n'a jamais tourné et son GGUF n'a jamais été demandé.
 */
export function wrapPlugin(proxy) {
  return Object.fromEntries(METHODS.map((m) => [m, (...args) => proxy[m](...args)]));
}

async function getPlugin() {
  if (plugin !== undefined) return plugin;
  plugin = null;
  try {
    const cap = globalThis.Capacitor;
    if (!cap?.isNativePlatform?.()) return null;
    if (cap.isPluginAvailable?.("LocalLlm") === false) {
      console.warn("[IA] greffon LocalLlm non enregistré dans cette APK");
      return null;
    }
    const { registerPlugin } = await import("@capacitor/core");
    plugin = wrapPlugin(registerPlugin("LocalLlm"));
  } catch (e) {
    console.warn("[IA] greffon LocalLlm introuvable :", e?.message || e);
    plugin = null;
  }
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
  // Borné en entier (import du greffon compris). Greffon qui ne répond pas ou qui échoue :
  // indisponible, avec sa raison (la ligne d'état la montre).
  const ask = async () => {
    const p = await getPlugin();
    return p ? await p.status({ file: NATIVE_MODEL.file }) : null;
  };
  const t0 = Date.now();
  try {
    const s = (await withTimeout(ask(), LIMITS.nativeStatusMs, "native status")) || null;
    if (s) console.info(`[IA] greffon LocalLlm : réponse en ${Date.now() - t0} ms`, JSON.stringify(s));
    return s;
  } catch (e) {
    console.warn(`[IA] greffon LocalLlm sans réponse utile après ${Date.now() - t0} ms :`, e?.message || e);
    return { supported: false, reason: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Télécharge le GGUF (repris s'il était interrompu, taille et SHA-256 vérifiées par le
 * greffon). `onProgress(pct)`. Rien à faire s'il est déjà là. Borné : `stallMs` sans aucun
 * octet reçu, ou `maxMs` au total, et il est annulé (NativeError « timeout », partiel gardé).
 */
export async function downloadNative(onProgress, { stallMs = LIMITS.stallMs, maxMs = LIMITS.nativeDownloadMs } = {}) {
  const p = await getPlugin();
  let stallTimer, stalled;
  const guard = new Promise((_, reject) => { stalled = reject; });
  guard.catch(() => {});
  const arm = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stalled(Object.assign(new Error(`download: no data for ${Math.round(stallMs / 1000)} s`), { timedOut: true })), stallMs);
  };
  const sub = await p.addListener?.("downloadProgress", (ev) => {
    arm();
    if (ev?.total > 0) onProgress?.(Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
  });
  arm();
  try {
    const url = `https://huggingface.co/${NATIVE_MODEL.id}/resolve/${NATIVE_MODEL.revision}/${NATIVE_MODEL.file}`;
    const dl = p.download({ file: NATIVE_MODEL.file, url, bytes: NATIVE_MODEL.bytes, sha256: NATIVE_MODEL.sha256 });
    await withTimeout(Promise.race([dl, guard]), maxMs, "download");
    onProgress?.(100);
  } catch (e) {
    if (e?.timedOut) {
      try { await withTimeout(p.cancelDownload(), LIMITS.nativeUnloadMs, "cancel"); } catch { /* il s'arrêtera seul */ }
      throw new NativeError("timeout", e.message);
    }
    throw new NativeError(e?.code === "cancelled" ? "cancelled" : "network", e?.message || String(e));
  } finally {
    clearTimeout(stallTimer);
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
 * @returns {Promise<{ info: object, selfTest: string, selfTestRaw: string[], mem: object|null, loadMs: number, bench: object }>}
 *   mem : mémoire du processus :llm après le chargement (Mo : rssMB, peakMB, pssMB, gfxMB)
 *   bench : vitesse de l'essai à vide (selfTestBench), affichée dans la ligne d'état
 */
export async function loadNative(backend, timeoutMs) {
  const p = await getPlugin();
  const t0 = Date.now();
  const run = async () => {
    const r = parse(await p.load({ file: NATIVE_MODEL.file, backend, nCtx: 4096 }).catch(rethrow("load")), "load");
    const turn = async (messages, maxTokens) => {
      const { prefix, rest } = splitPrompt(messages);
      const g = parse(await p.generate({ prefix, rest, maxTokens, phase: "selftest" }).catch(rethrow("selftest")), "selftest");
      return { raw: String(g.text ?? ""), said: String(g.text ?? "").split("<|im_end|>")[0].replace(/<\|[a-z_]+\|>/g, "").trim(), stats: g.stats };
    };
    const a = await turn(NATIVE_SELF_TEST.messages, NATIVE_SELF_TEST.maxNewTokens);
    const v = selfTestVerdict(a.said);
    if (!v.ok) throw new NativeError("selftest", `${v.reason}: ${JSON.stringify(a.raw)}`);
    // Second tour : sur le téléphone, le GPU répondait juste au premier tour, puis un mot
    // faux et la fin (« weather<|im_end|> »). Sorties brutes des deux tours dans l'erreur.
    const b = await turn(secondTurn(NATIVE_SELF_TEST.messages, a.said), NATIVE_SELF_TEST.secondMaxNewTokens);
    const v2 = selfTestVerdict(b.said, { minWords: SECOND_TURN.minWords });
    if (!v2.ok) throw new NativeError("selftest", `tour 2 ${v2.reason}: ${JSON.stringify(a.raw)} puis ${JSON.stringify(b.raw)}`);
    // Sorties BRUTES des deux tours : la preuve, à l'écran et au journal, que le GPU calcule juste.
    // Banc fixe : mêmes prompts à chaque chargement, la vitesse comparable d'un lancement à l'autre.
    return { info: r.info || {}, selfTest: `${a.said} | ${b.said}`, selfTestRaw: [a.raw, b.raw], mem: r.mem || null, loadMs: Date.now() - t0,
      bench: selfTestBench(r.info || {}, [a.stats, b.stats]) };
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
  const r = parse(await p.generate({ prefix, rest, maxTokens: maxNewTokens, phase: "answer" }).catch(rethrow("generate")), "generate");
  // La fin de tour n'est pas rendue en texte par le moteur : la remettre, sans quoi
  // cleanReply prendrait une réponse complète pour une réponse coupée.
  const text = String(r.text ?? "");
  return { raw: r.stats?.eog && !text.includes("<|im_end|>") ? `${text}<|im_end|>` : text, stats: { ...r.stats, ...(r.mem ? { mem: r.mem } : {}) } };
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
