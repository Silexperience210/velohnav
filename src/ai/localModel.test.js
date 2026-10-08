import { describe, it, expect } from "vitest";
import { chooseVariant } from "./localModel.js";

// Le choix de quantification est fait sur l'appareil.
//
// Mesuré : q4 = 1,7 Go, q4f16 = 1,17 Go sur le dépôt du modèle. Et vérifié à
// l'exécution : dans un navigateur sans adaptateur WebGPU, demander q4f16 fait
// échouer le chargement du modèle — la variante q4, elle, fonctionne sur WASM.
// D'où cette décision : la plus légère quand l'appareil a un vrai GPU, la
// compatible sinon. Aucun appareil ne se retrouve avec un modèle qui ne charge pas.
describe("choix de la quantification selon l'appareil", () => {
  it("avec un adaptateur WebGPU : q4f16, la variante la plus légère", () => {
    const v = chooseVariant(true);
    expect(v.dtype).toBe("q4f16");
    expect(v.device).toBe("webgpu");
    expect(v.mb).toBe(1165);
  });

  it("sans adaptateur : q4 sur WASM, la seule qui fonctionne", () => {
    const v = chooseVariant(false);
    expect(v.dtype).toBe("q4");
    expect(v.device).toBe("wasm");
    expect(v.mb).toBe(1704);
  });

  it("la variante légère est réservée au WebGPU, jamais choisie sur WASM", () => {
    expect(chooseVariant(true).mb).toBeLessThan(chooseVariant(false).mb);
    expect(chooseVariant(false).dtype).not.toBe("q4f16");
  });

  it("le couple variante/appareil reste cohérent", () => {
    const gpu = chooseVariant(true), cpu = chooseVariant(false);
    expect(gpu.device).toBe("webgpu");
    expect(cpu.device).toBe("wasm");
    expect(gpu.dtype).not.toBe(cpu.dtype);
  });
});
