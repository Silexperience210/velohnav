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
  VARIANTS, chooseVariant, LIMITS, watchdog,
  initialProgress, progressReducer, withTimeout,
  memoryVerdict, heaviestVariant, LEGACY_MODEL_DIRS, selfTestVerdict, SECOND_TURN,
  planAttempts, classifyFailure, deviceFingerprint, failureRecord,
  MODEL, NATIVE_MODEL, planNative, nativeAttemptId, nativeFingerprint, TRANSIENT,
  REPEAT, frozenReply,
} from "./modelPolicy.js";
import { readMemoryInfo } from "./deviceMemory.js";
import { JOURNAL_KEY, journalEntry, withReply, parseJournal, pushEntry, replaceLast } from "./launchJournal.js";
import {
  nativeStatus, downloadNative, cancelNativeDownload, loadNative, warmNative,
  generateNative, cancelNative, unloadNative, releaseNative, deleteNativeModel,
} from "./nativeModel.js";

export { chooseVariant };

// Tentatives en échec sur cet appareil (planAttempts les saute) : { fingerprint, failed:
// { "q4f16/webgpu": "raison", … } }. Liées à l'empreinte (modèle, échelle, GPU annoncé).
const FAILED_KEY = "velohnav_ai_attempts_ko";
// Clés d'avant l'échelle, reprises une fois puis effacées (voir failureRecord).
const LEGACY_F16_KEY = "velohnav_ai_f16_ko";
const LEGACY_WEBGPU_KEY = "velohnav_ai_webgpu_ko";

const store = () => { try { return globalThis.localStorage || null; } catch { return null; } };

function loadFailures(fingerprint) {
  const ls = store();
  let stored = null, legacyF16 = null;
  try { stored = ls?.getItem(FAILED_KEY) ?? null; legacyF16 = ls?.getItem(LEGACY_F16_KEY) ?? null; } catch { /* mode privé */ }
  const failed = failureRecord({ stored, legacyF16, fingerprint });
  if (legacyF16 || ls?.getItem?.(LEGACY_WEBGPU_KEY)) {
    saveFailures(fingerprint, failed);
    try { ls.removeItem?.(LEGACY_F16_KEY); ls.removeItem?.(LEGACY_WEBGPU_KEY); } catch { /* idem */ }
  }
  return failed;
}
function saveFailures(fingerprint, failed) {
  try { store()?.setItem(FAILED_KEY, JSON.stringify({ fingerprint, failed })); } catch { /* mode privé */ }
}
// Moteurs natifs en échec sur cet appareil : { fingerprint, failed: { vulkan: "raison", … } }.
const NATIVE_FAILED_KEY = "velohnav_ai_native_ko";
// Révision du chargement processeur natif. Un échec « cpu » noté par une révision plus
// ancienne redevient passager : rejoué une fois, en mode sûr. (Révision 2 : le pool de
// fils libéré trop tôt au calibrage figeait le chargement sur le téléphone.)
const NATIVE_CPU_REV = 2;
function loadNativeFailures(fingerprint) {
  try {
    const r = JSON.parse(store()?.getItem(NATIVE_FAILED_KEY) ?? "null");
    if (r?.fingerprint !== fingerprint || !r.failed || typeof r.failed !== "object") return {};
    const failed = { ...r.failed };
    if (failed.cpu && (r.cpuRev ?? 1) < NATIVE_CPU_REV && !String(failed.cpu).startsWith(TRANSIENT)) failed.cpu = `${TRANSIENT}${failed.cpu}`;
    return failed;
  } catch { return {}; }
}
function saveNativeFailures(fingerprint, failed) {
  try { store()?.setItem(NATIVE_FAILED_KEY, JSON.stringify({ fingerprint, failed, cpuRev: NATIVE_CPU_REV })); } catch { /* mode privé */ }
}

// ── Journal des chargements (launchJournal.js) : la preuve, lancement après lancement ──
let journalLive = false;   // l'entrée la plus récente est celle du modèle en service
const readJournalRaw = () => { try { return store()?.getItem(JOURNAL_KEY) ?? null; } catch { return null; } };
const writeJournal = (entries) => { try { store()?.setItem(JOURNAL_KEY, JSON.stringify(entries)); } catch { /* mode privé */ } };
/** Les chargements gardés, du plus ancien au plus récent. */
export const readJournal = () => parseJournal(readJournalRaw());
export function clearJournal() { journalLive = false; try { store()?.removeItem?.(JOURNAL_KEY); } catch { /* mode privé */ } }
function recordLaunch(error = null) {
  writeJournal(pushEntry(readJournal(), journalEntry(modelReport(), { at: Date.now(), error })));
  journalLive = !error;
}
function recordReply(raw, stats) {
  if (!journalLive) return;
  const entries = readJournal();
  if (!entries.length) return;
  const next = withReply(entries.at(-1), { raw, stats });
  if (next !== entries.at(-1)) writeJournal(replaceLast(entries, next));
}

/** Oublie les échecs mémorisés (natifs compris) : « Réessayer », « Réessayer le GPU ». */
export function forgetFailures() {
  try { store()?.removeItem?.(FAILED_KEY); store()?.removeItem?.(NATIVE_FAILED_KEY); } catch { /* mode privé */ }
}

/** Échec de chargement ou de génération, avec un code traduisible côté interface. */
export class ModelError extends Error {
  constructor(code, { detail = "", seconds = 0, mb = 0, needMB = 0, availMB = 0, attempts = [], recover = false } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ModelError";
    this.code = code;
    this.detail = detail;
    this.seconds = seconds;
    this.mb = mb;
    this.needMB = needMB;     // code "memory" : mémoire libre exigée…
    this.availMB = availMB;   // … et mémoire libre constatée
    this.attempts = attempts; // tentatives faites pendant ce chargement : { id, code, detail }
    this.recover = recover;   // true : la tentative est écartée, recharger passe à la suivante
  }
}

// Sonde WebGPU de la session : faite une fois (premier worker), réutilisée ensuite.
// undefined : pas encore sondé ; null : pas de WebGPU.
let probeCache;
// Tentative retenue (ou en cours) : variante + moteur.
let current = null;
// Moteur natif retenu ({ id, backend, engine, variant }) ; null : la voie WebGPU / processeur.
let native = null;
let nativeFp = "";
// Tentatives du chargement en cours ou du dernier (modelReport).
let report = { tried: [], skipped: [], chosen: null };
// Échecs natifs mémorisés d'un lancement précédent (montrés comme les autres, gpuSetAside).
let nativeSkipped = [];

/** Taille du modèle à annoncer : celle de la tentative retenue, sinon la variante processeur. */
export const chatModelMB = () => (current ? current.variant.mb : VARIANTS.wasm.mb);

/** Tentatives faites et leur issue, tentatives écartées d'avance et pourquoi, tentative retenue. */
export function modelReport() {
  return {
    tried: report.tried.map((x) => ({ ...x })),
    skipped: report.skipped.map((x) => ({ ...x })),
    chosen: report.chosen ? { ...report.chosen } : null,
    gpu: report.gpu ? { ...report.gpu } : null,
    // Moteur natif écarté à ce chargement : { kind: absent|unsupported|failed|failed_before|timeout, detail }
    native: report.native ? { ...report.native } : null,
    // GGUF en arrière-plan : { state: running|done|stopped, pct, detail }
    nativeDownload: nativeDl ? { ...nativeDl } : null,
  };
}

// Téléchargement du GGUF en arrière-plan, suivi par l'écran : sans lui, 219 Mo arrivaient
// sans aucun signe, et rien ne disait quand le GPU natif deviendrait possible.
let nativeDl = null;
const nativeDlListeners = new Set();
/** Suivre le GGUF en arrière-plan ; rend la fonction de désabonnement. */
export function onNativeDownload(fn) {
  nativeDlListeners.add(fn);
  return () => nativeDlListeners.delete(fn);
}
function setNativeDl(s) {
  nativeDl = s;
  for (const fn of nativeDlListeners) { try { fn(s ? { ...s } : null); } catch { /* l'écran ne casse pas le téléchargement */ } }
}

/**
 * Ce que l'appareil annonce de son GPU (sonde du worker) : de quoi savoir, dans
 * l'interface et les journaux, pourquoi une tentative GPU a été écartée ou tentée.
 * null : pas de WebGPU dans ce navigateur.
 */
function gpuSummary(probe) {
  if (!probe) return null;
  const i = probe.info || {};
  return {
    adapter: !!probe.adapter,
    vendor: i.vendor || "", architecture: i.architecture || "", description: i.description || "",
    fallback: !!probe.isFallbackAdapter,
    f16: (probe.features || []).includes("shader-f16"),
    maxBufferMiB: Number.isFinite(probe.limits?.maxBufferSize) ? Math.round(probe.limits.maxBufferSize / 2 ** 20) : null,
    maxBindingMiB: Number.isFinite(probe.limits?.maxStorageBufferBindingSize) ? Math.round(probe.limits.maxStorageBufferBindingSize / 2 ** 20) : null,
    device: probe.device?.ok ? "ok" : (probe.device?.error || probe.error || "—"),
  };
}

const gpuLine = (g) => g.adapter
  ? `${[g.vendor, g.architecture, g.description].filter(Boolean).join(" ") || "?"}${g.fallback ? " (logiciel)" : ""}, `
    + `shader-f16 ${g.f16 ? "oui" : "non"}, tampon ${g.maxBufferMiB ?? "?"} Mio, liaison ${g.maxBindingMiB ?? "?"} Mio, device ${g.device}`
  : `aucun adaptateur${g.device && g.device !== "—" ? ` (${g.device})` : ""}`;

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

/**
 * Arrête le worker (libère la mémoire et tout ce qui y était bloqué). `keepNative` : le
 * moteur natif prêt est seulement rendu — le processus :llm garde le modèle pour la visite
 * suivante (releaseNative) ; sinon il est arrêté.
 */
function killWorker(err, { keepNative = false } = {}) {
  if (native) { const kept = keepNative && ready; native = null; kept ? releaseNative() : unloadNative(); }
  if (worker) worker.terminate();
  worker = null;
  ready = false;
  for (const { reject } of pending.values()) reject(err || new ModelError("generate"));
  pending.clear();
}

// Fichiers d'une variante qui ne servira plus sur cet appareil : retirés du cache de
// transformers.js pour laisser la place à la suivante.
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
// Les anciens modèles Qwen (0.5B : jusqu'à 1 Go ; 1.5B : 1,2 à 1,8 Go de stockage) ne
// servent plus. Une seule fois par session ; appelé au démarrage de l'application (App)
// et avant tout chargement. Ne touche que le cache local : aucun accès réseau.
let legacyPurged = false;
export function purgeLegacyModels() {
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
  else p.resolve({ text: data.text, tokens: data.tokens });
}

/**
 * UNE tentative, dans un worker neuf (un moteur onnxruntime par worker). Si la sonde
 * n'est pas encore faite, le worker sonde d'abord et `choose(probe)` désigne la
 * tentative. Rend { attempt } (attempt null : plus rien à tenter),
 * ou rejette avec { attemptFailure, phase, timedOut, seconds, detail }.
 */
function runAttempt(choose, onProgress, onPhase) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./modelWorker.js", import.meta.url), { type: "module" });
    worker = w;
    let st = initialProgress(Date.now());
    let att = null;
    let settled = false;

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      abortLoad = null;
      clearInterval(tick);
      if (err) reject(err);
      else resolve(value);
    };
    // Désactivation pendant le chargement : le worker meurt avec tout ce qu'il tenait
    abortLoad = () => { killWorker(); done(new ModelError("cancelled")); };

    const fail = (phase, { timedOut = false, seconds = 0, detail = "" } = {}) => {
      if (settled) return;
      killWorker();
      done(Object.assign(new Error(detail || phase), { attemptFailure: true, attempt: att, phase, timedOut, seconds, detail }));
    };

    const start = (probe) => {
      const a = choose(probe);
      if (!a) { killWorker(); done(null, { attempt: null }); return; }
      att = a;
      const now = Date.now();
      st = { ...st, since: now, lastActivity: now, expect: a.variant.files };   // init seulement quand les POIDS sont là
      onPhase?.({ phase: "download", device: a.engine.device, engine: a.engine.id, attempt: a.id, mb: a.variant.mb });
      w.postMessage({ type: "load", variant: a.variant, engine: a.engine.id, attemptId: a.id });
    };

    // Le chien de garde : la seule chose qui voit un blocage (une attente qui ne se
    // résout jamais ne lève pas d'exception).
    const tick = setInterval(() => {
      const v = watchdog({ ...st, device: att?.engine.device || "wasm" }, Date.now());
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
        if (st.phase !== prev && st.phase === "init") {
          onPhase?.({ phase: "init", device: att?.engine.device, engine: att?.engine.id, attempt: att?.id, mb: att?.variant.mb });
        }
      } else if (data.type === "ready") {
        // « Prêt » seulement si l'essai à vide a produit du texte : une session créée ne
        // suffit pas (q4f16 sur un GPU sans fp16 se charge, puis ne génère rien).
        const v = selfTestVerdict(data.selfTest);
        if (!v.ok) {
          fail("init", { detail: `self-test ${v.reason}: ${JSON.stringify(data.selfTest ?? null)}` });
          return;
        }
        // Second tour (secondTurn) : la sortie exacte est gardée dans l'erreur.
        const v2 = data.selfTest2 === undefined ? v : selfTestVerdict(data.selfTest2, { minWords: SECOND_TURN.minWords });
        if (!v2.ok) {
          fail("init", { detail: `self-test tour 2 ${v2.reason}: ${JSON.stringify(data.selfTest)} puis ${JSON.stringify(data.selfTest2)}` });
          return;
        }
        w.onmessage = onRuntimeMessage;
        w.onerror = (e) => killWorker(new ModelError("generate", { detail: e?.message || "worker error" }));
        ready = true;
        done(null, { attempt: att, loadMs: data.loadMs, gpu: data.gpu || null, integrity: Array.isArray(data.integrity) ? data.integrity : [],
          selfTestRaw: Array.isArray(data.selfTestRaw) ? data.selfTestRaw.map(String) : [data.selfTest, data.selfTest2].filter((x) => x !== undefined).map(String) });
      } else if (data.type === "error") {
        // Échec à l'import du moteur : propre à la tentative, pas au réseau.
        const phase = data.stage === "engine" || data.stage === "integrity" ? data.stage : st.phase;
        // Le message d'onnxruntime est souvent générique (« failed to call OrtRun() ») :
        // la cause est dans son journal (console du worker), qu'on joint au message.
        const log = Array.isArray(data.log) ? data.log.filter((l) => l && !String(data.message).includes(l)) : [];
        fail(phase, { detail: [data.message, ...log].join(" | ") });
      }
    };

    if (probeCache !== undefined) start(probeCache);
    else w.postMessage({ type: "probe" });
  });
}

const attemptLine = (x) => `${x.id} → ${x.code}${x.detail ? ` (${x.detail})` : ""}`;

/**
 * L'échelle : tentatives dans l'ordre de planAttempts, sans rien demander. Une tentative
 * en échec (moteur, initialisation, essai à vide) est mémorisée et la suivante part
 * d'elle-même ; le processeur est la dernière. L'utilisateur ne voit une erreur que si
 * TOUT a échoué, ou si le réseau / la mémoire empêchent d'aller plus loin.
 *
 * `gpuOnly` : seulement les tentatives WebGPU, entre le GPU natif et le processeur natif.
 * Rend alors false — sans erreur — si aucune n'aboutit, réseau et mémoire compris : le
 * processeur natif, déjà sur l'appareil, prend le relais.
 * @returns {Promise<boolean>} true : une tentative est retenue
 */
async function runLadder(onProgress, onPhase, gen, { gpuOnly = false } = {}) {
  try {
    return await ladder(onProgress, onPhase, gen, gpuOnly);
  } catch (e) {
    if (!gpuOnly || e?.code === "cancelled" || gen !== generation) throw e;
    console.warn(`[IA] WebGPU sans succès (${e?.code}) : le processeur natif prend le relais`, e?.detail || "");
    current = null;
    return false;
  }
}

async function ladder(onProgress, onPhase, gen, gpuOnly) {
  // Les tentatives natives faites juste avant (runNative) restent dans le rapport.
  const tried = report.tried;
  let fingerprint = null, failed = {};
  const choose = (probe) => {
    if (probeCache === undefined) probeCache = probe ?? null;
    report.gpu = gpuSummary(probeCache);
    fingerprint = deviceFingerprint(probeCache);
    failed = loadFailures(fingerprint);
    // Ce qui a échoué pendant CE chargement n'est pas rejoué (un échec passager compris)
    const plan = planAttempts({ probe: probeCache, failed: { ...failed, ...Object.fromEntries(tried.map((x) => [x.id, x.code])) } });
    if (gpuOnly) plan.queue = plan.queue.filter((a) => a.engine.device === "webgpu");
    // Ce qui vient d'échouer pendant CE chargement figure déjà dans `tried`
    report.skipped = [...nativeSkipped, ...plan.skipped.filter((x) => !tried.some((y) => y.id === x.id))];
    const a = plan.queue[0] || null;
    if (a) {
      current = a;
      console.info(`[IA] tentative ${a.id} (${a.variant.mb} Mo)${plan.skipped.length ? ` ; écartées : ${plan.skipped.map((x) => `${x.id} [${x.reason}]`).join(", ")}` : ""}`);
    }
    return a;
  };

  for (let first = true; ; first = false) {
    if (gen !== generation) throw new ModelError("cancelled");
    // Sonde déjà faite : la tentative est désignée ici, et s'il ne reste rien à tenter,
    // aucun worker n'est créé pour rien.
    const probed = probeCache !== undefined;
    let r = probed && !choose(probeCache) ? { attempt: null } : null;
    // Avant chaque nouvelle tentative : la mémoire est relue pour SA variante (le worker
    // précédent est arrêté, mais rien ne garantit que le système a tout repris).
    if (!r && !first) {
      await checkMemory(current.variant);
      if (gen !== generation) throw new ModelError("cancelled");
    }
    if (!r) try {
      r = await runAttempt(probed ? () => current : choose, onProgress, onPhase);
    } catch (e) {
      if (!e?.attemptFailure) throw e;
      const a = e.attempt;
      if (!a) throw new ModelError(e.timedOut ? "setup_timeout" : "setup", { detail: e.detail, seconds: e.seconds, attempts: tried });
      const d = classifyFailure({ attempt: a, phase: e.phase, timedOut: e.timedOut, failed });
      tried.push({ id: a.id, code: d.code, detail: e.detail });
      console.warn(`[IA] tentative ${a.id} en échec (${d.code}, phase ${e.phase}) :`, e.detail);
      if (d.condemn || d.transient) {
        failed = { ...failed, [a.id]: `${d.transient ? TRANSIENT : ""}${String(e.detail || d.code).slice(0, 200)}` };
        saveFailures(fingerprint, failed);
      }
      if (d.purgeDtype) purgeCachedVariant(d.purgeDtype);
      if (!d.continue) throw new ModelError(d.code, { detail: e.detail, seconds: e.seconds, mb: a.variant.mb, attempts: tried });
      continue;
    }
    if (!r.attempt) {
      current = null;
      if (gpuOnly) return false;
      const lines = [...tried.map(attemptLine), ...report.skipped.filter((x) => x.reason.startsWith("failed-before")).map((x) => `${x.id} → ${x.reason}`)];
      console.warn("[IA] aucune tentative n'a abouti :", lines.join(" ; "));
      throw new ModelError("all_failed", { detail: lines.join(" ; "), attempts: tried });
    }
    // Réussite : un délai passager noté pour elle ne compte plus
    if (failed[r.attempt.id]) {
      const { [r.attempt.id]: _, ...rest } = failed;
      failed = rest;
      saveFailures(fingerprint, failed);
    }
    report.chosen = {
      id: r.attempt.id, dtype: r.attempt.variant.dtype, device: r.attempt.engine.device,
      engine: r.attempt.engine.id, mb: r.attempt.variant.mb,
      ...(Number.isFinite(r.loadMs) ? { loadMs: r.loadMs } : {}),
      selfTestRaw: r.selfTestRaw || [],
      // Fichiers vérifiés (taille, SHA-256) à ce chargement : « verified », « ok », « refetched: … »
      ...(r.integrity?.length ? { integrity: r.integrity } : {}),
      // Réglage GPU retenu et fonctions retirées du device (subgroups) : dit à l'écran et au journal
      ...(r.attempt.gpu ? { gpuMode: r.attempt.gpu.mode, dropped: r.gpu?.dropped || [] } : {}),
    };
    console.info(`[IA] retenu : ${r.attempt.id} (${r.attempt.variant.mb} Mo`
      + `${Number.isFinite(r.loadMs) ? `, prêt en ${(r.loadMs / 1000).toFixed(1)} s` : ""})`
      + `${r.gpu?.dropped?.length ? ` ; device sans ${r.gpu.dropped.join(", ")}` : ""}`
      + `${report.gpu ? ` ; GPU : ${gpuLine(report.gpu)}` : ""}`
      + `${tried.length ? ` ; avant lui : ${tried.map(attemptLine).join(" ; ")}` : ""}`);
    return true;
  }
}

/**
 * Charge le modèle une seule fois (cache en mémoire, pas de re-téléchargement).
 * Ne peut pas rester en attente indéfiniment : chaque phase est bornée (LIMITS).
 * @param {(pct: number) => void} [onProgress] progression du téléchargement (0-100)
 * @param {(p: {phase: "download"|"init", device: string, engine: string, attempt: string, mb: number}) => void} [onPhase]
 * @returns {Promise<void>}
 */
export function loadModel(onProgress, onPhase) {
  if (ready && (worker || native)) return Promise.resolve();
  if (loadPromise) return loadPromise;
  const gen = generation;
  report = { tried: [], skipped: [], chosen: null, gpu: null, native: null };
  turns = [];
  nativeSkipped = [];
  fetchNativeLater = false;
  // Un téléchargement terminé a déjà servi (ce chargement le trouve sur l'appareil) ; en cours,
  // il continue et reste suivi.
  if (!nativeFetch && nativeDl) setNativeDl(null);
  loadPromise = checkMemory(heaviestVariant()).then(async (before) => {
    // Désactivé pendant le contrôle mémoire : ne rien démarrer
    if (gen !== generation) throw new ModelError("cancelled");
    // Le GPU d'abord, toutes voies confondues : Vulkan natif, puis WebGPU ; le processeur
    // ensuite : natif, puis WASM. Avant, un Vulkan en échec menait droit au processeur natif,
    // sans que WebGPU soit essayé : le processeur l'emportait alors qu'un GPU pouvait servir.
    const ok = async () => { await measureLoadCost(before); recordLaunch(); };
    if (await runNative(onPhase, gen, "gpu")) return ok();
    if (gen !== generation) throw new ModelError("cancelled");
    if (nativeCpuLeft) {
      if (await runLadder(onProgress, onPhase, gen, { gpuOnly: true })) return ok();
      if (gen !== generation) throw new ModelError("cancelled");
      if (await runNative(onPhase, gen, "cpu")) return ok();
      if (gen !== generation) throw new ModelError("cancelled");
    }
    try {
      await runLadder(onProgress, onPhase, gen);
    } catch (e) {
      // La voie JavaScript a échoué en entier : le GGUF reste la seule chance d'avoir le GPU.
      // Avant, il n'était téléchargé qu'après une réussite de cette voie — un téléphone où
      // WebGPU et le processeur WASM échouaient ne l'obtenait jamais.
      if (e?.code !== "cancelled") fetchNativeInBackground();
      throw e;
    }
    await measureLoadCost(before);
    recordLaunch();
    fetchNativeInBackground();
  }).catch((e) => {
    // Échec gardé au journal aussi : un lancement sans GPU NI processeur doit s'y voir.
    if (e?.code !== "cancelled" && gen === generation) recordLaunch({ code: e?.code || "load", detail: e?.detail || e?.message || "" });
    throw e;
  }).finally(() => {
    loadPromise = null; // succès : `ready` prend le relais ; échec : retry possible
  });
  return loadPromise;
}

/**
 * Moteur natif (llama.cpp), sur un même GGUF, en deux temps : `stage` « gpu » (Vulkan),
 * premier essai du chargement ; « cpu » (processeur natif), après les tentatives WebGPU.
 * Rend true s'il est retenu. Rend false — sans erreur — si l'APK ne l'embarque pas, si
 * l'appareil ne peut pas le faire tourner, si le GGUF n'est pas encore sur l'appareil
 * (téléchargé ensuite, en arrière-plan), ou si le moteur demandé a échoué. Un moteur en
 * échec (chargement, plantage du processus :llm, essai à vide) est mémorisé et n'est plus
 * tenté sur cet appareil. `nativeCpuLeft` dit si le processeur natif reste à tenter.
 */
let nativeCtx = null;      // { status, failed } du chargement en cours
let nativeCpuLeft = false;
async function runNative(onPhase, gen, stage) {
  if (stage === "cpu") return nativeCtx ? tryNative(onPhase, gen, ["cpu"]) : false;
  nativeCtx = null;
  nativeCpuLeft = false;
  const status = await nativeStatus();
  if (!status) return false;   // navigateur : pas de greffon
  nativeFp = nativeFingerprint(status);
  const failed = loadNativeFailures(nativeFp);
  const plan = planNative({ status, failed });
  // Échecs d'un lancement précédent : montrés à l'écran ; « non embarqué » ne l'est pas.
  nativeSkipped = plan.skipped.filter((x) => x.reason.startsWith("failed-before")).map((x) => ({ id: nativeAttemptId(x.backend), reason: x.reason }));
  console.info(`[IA] moteur natif : ${status.supported ? `disponible (${status.device}, ${status.soc})` : `indisponible (${status.reason})`}`
    + `${plan.queue.length ? ` ; à tenter : ${plan.queue.join(", ")}` : ""}${plan.skipped.length ? ` ; écartés : ${plan.skipped.map((x) => `${x.backend} [${x.reason}]`).join(", ")}` : ""}`
    + `${status.supported ? ` ; modèle ${status.modelExists === true ? "présent" : "absent"}` : ""}`);
  if (!status.supported) return status.reason === "not-built" ? false : nativeAside("unsupported", status.reason);
  if (!plan.queue.length) return nativeAside("failed_before", plan.skipped.map((x) => x.reason.replace(/^failed-before:\s*/, "")).join(" ; "));
  // Modèle absent : on n'attend pas 219 Mo. La voie WebGPU / processeur part tout de suite,
  // le GGUF arrive en arrière-plan une fois le modèle prêt (fetchNativeLater), pour le
  // lancement suivant. Avant : le téléchargement passait AVANT tout, sans borne, et le
  // modèle ne chargeait jamais sur le téléphone.
  if (status.modelExists !== true) {
    fetchNativeLater = true;
    return nativeAside("absent", status.partialBytes > 0 ? `${Math.round(status.partialBytes / 2 ** 20)} Mo reçus` : "");
  }

  nativeCtx = { status, failed };
  nativeCpuLeft = plan.queue.includes("cpu");
  return tryNative(onPhase, gen, plan.queue.filter((b) => b !== "cpu"));
}

async function tryNative(onPhase, gen, backends) {
  const { status } = nativeCtx;
  let { failed } = nativeCtx;
  if (backends.includes("cpu")) nativeCpuLeft = false;
  const variant = { dtype: NATIVE_MODEL.dtype, device: "native", mb: NATIVE_MODEL.mb, files: [NATIVE_MODEL.file] };
  // Budget des moteurs natifs de cet essai : épuisé, la voie suivante part (rien de condamné).
  const deadline = Date.now() + LIMITS.nativeBudgetMs;
  for (const backend of backends) {
    const left = deadline - Date.now();
    if (left <= 0) { console.info(`[IA] budget natif épuisé : ${backend} sera tenté au prochain chargement`); break; }
    const allowed = Math.min(LIMITS.initMs.native, left);
    const id = nativeAttemptId(backend);
    const att = { id, backend, variant, engine: { id: backend === "cpu" ? "native_cpu" : backend, device: "native" } };
    current = att;
    try {
      if (gen !== generation) throw new ModelError("cancelled");
      const phase = { phase: "init", device: "native", engine: att.engine.id, attempt: id, mb: variant.mb };
      onPhase?.(phase);
      // Mode sûr : un processeur natif déjà en échec (délai passager compris) repart sans
      // calibrage des fils, le nombre de fils prévu tel quel.
      const calibrate = !(backend === "cpu" && failed.cpu);
      const r = await loadNative(backend, allowed, {
        calibrate,
        onStep: (step) => { if (gen === generation && current === att) onPhase?.({ ...phase, step }); },
      });
      if (gen !== generation) { unloadNative(); throw new ModelError("cancelled"); }
      native = att;
      ready = true;
      if (failed[backend]) {
        const { [backend]: _, ...rest } = failed;
        saveNativeFailures(nativeFp, rest);
      }
      // Les raisons des tentatives WebGPU sautées juste avant (sonde) restent à l'écran
      report.skipped = [...nativeSkipped, ...report.skipped.filter((x) => !nativeSkipped.some((y) => y.id === x.id))];
      report.chosen = {
        id, dtype: variant.dtype, device: "native", engine: att.engine.id, mb: variant.mb, loadMs: r.loadMs,
        selfTestRaw: r.selfTestRaw || [], ...(r.mem ? { mem: r.mem } : {}),
        ...(r.info.kv ? { kv: r.info.kv } : {}),
        ...(r.bench ? { bench: r.bench } : {}),
        ...(backend !== "cpu" ? { gpuName: r.info.description || r.info.device || "" } : {}),
      };
      console.info(`[IA] retenu : ${id} (${variant.mb} Mo, ${r.reused ? "repris de la mémoire" : "prêt"} en ${(r.loadMs / 1000).toFixed(1)} s)`
        + ` ; appareil ${r.info.device || "?"} ${r.info.description || ""} ; ${r.info.threads ?? "?"} fils ; essai à vide ${JSON.stringify(r.selfTest)}`
        + `${report.tried.length ? ` ; avant lui : ${report.tried.map(attemptLine).join(" ; ")}` : ""}`);
      // Un seul modèle sur l'appareil : la copie ONNX de l'autre voie ne sert plus.
      purgeCache((u) => u.includes(`/${MODEL.id}/`));
      return true;
    } catch (e) {
      if (e?.code === "cancelled" || gen !== generation) {
        cancelNativeDownload();
        unloadNative();
        throw new ModelError("cancelled");
      }
      current = null;
      report.tried.push({ id, code: e?.code || "load", detail: e?.detail || e?.message || String(e) });
      console.warn(`[IA] moteur natif ${backend} en échec (${e?.code}) :`, e?.detail || e);
      // Premier délai dépassé : noté, rejoué au lancement suivant (TRANSIENT) ; le second condamne.
      // Un délai raccourci par le budget commun reste passager : il ne prouve rien du moteur.
      const transient = e?.code === "timeout"
        && (allowed < LIMITS.initMs.native || !String(failed[backend] || "").startsWith(TRANSIENT));
      failed = { ...failed, [backend]: `${transient ? TRANSIENT : ""}${String(e?.detail || e?.code || "load").slice(0, 200)}` };
      nativeCtx.failed = failed;
      saveNativeFailures(nativeFp, failed);
      // Un processus :llm qui ne répond plus ne retient pas la voie JavaScript.
      await withTimeout(unloadNative(), LIMITS.nativeUnloadMs, "native unload").catch(() => {});
    }
  }
  // Plus aucun moteur natif à tenter, même plus tard : le GGUF ne servira plus, il ne reste
  // pas en plus du modèle ONNX. Un délai passager, lui, garde le fichier pour le rejouer.
  if (!nativeCpuLeft && !planNative({ status, failed }).queue.length) deleteNativeModel();
  const natTried = report.tried.filter((x) => x.id.startsWith(`${NATIVE_MODEL.dtype}/`));
  if (!natTried.length) return nativeAside("failed_before", Object.values(failed).join(" ; "));
  return nativeAside(natTried.every((x) => x.code === "timeout") ? "timeout" : "failed", natTried.map(attemptLine).join(" ; "));
}

/** Le moteur natif n'est pas retenu à ce chargement : la raison, pour la ligne d'état. Rend false. */
function nativeAside(kind, detail = "") {
  report.native = { kind, detail: String(detail).slice(0, 240) };
  console.info(`[IA] natif indisponible (${kind}${detail ? ` : ${detail}` : ""}) → WebGPU / processeur`);
  return false;
}

// GGUF absent au chargement : téléchargé en arrière-plan une fois la voie WebGPU / processeur
// prête (pas de concurrence avec son propre téléchargement), pour le lancement suivant.
let fetchNativeLater = false;
let nativeFetch = null;   // téléchargement en arrière-plan en cours
function fetchNativeInBackground() {
  if (!fetchNativeLater || nativeFetch) return;
  fetchNativeLater = false;
  console.info("[IA] modèle natif téléchargé en arrière-plan");
  setNativeDl({ state: "running", pct: 0, detail: "" });
  nativeFetch = downloadNative((pct) => { if (nativeDl?.state === "running" && pct !== nativeDl.pct) setNativeDl({ ...nativeDl, pct }); })
    .then(() => {
      console.info("[IA] modèle natif reçu, vérifié (SHA-256) : le GPU natif peut prendre le relais");
      // `done` : l'écran recharge dès qu'il est libre (sans attendre le lancement suivant) ;
      // le chargement suivant trouve le GGUF et passe par le GPU natif.
      setNativeDl({ state: "done", pct: 100, detail: "" });
    })
    // Réseau coupé, délai, annulation : rien de condamné, le fichier partiel est repris la fois suivante.
    .catch((e) => {
      console.warn(`[IA] téléchargement du modèle natif interrompu (${e?.code}) :`, e?.detail || e);
      setNativeDl({ state: "stopped", pct: nativeDl?.pct ?? 0, detail: `${e?.code || "network"}${e?.detail ? `: ${String(e.detail).slice(0, 160)}` : ""}` });
    })
    .finally(() => { nativeFetch = null; });
}

/**
 * Contrôle AVANT tout engagement (aucun worker créé, rien téléchargé) : si
 * l'appareil n'a pas la mémoire libre pour le pic de chargement, refus avec un
 * code traduisible plutôt qu'un WebView tué par le système. Refait avant chaque
 * tentative de l'échelle, pour la variante de cette tentative.
 */
async function checkMemory(variant) {
  purgeLegacyModels();
  const info = await readMemoryInfo();
  const v = memoryVerdict(info, variant);
  console.info(`[IA] mémoire : ${v.reason} (besoin ≈ ${v.needMB} Mo, disponible ${v.availMB ?? "?"} Mo)`);
  if (!v.ok) throw new ModelError("memory", { detail: v.reason, needMB: v.needMB, availMB: v.availMB ?? 0 });
  return info;
}

/**
 * Ce que le chargement a coûté au système : mémoire libre avant, moins mémoire libre une
 * fois prêt (Android, ActivityManager). Même mesure pour toutes les voies — la WebView
 * ne voit ni ses tampons GPU ni le processus :llm, le système, lui, voit tout. Approchée :
 * d'autres applications bougent dans le même temps. Rien si la mémoire libre est inconnue.
 */
async function measureLoadCost(before) {
  if (!Number.isFinite(before?.availBytes) || !report.chosen) return;
  const after = await readMemoryInfo().catch(() => null);
  if (!Number.isFinite(after?.availBytes)) return;
  report.chosen.sysMB = Math.round((before.availBytes - after.availBytes) / 1e6);
  report.chosen.availMB = Math.round(after.availBytes / 1e6);
  console.info(`[IA] coût du chargement : ${report.chosen.sysMB} Mo de mémoire système (libre ensuite : ${report.chosen.availMB} Mo)`);
}

/**
 * Arrête le modèle et rend la mémoire : le worker est terminé (son tas WASM, ses
 * tampons GPU et le fichier lu partent avec lui), un chargement en cours est
 * interrompu. Appelé quand l'utilisateur désactive la conversation libre ou
 * quitte l'écran. Avant : le worker restait en vie pour la durée de l'application
 * — plus d'1 Go résident pendant la carte et la caméra AR.
 *
 * `keepNative` (écran quitté) : le moteur natif prêt n'est pas arrêté, son processus :llm
 * garde le modèle (notification « modèle local actif ») et le prochain loadModel le reprend
 * en quelques millisecondes. Conversation désactivée : tout est arrêté.
 */
export function unloadModel({ keepNative = false } = {}) {
  generation++;
  if (abortLoad) abortLoad();
  else if (worker || native) killWorker(new ModelError("cancelled"), { keepNative });
  // Chargement natif en cours : runNative voit `generation` changer et s'arrête ;
  // le téléchargement et le processus :llm s'arrêtent dès maintenant.
  else if (loadPromise && current?.engine.device === "native") { cancelNativeDownload(); unloadNative(); }
  // Conversation désactivée : le GGUF en arrière-plan s'arrête aussi (le partiel est repris plus tard).
  if (nativeFetch) cancelNativeDownload();
}

/**
 * Calcule à l'avance l'état du modèle sur la consigne système, pendant que l'utilisateur
 * tape (processeur seulement ; le worker l'ignore sur WebGPU). À rappeler quand la
 * consigne change (langue). Sans effet si le modèle n'est pas prêt ; jamais d'erreur :
 * au pire la première question calcule la consigne elle-même.
 * @param {string} system
 * @param {object[]} [tools] comme generate : schémas passés au gabarit
 */
export function warmUp(system, tools) {
  if (!ready || !system) return;
  if (native) warmNative([{ role: "system", content: system }], tools);
  else if (worker) worker.postMessage({ type: "warm", system, tools });
}

// Le gabarit de conversation n'est plus écrit ici à la main (il était propre à Qwen) :
// le worker applique celui du tokenizer du modèle (apply_chat_template), seul à
// connaître ses jetons de rôle et sa façon de présenter les outils.
//
// Réponse = ce qui précède la fin de tour (<|im_end|>, jeton d'arrêt du modèle) ; rien de
// ce qui suivrait n'est une réponse. Sans fin de tour, la génération a été coupée par
// max_new_tokens : mesuré au banc (scripts/bench-chat), 2 réponses libres sur 10 l'étaient,
// et la bulle montrait une phrase interrompue (« …des sacs »). Un texte libre coupé est
// ramené à sa dernière phrase complète ; sans phrase complète, il ne reste rien et
// l'assistant déterministe répond. Un appel d'outil coupé est laissé tel quel : sa
// validation (tools.js) le rejette.
export function cleanReply(text) {
  const s = String(text ?? "");
  const end = s.indexOf("<|im_end|>");
  let body = (end >= 0 ? s.slice(0, end) : s)
    .replace(/<\|(im_start|startoftext|endoftext)\|>/g, "")
    .trim();
  if (end < 0 && !/<\|tool_call_start\|>|<tool_call>|^\[\s*[A-Za-z_]\w*\s*\(/.test(body)) {
    const m = /^[\s\S]*[.!?…](?=\s|$)/.exec(body);
    body = m ? m[0].trim() : "";
  }
  return body;
}

/**
 * Options de génération transmises au worker. Exportées pour que les bancs
 * (scripts/bench-chat) mesurent exactement ce que fait l'application.
 */
export function generationOptions(opts = {}) {
  return {
    max_new_tokens: opts.maxNewTokens ?? 256,
    do_sample: false, // greedy = déterministe, fiable pour les appels d'outils
  };
}

/**
 * Génère une réponse à partir du system prompt + historique de conversation.
 * Bornée dans le temps : au-delà de LIMITS.generateMs (selon l'appareil), le worker est arrêté (il sera
 * recréé, depuis le cache, à la prochaine demande).
 * @param {string} system
 * @param {Array<{role:string, content:string}>} history
 * @param {{maxNewTokens?: number, tools?: object[]}} [opts] `tools` : schémas d'outils
 *   transmis au gabarit du modèle (voir tools.js)
 * @returns {Promise<string>} texte produit après le prompt, jetons d'appel d'outil compris
 */
export async function generate(system, history, opts = {}) {
  return (await generateDetailed(system, history, opts)).text;
}

/**
 * Comme generate, mais rend aussi la sortie BRUTE du modèle (avant cleanReply,
 * marqueurs compris). Sans elle, une réponse rejetée ne pouvait pas être montrée :
 * personne ne savait ce que le modèle avait réellement produit.
 * @returns {Promise<{raw: string, text: string}>}
 */
export async function generateDetailed(system, history, opts = {}) {
  await loadModel();
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...history.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool"),
  ];
  const seconds = Math.round(generateLimitMs() / 1000);
  const t0 = Date.now();
  if (native) {
    const { raw, stats } = await runNativeGeneration(messages, opts, seconds);
    const st = { ...speed(native, stats.genTokens, stats.genMs, Date.now() - t0), ...(stats.mem ? { mem: stats.mem } : {}) };
    recordReply(raw, st);
    return checkFrozen(history, { raw, text: cleanReply(raw), stats: st });
  }
  const id = ++seq;
  const out = await runGeneration(id, messages, opts, seconds);
  // Le worker ne distingue pas le calcul de la consigne de la génération : vitesse sur le total.
  const raw = String(out?.text ?? "");
  const st = speed(current, out?.tokens, null, Date.now() - t0);
  recordReply(raw, st);
  return checkFrozen(history, { raw, text: cleanReply(out?.text), stats: st });
}

// Échanges en texte libre de la voie en service (frozenReply) ; remis à zéro à chaque chargement.
let turns = [];
const isToolCall = (s) => /<\|tool_call_start\|>|<tool_call>|^\[\s*[A-Za-z_]\w*\s*\(/.test(s);

/**
 * Réponse figée (la même à des questions différentes, frozenReply) : la voie en service
 * calcule faux, même si chaque réponse prise seule est une phrase valide — « Bonne nuit » à
 * « Bonsoir » puis à « Bonjour », relevé sur le téléphone. Elle n'est pas montrée ; la voie
 * est écartée sur l'appareil comme après une erreur de génération (`recover` : l'interface
 * recharge, la voie suivante part seule). Sur le processeur WASM, la dernière voie, ses
 * fichiers sont aussi retirés du cache : « Réessayer » les retélécharge et les revérifie.
 */
function checkFrozen(history, out) {
  if (!out.text || isToolCall(out.text)) return out;
  const q = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  turns = [...turns, { q, a: out.text }].slice(-REPEAT.turns);
  const f = frozenReply(turns);
  if (!f) return out;
  const detail = `${JSON.stringify(f.reply)} ×${f.times}`;
  turns = [];
  if (native) {
    const a = native;
    saveNativeFailures(nativeFp, { ...loadNativeFailures(nativeFp), [a.backend]: `degenerate: ${detail}`.slice(0, 200) });
    report.tried.push({ id: a.id, code: "degenerate", detail });
  } else if (current) {
    const a = current;
    const fingerprint = deviceFingerprint(probeCache ?? null);
    saveFailures(fingerprint, { ...loadFailures(fingerprint), [a.id]: `degenerate: ${detail}`.slice(0, 200) });
    if (a.engine.device === "wasm") purgeCachedVariant(a.variant.dtype);
    report.tried.push({ id: a.id, code: "degenerate", detail });
  }
  report.chosen = null;
  console.warn(`[IA] réponse figée (${detail}) : voie ${native?.id || current?.id || "?"} écartée`);
  const err = new ModelError("degenerate", { detail, recover: true, attempts: report.tried });
  killWorker(err);
  throw err;
}

/**
 * Vitesse de la réponse, rendue à l'écran pour comparer les voies sur la même question.
 * `genMs` : temps de génération seul (moteur natif) ; sinon le temps total de la réponse.
 */
function speed(att, tokens, genMs, totalMs) {
  const n = Number.isFinite(tokens) ? tokens : null;
  const genOnly = Number.isFinite(genMs) && genMs > 0;
  const ms = genOnly ? genMs : totalMs;
  const s = { id: att?.id || "?", engine: att?.engine.id || "?", tokens: n, ms: Math.round(ms), totalMs, genOnly,
    tps: n && ms > 0 ? Math.round((n / (ms / 1000)) * 10) / 10 : null };
  console.info(`[IA] réponse ${s.id} : ${n ?? "?"} jetons en ${(ms / 1000).toFixed(2)} s${s.tps ? ` (${s.tps} j/s)` : ""}, total ${(totalMs / 1000).toFixed(2)} s`);
  return s;
}

/**
 * Génération sur le moteur natif, bornée dans le temps. Plantage du processus :llm ou
 * erreur du moteur : ce moteur est écarté sur l'appareil et `recover` demande à l'interface
 * de recharger — le moteur natif suivant, ou l'échelle WebGPU / processeur, part seul.
 */
async function runNativeGeneration(messages, opts, seconds) {
  const a = native;
  try {
    return await withTimeout(generateNative(messages, { tools: opts.tools, maxNewTokens: opts.maxNewTokens ?? 256 }),
      generateLimitMs(), "generate", () => { cancelNative(); });
  } catch (e) {
    if (e?.timedOut) {
      const err = new ModelError("generate_timeout", { seconds });
      killWorker(err);
      throw err;
    }
    // Moteur rendu ou arrêté entre-temps (écran quitté) : rien n'est prouvé contre lui.
    if (native !== a) throw new ModelError("cancelled");
    // Arrêté depuis la notification : le moteur n'a pas failli, il est rechargé tel quel.
    if (/^stopped\b/.test(String(e?.detail || ""))) {
      console.info("[IA] moteur natif arrêté depuis la notification : rechargement");
      const err = new ModelError("generate", { detail: "stopped", recover: true, attempts: report.tried });
      killWorker(err);
      throw err;
    }
    const failed = { ...loadNativeFailures(nativeFp), [a.backend]: String(e?.detail || e?.code || "generate").slice(0, 200) };
    saveNativeFailures(nativeFp, failed);
    report.tried.push({ id: a.id, code: e?.code || "generate", detail: e?.detail || e?.message });
    report.chosen = null;
    console.warn(`[IA] moteur natif ${a.backend} écarté après une erreur de génération :`, e?.detail || e);
    const err = new ModelError("generate", { detail: e?.detail || e?.message, recover: true, attempts: report.tried });
    killWorker(err);
    throw err;
  }
}

async function runGeneration(id, messages, opts, seconds) {
  try {
    return await sendGeneration(id, messages, opts, seconds);
  } catch (e) {
    // Erreur du moteur (pas un délai) sur le GPU : une session peut se créer puis échouer
    // à chaque réponse (banc : « Sub requires f16 »). La tentative est écartée sur cet
    // appareil, le worker arrêté ; `recover` dit à l'interface de recharger : l'échelle
    // passe d'elle-même à la tentative suivante (le processeur en dernier).
    const a = current;
    if (e?.code === "generate" && a) {
      const d = classifyFailure({ attempt: a, phase: "generate" });
      if (d.condemn) {
        const fingerprint = deviceFingerprint(probeCache ?? null);
        const failed = { ...loadFailures(fingerprint), [a.id]: String(e.detail || d.code).slice(0, 200) };
        saveFailures(fingerprint, failed);
        if (classifyFailure({ attempt: a, phase: "generate", failed }).purgeDtype) purgeCachedVariant(a.variant.dtype);
        report.tried.push({ id: a.id, code: d.code, detail: e.detail });
        report.chosen = null;
        console.warn(`[IA] tentative ${a.id} écartée après une erreur de génération :`, e.detail);
        const err = new ModelError("generate", { detail: e.detail, recover: true, attempts: report.tried });
        killWorker(err);
        throw err;
      }
    }
    throw e;
  }
}

const generateLimitMs = () => LIMITS.generateMs[current?.engine.device] ?? LIMITS.generateMs.webgpu;

function sendGeneration(id, messages, opts, seconds) {
  return withTimeout(
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({
        type: "generate",
        id,
        messages,
        tools: opts.tools,
        options: generationOptions(opts),
      });
    }),
    generateLimitMs(),
    "generate",
    () => killWorker(new ModelError("generate_timeout", { seconds })),
  );
}
