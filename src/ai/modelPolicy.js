// Politique de chargement du modèle conversationnel : décisions PURES, testables sans
// navigateur. Le worker (modelWorker.js) et la façade (localModel.js) ne font
// qu'appliquer ce qui est décidé ici.
//
// Pourquoi ce module existe : sur un vrai téléphone, la progression atteignait 100 %
// puis se figeait. 100 % ne marque que la fin du TÉLÉCHARGEMENT ; viennent ensuite
// l'écriture en cache (1,17 Go pour le 1.5B d'alors), l'initialisation d'onnxruntime-web et la création de
// la session WebGPU — et aucune de ces étapes n'a de délai d'expiration, ni dans
// transformers.js (3.8.1), ni dans onnxruntime-web (env.wasm.initTimeout = 0 par
// défaut). Une attente GPU qui ne se résout jamais n'est pas une exception : seul un
// chien de garde la voit.

/**
 * Modèle conversationnel : Qwen2.5-0.5B-Instruct (et non plus 1.5B).
 *
 * Pourquoi : l'application MOURAIT au chargement (WebView tué par le système, puis
 * redémarrage). Tailles relevées sur le dépôt HF (API /tree, octets) :
 *   1.5B : q4f16 1 221,9 Mo · q4 1 787,6 Mo
 *   0.5B : q4f16   483,0 Mo · q8 (model_quantized) 512,1 Mo · q4 786,2 Mo
 * et le pic mémoire vaut environ 3 fois le fichier (estimatePeakBytes) : ≈ 3,7 Go
 * pour le 1.5B en GPU, ≈ 1,45 Go pour le 0.5B. Pour de la discussion libre — les
 * réponses factuelles sont calculées en code — le 0.5B suffit ; Qwen3-0.6B
 * (q4f16 569,8 Mo) a été écarté : plus lourd et un gabarit de « réflexion » à
 * neutraliser.
 */
export const MODEL = Object.freeze({
  id: "onnx-community/Qwen2.5-0.5B-Instruct",
  localDir: "Qwen2.5-0.5B-Instruct",       // copie embarquée éventuelle (scripts/fetch-model.sh)
});
/** Anciens modèles dont les fichiers en cache (1,2 à 1,8 Go de stockage) sont à purger. */
export const LEGACY_MODEL_DIRS = Object.freeze(["Qwen2.5-1.5B-Instruct"]);

/** Variantes du modèle, tailles mesurées sur le dépôt HF (Mo décimaux arrondis). */
export const VARIANTS = Object.freeze({
  webgpu: Object.freeze({ dtype: "q4f16", device: "webgpu", mb: 483, file: "onnx/model_q4f16.onnx" }),
  // q8 (int8) plutôt que q4 sur WASM : 512 Mo au lieu de 786, et meilleure qualité
  wasm:   Object.freeze({ dtype: "q8",    device: "wasm",   mb: 512, file: "onnx/model_quantized.onnx" }),
});

/** URL d'un fichier du modèle sur le Hub — c'est aussi la clé du cache de transformers.js. */
export function hubFileUrl(file, model = MODEL.id) {
  return `https://huggingface.co/${model}/resolve/main/${file}`;
}

/**
 * Choix de la quantification, décidé sur l'appareil.
 *
 * q4f16 n'est utilisable que sur WebGPU ; sans GPU exploitable, seule la variante q4
 * fonctionne (WASM). Le booléen doit venir de la SONDE (assessWebGPU), pas de la seule
 * présence d'un adaptateur : un adaptateur peut exister sans pouvoir porter le modèle.
 */
export function chooseVariant(webgpuUsable) {
  return webgpuUsable ? VARIANTS.webgpu : VARIANTS.wasm;
}

// Plus gros tenseur de la variante q4f16 : la table d'embeddings, NON quantifiée,
// 151 936 jetons × 896 dimensions (0.5B) en fp16. Déduit des tailles du dépôt : q4
// (fp32) et q4f16 (fp16) diffèrent de 303 Mo, dont 272 Mo pour cette seule table. Sur WebGPU,
// onnxruntime la place dans UN tampon lié en stockage : l'appareil doit accepter un
// tampon et une liaison de cette taille. Beaucoup de GPU mobiles plafonnent à 128 ou
// 256 Mio ; onnxruntime ne lève alors pas d'exception (les erreurs de validation
// WebGPU partent dans `onuncapturederror`, simple console.error) — d'où le blocage.
export const LARGEST_TENSOR_BYTES = 151936 * 896 * 2; // 272 269 312 o ≈ 260 Mio

/**
 * Le GPU peut-il réellement porter la variante q4f16 ?
 *
 * @param {null | {
 *   adapter: boolean,
 *   isFallbackAdapter?: boolean,
 *   features?: string[],
 *   limits?: { maxBufferSize?: number, maxStorageBufferBindingSize?: number },
 *   device?: { ok: boolean, error?: string },
 * }} probe résumé de la sonde (null : pas de navigator.gpu)
 * @returns {{ ok: boolean, reason: string }}
 */
export function assessWebGPU(probe) {
  if (!probe) return { ok: false, reason: "no-webgpu" };
  if (!probe.adapter) return { ok: false, reason: "no-adapter" };
  if (probe.isFallbackAdapter) return { ok: false, reason: "software-adapter" };
  if (!(probe.features || []).includes("shader-f16")) return { ok: false, reason: "no-shader-f16" };
  const lim = probe.limits || {};
  if (!((lim.maxBufferSize ?? 0) >= LARGEST_TENSOR_BYTES)) {
    return { ok: false, reason: `maxBufferSize ${mib(lim.maxBufferSize)} < ${mib(LARGEST_TENSOR_BYTES)}` };
  }
  if (!((lim.maxStorageBufferBindingSize ?? 0) >= LARGEST_TENSOR_BYTES)) {
    return {
      ok: false,
      reason: `maxStorageBufferBindingSize ${mib(lim.maxStorageBufferBindingSize)} < ${mib(LARGEST_TENSOR_BYTES)}`,
    };
  }
  // Les limites annoncées ne suffisent pas : on exige qu'un device ait réellement été
  // obtenu avec ces limites et shader-f16 (requestDevice peut refuser ou ne jamais répondre).
  if (!probe.device?.ok) return { ok: false, reason: `device: ${probe.device?.error || "refused"}` };
  return { ok: true, reason: "ok" };
}

const mib = (n) => (typeof n === "number" ? `${Math.round(n / 1048576)} MiB` : "?");

/**
 * Variante à charger. Un échec WebGPU déjà constaté sur cet appareil (mémorisé) force
 * WASM sans même sonder : on ne retente pas un chemin qui a déjà bloqué.
 * @param {{ webgpuKnownBroken: boolean, assessment: {ok:boolean, reason:string} | null }} s
 */
export function planLoad({ webgpuKnownBroken, assessment }) {
  if (webgpuKnownBroken) return { variant: VARIANTS.wasm, reason: "webgpu-failed-before" };
  if (assessment?.ok) return { variant: VARIANTS.webgpu, reason: "webgpu-ok" };
  return { variant: VARIANTS.wasm, reason: assessment?.reason || "no-probe" };
}

// ── Mémoire : refuser proprement plutôt que faire tuer l'application ─────────
//
// Copies simultanées pendant le chargement (lecture de transformers.js 3.8.1 et
// onnxruntime-web) :
//   1. le fichier entier lu en JS (Uint8Array, readResponse / arrayBuffer) ;
//   2. sa copie dans le tas WASM d'onnxruntime (InferenceSession.create(buffer)) —
//      un tas WASM ne rétrécit jamais ;
//   3. les poids de travail : tas WASM (CPU) ou tampons GPU (mémoire unifiée sur
//      téléphone, donc la même RAM).
// Premier téléchargement : transformers.js garde EN PLUS une copie pour cache.put
// (new Response(buffer)) — 4 copies. Le worker pré-remplit désormais le cache en
// flux (prefetch, sans copie JS), ce qui ramène le premier lancement à 3.
// Facteur 3 = estimation, À MESURER sur l'appareil (chrome://inspect → mémoire).
export const MEMORY = Object.freeze({
  peakFactor: 3,
  marginBytes: 300 * 2 ** 20,   // le reste de l'application (carte, caméra, JS)
});

export const estimatePeakBytes = (variant) => Math.round(variant.mb * 1e6 * MEMORY.peakFactor + MEMORY.marginBytes);

/**
 * Peut-on charger `variant` sans risquer la mort du processus ?
 * @param {null | {
 *   availBytes?: number, totalBytes?: number, thresholdBytes?: number, lowMemory?: boolean,  // Android (ActivityManager.MemoryInfo)
 *   deviceMemoryGB?: number,                                                                   // navigateur (navigator.deviceMemory, arrondi, plafonné à 8)
 * }} info
 * @returns {{ ok: boolean, reason: string, needMB: number, availMB: number|null }}
 */
export function memoryVerdict(info, variant) {
  const need = estimatePeakBytes(variant);
  const needMB = Math.round(need / 1e6);
  if (!info) return { ok: true, reason: "unknown", needMB, availMB: null };
  if (info.lowMemory) {
    return { ok: false, reason: "low-memory", needMB, availMB: info.availBytes ? Math.round(info.availBytes / 1e6) : null };
  }
  if (Number.isFinite(info.availBytes)) {
    // Sous le seuil système, Android commence à tuer des processus : il ne compte pas.
    const usable = info.availBytes - (Number.isFinite(info.thresholdBytes) ? info.thresholdBytes : 0);
    const availMB = Math.round(usable / 1e6);
    return usable >= need ? { ok: true, reason: "ok", needMB, availMB } : { ok: false, reason: "insufficient", needMB, availMB };
  }
  if (Number.isFinite(info.deviceMemoryGB)) {
    // Seule la RAM totale est connue : on exige qu'elle fasse au moins deux fois le pic.
    const total = info.deviceMemoryGB * 2 ** 30;
    const availMB = Math.round(total / 2 / 1e6);
    return total >= 2 * need ? { ok: true, reason: "ok-total", needMB, availMB } : { ok: false, reason: "small-device", needMB, availMB };
  }
  return { ok: true, reason: "unknown", needMB, availMB: null };
}

/** Variante la plus exigeante en mémoire : le contrôle préalable vaut pour les deux. */
export const heaviestVariant = () => (VARIANTS.wasm.mb >= VARIANTS.webgpu.mb ? VARIANTS.wasm : VARIANTS.webgpu);

// ── Délais ────────────────────────────────────────────────────────
// Le téléchargement n'a PAS de durée maximale (un modèle de plusieurs centaines de Mo en 4G lente peut prendre une
// demi-heure) : on surveille l'absence de données. L'initialisation, elle, est bornée.
export const LIMITS = Object.freeze({
  setupMs: 60_000,          // worker + sonde GPU + premier octet
  stallMs: 90_000,          // téléchargement sans aucun octet reçu
  initMs: Object.freeze({   // de 100 % à « prêt » : cache + moteur + session
    webgpu: 180_000,
    wasm: 300_000,
  }),
  generateMs: 180_000,      // une réponse complète
  probeMs: 10_000,          // requestAdapter / requestDevice
  localCheckMs: 4_000,      // HEAD sur /models/… (copie embarquée)
});

/**
 * Chien de garde. Rend null si tout va bien, sinon la raison de l'abandon.
 * @param {{ phase: "setup"|"download"|"init", since: number, lastActivity: number, device: "webgpu"|"wasm" }} s
 * @param {number} now
 */
export function watchdog(s, now, limits = LIMITS) {
  if (s.phase === "setup" && now - s.since > limits.setupMs) {
    return { phase: "setup", timedOut: true, seconds: Math.round(limits.setupMs / 1000) };
  }
  if (s.phase === "download" && now - s.lastActivity > limits.stallMs) {
    return { phase: "download", timedOut: true, seconds: Math.round(limits.stallMs / 1000) };
  }
  if (s.phase === "init") {
    const max = limits.initMs[s.device] ?? limits.initMs.wasm;
    if (now - s.since > max) return { phase: "init", timedOut: true, seconds: Math.round(max / 1000) };
  }
  return null;
}

/**
 * Suivi de progression. Les événements viennent du progress_callback de transformers.js
 * ({status, file, loaded, total}). La phase passe à « init » dès que le fichier .onnx
 * atteint 100 % : ce qui suit (écriture en cache, moteur, session) n'émet plus aucun
 * événement et relève du délai d'initialisation, pas de la détection de coupure réseau.
 */
export function initialProgress(now) {
  return { phase: "setup", since: now, lastActivity: now, files: {}, pct: 0 };
}

export function progressReducer(state, ev, now) {
  if (!ev || state.phase === "init") return state;
  const file = ev.file || "";
  const isModel = /\.onnx(_data)?$/.test(file);
  let files = state.files;
  if (ev.status === "progress" && typeof ev.loaded === "number") {
    files = { ...files, [file]: { loaded: ev.loaded, total: ev.total || 0 } };
  }
  const known = Object.values(files).filter((f) => f.total > 0);
  const total = known.reduce((a, f) => a + f.total, 0);
  const loaded = known.reduce((a, f) => a + Math.min(f.loaded, f.total), 0);
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : state.pct;
  const modelFinished =
    isModel && (ev.status === "done" || (ev.status === "progress" && ev.total > 0 && ev.loaded >= ev.total));
  if (modelFinished) return { ...state, files, pct: 100, phase: "init", since: now, lastActivity: now };
  // Tout événement du hub (initiate, download, progress, done) prouve que le réseau
  // répond : on quitte « setup » pour la surveillance de coupure.
  return { ...state, files, pct, phase: "download", lastActivity: now };
}

/**
 * Que faire après un échec ? Aucune décision ne relance AUTOMATIQUEMENT un second
 * téléchargement complet : le repli vers WASM après un échec WebGPU (le fichier q4f16
 * est déjà téléchargé) est annoncé à l'utilisateur, avec la taille, et n'a lieu que
 * s'il appuie sur « Réessayer ». Seule la sonde, AVANT tout téléchargement, bascule
 * d'elle-même vers WASM.
 * @param {{ device: "webgpu"|"wasm", phase: "setup"|"download"|"init"|"generate", timedOut?: boolean }} f
 */
export function decideAfterFailure({ device, phase, timedOut = false }) {
  const sfx = timedOut ? "_timeout" : "";
  if (phase === "init" && device === "webgpu") {
    return {
      code: `webgpu_init${sfx}`,
      markWebGPUBroken: true,
      purgeDtype: VARIANTS.webgpu.dtype, // libère le fichier GPU devenu inutile sur cet appareil
      next: VARIANTS.wasm,
      autoRetry: false,
    };
  }
  if (phase === "init") return { code: `wasm_init${sfx}`, markWebGPUBroken: false, purgeDtype: null, next: VARIANTS.wasm, autoRetry: false };
  if (phase === "download") return { code: `download${sfx}`, markWebGPUBroken: false, purgeDtype: null, next: VARIANTS[device], autoRetry: false };
  if (phase === "generate") return { code: `generate${sfx}`, markWebGPUBroken: false, purgeDtype: null, next: VARIANTS[device], autoRetry: false };
  return { code: `setup${sfx}`, markWebGPUBroken: false, purgeDtype: null, next: VARIANTS[device] || VARIANTS.wasm, autoRetry: false };
}

/**
 * Borne une promesse dans le temps. À l'expiration, rejette avec une erreur portant
 * `timedOut: true` ; `onTimeout` permet de libérer la ressource bloquée.
 */
export function withTimeout(promise, ms, label = "operation", onTimeout) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* la libération ne doit pas masquer l'expiration */ }
      const e = new Error(`${label}: no answer after ${Math.round(ms / 1000)} s`);
      e.timedOut = true;
      reject(e);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer));
}
