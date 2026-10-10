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
  memoryVerdict, heaviestVariant, LEGACY_MODEL_DIRS, selfTestVerdict,
  planAttempts, classifyFailure, deviceFingerprint, failureRecord,
} from "./modelPolicy.js";
import { readMemoryInfo } from "./deviceMemory.js";

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
/** Oublie les échecs mémorisés : « Réessayer » quand plus rien ne restait à tenter. */
export function forgetFailures() {
  try { store()?.removeItem?.(FAILED_KEY); } catch { /* mode privé */ }
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
// Tentatives du chargement en cours ou du dernier (modelReport).
let report = { tried: [], skipped: [], chosen: null };

/** Taille du modèle à annoncer : celle de la tentative retenue, sinon la variante processeur. */
export const chatModelMB = () => (current ? current.variant.mb : VARIANTS.wasm.mb);

/** Tentatives faites et leur issue, tentatives écartées d'avance et pourquoi, tentative retenue. */
export function modelReport() {
  return {
    tried: report.tried.map((x) => ({ ...x })),
    skipped: report.skipped.map((x) => ({ ...x })),
    chosen: report.chosen ? { ...report.chosen } : null,
    gpu: report.gpu ? { ...report.gpu } : null,
  };
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

/** Arrête le worker (libère la mémoire et tout ce qui y était bloqué). */
function killWorker(err) {
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
  else p.resolve(data.text);
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
        w.onmessage = onRuntimeMessage;
        w.onerror = (e) => killWorker(new ModelError("generate", { detail: e?.message || "worker error" }));
        ready = true;
        done(null, { attempt: att, loadMs: data.loadMs, gpu: data.gpu || null });
      } else if (data.type === "error") {
        // Échec à l'import du moteur : propre à la tentative, pas au réseau.
        const phase = data.stage === "engine" ? "engine" : st.phase;
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
 */
async function runLadder(onProgress, onPhase, gen) {
  const tried = [];
  report = { tried, skipped: [], chosen: null, gpu: null };
  let fingerprint = null, failed = {};
  const choose = (probe) => {
    if (probeCache === undefined) probeCache = probe ?? null;
    report.gpu = gpuSummary(probeCache);
    fingerprint = deviceFingerprint(probeCache);
    failed = loadFailures(fingerprint);
    const plan = planAttempts({ probe: probeCache, failed });
    // Ce qui vient d'échouer pendant CE chargement figure déjà dans `tried`
    report.skipped = plan.skipped.filter((x) => !tried.some((y) => y.id === x.id));
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
      if (d.condemn) {
        failed = { ...failed, [a.id]: String(e.detail || d.code).slice(0, 200) };
        saveFailures(fingerprint, failed);
      }
      if (d.purgeDtype) purgeCachedVariant(d.purgeDtype);
      if (!d.continue) throw new ModelError(d.code, { detail: e.detail, seconds: e.seconds, mb: a.variant.mb, attempts: tried });
      continue;
    }
    if (!r.attempt) {
      current = null;
      const lines = [...tried.map(attemptLine), ...report.skipped.filter((x) => x.reason.startsWith("failed-before")).map((x) => `${x.id} → ${x.reason}`)];
      console.warn("[IA] aucune tentative n'a abouti :", lines.join(" ; "));
      throw new ModelError("all_failed", { detail: lines.join(" ; "), attempts: tried });
    }
    report.chosen = {
      id: r.attempt.id, dtype: r.attempt.variant.dtype, device: r.attempt.engine.device,
      engine: r.attempt.engine.id, mb: r.attempt.variant.mb,
      ...(Number.isFinite(r.loadMs) ? { loadMs: r.loadMs } : {}),
      // Réglage GPU retenu et fonctions retirées du device (subgroups) : dit à l'écran et au journal
      ...(r.attempt.gpu ? { gpuMode: r.attempt.gpu.mode, dropped: r.gpu?.dropped || [] } : {}),
    };
    console.info(`[IA] retenu : ${r.attempt.id} (${r.attempt.variant.mb} Mo`
      + `${Number.isFinite(r.loadMs) ? `, prêt en ${(r.loadMs / 1000).toFixed(1)} s` : ""})`
      + `${r.gpu?.dropped?.length ? ` ; device sans ${r.gpu.dropped.join(", ")}` : ""}`
      + `${report.gpu ? ` ; GPU : ${gpuLine(report.gpu)}` : ""}`
      + `${tried.length ? ` ; avant lui : ${tried.map(attemptLine).join(" ; ")}` : ""}`);
    return;
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
  if (ready && worker) return Promise.resolve();
  if (loadPromise) return loadPromise;
  const gen = generation;
  loadPromise = checkMemory(heaviestVariant()).then(() => {
    // Désactivé pendant le contrôle mémoire : ne rien démarrer
    if (gen !== generation) throw new ModelError("cancelled");
    return runLadder(onProgress, onPhase, gen);
  }).finally(() => {
    loadPromise = null; // succès : `ready` prend le relais ; échec : retry possible
  });
  return loadPromise;
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

/**
 * Calcule à l'avance l'état du modèle sur la consigne système, pendant que l'utilisateur
 * tape (processeur seulement ; le worker l'ignore sur WebGPU). À rappeler quand la
 * consigne change (langue). Sans effet si le modèle n'est pas prêt ; jamais d'erreur :
 * au pire la première question calcule la consigne elle-même.
 * @param {string} system
 * @param {object[]} [tools] comme generate : schémas passés au gabarit
 */
export function warmUp(system, tools) {
  if (!ready || !worker || !system) return;
  worker.postMessage({ type: "warm", system, tools });
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
  const id = ++seq;
  const seconds = Math.round(generateLimitMs() / 1000);
  const full = await runGeneration(id, messages, opts, seconds);
  return { raw: String(full ?? ""), text: cleanReply(full) };
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
