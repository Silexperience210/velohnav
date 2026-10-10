// Plugin Vite : l'import `onnxruntime-web/webgpu` fait PAR transformers.js est servi par
// src/ai/ortEngine.js, qui rend le moteur onnxruntime choisi par le worker du modèle.
// Les autres imports d'onnxruntime-web (ceux du worker) ne sont pas touchés : chaque
// build garde son binaire WASM, émis par Vite à côté du bundle.
//
// Le build échoue si transformers.js n'importe plus ce module : la redirection serait
// silencieusement perdue, et le processeur retomberait sur un moteur sans ses noyaux.
//
// Il échoue aussi sur tout import des builds « all » ou par défaut d'onnxruntime-web :
// ils embarquent ort-wasm-simd-threaded.jsep.wasm (28,4 Mo, 8,3 Mo compressés), que
// l'échelle des tentatives n'utilise pas et qui portait l'APK au-delà de 50 Mo.
// Seuls restent le binaire WebGPU (asyncify) et le binaire processeur (wasm).
import { fileURLToPath } from "node:url";

const SHIM = fileURLToPath(new URL("../src/ai/ortEngine.js", import.meta.url));

/** Builds d'onnxruntime-web qui ne doivent pas entrer dans l'APK (binaire JSEP). */
export const FORBIDDEN_ORT = ["onnxruntime-web", "onnxruntime-web/all"];

export default function ortEngine() {
  let redirected = false;
  return {
    name: "velohnav-ort-engine",
    enforce: "pre",
    resolveId(id, importer) {
      if (FORBIDDEN_ORT.includes(id)) {
        throw new Error(`${id} importé par ${importer} : ce build embarque le binaire JSEP (28 Mo) — utiliser onnxruntime-web/webgpu ou /wasm`);
      }
      if (id === "onnxruntime-web/webgpu" && importer && /[\\/]@huggingface[\\/]transformers[\\/]/.test(importer)) {
        redirected = true;
        return SHIM;
      }
      return null;
    },
    buildEnd(err) {
      if (!err && this.meta?.watchMode !== true && !redirected && this.getModuleIds) {
        const ids = [...this.getModuleIds()];
        if (ids.some((i) => /[\\/]@huggingface[\\/]transformers[\\/]/.test(i))) {
          this.error("transformers.js n'importe plus onnxruntime-web/webgpu : choix du moteur ONNX perdu (src/ai/ortEngine.js)");
        }
      }
    },
  };
}
