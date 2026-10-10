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

/**
 * Réglages du GPU, une même variante pouvant échouer avec l'un et réussir avec l'autre.
 *
 * Retour du téléphone : les DEUX variantes GPU se chargeaient, puis l'essai à vide rendait
 * du charabia (« 臟 » en q4f16, « � » en q4). Ce n'était donc ni le fp16 (q4 calcule en
 * fp32) ni le chargement : le GPU calculait faux. Ce qui distingue ce téléphone des
 * machines où le même modèle répond (Dawn natif, Chrome de bureau) :
 *  - onnxruntime demande à l'adaptateur TOUTES les fonctions qu'il offre, dont
 *    `subgroups` et `subgroup-size-control` (webgpu_context.cc, GetAvailableRequiredFeatures) ;
 *  - avec `subgroups`, le noyau MatMulNBits de remplissage (WideTile, prompt de plus de
 *    quelques jetons) réduit ses résultats par subgroupShuffle en bandes de
 *    `adapterInfo.subgroupMinSize` (matmul_nbits.cc). Les GPU mobiles ont des tailles de
 *    subgroup variables (Mali ~16, Adreno 64/128), terrain des pilotes fragiles ;
 *  - sans `subgroups`, le même noyau fait une réduction directe.
 * Lu dans le graphe : les 93 MatMulNBits du modèle n'ont pas d'accuracy_level, le chemin
 * DP4A (int8) n'est donc jamais pris — il n'est pas en cause.
 *
 *  - native : onnxruntime crée le device lui-même (le plus rapide quand le pilote suit) ;
 *  - compat : le worker crée le device SANS subgroups (shader-f16 seulement, et seulement
 *    pour q4f16) et le passe à onnxruntime (option `device` de l'EP WebGPU, qui lit alors
 *    les fonctions de CE device) ; accumulation fp32 des produits matriciels en q4f16.
 * L'id d'une tentative native est inchangé (« q4f16/webgpu ») : les échecs déjà
 * mémorisés sur un téléphone restent valables et ne sont pas rejoués.
 */
export const GPU_PROFILES = Object.freeze({
  native: Object.freeze({ id: "native", suffix: "", custom: false }),
  compat: Object.freeze({ id: "compat", suffix: "-compat", custom: true, subgroups: false, f32acc: true }),
});

/**
 * Fonctions à demander pour un device « compat » : jamais de subgroups, shader-f16 seulement
 * si la variante calcule en fp16 (q4f16 ne tourne pas sans).
 * @param {string} dtype @param {Iterable<string>} adapterFeatures
 */
export function compatFeatures(dtype, adapterFeatures) {
  return dtype === "q4f16" && [...(adapterFeatures || [])].includes("shader-f16") ? ["shader-f16"] : [];
}

/**
 * Limites à demander pour un device « compat » : celles de l'adaptateur, toutes (onnxruntime
 * en a besoin de plusieurs — tampons, stockage partagé, taille des groupes). Un device créé
 * avec les limites par défaut (128 Mio de tampon, 16 Kio partagés) ferait échouer des noyaux.
 * Seules les valeurs numériques sont reprises.
 * @param {object} limits GPUSupportedLimits (attributs sur le prototype : for…in les voit)
 */
export function compatLimits(limits) {
  const out = {};
  if (!limits) return out;
  for (const k in limits) {
    const v = limits[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

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
// Une tentative = une variante (fichiers, dtype) × un moteur onnxruntime × un réglage du
// GPU (GPU_PROFILES). Ordre de préférence, du plus rapide au plus sûr, établi au banc
// (docs/MODELE.md) :
//
//   q4f16 / GPU natif          255 Mo, le plus rapide quand le GPU calcule en fp16
//   q4f16 / GPU compatible     mêmes fichiers, device sans subgroups, accumulation fp32
//   q4    / GPU natif          294 Mo, calcul fp32 : n'exige pas shader-f16
//   q4    / GPU compatible     mêmes fichiers, device sans subgroups
//   q4    / processeur         mêmes fichiers : le repli, qui ne demande rien au GPU
//
// q4 sert au GPU comme au processeur : passer d'une tentative à la suivante ne
// retélécharge jamais un fichier déjà en cache. Seul q4f16 peut coûter un téléchargement
// que le processeur n'aurait pas exigé (255 Mo) : planAttempts ne le lance de lui-même
// qu'au premier chargement (voir là).
//
// fp16 (725 Mo, model_fp16) n'est PAS dans l'échelle : pic mémoire estimé 2,5 Go
// (MEMORY.peakFactor), hors de portée des téléphones visés (1,4 Go libres chez le
// propriétaire), et le décodage d'un petit modèle sur GPU mobile est borné par la
// bande passante mémoire : 2,8 fois plus de poids à lire par jeton.
const attempt = (variant, engine, profile = null) => Object.freeze({
  id: `${variant.dtype}/${engine.id}${profile?.suffix ?? ""}`, variant, engine, profile,
});
export const ATTEMPTS = Object.freeze([
  attempt(VARIANTS.webgpu, ENGINES.webgpu, GPU_PROFILES.native),
  attempt(VARIANTS.webgpu, ENGINES.webgpu, GPU_PROFILES.compat),
  attempt(VARIANTS.webgpuQ4, ENGINES.webgpu, GPU_PROFILES.native),
  attempt(VARIANTS.webgpuQ4, ENGINES.webgpu, GPU_PROFILES.compat),
  attempt(VARIANTS.wasm, ENGINES.wasm),
]);
export const attemptById = (id) => ATTEMPTS.find((a) => a.id === id) || null;

/**
 * Version de l'échelle : un échec mémorisé ne vaut que pour la même échelle, le même
 * modèle et le même GPU. Changer de moteur ou d'export redonne sa chance à chacun.
 * Le retrait du moteur JSEP ne la change PAS : les tentatives restantes sont identiques,
 * et rejouer un échec q4f16 déjà constaté retéléchargerait 255 Mo pour rien. Les
 * échecs « …/jsep » mémorisés sont simplement ignorés (absents de ATTEMPTS).
 * L'ajout des tentatives « compat » ne la change pas non plus : les tentatives natives
 * gardent leur id, leurs échecs restent vrais ; les nouvelles n'ont encore rien d'écrit.
 */
export const LADDER_VERSION = 3;

/**
 * Version d'onnxruntime-web embarquée (vite.config.js, lue dans node_modules au build).
 * Un échec GPU dépend du moteur : un nouveau moteur redonne sa chance à chaque tentative.
 */
// eslint-disable-next-line no-undef
export const ORT_WEB_VERSION = typeof __ORT_WEB_VERSION__ === "string" ? __ORT_WEB_VERSION__ : "unknown";

/**
 * Contexte d'exécution d'un échec : moteur onnxruntime et version majeure du navigateur
 * (la WebView du système, mise à jour à part de l'application). Un échec ne vaut que dans
 * le contexte où il a été constaté : après la mise à jour de l'un ou de l'autre (pilotes
 * WebGPU de Chrome, noyaux d'onnxruntime), les tentatives sont rejouées d'elles-mêmes —
 * sans téléchargement imposé (planAttempts).
 * @param {string} [ua] navigator.userAgent
 */
export function runtimeContext(ua = globalThis.navigator?.userAgent || "") {
  const b = /(Chrome|Firefox)\/(\d+)/.exec(ua);
  return `ort ${ORT_WEB_VERSION} · ${b ? `${b[1].toLowerCase()} ${b[2]}` : "?"}`;
}

/**
 * Empreinte de l'appareil pour les échecs mémorisés : modèle, échelle, et GPU annoncé.
 * Un téléphone dont le pilote ou le navigateur change d'adaptateur repart de zéro.
 */
export function deviceFingerprint(probe) {
  const i = probe?.info || {};
  const gpu = probe?.adapter ? [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join("/") || "gpu" : "no-gpu";
  return `${MODEL.revision.slice(0, 8)}|${LADDER_VERSION}|${gpu}`;
}

/** Raison d'une tentative GPU reportée faute de fichiers en cache (voir planAttempts). */
export const NEEDS_DOWNLOAD = "needs-download";

/**
 * Tentatives à essayer, dans l'ordre, sur cet appareil.
 *
 * Tout ce qui ne coûte rien est tenté sans rien demander. Ce qui coûterait un
 * téléchargement que le processeur n'exige pas (q4f16 hors du cache : 255 Mo) n'est lancé
 * de lui-même qu'au PREMIER chargement (rien en cache : un téléchargement est attendu de
 * toute façon). Ensuite, il attend le consentement (« Réessayer le GPU ») : un échec
 * oublié après une mise à jour (runtimeContext) ne doit pas retélécharger 255 Mo sur le
 * forfait mobile à chaque mise à jour de la WebView.
 *
 * @param {{ probe: object|null, failed?: Record<string,string>, cached?: Set<string>|null, consent?: boolean }} s
 *   failed  : tentatives déjà en échec ici (id → raison), voir failureRecord
 *   cached  : dtypes dont TOUS les fichiers sont déjà sur l'appareil ; null = inconnu
 *             (ordre de préférence pur, comme au premier chargement)
 *   consent : l'utilisateur a demandé de tout réessayer, téléchargement compris
 * @returns {{ queue: object[], skipped: {id:string, reason:string}[] }}
 *   skipped : ce qui n'est pas tenté, et pourquoi (journalisé et montré)
 */
export function planAttempts({ probe, failed = {}, cached = null, consent = false }) {
  const gpuF16 = assessWebGPU(probe);
  const gpuF32 = assessWebGPU(probe, { f16: false });
  const pure = consent || !cached || cached.size === 0;
  const queue = [], skipped = [];
  for (const a of ATTEMPTS) {
    let why = null;
    if (failed[a.id]) why = `failed-before: ${failed[a.id]}`;
    else if (a.engine.device === "webgpu") {
      const v = a.variant.dtype === "q4f16" ? gpuF16 : gpuF32;
      if (!v.ok) why = v.reason;
      // Fichiers propres au GPU, absents : seulement avec consentement (ou au premier chargement)
      else if (!pure && !cached.has(a.variant.dtype) && a.variant.dtype !== VARIANTS.wasm.dtype) why = NEEDS_DOWNLOAD;
    }
    if (why) skipped.push({ id: a.id, reason: why });
    else queue.push(a);
  }
  return { queue, skipped };
}

/**
 * Échecs mémorisés, lus depuis le stockage. Ne vaut que pour la même empreinte.
 * Les anciennes clés (avant l'échelle) sont reprises pour ne pas retélécharger :
 * « f16 en échec » couvrait q4f16, dont les fichiers ont été purgés. L'ancien « GPU
 * condamné » n'est PAS repris : l'échec n'a jamais été lu (message tronqué à
 * l'écran), il a eu lieu avec un moteur processeur qui ne pouvait pas démarrer, et
 * retenter q4 sur le GPU ne télécharge rien (fichiers partagés avec le processeur).
 *
 * Contexte (runtimeContext) : un échec constaté avec un autre moteur onnxruntime ou une
 * autre version du navigateur est oublié — les tentatives repartent d'elles-mêmes. Un
 * enregistrement écrit avant ce champ n'en a pas : il est supposé du contexte courant
 * (même moteur embarqué depuis), et prend le contexte à la prochaine écriture.
 * @param {{ stored: string|null, legacyF16?: string|null, fingerprint: string, context?: string|null }} s
 * @returns {Record<string,string>}
 */
export function failureRecord({ stored, legacyF16 = null, fingerprint, context = null }) {
  let rec = null;
  try { rec = stored ? JSON.parse(stored) : null; } catch { rec = null; }
  const sameContext = !rec?.context || !context || rec.context === context;
  const failed = rec && rec.fingerprint === fingerprint && sameContext && rec.failed && typeof rec.failed === "object" ? { ...rec.failed } : {};
  if (legacyF16) {
    // L'ancien « fp16 en échec » a été constaté avec le device d'onnxruntime : il vaut
    // pour la tentative native, pas pour la compatible, jamais essayée.
    const native = ATTEMPTS.find((a) => a.variant.dtype === "q4f16" && !a.profile?.custom);
    if (!failed[native.id]) failed[native.id] = `legacy: ${String(legacyF16).slice(0, 120)}`;
  }
  return failed;
}

/**
 * Que faire après l'échec d'une tentative ?
 *  - réseau (setup, download) : on s'arrête, sans rien condamner — le même essai
 *    reprendra, fichiers déjà reçus compris ;
 *  - moteur (import du moteur, initialisation, essai à vide) : la tentative est
 *    condamnée sur cet appareil et la suivante part d'elle-même ;
 *  - génération : une erreur du moteur sur le GPU condamne la tentative (une session
 *    peut se créer puis échouer à chaque réponse, mesuré) ; un délai dépassé ne prouve
 *    rien et ne condamne pas ; sur le processeur, rien après lui : on ne condamne pas.
 * purge : dtype dont les fichiers ne serviront plus (toutes ses tentatives condamnées).
 * @param {{ attempt: object, phase: "setup"|"engine"|"download"|"init"|"generate", timedOut?: boolean,
 *           failed?: Record<string,string> }} f
 */
export function classifyFailure({ attempt: a, phase, timedOut = false, failed = {} }) {
  const sfx = timedOut ? "_timeout" : "";
  const none = { condemn: false, continue: false, purgeDtype: null };
  if (phase === "setup" || phase === "download") return { ...none, code: `${phase}${sfx}` };
  if (phase === "generate" && (timedOut || a.engine.device !== "webgpu")) return { ...none, code: `generate${sfx}` };
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
  }),
  generateMs: Object.freeze({   // une réponse complète
    webgpu: 180_000,
    // Processeur, un seul fil (pas de SharedArrayBuffer dans la WebView) : chaque passe
    // coûte ~1,8 s mesurée dans Chrome sur un processeur de bureau, 41 à 115 s par
    // réponse courte, et une réponse de 96 jetons dépasse 180 s. Avec 180 s, la voie
    // processeur échouait sur toute réponse longue. Téléphone : plus lent, non mesuré.
    wasm: 600_000,
  }),
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
 * Essai à vide fait par le worker juste après le chargement (quelques jetons, glouton,
 * sans outils) : « prêt » n'est annoncé que si le modèle a réellement GÉNÉRÉ. Avant,
 * une session créée suffisait — et un GPU pouvait la créer puis échouer à chaque
 * réponse, ou produire du charabia (« 地黎 », relevé sur téléphone).
 * @param {unknown} text texte produit, jetons spéciaux retirés
 * @returns {{ ok: boolean, reason: string }}
 */
export function selfTestVerdict(text) {
  if (typeof text !== "string") return { ok: false, reason: "no-output" };
  const s = text.trim();
  if (!/\p{L}{2,}/u.test(s)) return { ok: false, reason: "no-word" };
  // L'essai est en français : une lettre d'une autre écriture trahit un calcul faussé.
  if (/(?=\p{L})\P{Script=Latin}/u.test(s)) return { ok: false, reason: "script" };
  return { ok: true, reason: "ok" };
}

/**
 * Sortie d'une génération manifestement corrompue : caractère de remplacement (octets
 * qui ne forment pas d'UTF-8, « � » relevé sur téléphone) ou lettre d'une autre écriture
 * que le latin (« 臟 »). Le modèle répond en français ou en anglais, ses appels d'outils
 * sont en ASCII : ni l'un ni l'autre n'arrive d'un calcul juste. Jetons spéciaux ignorés.
 * Sert APRÈS l'essai à vide : un GPU peut le passer puis calculer faux sur un long prompt
 * (autre noyau de remplissage) — la façade écarte alors la tentative.
 * @param {unknown} text sortie brute du modèle
 */
export function outputLooksCorrupted(text) {
  const s = String(text ?? "").replace(/<\|[a-z_]+\|>/g, "");
  return /�/.test(s) || /(?=\p{L})\P{Script=Latin}/u.test(s);
}

/**
 * Messages de l'essai à vide (le worker et les tests s'en servent).
 *
 * Sur le GPU, l'essai passe par une consigne de quelques centaines de caractères avant
 * « Bonjour » : le remplissage d'un prompt long emprunte d'autres noyaux que celui de
 * quelques jetons (MatMulNBits WideTile au-delà de quelques lignes, attention sur une
 * séquence plus longue), et c'est sur ce chemin que tournent les vraies questions (consigne
 * + outils : ~730 jetons). Sur le processeur, l'essai reste court : son calcul n'est pas en
 * doute, et chaque jeton y coûte cher.
 */
const GPU_SELF_TEST_SYSTEM =
  "Tu es l'assistant de VelohNav, une application de vélos en libre-service à Luxembourg. "
  + "Tu réponds en français, en une ou deux phrases courtes et polies. Tu aides à trouver une "
  + "station Vel'OH! avec des vélos ou des places libres, à préparer un itinéraire à vélo, à "
  + "consulter la météo avant de partir et les prochains départs de bus ou de tram. Quand une "
  + "information te manque, tu le dis simplement au lieu d'inventer. Tu ne donnes jamais de "
  + "chiffres que tu n'as pas reçus : le nombre de vélos, les horaires et la météo viennent "
  + "des outils de l'application, pas de toi.";
export const SELF_TEST = Object.freeze({
  messages: Object.freeze([{ role: "user", content: "Bonjour" }]),
  gpuMessages: Object.freeze([
    { role: "system", content: GPU_SELF_TEST_SYSTEM },
    { role: "user", content: "Bonjour" },
  ]),
  maxNewTokens: 6,
});

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
 * @param {{ chosen: object|null, tried?: {id,code,detail}[], skipped?: {id,reason}[], cached?: string[]|null }} report modelReport()
 * @returns {null | { reasons: { ids: string[], kind: string, detail: string }[], retry: boolean, downloadMB: number }}
 *   null : le GPU est retenu, ou rien n'est encore retenu. `kind` : no_webgpu, no_adapter,
 *   software, no_f16, limits, device, failed (à ce chargement), failed_before (lancement
 *   précédent), download (pas encore essayé : fichiers à télécharger). Raisons identiques
 *   regroupées. `retry` : un échec ou une tentative reportée peut être rejoué (« Réessayer
 *   le GPU ») ; `downloadMB` : ce que ce nouvel essai téléchargerait, chaque fichier compté
 *   une fois (q4f16 n'est pas en cache s'il a été purgé ; q4 l'est, il sert au processeur).
 */
export function gpuSetAside(report) {
  if (!report?.chosen || report.chosen.device === "webgpu") return null;
  const reasons = [];
  const have = new Set(report.cached ?? [report.chosen.dtype]);
  const toFetch = new Map();   // dtype → Mo
  let retry = false;
  for (const a of ATTEMPTS.filter((x) => x.engine.device === "webgpu")) {
    const t = report.tried?.find((x) => x.id === a.id);
    const s = report.skipped?.find((x) => x.id === a.id);
    let kind, detail;
    if (t) { kind = "failed"; detail = t.detail || t.code; }
    else if (!s) continue;
    else if (s.reason.startsWith("failed-before")) { kind = "failed_before"; detail = s.reason.replace(/^failed-before:\s*/, ""); }
    else if (s.reason === NEEDS_DOWNLOAD) { kind = "download"; detail = ""; }
    else if (SKIP_KIND[s.reason]) { kind = SKIP_KIND[s.reason]; detail = ""; }
    else if (s.reason.startsWith("device")) { kind = "device"; detail = s.reason.replace(/^device:\s*/, ""); }
    else { kind = "limits"; detail = s.reason; }
    if (kind === "failed" || kind === "failed_before" || kind === "download") {
      retry = true;
      if (!have.has(a.variant.dtype)) toFetch.set(a.variant.dtype, a.variant.mb);
    }
    const same = reasons.find((r) => r.kind === kind && r.detail === detail);
    if (same) same.ids.push(a.id);
    else reasons.push({ ids: [a.id], kind, detail: String(detail).slice(0, 240) });
  }
  const downloadMB = [...toFetch.values()].reduce((x, y) => x + y, 0);
  return { reasons, retry, downloadMB };
}
