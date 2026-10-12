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

/**
 * SHA-256 de chaque fichier (champ lfs.oid de l'API /tree du Hub, révision ci-dessus ;
 * recalculés sur la copie de ~/.cache/vn-models : identiques).
 *
 * Pourquoi : transformers.js relit un fichier en cache dans un tampon de Content-Length
 * octets (readResponse) et laisse à ZÉRO, sans aucune erreur, ce que le corps ne fournit
 * pas. Un .onnx_data incomplet en cache donne donc un modèle qui se charge, passe l'essai
 * à vide, puis répond n'importe quoi. Mesuré (scripts/bench-chat/worker-node.mjs, vrai
 * worker, poids tronqués de 10 %) : essai à vide « C'est bien à vous ! » / « Oui, je
 * serais ravi » — accepté —, puis « Bonsoir » → « BTrama, bénédiction. Bonsei… ». C'est
 * la classe du « Bonne nuit » à tout relevé sur le téléphone en processeur q4.
 */
const FILE_SHA256 = Object.freeze({
  "onnx/model_q4f16.onnx": "3012c28a119828561c90196331435d91c43c1a6ab4898ac79715585fff1dff85",
  "onnx/model_q4f16.onnx_data": "9256ecd417b801b441d926ebe5ead4ebf50ac1a5a0f8f7914cf60d9d6452ef69",
  "onnx/model_q4.onnx": "d1a705712e93aafaba1346b32245fa59e7857a46e2272003c0e8c524977e0de8",
  "onnx/model_q4.onnx_data": "71ec6ad38a4c463dcb3dba671d06a1d9861be3a23e51290d818b95c0b7d2a5db",
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
    sha256: Object.freeze(Object.fromEntries(files.map((f) => [f, FILE_SHA256[f]]))),
  });
};

/**
 * Clé du cache qui atteste qu'un fichier en cache a été vérifié (taille et SHA-256) :
 * la vérification complète (294 Mo à hacher) n'est faite qu'une fois par fichier reçu.
 * L'empreinte est dans la clé : un autre fichier attendu n'est jamais pris pour vérifié.
 */
export const verifiedKey = (url, sha256) => `${url}?vh-verified=${sha256}`;

/**
 * Verdict sur un fichier relu en entier.
 * @param {{ bytes: number, sha256: string }} got ce qui a été lu
 * @param {{ bytes?: number, sha256?: string }} want ce qui est attendu
 * @returns {{ ok: boolean, reason: string }}
 */
export function integrityVerdict(got, want) {
  if (Number.isFinite(want?.bytes) && got.bytes !== want.bytes) return { ok: false, reason: `size ${got.bytes} != ${want.bytes}` };
  if (want?.sha256 && got.sha256 !== want.sha256) return { ok: false, reason: `sha256 ${String(got.sha256).slice(0, 12)}… != ${want.sha256.slice(0, 12)}…` };
  return { ok: true, reason: "ok" };
}

/** Variantes du modèle (255 Mo en q4f16, 294 Mo en q4). */
export const VARIANTS = Object.freeze({
  webgpu: variant("q4f16", "webgpu", "_q4f16"),
  // q4 sur le GPU : poids 4 bits, calcul en fp32 — n'exige pas shader-f16. Mesuré au banc
  // (scripts/bench-chat, Chrome) : là où q4f16 se charge puis échoue à CHAQUE génération
  // (« Sub requires f16 »), q4 sur WebGPU répond normalement (« Je suis Silex » compris).
  // Mêmes fichiers que la variante WASM.
  webgpuQ4: variant("q4", "webgpu", "_q4"),
  // q4 sur le processeur : q4f16 calcule en fp16, que le moteur processeur ne sait pas
  // faire ; q8 (model_quantized) pèserait 510 Mo. Ne démarre QU'AVEC le moteur « wasm »
  // (ENGINES) : celui qu'importe transformers.js n'a pas le noyau processeur
  // GatherBlockQuantized. Mesuré dans Chrome avec le bon moteur : 6/6 réponses.
  wasm:   variant("q4",    "wasm",   "_q4"),
});

/**
 * Modèles natifs (llama.cpp, src/ai/nativeModel.js) candidats, au format GGUF. Octets et
 * SHA-256 relevés sur l'API /tree du Hub (révision épinglée), vérifiés par le greffon
 * avant d'accepter le fichier, et par scripts/bench-native/fetch.mjs au banc.
 * `template` : famille du gabarit de conversation (chatTemplate.js) — le moteur natif ne
 * reçoit que du texte déjà mis en forme, le gabarit doit donc suivre le modèle.
 *
 * Défaut : LFM2.5-350M, publié par LiquidAI sous la même licence LFM 1.0 que l'export
 * ONNX. Q4_0 plutôt que QAD-Q4_0 (même taille), mesuré au banc scripts/bench-native le
 * 11/10 : réponses en français 10/10 contre 8/10, même vitesse. Les autres sont évalués
 * par scripts/bench-native/compare.mjs (docs/MODELES-NATIFS.md) ; Q4_0 est réempaqueté par
 * llama.cpp pour les cœurs ARM à produit scalaire (Snapdragon 888), Q4_K_M ne l'est pas
 * sans i8mm : sur le téléphone, Q4_0 est la quantification rapide.
 */
const gguf = (key, id, revision, file, dtype, bytes, sha256, template) =>
  Object.freeze({ key, id, revision, file, dtype, bytes, sha256, template, mb: Math.round(bytes / 1e6) });
export const NATIVE_CANDIDATES = Object.freeze(Object.fromEntries([
  gguf("lfm2.5-350m", "LiquidAI/LFM2.5-350M-GGUF", "657e078c94084481950a2d555a941481f715536b",
    "LFM2.5-350M-Q4_0.gguf", "q4_0", 219_309_792, "85e32858daafad55b7bcd6b97a1343ee0661188e8036f9862d14d6b563142f50", "lfm"),
  gguf("lfm2.5-1.2b", "LiquidAI/LFM2.5-1.2B-Instruct-GGUF", "8ed288026e23958ad9dfa92d53ed773a8eee7125",
    "LFM2.5-1.2B-Instruct-Q4_0.gguf", "q4_0", 695_751_488, "2ea801949d760cdf1a2cc04a54262c22c3c0c54f0769d57760c9adeb0e59233f", "lfm"),
  gguf("lfm2.5-1.2b-q4km", "LiquidAI/LFM2.5-1.2B-Instruct-GGUF", "8ed288026e23958ad9dfa92d53ed773a8eee7125",
    "LFM2.5-1.2B-Instruct-Q4_K_M.gguf", "q4_k_m", 730_895_168, "b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5", "lfm"),
  gguf("qwen2.5-0.5b", "Qwen/Qwen2.5-0.5B-Instruct-GGUF", "9217f5db79a29953eb74d5343926648285ec7e67",
    "qwen2.5-0.5b-instruct-q4_k_m.gguf", "q4_k_m", 491_400_032, "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db", "chatml"),
  gguf("qwen2.5-0.5b-q4_0", "Qwen/Qwen2.5-0.5B-Instruct-GGUF", "9217f5db79a29953eb74d5343926648285ec7e67",
    "qwen2.5-0.5b-instruct-q4_0.gguf", "q4_0", 428_730_208, "7671c0c304e6ce5a7fc577bcb12aba01e2c155cc2efd29b2213c95b18edaf6ed", "chatml"),
  gguf("qwen2.5-1.5b", "Qwen/Qwen2.5-1.5B-Instruct-GGUF", "91cad51170dc346986eccefdc2dd33a9da36ead9",
    "qwen2.5-1.5b-instruct-q4_k_m.gguf", "q4_k_m", 1_117_320_736, "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e", "chatml"),
  gguf("qwen2.5-1.5b-q4_0", "Qwen/Qwen2.5-1.5B-Instruct-GGUF", "91cad51170dc346986eccefdc2dd33a9da36ead9",
    "qwen2.5-1.5b-instruct-q4_0.gguf", "q4_0", 1_066_227_232, "dcd819ff094852c38faba6873d8ff0c9d51eadb2844539e52042ae5d647bbfdb", "chatml"),
  // Phi-3-mini : 2,39 Go de poids, et pas d'attention groupée (32 têtes clés-valeurs) — le
  // cache d'un contexte de 4 096 jetons pèse 1,5 Go de plus en fp16. Hors budget mémoire.
  gguf("phi-3-mini", "microsoft/Phi-3-mini-4k-instruct-gguf", "a64113399c2f6b8ad3e11c394733a2ddadaa7f33",
    "Phi-3-mini-4k-instruct-q4.gguf", "q4_k_m", 2_393_231_072, "8a83c7fb9049a9b2e92266fa7ad04933bb53aa1e85136b7b30f1b8000ff2edef", "phi3"),
  gguf("tinyllama-1.1b", "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF", "52e7645ba7c309695bec7ac98f4f005b139cf465",
    "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf", "q4_k_m", 668_788_096, "9fecc3b3cd76bba89d504f29b616eedf7da85b96540e490ca5824d3f7d2776a0", "zephyr"),
].map((m) => [m.key, m])));

/**
 * Candidat retenu, choisi À LA CONSTRUCTION (VITE_NATIVE_MODEL=<clé> npm run build) : une
 * APK d'évaluation n'exige aucune modification du code. Clé inconnue ou absente : le défaut.
 * @param {string|undefined} key
 */
export const nativeModelFor = (key) => NATIVE_CANDIDATES[key] || NATIVE_CANDIDATES["lfm2.5-350m"];
export const NATIVE_MODEL = nativeModelFor(import.meta.env?.VITE_NATIVE_MODEL);

/**
 * Moteurs natifs, dans l'ordre : le GPU (Vulkan), puis le processeur de llama.cpp, qui
 * reste bien plus rapide que le processeur WASM (docs/MODELE.md : 71 contre 1 490 ms par
 * jeton). Même fichier : passer de l'un à l'autre ne retélécharge rien.
 */
export const NATIVE_BACKENDS = Object.freeze(["vulkan", "cpu"]);
/** Identifiant de tentative (même forme que l'échelle : « quantification/moteur »). */
export const nativeAttemptId = (backend) => `${NATIVE_MODEL.dtype}/${backend === "cpu" ? "native_cpu" : backend}`;

/**
 * Moteurs natifs à tenter. `status` : réponse de LocalLlm.status() (null : pas de greffon,
 * navigateur). APK sans le moteur (« not-built ») ou appareil incompatible : rien à tenter,
 * et ce n'est pas une erreur — l'échelle WebGPU / processeur prend le relais.
 * @param {{ status: null|{supported: boolean, reason?: string}, failed?: Record<string,string> }} p
 * @returns {{ queue: string[], skipped: {backend: string, reason: string}[] }}
 */
export function planNative({ status, failed = {} }) {
  if (!status) return { queue: [], skipped: [] };
  if (!status.supported) return { queue: [], skipped: NATIVE_BACKENDS.map((backend) => ({ backend, reason: `unsupported: ${status.reason || "?"}` })) };
  const queue = [], skipped = [];
  for (const backend of NATIVE_BACKENDS) {
    if (isCondemned(failed[backend])) skipped.push({ backend, reason: `failed-before: ${failed[backend]}` });
    else queue.push(backend);
  }
  return { queue, skipped };
}

/**
 * Sous-étape du processus :llm (LocalLlm.stage) en une ligne courte : « load cpu: threads
 * 2/3 », suivie de « · muette 12 s » quand la trace n'a plus rien reçu depuis 5 s ou plus
 * (une étape figée se voit ainsi), ou « liaison au processus :llm » avant qu'il réponde.
 * Chaîne vide si rien n'est connu.
 * @param {{ stage?: string, idleMs?: number } | null | undefined} st
 */
export function nativeStepText(st) {
  if (!st?.stage) return "";
  if (st.stage === "bind") return "liaison au processus :llm";
  const quiet = Number(st.idleMs) >= 5_000 ? ` · muette ${Math.round(st.idleMs / 1000)} s` : "";
  return `${String(st.stage).slice(0, 120)}${quiet}`;
}

/** Empreinte des échecs natifs : un autre appareil, ou un autre fichier, les remet à zéro. */
export const nativeFingerprint = (status) => `${NATIVE_MODEL.file}|${status?.device || "?"}|${status?.soc || "?"}`;

/** Emplacement global où le worker pose le moteur choisi (lu par ortEngine.js). */
export const ENGINE_SLOT = Symbol.for("velohnav.ort-engine");

/**
 * Moteurs onnxruntime-web, un par build (chacun a son binaire WASM, embarqué dans l'APK) :
 *  - webgpu : l'EP WebGPU natif (build « asyncify », 26,9 Mo), celui qu'importe
 *    transformers.js. Son binaire n'a PAS de noyau processeur GatherBlockQuantized : il
 *    ne sait faire tourner ce modèle que sur le GPU ;
 *  - wasm : processeur seul (build « wasm », 14,3 Mo), noyaux GatherBlockQuantized présents.
 * Relevé dans les binaires d'onnxruntime-web 1.31 : GatherBlockQuantized<uint8, int64>
 * (indices int64 du modèle) existe dans ort-wasm-simd-threaded.wasm, pas dans
 * .asyncify.wasm.
 *
 * Le build « all » (EP WebGPU JSEP, binaire .jsep.wasm de 28,4 Mo) n'est PAS embarqué :
 * seconde implémentation WebGPU, jamais mesurée sur téléphone, elle portait l'APK
 * au-delà de 50 Mo (limite d'envoi Telegram). Un seul moteur par voie : GPU, processeur.
 */
export const ENGINES = Object.freeze({
  webgpu: Object.freeze({ id: "webgpu", module: "webgpu", device: "webgpu" }),
  wasm:   Object.freeze({ id: "wasm",   module: "wasm",   device: "wasm" }),
});

/** Variante correspondant à un couple appareil / quantification (q4f16 par défaut sur GPU). */
export function variantFor(device, dtype) {
  if (device === "webgpu") return dtype === "q4" ? VARIANTS.webgpuQ4 : VARIANTS.webgpu;
  return VARIANTS.wasm;
}

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
 * @param {{ f16?: boolean }} [opts] f16 : false pour évaluer la variante q4 (sans shader-f16)
 * @param {null | {
 *   adapter: boolean,
 *   isFallbackAdapter?: boolean,
 *   features?: string[],
 *   limits?: { maxBufferSize?: number, maxStorageBufferBindingSize?: number },
 *   device?: { ok: boolean, error?: string },
 * }} probe résumé de la sonde (null : pas de navigator.gpu)
 * @returns {{ ok: boolean, reason: string }}
 */
export function assessWebGPU(probe, { f16 = true } = {}) {
  if (!probe) return { ok: false, reason: "no-webgpu" };
  if (!probe.adapter) return { ok: false, reason: "no-adapter" };
  // Adaptateur logiciel (SwiftShader) : q4 y tourne, mais mesuré à ~200 s par réponse.
  if (probe.isFallbackAdapter) return { ok: false, reason: "software-adapter" };
  // `f16: false` : évaluation pour la variante q4 (calcul fp32), qui se passe de shader-f16.
  if (f16 && !(probe.features || []).includes("shader-f16")) return { ok: false, reason: "no-shader-f16" };
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

// ── Échelle des tentatives ──────────────────────────────────────
//
// Une tentative = une variante (fichiers, dtype) × un moteur onnxruntime. Ordre de
// préférence, du plus léger au plus sûr, établi au banc (docs/MODELE.md) :
//
//   q4f16 / EP WebGPU natif   255 Mo, le plus rapide quand le GPU calcule en fp16
//   q4    / EP WebGPU natif   294 Mo, calcul fp32 : n'exige pas shader-f16
//   q4    / GPU « sur »       mêmes fichiers, noyaux suspects évités (voir plus bas)
//   q4    / processeur        mêmes fichiers : le repli, qui ne demande rien au GPU
// Sur Adreno, les q4 GPU passent avant q4f16 (orderFor).
//
// q4 sert au GPU comme au processeur : passer d'une tentative à la suivante ne
// retélécharge jamais un fichier déjà en cache. Seul le passage q4f16 → q4 télécharge
// (294 Mo).
//
// fp16 (725 Mo, model_fp16) n'est PAS dans l'échelle : pic mémoire estimé 2,5 Go
// (MEMORY.peakFactor), hors de portée des téléphones visés (1,4 Go libres chez le
// propriétaire), et le décodage d'un petit modèle sur GPU mobile est borné par la
// bande passante mémoire : 2,8 fois plus de poids à lire par jeton.
//
// Réglages GPU (`gpu` de chaque tentative WebGPU), appliqués par le worker au device
// et à la session — voir gpuDeviceRequest et gpuSessionOptions :
//  - TOUJOURS sans « subgroups » : depuis onnxruntime-web 1.30, MatMulNBits (93 nœuds
//    sur ce modèle, tous les produits 4 bits) prend une voie subgroupShuffle sur tout
//    GPU non NVIDIA ayant cette fonction. Sur Adreno, elle rend des valeurs fausses
//    (Adreno 660, Chrome 154) ou fait planter le compilateur de shaders (Adreno 750,
//    Chrome 153/154) — relevé public, musetric#975 et #990 : sans subgroups, sortie
//    conforme au processeur. C'est le symptôme du téléphone du propriétaire (Adreno,
//    WebView 153) : q4f16 et q4 se chargent sur le GPU, puis « Bonjour » donne « 鹰 » et
//    « 龙 ». Prix connu : jusqu'à ~30 % sur ce noyau ; NVIDIA n'empruntait pas la voie.
//  - « sur » (repli GPU) : en plus, les Transpose du modèle (20, blocs conv) sur le
//    processeur et la disposition NCHW (aucune transposition insérée autour des Conv).
//    Le noyau Transpose à tuile partagée (tile_size + 1, présent dans ce build) perd une
//    partie de sa sortie sur Adreno 660/730 (musetric#975, onnxsim#1993). Coûte des
//    allers-retours GPU ↔ processeur par jeton : bien moins que le processeur seul.
const attempt = (variant, engine, mode = "") => Object.freeze({
  id: `${variant.dtype}/${engine.id}${mode ? `/${mode}` : ""}`, variant, engine,
  ...(engine.device === "webgpu" ? { gpu: Object.freeze({ mode: mode || "base" }) } : {}),
});
export const ATTEMPTS = Object.freeze([
  attempt(VARIANTS.webgpu, ENGINES.webgpu),
  attempt(VARIANTS.webgpuQ4, ENGINES.webgpu),
  attempt(VARIANTS.webgpuQ4, ENGINES.webgpu, "sur"),
  attempt(VARIANTS.wasm, ENGINES.wasm),
]);

/**
 * Transpose du graphe (blocs conv de LFM2.5, mêmes noms en q4 et q4f16), relevés dans
 * model_q4.onnx et model_q4f16.onnx à la révision épinglée.
 */
export const TRANSPOSE_NODES = Object.freeze([0, 1, 3, 4, 6, 7, 9, 11, 13, 15]
  .flatMap((l) => [`/model/layers.${l}/conv/Transpose_1`, `/model/layers.${l}/conv/Transpose_2`]));

// Limites demandées au device : celles qu'onnxruntime demande lui-même pour son device
// (au maximum de l'adaptateur), plus la taille des tampons.
const GPU_LIMITS = Object.freeze([
  "maxBufferSize", "maxStorageBufferBindingSize", "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupsPerDimension", "maxStorageBuffersPerShaderStage",
]);

/**
 * Demande de device WebGPU pour onnxruntime : toutes les fonctions de l'adaptateur SAUF
 * les subgroups (voir plus haut), limites au maximum.
 * @param {Iterable<string>} features adapter.features
 * @param {Record<string, number>} limits adapter.limits
 * @returns {{ requiredFeatures: string[], requiredLimits: Record<string, number>, dropped: string[] }}
 */
export function gpuDeviceRequest(features, limits) {
  const all = [...(features || [])];
  const requiredLimits = {};
  for (const k of GPU_LIMITS) if (Number.isFinite(limits?.[k])) requiredLimits[k] = limits[k];
  return {
    requiredFeatures: all.filter((f) => !/subgroup/i.test(f)),
    requiredLimits,
    dropped: all.filter((f) => /subgroup/i.test(f)),
  };
}

/**
 * Options du fournisseur WebGPU d'onnxruntime pour une tentative (device fourni par le
 * worker). q4f16 : accumulation des produits en fp32 — le fp16 des GPU mobiles perd les
 * petites valeurs (sous-normaux lus comme zéro sur Adreno 660/750, musetric#975).
 */
export function gpuSessionOptions(a, device) {
  const ep = { name: "webgpu", device };
  if (a.variant.dtype === "q4f16") ep.enableMatmulFp32Accumulation = true;
  if (a.gpu?.mode === "sur") {
    ep.preferredLayout = "NCHW";
    ep.forceCpuNodeNames = [...TRANSPOSE_NODES];
  }
  return { executionProviders: [ep] };
}
export const attemptById = (id) => ATTEMPTS.find((a) => a.id === id) || null;

/**
 * Version de l'échelle : un échec mémorisé ne vaut que pour la même échelle, le même
 * modèle et le même GPU. Changer de moteur ou d'export redonne sa chance à chacun.
 * Le retrait du moteur JSEP ne la change PAS : les tentatives restantes sont identiques,
 * et rejouer un échec q4f16 déjà constaté retéléchargerait 255 Mo pour rien. Les
 * échecs « …/jsep » mémorisés sont simplement ignorés (absents de ATTEMPTS).
 */
//
// 4 : device GPU sans subgroups et réglage « sur ». Les échecs GPU mémorisés l'avaient
// été AVEC subgroups (« 鹰 », « 龙 » sur le téléphone) : ils ne disent plus rien, chaque
// tentative GPU est rejouée une fois.
export const LADDER_VERSION = 4;

/**
 * Empreinte de l'appareil pour les échecs mémorisés : modèle, échelle, et GPU annoncé.
 * Un téléphone dont le pilote ou le navigateur change d'adaptateur repart de zéro.
 */
export function deviceFingerprint(probe) {
  const i = probe?.info || {};
  const gpu = probe?.adapter ? [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join("/") || "gpu" : "no-gpu";
  return `${MODEL.revision.slice(0, 8)}|${LADDER_VERSION}|${gpu}`;
}

/** GPU Qualcomm (Adreno), d'après ce qu'annonce l'adaptateur. */
export const isAdreno = (probe) => {
  const i = probe?.info || {};
  return /qualcomm|adreno/i.test(`${i.vendor} ${i.architecture} ${i.description}`);
};

/**
 * Ordre des tentatives selon le GPU. Sur Adreno, q4 (calcul 32 bits) passe AVANT q4f16 :
 * le fp16 y a des défauts relevés (sous-normaux à zéro, produits sous 2^-14 nuls :
 * musetric#975), et q4 est déjà en cache (il sert au processeur) — rien à télécharger
 * pour les deux premiers essais GPU (q4, puis q4 « sur ») ; q4f16 (255 Mo) ne se
 * télécharge que s'ils ont échoué tous deux.
 */
function orderFor(probe) {
  if (!isAdreno(probe)) return ATTEMPTS;
  const gpu = (a) => a.engine.device === "webgpu";
  return [
    ...ATTEMPTS.filter((a) => gpu(a) && a.variant.dtype !== "q4f16"),
    ...ATTEMPTS.filter((a) => gpu(a) && a.variant.dtype === "q4f16"),
    ...ATTEMPTS.filter((a) => !gpu(a)),
  ];
}

/**
 * Tentatives à essayer, dans l'ordre, sur cet appareil.
 * @param {{ probe: object|null, failed?: Record<string,string> }} s
 *   failed : tentatives déjà en échec ici (id → raison), voir failureRecord
 * @returns {{ queue: object[], skipped: {id:string, reason:string}[] }}
 *   skipped : ce qui n'est pas tenté, et pourquoi (journalisé et montré)
 */
export function planAttempts({ probe, failed = {} }) {
  const gpuF16 = assessWebGPU(probe);
  const gpuF32 = assessWebGPU(probe, { f16: false });
  const queue = [], skipped = [];
  for (const a of orderFor(probe)) {
    let why = null;
    if (isCondemned(failed[a.id])) why = `failed-before: ${failed[a.id]}`;
    else if (a.engine.device === "webgpu") {
      const v = a.variant.dtype === "q4f16" ? gpuF16 : gpuF32;
      if (!v.ok) why = v.reason;
    }
    if (why) skipped.push({ id: a.id, reason: why });
    else queue.push(a);
  }
  return { queue, skipped };
}

/**
 * Échec PASSAGER mémorisé : un délai dépassé au démarrage ne prouve rien contre le GPU.
 * Sur le téléphone, l'application passée en arrière-plan pendant la compilation des
 * nuanceurs suspend le GPU, pas le chien de garde : avant, ce délai condamnait le GPU
 * pour toujours sur l'appareil — même build, lancements suivants sur le processeur.
 * Un délai est noté « transient: … » et la tentative est rejouée au lancement suivant ;
 * c'est le SECOND délai d'affilée qui la condamne. Une réussite efface la note.
 */
export const TRANSIENT = "transient: ";
const isCondemned = (reason) => !!reason && !String(reason).startsWith(TRANSIENT);

/**
 * Échecs mémorisés, lus depuis le stockage. Ne vaut que pour la même empreinte.
 * Les anciennes clés (avant l'échelle) sont reprises pour ne pas retélécharger :
 * « f16 en échec » couvrait q4f16, dont les fichiers ont été purgés. L'ancien « GPU
 * condamné » n'est PAS repris : l'échec n'a jamais été lu (message tronqué à
 * l'écran), il a eu lieu avec un moteur processeur qui ne pouvait pas démarrer, et
 * retenter q4 sur le GPU ne télécharge rien (fichiers partagés avec le processeur).
 * @param {{ stored: string|null, legacyF16?: string|null, fingerprint: string }} s
 * @returns {Record<string,string>}
 */
export function failureRecord({ stored, legacyF16 = null, fingerprint }) {
  let rec = null;
  try { rec = stored ? JSON.parse(stored) : null; } catch { rec = null; }
  const failed = rec && rec.fingerprint === fingerprint && rec.failed && typeof rec.failed === "object" ? { ...rec.failed } : {};
  if (legacyF16) {
    for (const a of ATTEMPTS) if (a.variant.dtype === "q4f16" && !failed[a.id]) failed[a.id] = `legacy: ${String(legacyF16).slice(0, 120)}`;
  }
  return failed;
}

/**
 * Que faire après l'échec d'une tentative ?
 *  - réseau (setup, download) : on s'arrête, sans rien condamner — le même essai
 *    reprendra, fichiers déjà reçus compris ;
 *  - moteur (import du moteur, initialisation, essai à vide) : la tentative est
 *    condamnée sur cet appareil et la suivante part d'elle-même ; un premier DÉLAI au
 *    démarrage est seulement noté (`transient`, voir TRANSIENT), la suivante part aussi ;
 *  - génération : une erreur du moteur sur le GPU condamne la tentative (une session
 *    peut se créer puis échouer à chaque réponse, mesuré) ; un délai dépassé ne prouve
 *    rien et ne condamne pas ; sur le processeur, rien après lui : on ne condamne pas.
 * purge : dtype dont les fichiers ne serviront plus (toutes ses tentatives condamnées).
 * @param {{ attempt: object, phase: "setup"|"engine"|"download"|"integrity"|"init"|"generate", timedOut?: boolean,
 *           failed?: Record<string,string> }} f
 */
export function classifyFailure({ attempt: a, phase, timedOut = false, failed = {} }) {
  const sfx = timedOut ? "_timeout" : "";
  const none = { condemn: false, continue: false, purgeDtype: null };
  // integrity : un fichier en cache faux, retéléchargé, faux encore — le réseau ou le
  // stockage, pas le moteur. Rien de condamné, le prochain chargement revérifie.
  if (phase === "setup" || phase === "download" || phase === "integrity") return { ...none, code: `${phase}${sfx}` };
  if (phase === "generate" && (timedOut || a.engine.device !== "webgpu")) return { ...none, code: `generate${sfx}` };
  // Premier délai au démarrage : noté, pas condamné (TRANSIENT) ; la suivante part.
  if (timedOut && !String(failed[a.id] || "").startsWith(TRANSIENT)) {
    return { condemn: false, transient: true, continue: true, purgeDtype: null, code: `init${sfx}` };
  }
  const after = { ...failed, [a.id]: "x" };
  const dtypeDead = ATTEMPTS.filter((o) => o.variant.dtype === a.variant.dtype).every((o) => after[o.id]);
  // q4 sert aussi au processeur : jamais purgé
  const purgeDtype = dtypeDead && a.variant.dtype !== VARIANTS.wasm.dtype ? a.variant.dtype : null;
  return { condemn: true, continue: true, purgeDtype, code: `${phase === "generate" ? "generate" : "init"}${sfx}` };
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
    // Moteur natif : chargement du GGUF (mmap) + compilation des nuanceurs Vulkan + essai à
    // vide. 14,5 s mesurées au premier chargement Vulkan sur PC (cache de nuanceurs vide).
    native: 120_000,
  }),
  generateMs: Object.freeze({   // une réponse complète
    webgpu: 180_000,
    // Processeur, un seul fil (pas de SharedArrayBuffer dans la WebView) : chaque passe
    // coûte ~1,8 s mesurée dans Chrome sur un processeur de bureau, 41 à 115 s par
    // réponse courte, et une réponse de 96 jetons dépasse 180 s. Avec 180 s, la voie
    // processeur échouait sur toute réponse longue. Téléphone : plus lent, non mesuré.
    wasm: 600_000,
    // Natif : 96 jetons à 100 j/s (processeur de PC) prennent 1 s ; un téléphone, même dix
    // fois plus lent, reste loin de cette borne. Au-delà, le processus :llm est tué.
    native: 120_000,
  }),
  probeMs: 10_000,          // requestAdapter / requestDevice
  localCheckMs: 4_000,      // HEAD sur /models/… (copie embarquée)
  // Moteur natif : il passe AVANT la voie JavaScript, il ne doit donc jamais la faire
  // attendre sans fin. Au-delà de ces délais, repli vers WebGPU / processeur.
  // Greffon (import compris) et LocalLlm.status() — réponse immédiate côté Kotlin. 10 s : le
  // fil des greffons Capacitor, partagé, peut être occupé au démarrage à froid. (Les 5 s
  // dépassées sur le téléphone ne venaient pas du délai : voir nativeModel.wrapPlugin.)
  nativeStatusMs: 10_000,
  // Tous les moteurs natifs d'un chargement réunis : Vulkan figé (initMs.native) laisse
  // 30 s au processeur natif, puis la voie JavaScript part. Un essai raccourci par ce
  // budget ne compte jamais comme un échec définitif.
  nativeBudgetMs: 150_000,
  nativeUnloadMs: 5_000,    // arrêt du processus :llm après un échec
  // Relevé de la sous-étape du processus :llm pendant un chargement (LocalLlm.stage) : la
  // ligne d'état dit laquelle traîne, l'erreur « timeout » laquelle a figé.
  nativeStageMs: 2_000,
  // GGUF en arrière-plan (la voie JavaScript est déjà prête) : stallMs sans aucun octet,
  // ou cette durée au total, et il est arrêté ; le partiel est repris au lancement suivant.
  nativeDownloadMs: 1_800_000,
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
 * Essai à vide fait par le worker juste après le chargement (quelques jetons, glouton,
 * sans outils) : « prêt » n'est annoncé que si le modèle a réellement GÉNÉRÉ. Avant,
 * une session créée suffisait — et un GPU pouvait la créer puis échouer à chaque
 * réponse, ou produire du charabia (« 地黎 », relevé sur téléphone).
 * @param {unknown} text texte produit, jetons spéciaux retirés
 * @returns {{ ok: boolean, reason: string }}
 */
export function selfTestVerdict(text, { minWords = 1 } = {}) {
  if (typeof text !== "string") return { ok: false, reason: "no-output" };
  const s = text.trim();
  if (!/\p{L}{2,}/u.test(s)) return { ok: false, reason: "no-word" };
  // L'essai est en français : une lettre d'une autre écriture trahit un calcul faussé.
  if (/(?=\p{L})\P{Script=Latin}/u.test(s)) return { ok: false, reason: "script" };
  // Second tour : un mot isolé puis la fin (« weather », « Salte ») est la signature d'un
  // état faussé entre les tours, relevée sur le téléphone — pas une réponse.
  if ((s.match(/\p{L}{2,}/gu) || []).length < minWords) return { ok: false, reason: "one-word" };
  return { ok: true, reason: "ok" };
}

/**
 * Essai du second tour : sur le téléphone, la PREMIÈRE réponse du GPU était juste
 * (« Bonne nuit, cette question. ») et les suivantes réduites à un mot faux suivi de la
 * fin (« weather<|im_end|> »). Un essai d'un seul tour ne le voit pas : on rejoue un
 * second tour, qui reprend la réponse du premier, et on exige une phrase (3 mots).
 * @param {object[]} messages ceux du premier tour
 * @param {string} first réponse du premier tour
 * @returns {object[]} messages du second tour
 */
export const secondTurn = (messages, first) => [
  ...messages,
  { role: "assistant", content: first },
  { role: "user", content: SECOND_TURN.question },
];
export const SECOND_TURN = Object.freeze({
  question: "Je suis Silex. Peux-tu m'aider à trouver un vélo ?",
  minWords: 3,
});

/** Message de l'essai à vide (le worker et les tests s'en servent). */
export const SELF_TEST = Object.freeze({
  messages: Object.freeze([{ role: "user", content: "Bonjour" }]),
  maxNewTokens: 6,
  // Second tour : de quoi écrire trois mots, pas davantage (coût du chargement).
  secondMaxNewTokens: 8,
});

/**
 * Essai à vide du moteur natif : une vraie génération courte, en français, avec une
 * consigne. Sur téléphone, l'essai de 6 jetons sans consigne a rendu « 鹰 », « 龙 » sur
 * le GPU (WebGPU) : un calcul faussé. Ici le GPU doit produire une phrase française
 * plausible ; jugée par selfTestVerdict.
 */
export const NATIVE_SELF_TEST = Object.freeze({
  messages: Object.freeze([
    { role: "system", content: "Tu es l'assistant d'une application de vélo. Réponds en français, en une phrase." },
    { role: "user", content: "Bonjour" },
  ]),
  maxNewTokens: 16,
  secondMaxNewTokens: 16,
});

/** Vitesse de génération exigée du moteur natif sur le processeur (jetons/s). */
export const SPEED_TARGET_TPS = 20;

/**
 * Banc fixe : l'essai à vide du moteur natif, mêmes prompts à chaque chargement, mesuré.
 * `info` : réponse du chargement (loadMs, threads, cpus) ; `stats` : celles des deux tours
 * (genTokens, genMs, firstMs). Vitesse = jetons des deux tours / leur temps de génération
 * (consigne et premier calcul exclus : c'est le 1er jeton, compté à part).
 * @returns {{ loadMs: number|null, firstMs: number|null, tokens: number, tps: number|null,
 *   target: number, met: boolean, threads: number|null, cpus: string }}
 */
export function selfTestBench(info = {}, stats = []) {
  const ok = stats.filter((s) => Number.isFinite(s?.genTokens) && Number.isFinite(s?.genMs));
  const tokens = ok.reduce((n, s) => n + s.genTokens, 0);
  const ms = ok.reduce((n, s) => n + s.genMs, 0);
  const tps = tokens > 0 && ms > 0 ? Math.round((tokens / (ms / 1000)) * 10) / 10 : null;
  const first = stats[0]?.firstMs ?? stats[0]?.promptMs;
  return {
    loadMs: Number.isFinite(info.loadMs) ? Math.round(info.loadMs) : null,
    firstMs: Number.isFinite(first) ? Math.round(first) : null,
    tokens, tps, target: SPEED_TARGET_TPS, met: tps !== null && tps >= SPEED_TARGET_TPS,
    threads: Number.isFinite(info.threads) ? info.threads : null,
    cpus: String(info.cpus || ""),
  };
}

// ── Réponse figée d'un tour à l'autre ───────────────────────────
//
// Retour du téléphone : « Bonsoir » → « Bonne nuit », « Bonjour » → « Bonne nuit ». Un
// calcul faussé (poids incomplets, GPU qui calcule faux) peut produire une phrase
// française valide, qui passe l'essai à vide et tous les contrôles d'une réponse prise
// seule (assistant.checkFreeText). Seule la suite des tours la trahit : la MÊME réponse à
// des questions différentes.
export const REPEAT = Object.freeze({
  // Même réponse à N questions différentes d'affilée : la voie est jugée fausse.
  turns: 3,
  // Réponse courte (moins de `shortWords` mots) : deux fois suffisent. Une salutation
  // complète (« Bonjour ! Comment puis-je vous aider ? », 7 mots) peut légitimement revenir
  // à deux questions proches ; « Bonne nuit » ne répond à rien deux fois de suite.
  shortTurns: 2,
  shortWords: 4,
});

const normalize = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Le modèle répète-t-il une réponse figée ?
 * @param {{ q: string, a: string }[]} turns échanges de la voie en service, du plus ancien
 *   au plus récent, le dernier compris (texte libre montré seulement)
 * @returns {null | { reply: string, times: number }} null : rien d'anormal
 */
export function frozenReply(turns) {
  if (!turns?.length) return null;
  const last = normalize(turns.at(-1).a);
  if (!last) return null;
  const questions = new Set();
  let times = 0;
  for (let i = turns.length - 1; i >= 0 && normalize(turns[i].a) === last; i--) {
    times++;
    questions.add(normalize(turns[i].q));
  }
  // La même question reposée appelle la même réponse : seules les questions distinctes comptent.
  const distinct = questions.size;
  const words = last.split(" ").length;
  const need = words < REPEAT.shortWords ? REPEAT.shortTurns : REPEAT.turns;
  return distinct >= need ? { reply: turns.at(-1).a, times } : null;
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

// ── Le GPU mis de côté : le dire ────────────────────────────────
//
// Retour du téléphone : « prêt · q4 · processeur · calcul 32 bits », et rien sur la
// raison. L'échelle la connaît (tentative écartée d'avance par la sonde, échouée à ce
// chargement, ou mémorisée en échec d'un lancement précédent) : elle doit se lire à
// l'écran, sans quoi personne ne peut dire pourquoi le GPU ne sert pas.
const SKIP_KIND = Object.freeze({
  "no-webgpu": "no_webgpu", "no-adapter": "no_adapter", "software-adapter": "software", "no-shader-f16": "no_f16",
});

/**
 * Pourquoi aucune tentative GPU n'a été retenue.
 * @param {{ chosen: object|null, tried?: {id,code,detail}[], skipped?: {id,reason}[] }} report modelReport()
 * @returns {null | { reasons: { ids: string[], kind: string, detail: string }[], retry: boolean, downloadMB: number }}
 *   null : le GPU est retenu, ou rien n'est encore retenu. `kind` : no_webgpu, no_adapter,
 *   software, no_f16, limits, device, failed (à ce chargement), failed_before (lancement
 *   précédent). Raisons identiques regroupées. `retry` : un échec mémorisé ou constaté
 *   peut être rejoué (« Réessayer le GPU ») ; `downloadMB` : ce que ce nouvel essai
 *   téléchargerait (q4f16 n'est pas en cache s'il a été purgé ; q4 l'est, il sert au processeur).
 */
export function gpuSetAside(report) {
  if (!report?.chosen || report.chosen.device === "webgpu" || report.chosen.engine === "vulkan") return null;
  const reasons = [];
  let retry = false, downloadMB = 0;
  // Le GPU natif (Vulkan) d'abord : c'est la voie principale quand l'APK l'embarque.
  const nativeGpu = { id: nativeAttemptId("vulkan"), variant: { dtype: NATIVE_MODEL.dtype, mb: NATIVE_MODEL.mb } };
  for (const a of [nativeGpu, ...ATTEMPTS.filter((x) => x.engine.device === "webgpu")]) {
    const t = report.tried?.find((x) => x.id === a.id);
    const s = report.skipped?.find((x) => x.id === a.id);
    let kind, detail;
    if (t) { kind = "failed"; detail = t.detail || t.code; }
    else if (!s) continue;
    else if (s.reason.startsWith("failed-before")) { kind = "failed_before"; detail = s.reason.replace(/^failed-before:\s*/, ""); }
    else if (SKIP_KIND[s.reason]) { kind = SKIP_KIND[s.reason]; detail = ""; }
    else if (s.reason.startsWith("device")) { kind = "device"; detail = s.reason.replace(/^device:\s*/, ""); }
    else { kind = "limits"; detail = s.reason; }
    if (kind === "failed" || kind === "failed_before") {
      retry = true;
      if (a.variant.dtype !== report.chosen.dtype) downloadMB += a.variant.mb;
    }
    const same = reasons.find((r) => r.kind === kind && r.detail === detail);
    if (same) same.ids.push(a.id);
    else reasons.push({ ids: [a.id], kind, detail: String(detail).slice(0, 240) });
  }
  return { reasons, retry, downloadMB };
}

// ── Le moteur natif mis de côté : le dire ───────────────────────
/** Raisons d'un repli du natif vers la voie JavaScript (localModel.js, report.native). */
export const NATIVE_ASIDE_KINDS = Object.freeze(["absent", "unsupported", "failed", "failed_before", "timeout"]);

/**
 * Le moteur natif a-t-il été écarté au profit de la voie JavaScript, et pourquoi ?
 * @param {{ chosen: object|null, native?: {kind: string, detail: string}|null }} report modelReport()
 * @returns {null | { kind: string, detail: string }} null : natif retenu, ou jamais en jeu
 *   (navigateur, APK sans le moteur).
 */
export function nativeFallback(report) {
  if (!report?.native || report.chosen?.device === "native") return null;
  return { kind: report.native.kind, detail: report.native.detail || "" };
}
