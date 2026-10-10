// Moteur onnxruntime vu par transformers.js.
//
// transformers.js importe toujours `onnxruntime-web/webgpu`, dont le binaire n'a pas de
// noyau processeur pour GatherBlockQuantized (le modèle ne peut alors tourner que sur le
// GPU). Le plugin `ortEngine` (scripts/vite-ort-engine.mjs) redirige CET import-là, et
// seulement celui de transformers.js, vers ce module ; le worker du modèle choisit le
// build (webgpu, all, wasm), le pose sous ENGINE_SLOT, PUIS importe transformers.js.
//
// Son mécanisme officiel (globalThis[Symbol.for("onnxruntime")]) ne convient pas :
// en 4.3.1, il laisse vide la liste des appareils, et tout `device` est refusé
// (« Unsupported device: "wasm". Should be one of: . », mesuré).
import { ENGINE_SLOT } from "./modelPolicy.js";

const ort = globalThis[ENGINE_SLOT];
if (!ort) throw new Error("onnxruntime engine not selected before importing transformers.js");

export const InferenceSession = ort.InferenceSession;
export const Tensor = ort.Tensor;
export const env = ort.env;
export default ort;
