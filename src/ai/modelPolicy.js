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
 * Modèle conversationnel : LFM2.5-350M (Liquid AI), et non plus Qwen2.5-0.5B.
 *
 * Pourquoi (mesures et banc dans docs/MODELE.md) : à runtime identique, pic de mémoire
 * résidente 821 Mo contre 2 934 (−72 %), fichier WebGPU 255 Mo contre 483, et un
 * modèle entraîné à l'appel d'outils (6/12 au banc contre 5/12). Il exige
 * @huggingface/transformers v4 : son export ONNX (GatherBlockQuantized « bits ») ne se
 * charge pas en 3.x.
 *
 * Tailles relevées sur le dépôt HF (API /tree, octets, révision 7dd49995) :
 *   q4f16 : model_q4f16.onnx 182 827 + model_q4f16.onnx_data 254 965 760 = 255,1 Mo
 *   q4    : model_q4.onnx    183 442 + model_q4.onnx_data    293 629 952 = 293,8 Mo
 * Les poids sont dans un fichier séparé (.onnx_data, config « use_external_data_format ») :
 * chaque variante compte DEUX fichiers, et c'est le second qui pèse.
 */
export const MODEL = Object.freeze({
  id: "onnx-community/LFM2.5-350M-ONNX",
  // Révision ÉPINGLÉE (celle mesurée) : « main » peut changer sous nos pieds — autres
  // tailles, autre export — sans que l'application le sache.
  revision: "7dd4999565b0342c381ba90a3d8fc467d6df19c4",
  localDir: "LFM2.5-350M-ONNX",            // copie embarquée éventuelle (scripts/fetch-model.sh)
});
/**
 * Anciens modèles dont les fichiers en cache sont à purger : ils ne servent plus et
 * occupent jusqu'à 1,8 Go (1.5B) et 1 Go (0.5B, q4f16 + q8) de stockage.
 */
export const LEGACY_MODEL_DIRS = Object.freeze(["Qwen2.5-1.5B-Instruct", "Qwen2.5-0.5B-Instruct"]);

// Octets exacts de chaque fichier (API /tree du Hub, révision ci-dessus).
const FILE_BYTES = Object.freeze({
  "onnx/model_q4f16.onnx": 182_827,
  "onnx/model_q4f16.onnx_data": 254_965_760,
  "onnx/model_q4.onnx": 183_442,
  "onnx/model_q4.onnx_data": 293_629_952,
});

const variant = (dtype, device, suffix) => {
  const files = [`onnx/model${suffix}.onnx`, `onnx/model${suffix}.onnx_data`];
  const bytes = Object.freeze(Object.fromEntries(files.map((f) => [f, FILE_BYTES[f]])));
  return Object.freeze({
    dtype, device,
    // Taille annoncée à l'utilisateur, en Mo décimaux : déduite des octets, jamais recopiée.
    mb: Math.round(files.reduce((a, f) => a + bytes[f], 0) / 1e6),
    file: files[0],
    // Tous les fichiers de poids, le graphe d'abord : le dernier est le gros.
    files: Object.freeze(files),
    bytes,
  });
};

/** Variantes du modèle (255 Mo en q4f16, 294 Mo en q4). */
export const VARIANTS = Object.freeze({
  webgpu: variant("q4f16", "webgpu", "_q4f16"),
  // q4 sur WASM : q4f16 calcule en fp16, que le moteur processeur ne sait pas faire ;
  // q8 (model_quantized) pèserait 510 Mo.
  wasm:   variant("q4",    "wasm",   "_q4"),
});

/** URL d'un fichier du modèle sur le Hub — c'est aussi la clé du cache de transformers.js. */
export function hubFileUrl(file, model = MODEL.id, revision = MODEL.revision) {
  return `https://huggingface.co/${model}/resolve/${encodeURIComponent(revision)}/${file}`;
}

/**
 * En-têtes à stocker avec un fichier pré-chargé en cache : Content-Length FORCÉ à la
 * taille connue quand le réseau ne l'a pas donné (ou que CORS l'a masqué).
 *
 * Pourquoi : à la relecture, transformers.js (readResponse) pré-alloue un tampon de
 * Content-Length octets. Sans cet en-tête, il part d'un tampon vide et le RÉALLOUE à
 * chaque morceau reçu, en recopiant tout : deux copies du fichier coexistent à chaque
 * étape et le coût de copie devient quadratique (des centaines de Go recopiés pour
 * 255 Mo lus par morceaux de 64 Ko).
 * @param {Headers|Record<string,string>|null} headers en-têtes de la réponse réseau
 * @param {number|undefined} bytes taille attendue
 */
export function cacheHeaders(headers, bytes) {
  const h = new Headers(headers || {});
  if (!(Number(h.get("content-length")) > 0) && Number.isFinite(bytes) && bytes > 0) {
    h.set("content-length", String(bytes));
  }
  return h;
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

// Plus gros tenseur de la variante q4f16 : la table d'embeddings quantifiée en 4 bits,
// 65 536 jetons × 1 024 dimensions / 2 = 32 Mio (deux copies de cette taille, l'une pour
// la recherche d'embeddings, l'autre pour la tête de sortie liée). Relevé en lisant les
// initialiseurs du graphe model_q4f16.onnx (champ « length » des données externes).
// Sur WebGPU, onnxruntime place chaque tenseur dans UN tampon lié en stockage :
// l'appareil doit accepter un tampon et une liaison de cette taille. Les GPU mobiles
// plafonnent souvent à 128 ou 256 Mio — limite qui recalait Qwen (260 Mio d'embeddings
// fp16) et que LFM2.5 respecte. onnxruntime ne lève pas d'exception en cas de
// dépassement (les erreurs de validation WebGPU partent dans `onuncapturederror`,
// simple console.error) : d'où l'intérêt de le vérifier avant.
export const LARGEST_TENSOR_BYTES = 65536 * 512; // 33 554 432 o = 32 Mio

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
// Copies simultanées du fichier de poids pendant le chargement (lecture de
// transformers.js 4.3.1 et onnxruntime-web 1.31) :
//   1. le .onnx_data entier lu en JS (Uint8Array, readResponse) — inévitable : c'est
//      la forme sous laquelle transformers.js le passe à onnxruntime (externalData) ;
//   2. sa destination : le tas WASM d'onnxruntime (CPU) — un tas WASM ne rétrécit
//      jamais — ou les tampons GPU (WebGPU ; mémoire unifiée sur téléphone, donc la
//      même RAM). onnxruntime démonte (unmountExternalData) la copie 1 après la
//      création de session ; elle part au ramasse-miettes suivant ;
//   3. en CPU, les poids réarrangés (prepack) par certains opérateurs.
// Copies supprimées : celle de cache.put au premier téléchargement (pré-chargement en
// flux, modelWorker.prefetchToCache) et les réallocations de readResponse sans
// Content-Length (cacheHeaders).
// Facteur 3 : cohérent avec la mesure Node/CPU de docs/MODELE.md (pic RSS 821 Mo pour
// 294 Mo de q4, soit 2,8 fois, runtime Node compris). Pas mesuré sur téléphone.
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
 * ({status, file, loaded, total}). La phase passe à « init » quand les fichiers de poids
 * attendus (`expect`, ceux de la variante) sont tous à 100 % : ce qui suit (écriture en
 * cache, moteur, session) n'émet plus aucun événement et relève du délai
 * d'initialisation, pas de la détection de coupure réseau.
 *
 * Pourquoi `expect` : les poids de LFM2.5 sont dans un .onnx_data séparé. Le graphe
 * (183 Ko) arrive à 100 % bien avant les 255 Mo de poids ; sans cette liste, le délai
 * d'initialisation partait en plein téléchargement et l'interrompait sur réseau lent.
 * Sans liste (variante pas encore choisie), le premier fichier .onnx(_data) terminé fait foi.
 */
export function initialProgress(now, expect = null) {
  return { phase: "setup", since: now, lastActivity: now, files: {}, finished: [], expect, pct: 0 };
}

const baseName = (f) => String(f || "").replace(/^.*\//, "");

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
  let pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : state.pct;
  const fileFinished =
    isModel && (ev.status === "done" || (ev.status === "progress" && ev.total > 0 && ev.loaded >= ev.total));
  const finished = fileFinished && !state.finished.includes(baseName(file))
    ? [...state.finished, baseName(file)] : state.finished;
  const allFinished = state.expect?.length
    ? state.expect.every((f) => finished.includes(baseName(f)))
    : fileFinished;
  if (allFinished) return { ...state, files, finished, pct: 100, phase: "init", since: now, lastActivity: now };
  // Le graphe seul est à 100 % : on n'annonce pas 100 % tant que les poids manquent.
  if (pct >= 100 && state.expect?.length) pct = 99;
  // Tout événement du hub (initiate, download, progress, done) prouve que le réseau
  // répond : on quitte « setup » pour la surveillance de coupure.
  return { ...state, files, finished, pct, phase: "download", lastActivity: now };
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
