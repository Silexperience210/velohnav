// Worker dédié au modèle conversationnel.
//
// Le modèle tourne ici et non dans la page pour une raison précise : un blocage
// d'onnxruntime ne se rattrape pas. transformers.js garde la première création de
// session dans une promesse de module (`wasmInitPromise`) qui n'est jamais remise à
// zéro, et onnxruntime-web marque son moteur « en cours » / « abandonné » pour toute la
// vie de la page. Une initialisation qui ne rend jamais la main condamne donc toute
// tentative suivante dans la même page. Un worker, lui, se termine : la façade
// (localModel.js) le tue à l'expiration du délai et en recrée un neuf.
import { pipeline, env } from "@huggingface/transformers";
import { LIMITS, MODEL, SELF_TEST, hubFileUrl, cacheHeaders, withTimeout } from "./modelPolicy.js";

const MODEL_ID = MODEL.id;
// Copie embarquée éventuelle (public/models/ via scripts/fetch-model.sh).
const LOCAL_DIR = MODEL.localDir;
const LOCAL_PATH = "/models/";
// Cache de transformers.js (hub.js : caches.open("transformers-cache"), clé = URL du Hub)
const CACHE_NAME = "transformers-cache";

const ort = env.backends.onnx;
// Un seul fil : sans isolation cross-origin (COOP/COEP, absente de la WebView
// Capacitor) il n'y a pas de SharedArrayBuffer. onnxruntime retombe déjà à 1 fil dans
// ce cas, on le fixe explicitement pour ne dépendre d'aucune heuristique.
ort.wasm.numThreads = 1;
ort.wasm.proxy = false;
// transformers.js force wasmPaths vers cdn.jsdelivr.net : le moteur (21 Mo) était
// retéléchargé à chaque initialisation, hors de tout délai, et l'IA ne démarrait pas
// hors ligne. Le binaire est déjà embarqué par Vite à côté du bundle : on le rend à
// onnxruntime en effaçant la surcharge.
ort.wasm.wasmPaths = undefined;

let generator = null;

const post = (msg) => self.postMessage(msg);

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
 * fp32) peut tourner sur ce GPU. Le verdict est rendu par assessWebGPU (modelPolicy.js),
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
  const out = {
    adapter: true,
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

async function load({ variant, modelId }) {
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

self.onmessage = async ({ data }) => {
  const msg = data || {};
  if (msg.type === "probe") {
    post({ type: "probe", probe: await probeWebGPU() });
    return;
  }
  if (msg.type === "load") {
    try {
      await load(msg);
      post({ type: "ready", selfTest: await selfTest() });
    } catch (e) {
      post({ type: "error", message: String(e?.message || e) });
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
async function selfTest() {
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
