// Plugin Vite : l'import `onnxruntime-web/webgpu` fait PAR transformers.js est servi par
// src/ai/ortEngine.js, qui rend le moteur onnxruntime choisi par le worker du modèle.
// Les autres imports d'onnxruntime-web (ceux du worker) ne sont pas touchés : chaque
// build garde son binaire WASM, émis par Vite à côté du bundle.
//
// Le build échoue si transformers.js n'importe plus ce module : la redirection serait
// silencieusement perdue, et le processeur retomberait sur un moteur sans ses noyaux.
import { fileURLToPath } from "node:url";

const SHIM = fileURLToPath(new URL("../src/ai/ortEngine.js", import.meta.url));

export default function ortEngine() {
  let redirected = false;
  return {
    name: "velohnav-ort-engine",
    enforce: "pre",
    resolveId(id, importer) {
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
