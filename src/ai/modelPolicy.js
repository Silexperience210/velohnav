// Politique de chargement du modèle conversationnel : décisions PURES, testables sans
// navigateur. Le worker (modelWorker.js) et la façade (localModel.js) ne font
// qu'appliquer ce qui est décidé ici.
//
// Pourquoi ce module existe : sur un vrai téléphone, la progression atteignait 100 %
// puis se figeait. 100 % ne marque que la fin du TÉLÉCHARGEMENT ; viennent ensuite
// l'écriture en cache (1,17 Go), l'initialisation d'onnxruntime-web et la création de
// la session WebGPU — et aucune de ces étapes n'a de délai d'expiration, ni dans
// transformers.js (3.8.1), ni dans onnxruntime-web (env.wasm.initTimeout = 0 par
// défaut). Une attente GPU qui ne se résout jamais n'est pas une exception : seul un
// chien de garde la voit.

/** Variantes du modèle, tailles mesurées sur le dépôt HF (onnx/model_q4f16.onnx, onnx/model_q4.onnx). */
export const VARIANTS = Object.freeze({
  webgpu: Object.freeze({ dtype: "q4f16", device: "webgpu", mb: 1165 }),
  wasm:   Object.freeze({ dtype: "q4",    device: "wasm",   mb: 1704 }),
});

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
// 151 936 jetons × 1 536 dimensions en fp16. Déduit des tailles du dépôt : q4 (fp32)
// et q4f16 (fp16) diffèrent de 540 Mo, dont 467 Mo pour cette seule table. Sur WebGPU,
// onnxruntime la place dans UN tampon lié en stockage : l'appareil doit accepter un
// tampon et une liaison de cette taille. Beaucoup de GPU mobiles plafonnent à 128 ou
// 256 Mio ; onnxruntime ne lève alors pas d'exception (les erreurs de validation
// WebGPU partent dans `onuncapturederror`, simple console.error) — d'où le blocage.
export const LARGEST_TENSOR_BYTES = 151936 * 1536 * 2; // 466 747 392 o ≈ 445 Mio

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

// ── Délais ────────────────────────────────────────────────────────
// Le téléchargement n'a PAS de durée maximale (1,7 Go en 4G lente peut prendre une
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
      purgeDtype: VARIANTS.webgpu.dtype, // libère 1,17 Go devenu inutile sur cet appareil
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
