import { describe, it, expect } from "vitest";
import ortEngine from "../../scripts/vite-ort-engine.mjs";

// La variante processeur ne démarrait pas : transformers.js importe toujours le build
// `onnxruntime-web/webgpu`, sans noyau processeur GatherBlockQuantized. Le plugin lui
// sert le moteur choisi par le worker — et à lui SEUL.
describe("plugin ortEngine : transformers.js reçoit le moteur choisi par le worker", () => {
  const TF = "/app/node_modules/@huggingface/transformers/dist/transformers.web.js";

  it("l'import onnxruntime-web/webgpu de transformers.js est redirigé vers ortEngine.js", () => {
    expect(ortEngine().resolveId("onnxruntime-web/webgpu", TF)).toMatch(/src[\\/]ai[\\/]ortEngine\.js$/);
  });

  it("les imports du worker (un build par moteur) ne sont pas touchés", () => {
    const p = ortEngine();
    for (const id of ["onnxruntime-web/webgpu", "onnxruntime-web/all", "onnxruntime-web/wasm"]) {
      expect(p.resolveId(id, "/app/src/ai/modelWorker.js")).toBeNull();
    }
    expect(p.resolveId("onnxruntime-web/wasm", TF)).toBeNull();
  });

  it("le build échoue si transformers.js n'importe plus ce module (redirection perdue en silence)", () => {
    const p = ortEngine();
    let msg = null;
    p.buildEnd.call({ error: (m) => { msg = m; }, getModuleIds: () => [TF][Symbol.iterator](), meta: {} });
    expect(msg).toMatch(/onnxruntime-web\/webgpu/);
  });
});
