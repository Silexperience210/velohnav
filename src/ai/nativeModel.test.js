import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { planNative, gpuSetAside, NATIVE_MODEL, nativeFingerprint } from "./modelPolicy.js";

// Le moteur natif (llama.cpp, Vulkan) est la PREMIÈRE voie quand l'APK l'embarque ; s'il
// est absent ou en échec, l'échelle WebGPU / processeur part d'elle-même, sans erreur ni clic.

describe("planNative : quels moteurs natifs tenter", () => {
  it("pas de greffon (navigateur) : rien, sans raison à afficher", () => {
    expect(planNative({ status: null })).toEqual({ queue: [], skipped: [] });
  });
  it("APK sans le moteur : rien à tenter", () => {
    expect(planNative({ status: { supported: false, reason: "not-built" } }).queue).toEqual([]);
  });
  it("disponible : GPU Vulkan d'abord, puis processeur natif", () => {
    expect(planNative({ status: { supported: true } }).queue).toEqual(["vulkan", "cpu"]);
  });
  it("Vulkan en échec mémorisé : processeur natif seul", () => {
    const p = planNative({ status: { supported: true }, failed: { vulkan: "crash" } });
    expect(p.queue).toEqual(["cpu"]);
    expect(p.skipped).toEqual([{ backend: "vulkan", reason: "failed-before: crash" }]);
  });
});

// ── Façade rejouée avec un faux greffon LocalLlm ──────────────────────
const STATUS = { supported: true, reason: "", device: "Xiaomi 2107113SG", soc: "QTI SM7325" };
const ok = (o) => ({ result: JSON.stringify({ ok: true, ...o }) });
const bad = (error, log = "") => ({ result: JSON.stringify({ ok: false, error, log }) });
const STATS = { promptTokens: 30, reusedTokens: 0, genTokens: 20, promptMs: 80, genMs: 500, eog: true };
const INFO = { vulkan: { backend: "vulkan", device: "Vulkan0", description: "Adreno (TM) 642L", threads: 4 }, cpu: { backend: "cpu", device: "CPU", threads: 4 } };

function fakePlugin({ status = STATUS, load = {}, selfTest = {}, reply = "Bonjour ! Comment puis-je vous aider ?<|im_end|>", download } = {}) {
  let backend = null;
  const p = {
    calls: [],
    status: vi.fn(async () => status),
    addListener: vi.fn(async () => ({ remove() {} })),
    download: vi.fn(download || (async () => ({ cached: false }))),
    cancelDownload: vi.fn(async () => {}),
    deleteModels: vi.fn(async () => ({ freedBytes: NATIVE_MODEL.bytes })),
    load: vi.fn(async ({ backend: b }) => {
      backend = b;
      const r = load[b];
      if (r instanceof Error) throw r;
      return r || ok({ info: INFO[b] });
    }),
    // Premier appel après un chargement : l'essai à vide ; ensuite les questions.
    generate: vi.fn(async (req) => {
      p.calls.push({ backend, ...req });
      const first = p.calls.filter((c) => c.backend === backend).length === 1;
      const r = first ? selfTest[backend] : null;
      if (r instanceof Error) throw r;
      if (r) return r;
      if (!first && typeof reply === "function") return reply(backend, req);
      return ok({ text: first ? "Bonjour ! Comment ça va ?<|im_end|>" : reply, stats: STATS });
    }),
    warm: vi.fn(async () => ok({})),
    cancel: vi.fn(async () => {}),
    unload: vi.fn(async () => {}),
  };
  return p;
}
const crash = () => Object.assign(new Error("crash during load vulkan"), { code: "crash" });

class FakeWorker {
  static all = [];
  constructor() { this.sent = []; FakeWorker.all.push(this); }
  postMessage(m) { this.sent.push(m); }
  terminate() { this.terminated = true; }
}

describe("façade : le moteur natif d'abord, repli silencieux ensuite", () => {
  let mod, native, store;
  const setup = async (plugin) => {
    native = await import("./nativeModel.js");
    native.setNativePlugin(plugin);
    mod = await import("./localModel.js");
  };
  beforeEach(() => {
    vi.resetModules();
    FakeWorker.all = [];
    store = new Map();
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("localStorage", {
      getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("disponible : le GPU natif est retenu, aucun worker WebGPU, l'écran peut le dire", async () => {
    const p = fakePlugin();
    await setup(p);
    const phases = [];
    await mod.loadModel(() => {}, (x) => phases.push(x));
    expect(mod.isModelReady()).toBe(true);
    expect(FakeWorker.all).toHaveLength(0);
    expect(p.download).toHaveBeenCalledWith(expect.objectContaining({ file: NATIVE_MODEL.file, bytes: NATIVE_MODEL.bytes, sha256: NATIVE_MODEL.sha256 }));
    expect(p.load).toHaveBeenCalledTimes(1);
    expect(p.load.mock.calls[0][0]).toMatchObject({ backend: "vulkan" });
    const r = mod.modelReport();
    expect(r.chosen).toMatchObject({ id: "q4_0/vulkan", engine: "vulkan", device: "native", dtype: "q4_0", gpuName: "Adreno (TM) 642L" });
    expect(gpuSetAside(r)).toBeNull();   // le GPU sert : rien à justifier
    expect(phases.map((x) => [x.phase, x.attempt])).toEqual([["download", "q4_0/vulkan"], ["init", "q4_0/vulkan"]]);
    expect(mod.chatModelMB()).toBe(219);
  });

  it("une réponse passe par le moteur natif, même gabarit, vitesse mesurée", async () => {
    const p = fakePlugin();
    await setup(p);
    await mod.loadModel();
    const out = await mod.generateDetailed("Tu es un assistant.", [{ role: "user", content: "Salut" }], { maxNewTokens: 96 });
    expect(out.text).toBe("Bonjour ! Comment puis-je vous aider ?");
    expect(out.stats).toMatchObject({ engine: "vulkan", tokens: 20, tps: 40, genOnly: true });
    const req = p.calls.at(-1);
    expect(req.maxTokens).toBe(96);
    expect(req.prefix).toBe("<|startoftext|><|im_start|>system\nTu es un assistant.<|im_end|>\n");
    expect(req.rest).toBe("<|im_start|>user\nSalut<|im_end|>\n<|im_start|>assistant\n");
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("APK construite sans le moteur : rien téléchargé, l'échelle WebGPU part, aucune erreur", async () => {
    const p = fakePlugin({ status: { supported: false, reason: "not-built" } });
    await setup(p);
    mod.loadModel().catch(() => {});
    await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    expect(p.download).not.toHaveBeenCalled();
    expect(p.load).not.toHaveBeenCalled();
    expect(mod.modelReport().tried).toEqual([]);
    expect(mod.modelReport().skipped).toEqual([]);   // « non embarqué » n'est pas montré
    mod.unloadModel();
  });

  it("Vulkan calcule faux (essai à vide « 鹰 ») : processeur natif, même fichier, Vulkan mémorisé", async () => {
    const p = fakePlugin({ selfTest: { vulkan: ok({ text: "鹰<|im_end|>", stats: STATS }) } });
    await setup(p);
    await mod.loadModel();
    expect(p.download).toHaveBeenCalledTimes(1);   // pas de second téléchargement
    expect(p.load.mock.calls.map((c) => c[0].backend)).toEqual(["vulkan", "cpu"]);
    const r = mod.modelReport();
    expect(r.chosen).toMatchObject({ id: "q4_0/native_cpu", engine: "native_cpu" });
    expect(r.tried).toEqual([{ id: "q4_0/vulkan", code: "selftest", detail: 'no-word: "鹰<|im_end|>"' }]);
    // L'écran dit pourquoi le GPU ne sert pas, et qu'on peut le retenter sans rien télécharger
    expect(gpuSetAside(r)).toEqual({ reasons: [{ ids: ["q4_0/vulkan"], kind: "failed", detail: 'no-word: "鹰<|im_end|>"' }], retry: true, downloadMB: 0 });
    expect(JSON.parse(store.get("velohnav_ai_native_ko"))).toMatchObject({ fingerprint: nativeFingerprint(STATUS), failed: { vulkan: expect.any(String) } });
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("lancement suivant : Vulkan n'est pas rejoué, le processeur natif part directement", async () => {
    store.set("velohnav_ai_native_ko", JSON.stringify({ fingerprint: nativeFingerprint(STATUS), failed: { vulkan: "crash" } }));
    const p = fakePlugin();
    await setup(p);
    await mod.loadModel();
    expect(p.load.mock.calls.map((c) => c[0].backend)).toEqual(["cpu"]);
    expect(mod.modelReport().skipped).toEqual([{ id: "q4_0/vulkan", reason: "failed-before: crash" }]);
    // « Réessayer le GPU » oublie aussi les échecs natifs
    mod.forgetFailures();
    expect(store.has("velohnav_ai_native_ko")).toBe(false);
  });

  it("les deux moteurs natifs échouent : GGUF effacé (un seul modèle), l'échelle WebGPU part sans erreur", async () => {
    const p = fakePlugin({ load: { vulkan: crash(), cpu: bad("model load failed on cpu", "llama_model_load: error") } });
    await setup(p);
    mod.loadModel().catch(() => {});
    await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    expect(p.deleteModels).toHaveBeenCalledWith({ keep: "" });
    expect(mod.modelReport().tried.map((x) => [x.id, x.code])).toEqual([["q4_0/vulkan", "crash"], ["q4_0/native_cpu", "load"]]);
    expect(mod.modelReport().tried[1].detail).toContain("llama_model_load: error");   // journal du moteur gardé
    expect(FakeWorker.all[0].sent[0]).toEqual({ type: "probe" });
    mod.unloadModel();
  });

  it("réseau coupé pendant le téléchargement du GGUF : rien de condamné, l'échelle prend le relais", async () => {
    const p = fakePlugin({ download: async () => { throw Object.assign(new Error("HTTP 503"), { code: "network" }); } });
    await setup(p);
    mod.loadModel().catch(() => {});
    await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    expect(store.has("velohnav_ai_native_ko")).toBe(false);
    expect(p.deleteModels).not.toHaveBeenCalled();   // la reprise repartira du fichier partiel
    mod.unloadModel();
  });

  it("le processus :llm meurt en pleine réponse : Vulkan écarté, `recover`, le rechargement prend le processeur natif", async () => {
    const p = fakePlugin({ reply: (b) => { if (b === "vulkan") throw crash(); return ok({ text: "Salut !<|im_end|>", stats: STATS }); } });
    await setup(p);
    await mod.loadModel();
    const e = await mod.generateDetailed("", [{ role: "user", content: "Salut" }]).catch((x) => x);
    expect(e).toMatchObject({ code: "generate", recover: true });
    expect(mod.isModelReady()).toBe(false);
    expect(p.unload).toHaveBeenCalled();
    mod.unloadModel();
    await mod.loadModel();
    expect(mod.modelReport().chosen).toMatchObject({ engine: "native_cpu" });
    expect((await mod.generateDetailed("", [{ role: "user", content: "Salut" }])).text).toBe("Salut !");
  });

  it("conversation désactivée : le processus :llm est arrêté, sa mémoire rendue", async () => {
    const p = fakePlugin();
    await setup(p);
    await mod.loadModel();
    mod.unloadModel();
    expect(mod.isModelReady()).toBe(false);
    await vi.waitFor(() => expect(p.unload).toHaveBeenCalled());
  });

  it("la consigne est calculée d'avance par le moteur natif", async () => {
    const p = fakePlugin();
    await setup(p);
    await mod.loadModel();
    mod.warmUp("Tu es un assistant.");
    await vi.waitFor(() => expect(p.warm).toHaveBeenCalledWith({ prefix: "<|startoftext|><|im_start|>system\nTu es un assistant.<|im_end|>\n" }));
  });
});
