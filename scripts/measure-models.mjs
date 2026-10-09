#!/usr/bin/env node
// Mesure, sans rien télécharger, la taille des fichiers ONNX que
// @huggingface/transformers chargerait pour chaque modèle candidat.
// Source : API du Hub (/api/models/<id>/tree/main/onnx), tailles en octets.
// Lit aussi config.json (model_type, embeddings liés) et la licence déclarée.
// Une entrée « dépôt@révision » mesure une révision précise.
//
//   node scripts/measure-models.mjs            → tableau texte
//   node scripts/measure-models.mjs --json     → JSON brut

const REPOS = [
  "onnx-community/functiongemma-270m-it-ONNX",
  "onnx-community/LFM2-350M-ONNX",
  "onnx-community/LFM2-350M-ONNX@5bc4b3e8cf",   // dernière révision avant l'export « transformers.js v4 »
  "onnx-community/LFM2.5-350M-ONNX",
  "keisuke-miyako/Hammer2.1-0.5b-onnx-int4",
  "onnx-community/Qwen3-0.6B-ONNX",
  "onnx-community/SmolLM2-135M-Instruct-ONNX",
  "onnx-community/SmolLM2-360M-Instruct-ONNX",
  "onnx-community/Qwen2.5-0.5B-Instruct",
];

// Suffixes de transformers.js 3.x (src/utils/dtypes.js).
const SUFFIX = { fp32: "", fp16: "_fp16", q8: "_quantized", q4: "_q4", q4f16: "_q4f16" };
const HUB = "https://huggingface.co";
const MB = 1e6;

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json();
}

async function measure(ref) {
  const [id, rev = "main"] = ref.split("@");
  const [tree, config, info] = await Promise.all([
    getJson(`${HUB}/api/models/${id}/tree/${rev}/onnx`),
    getJson(`${HUB}/${id}/resolve/${rev}/config.json`),
    getJson(`${HUB}/api/models/${id}`),
  ]);
  const files = new Map((tree ?? []).map((f) => [f.path.replace(/^onnx\//, ""), f.size]));
  const sizes = {};
  for (const [dtype, suf] of Object.entries(SUFFIX)) {
    const base = `model${suf}.onnx`;
    if (!files.has(base)) continue;
    // Poids externes éventuels : model_q4.onnx_data, model_q4.onnx_data_1, …
    let total = files.get(base);
    for (const [name, size] of files) if (name.startsWith(`${base}_data`)) total += size;
    sizes[dtype] = +(total / MB).toFixed(1);
  }
  return {
    id: ref,
    model_type: config?.model_type ?? config?.text_config?.model_type ?? null,
    tie_word_embeddings: config?.tie_word_embeddings ?? null,
    vocab: config?.vocab_size ?? null,
    hidden: config?.hidden_size ?? null,
    license: info?.cardData?.license ?? null,
    onnxFiles: [...files.keys()],
    sizes,
  };
}

const rows = await Promise.all(REPOS.map(measure));
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    const s = Object.entries(r.sizes).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`${r.id}\n  type=${r.model_type} licence=${r.license} vocab=${r.vocab} hidden=${r.hidden}\n  Mo: ${s || "(aucun fichier standard)"}\n  fichiers: ${r.onnxFiles.join(", ")}`);
  }
}
