// Worker dédié au modèle conversationnel.
//
// Le modèle tourne ici et non dans la page pour une raison précise : un blocage
// d'onnxruntime ne se rattrape pas. transformers.js garde la première création de
// session dans une promesse de module (`wasmInitPromise`) qui n'est jamais remise à
// zéro, et onnxruntime-web marque son moteur « en cours » / « abandonné » pour toute la
// vie de la page. Une initialisation qui ne rend jamais la main condamne donc toute
// tentative suivante dans la même page. Un worker, lui, se termine : la façade
// (localModel.js) le tue à l'expiration du délai et en recrée un neuf.
//
// Un worker = UNE tentative = UN moteur onnxruntime. transformers.js importe toujours
// `onnxruntime-web/webgpu`, dont le binaire (ort-wasm-simd-threaded.asyncify.wasm) n'a
// pas de noyau processeur pour GatherBlockQuantized : la variante processeur ne pouvait
// PAS démarrer (« Could not find an implementation for GatherBlockQuantized(1) », mesuré
// dans Chrome). Le worker charge le build qu'exige la tentative (ENGINES, modelPolicy.js),
// le pose sous ENGINE_SLOT, PUIS importe transformers.js, qui le reçoit (ortEngine.js).
// ortEngine.js n'est PAS importé ici : il lit le moteur à son évaluation, qui doit venir
// après le choix (il est importé par transformers.js, via le plugin).
import { LIMITS, MODEL, SELF_TEST, hubFileUrl, cacheHeaders, withTimeout, ENGINES, ENGINE_SLOT } from "./modelPolicy.js";

const MODEL_ID = MODEL.id;
// Copie embarquée éventuelle (public/models/ via scripts/fetch-model.sh).
const LOCAL_DIR = MODEL.localDir;
const LOCAL_PATH = "/models/";
// Cache de transformers.js (hub.js : caches.open("transformers-cache"), clé = URL du Hub)
const CACHE_NAME = "transformers-cache";

// Imports littéraux : Vite doit voir chaque moteur pour embarquer son binaire.
const ENGINE_MODULES = {
  [ENGINES.webgpu.module]: () => import("onnxruntime-web/webgpu"),
  [ENGINES.wasm.module]: () => import("onnxruntime-web/wasm"),
};

let tf = null;          // module transformers.js, importé après le choix du moteur
let generator = null;

const post = (msg) => self.postMessage(msg);

// Journal d'onnxruntime : ses erreurs WebGPU (validation, shader non compilable, « Sub
// requires f16 ») partent en console.error/warn, et l'exception qui remonte se réduit
// souvent à « failed to call OrtRun() ». Les dernières lignes sont gardées pour être
// jointes à l'erreur : sans elles, la cause d'un échec GPU n'est pas lisible.
const LOG_MAX = 8;
const logTail = [];
for (const level of ["error", "warn"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    const line = args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
    logTail.push(`${level}: ${line}`.slice(0, 300));
    if (logTail.length > LOG_MAX) logTail.shift();
    orig(...args);
  };
}

async function runtime(engineId) {
  if (tf) return tf;
  const engine = ENGINES[engineId] ?? ENGINES.webgpu;
  const ort = await ENGINE_MODULES[engine.module]();
  globalThis[ENGINE_SLOT] = ort;
  tf = await import("@huggingface/transformers");
  const onnx = tf.env.backends.onnx;
  // Un seul fil : sans isolation cross-origin (COOP/COEP, absente de la WebView
  // Capacitor) il n'y a pas de SharedArrayBuffer. onnxruntime retombe déjà à 1 fil dans
  // ce cas, on le fixe explicitement pour ne dépendre d'aucune heuristique.
  onnx.wasm.numThreads = 1;
  onnx.wasm.proxy = false;
  // transformers.js force wasmPaths vers cdn.jsdelivr.net : le moteur (14 à 28 Mo) était
  // retéléchargé à chaque initialisation, hors de tout délai, et l'IA ne démarrait pas
  // hors ligne. Le binaire est déjà embarqué par Vite à côté du bundle : on le rend à
  // onnxruntime en effaçant la surcharge.
  onnx.wasm.wasmPaths = undefined;
  return tf;
}

async function hasLocalModel() {
  const ctrl = new AbortController();
  try {
    const r = await withTimeout(
      fetch(`${LOCAL_PATH}${LOCAL_DIR}/config.json`, { method: "HEAD", signal: ctrl.signal }),
      LIMITS.localCheckMs, "local model check", () => ctrl.abort(),
    );
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Sonde WebGPU : pas seulement « un adaptateur existe », mais « un device a été obtenu
 * avec les limites (et la fonction shader-f16 si l'adaptateur l'offre) ». Chaque appel
 * est borné. Sans shader-f16, le device est tout de même demandé : la variante q4 (calcul
 * fp32) peut tourner sur ce GPU. Le verdict est rendu par planAttempts (modelPolicy.js),
 * côté façade.
 */
async function probeWebGPU() {
  if (typeof navigator === "undefined" || !navigator.gpu) return null;
  let adapter;
  try {
    adapter = await withTimeout(
      navigator.gpu.requestAdapter({ powerPreference: "high-performance" }),
      LIMITS.probeMs, "requestAdapter",
    );
  } catch (e) {
    return { adapter: false, error: String(e?.message || e) };
  }
  if (!adapter) return { adapter: false };
  const features = [...adapter.features];
  const limits = {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  };
  const info = adapter.info || {};
  const out = {
    adapter: true,
    info: { vendor: info.vendor || "", architecture: info.architecture || "", device: info.device || "", description: info.description || "" },
    isFallbackAdapter: !!(adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter),
    features,
    limits,
    device: { ok: false, error: "not-requested" },
  };
  const requiredFeatures = features.includes("shader-f16") ? ["shader-f16"] : [];
  try {
    const device = await withTimeout(
      adapter.requestDevice({ requiredFeatures, requiredLimits: limits }),
      LIMITS.probeMs, "requestDevice",
    );
    device.destroy();
    out.device = { ok: true };
  } catch (e) {
    out.device = { ok: false, error: String(e?.message || e) };
  }
  return out;
}

/**
 * Premier téléchargement des fichiers de poids : écrits EN FLUX dans le cache de
 * transformers.js, sous la clé qu'il cherchera ensuite.
 *
 * Sans cela, transformers.js lit le fichier entier en mémoire (Uint8Array), en
 * fait une seconde copie pour cache.put(new Response(buffer)), puis onnxruntime
 * le recopie dans son tas WASM : jusqu'à 4 copies au premier lancement. Ici le
 * corps de la réponse passe du réseau au cache sans jamais être assemblé en JS ;
 * transformers.js le trouve ensuite en cache (une seule lecture).
 * Tout échec est silencieux : transformers.js retélécharge alors à sa manière.
 */
async function prefetchToCache(file, bytes) {
  if (typeof caches === "undefined" || typeof TransformStream === "undefined") return;
  const url = hubFileUrl(file);
  try {
    const cache = await caches.open(CACHE_NAME);
    if (await cache.match(url)) return;
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return;
    const total = Number(resp.headers.get("content-length")) || bytes || 0;
    let loaded = 0, lastPost = 0;
    const counter = new TransformStream({
      transform(chunk, ctl) {
        loaded += chunk.byteLength;
        // ~4 messages par Mo au plus : le chien de garde n'a besoin que de signes de vie
        if (loaded - lastPost >= 256 * 1024 || (total && loaded >= total)) {
          lastPost = loaded;
          post({ type: "progress", ev: { status: "progress", file, loaded, total } });
        }
        ctl.enqueue(chunk);
      },
    });
    await cache.put(url, new Response(resp.body.pipeThrough(counter), { status: 200, headers: cacheHeaders(resp.headers, bytes) }));
  } catch (e) {
    console.warn("[IA] pré-chargement en flux impossible :", e?.message || e);
  }
}

async function load({ variant, engine, modelId }) {
  let rt;
  try {
    rt = await runtime(engine);
  } catch (e) {
    // Moteur introuvable ou qui refuse de s'initialiser : propre à CETTE tentative
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { stage: "engine" });
  }
  const { pipeline, env } = rt;
  let ref = modelId || MODEL_ID;
  if (!modelId && (await hasLocalModel())) {
    env.allowLocalModels = true;
    env.localModelPath = LOCAL_PATH;
    ref = LOCAL_DIR;
  } else if (!modelId) {
    // Graphe puis poids (.onnx_data, le gros), l'un après l'autre : jamais deux flux
    // de plusieurs centaines de Mo en même temps.
    for (const file of variant.files || [variant.file]) await prefetchToCache(file, variant.bytes?.[file]);
  }
  generator = await pipeline("text-generation", ref, {
    ...(ref === MODEL_ID ? { revision: MODEL.revision } : {}),   // même clé de cache que le pré-chargement
    dtype: variant.dtype,
    device: variant.device,
    progress_callback: (p) => {
      if (!p || !p.status) return;
      post({ type: "progress", ev: { status: p.status, file: p.file, loaded: p.loaded, total: p.total } });
    },
  });
}

/** Erreur à transmettre : message, étape (« engine » : import du moteur), journal du moteur. */
const errorReport = (e) => ({
  message: String(e?.message || e),
  stage: e?.stage || "load",
  log: logTail.slice(),
});

self.onmessage = async ({ data }) => {
  const msg = data || {};
  if (msg.type === "probe") {
    post({ type: "probe", probe: await probeWebGPU() });
    return;
  }
  if (msg.type === "load") {
    const t0 = performance.now();
    try {
      await load(msg);
      // loadMs : du message « load » à l'essai à vide réussi (téléchargement compris)
      const t1 = performance.now();
      const selfTest = await selfTestRun();
      const t2 = performance.now();
      post({ type: "ready", selfTest, loadMs: Math.round(t2 - t0), selfTestMs: Math.round(t2 - t1) });
    } catch (e) {
      post({ type: "error", ...errorReport(e) });
    }
    return;
  }
  if (msg.type === "generate") {
    try {
      if (!generator) throw new Error("model not loaded");
      post({ type: "result", id: msg.id, text: await complete(msg) });
    } catch (e) {
      post({ type: "result", id: msg.id, error: String(e?.message || e) });
    }
  }
};

/**
 * Essai à vide : quelques jetons générés juste après le chargement. Une session créée ne
 * prouve pas que le modèle sait générer — mesuré au banc : q4f16 sur un GPU sans fp16 se
 * charge, puis chaque génération échoue. Une erreur ici remonte comme un échec de
 * chargement ; le texte produit est jugé par la façade (selfTestVerdict).
 */
async function selfTestRun() {
  const raw = await complete({
    messages: SELF_TEST.messages,
    options: { max_new_tokens: SELF_TEST.maxNewTokens, do_sample: false },
  });
  return raw.replace(/<\|[a-z_]+\|>/g, "").trim();
}

/**
 * Gabarit de conversation DU MODÈLE (tokenizer_config / chat_template.jinja), outils
 * compris : c'est ainsi que LFM2.5 a été entraîné à les voir. Rend seulement le texte
 * produit après le prompt, jetons spéciaux conservés — <|tool_call_start|> marque un
 * appel d'outil, il ne faut pas le perdre au décodage.
 */
async function complete({ messages, tools, options }) {
  const tok = generator.tokenizer;
  const inputs = tok.apply_chat_template(messages, {
    ...(tools?.length ? { tools } : {}),
    add_generation_prompt: true,
    return_dict: true,
  });
  const out = await generator.model.generate({ ...inputs, ...options });
  const n = inputs.input_ids.dims.at(-1);
  return tok.decode(out.slice(null, [n, null])[0], { skip_special_tokens: false });
}
