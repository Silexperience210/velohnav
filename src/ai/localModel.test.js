import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chooseVariant } from "./localModel.js";

// Le choix de quantification est fait sur l'appareil.
//
// Mesuré sur le dépôt du modèle (LFM2.5-350M, graphe + poids .onnx_data) : q4f16 =
// 255 Mo, q4 = 294 Mo. Et vérifié à l'exécution (sur Qwen) : dans un navigateur sans
// adaptateur WebGPU, demander q4f16 fait échouer le chargement — une variante WASM, elle,
// fonctionne.
// D'où cette décision : la plus légère quand l'appareil a un vrai GPU, la
// compatible sinon. Aucun appareil ne se retrouve avec un modèle qui ne charge pas.
describe("choix de la quantification selon l'appareil", () => {
  it("avec un adaptateur WebGPU : q4f16, la variante la plus légère", () => {
    const v = chooseVariant(true);
    expect(v.dtype).toBe("q4f16");
    expect(v.device).toBe("webgpu");
    expect(v.mb).toBe(255);
  });

  it("sans adaptateur : q4 sur WASM, la seule qui fonctionne", () => {
    const v = chooseVariant(false);
    expect(v.dtype).toBe("q4");
    expect(v.device).toBe("wasm");
    expect(v.mb).toBe(294);
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

// ── Le défaut observé sur téléphone, rejoué avec un faux worker ──────────
// Progression à 100 %, puis plus rien : ni « prêt », ni erreur. Le chargement doit
// désormais finir en échec explicite, tuer le worker bloqué, et proposer WASM.
class FakeWorker {
  static all = [];
  constructor() { this.sent = []; this.terminated = false; FakeWorker.all.push(this); }
  postMessage(m) { this.sent.push(m); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage?.({ data }); }
}

const GOOD_PROBE = {
  adapter: true, isFallbackAdapter: false, features: ["shader-f16"],
  limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 31 }, device: { ok: true },
};
const MB = 254_965_760;   // model_q4f16.onnx_data
const GRAPH = 182_827;    // model_q4f16.onnx
// Le contrôle mémoire précède la création du worker (asynchrone)
const flush = () => vi.advanceTimersByTimeAsync(0);
const progress = (file, loaded, total) => ({ type: "progress", ev: { status: "progress", file, loaded, total } });

describe("façade : un chargement ne peut plus rester figé", () => {
  let mod, store;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeWorker.all = [];
    store = new Map();
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("localStorage", { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    mod = await import("./localModel.js");
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("WebGPU figé à 100 % : échec explicite après le délai, worker tué, repli WASM mémorisé", async () => {
    const pcts = [], phases = [];
    const p = mod.loadModel((x) => pcts.push(x), (x) => phases.push(x));
    const outcome = p.then(() => "resolved", (e) => e);
    await flush();
    const w = FakeWorker.all[0];
    expect(w.sent[0]).toEqual({ type: "probe" });
    w.emit({ type: "probe", probe: GOOD_PROBE });
    expect(w.sent[1].variant).toMatchObject({ dtype: "q4f16", device: "webgpu" });
    // Le graphe arrive d'abord : à 100 %, ce n'est PAS la fin (les poids suivent).
    w.emit(progress("onnx/model_q4f16.onnx", GRAPH, GRAPH));
    expect(phases.at(-1)).toEqual({ phase: "download", device: "webgpu" });
    w.emit(progress("onnx/model_q4f16.onnx_data", MB / 2, MB));
    w.emit(progress("onnx/model_q4f16.onnx_data", MB, MB));
    expect(pcts.at(-1)).toBe(100);
    expect(phases.at(-1)).toEqual({ phase: "init", device: "webgpu" });

    await vi.advanceTimersByTimeAsync(179_000);
    expect(w.terminated).toBe(false); // encore dans le délai

    await vi.advanceTimersByTimeAsync(3_000);
    const e = await outcome;
    expect(e).toMatchObject({ name: "ModelError", code: "webgpu_init_timeout", seconds: 180, mb: 294 });
    expect(w.terminated).toBe(true);
    expect(store.get("velohnav_ai_webgpu_ko")).toBeTruthy();
    expect(mod.chatModelMB()).toBe(294); // l'interface annonce la taille du repli
    expect(mod.isModelReady()).toBe(false);

    // « Réessayer » : worker neuf, plus de sonde, directement WASM / q4.
    const retry = mod.loadModel();
    await flush();
    const w2 = FakeWorker.all[1];
    expect(w2).not.toBe(w);
    expect(w2.sent).toEqual([{ type: "load", variant: expect.objectContaining({ dtype: "q4", device: "wasm" }) }]);
    w2.emit(progress("onnx/model_q4.onnx", 10, 10));
    w2.emit(progress("onnx/model_q4.onnx_data", 10, 10));
    w2.emit({ type: "ready" });
    await expect(retry).resolves.toBeUndefined();
    expect(mod.isModelReady()).toBe(true);
  });

  it("sonde défavorable : WASM d'emblée, un seul téléchargement", async () => {
    mod.loadModel().catch(() => {});
    await flush();
    const w = FakeWorker.all[0];
    w.emit({ type: "probe", probe: { ...GOOD_PROBE, features: [] } });   // pas de shader-f16
    const loads = w.sent.filter((m) => m.type === "load");
    expect(loads).toHaveLength(1);
    expect(loads[0].variant.dtype).toBe("q4");
  });

  it("coupure réseau pendant le téléchargement : échec explicite, GPU non condamné", async () => {
    const outcome = mod.loadModel().then(() => "resolved", (e) => e);
    await flush();
    const w = FakeWorker.all[0];
    w.emit({ type: "probe", probe: GOOD_PROBE });
    w.emit(progress("onnx/model_q4f16.onnx_data", 1000, MB));
    await vi.advanceTimersByTimeAsync(92_000);
    expect(await outcome).toMatchObject({ code: "download_timeout", seconds: 90 });
    expect(w.terminated).toBe(true);
    expect(store.has("velohnav_ai_webgpu_ko")).toBe(false);
  });

  it("erreur remontée par le worker : rapportée avec sa raison, pas avalée", async () => {
    store.set("velohnav_ai_webgpu_ko", "1");
    const outcome = mod.loadModel().then(() => "resolved", (e) => e);
    await flush();
    const w = FakeWorker.all[0];
    w.emit(progress("onnx/model_q4.onnx", 5, 5));
    w.emit(progress("onnx/model_q4.onnx_data", 5, 5));
    w.emit({ type: "error", message: "RangeError: Array buffer allocation failed" });
    expect(await outcome).toMatchObject({ code: "wasm_init", detail: "RangeError: Array buffer allocation failed" });
    expect(w.terminated).toBe(true);
  });

  it("une réponse qui ne vient jamais : délai, worker arrêté, erreur generate_timeout", async () => {
    store.set("velohnav_ai_webgpu_ko", "1");
    const loading = mod.loadModel();
    await flush();
    const w = FakeWorker.all[0];
    w.emit({ type: "ready" });
    await loading;
    const outcome = mod.generate("sys", [{ role: "user", content: "salut" }]).then(() => "resolved", (e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.sent.at(-1).type).toBe("generate");
    await vi.advanceTimersByTimeAsync(181_000);
    expect(await outcome).toMatchObject({ code: "generate_timeout", seconds: 180 });
    expect(w.terminated).toBe(true);
    expect(mod.isModelReady()).toBe(false);
  });

  it("une réponse normale traverse le worker et est nettoyée", async () => {
    store.set("velohnav_ai_webgpu_ko", "1");
    const loading = mod.loadModel();
    await flush();
    const w = FakeWorker.all[0];
    w.emit({ type: "ready" });
    await loading;
    const reply = mod.generate("sys", [{ role: "user", content: "salut" }]);
    await vi.advanceTimersByTimeAsync(0);
    const req = w.sent.at(-1);
    // Messages bruts : c'est le worker qui applique le gabarit du modèle
    expect(req.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "salut" }]);
    w.emit({ type: "result", id: req.id, text: "Bonjour !<|im_end|>" });
    await expect(reply).resolves.toBe("Bonjour !");
  });
});
