import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { planNative, gpuSetAside, NATIVE_MODEL, nativeFingerprint, SECOND_TURN } from "./modelPolicy.js";

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
// modelExists : le GGUF est déjà sur l'appareil (le natif est « prêt »).
const STATUS = { supported: true, reason: "", device: "Xiaomi 2107113SG", soc: "QTI SM7325", modelExists: true };
const ABSENT = { ...STATUS, modelExists: false, partialBytes: 0 };
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
    // Deux premiers appels après un chargement : l'essai à vide (deux tours) ; ensuite les
    // questions. `selfTest[backend]` : réponse du premier tour, ou [premier, second].
    generate: vi.fn(async (req) => {
      p.calls.push({ backend, ...req });
      const n = p.calls.filter((c) => c.backend === backend).length;
      const st = [].concat(selfTest[backend] ?? []);
      const r = n <= 2 ? st[n - 1] : null;
      if (r instanceof Error) throw r;
      if (r) return r;
      if (n > 2 && typeof reply === "function") return reply(backend, req);
      const text = n === 1 ? "Bonjour ! Comment ça va ?<|im_end|>" : n === 2 ? "Bien sûr, je peux vous aider.<|im_end|>" : reply;
      return ok({ text, stats: STATS });
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
  emit(data) { this.onmessage?.({ data }); }
  get load() { return this.sent.find((m) => m.type === "load"); }
}
const GOOD_PROBE = {
  adapter: true, isFallbackAdapter: false, info: { vendor: "qualcomm", architecture: "adreno-7xx" }, features: ["shader-f16"],
  limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 31 }, device: { ok: true },
};
// La voie JavaScript jusqu'à « prêt » : sonde, fichiers reçus, essai à vide juste (deux tours).
async function ladderReady(w, probe = GOOD_PROBE) {
  await vi.waitFor(() => expect(w.sent.length).toBeGreaterThan(0));
  if (w.sent[0].type === "probe") w.emit({ type: "probe", probe });   // sonde déjà faite : pas de seconde
  for (const f of w.load.variant.files) w.emit({ type: "progress", ev: { status: "progress", file: f, loaded: 10, total: 10 } });
  w.emit({ type: "ready", selfTest: "Bonjour ! Comment puis-je vous aider ?", selfTest2: "Bien sûr, je peux vous aider.", loadMs: 9000 });
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
    expect(p.download).not.toHaveBeenCalled();   // le GGUF est là : rien à attendre
    expect(p.load).toHaveBeenCalledTimes(1);
    expect(p.load.mock.calls[0][0]).toMatchObject({ backend: "vulkan" });
    const r = mod.modelReport();
    expect(r.chosen).toMatchObject({ id: "q4_0/vulkan", engine: "vulkan", device: "native", dtype: "q4_0", gpuName: "Adreno (TM) 642L" });
    expect(gpuSetAside(r)).toBeNull();   // le GPU sert : rien à justifier
    expect(r.native).toBeNull();          // natif retenu : pas de repli à dire
    expect(phases.map((x) => [x.phase, x.attempt])).toEqual([["init", "q4_0/vulkan"]]);
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
    expect(p.download).not.toHaveBeenCalled();   // même fichier, déjà là : rien retéléchargé
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
    expect(mod.modelReport().native).toMatchObject({ kind: "failed", detail: expect.stringContaining("q4_0/vulkan → crash") });
    mod.unloadModel();
  });

  it("natif ABSENT (GGUF pas téléchargé) : repli immédiat vers WebGPU, rien attendu ; le GGUF arrive ensuite en arrière-plan", async () => {
    let finish;
    const p = fakePlugin({ status: ABSENT, download: () => new Promise((r) => { finish = r; }) });
    await setup(p);
    const loading = mod.loadModel();
    await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    // Aucun moteur natif sollicité, aucun téléchargement de 219 Mo AVANT la voie JavaScript
    expect(p.load).not.toHaveBeenCalled();
    expect(p.download).not.toHaveBeenCalled();
    expect(mod.modelReport().native).toEqual({ kind: "absent", detail: "" });
    await ladderReady(FakeWorker.all[0]);
    await loading;
    // La voie GPU WebGPU qui fonctionne est gardée : le repli ne la remplace pas
    expect(mod.isModelReady()).toBe(true);
    expect(mod.modelReport().chosen).toMatchObject({ engine: "webgpu", device: "webgpu" });
    expect(FakeWorker.all[0].load).toMatchObject({ engine: "webgpu" });
    // Le modèle est prêt AVANT la fin du téléchargement natif, lancé ensuite en arrière-plan
    await vi.waitFor(() => expect(p.download).toHaveBeenCalledTimes(1));
    expect(p.download).toHaveBeenCalledWith(expect.objectContaining({ file: NATIVE_MODEL.file, bytes: NATIVE_MODEL.bytes, sha256: NATIVE_MODEL.sha256 }));
    expect(store.has("velohnav_ai_native_ko")).toBe(false);   // rien de condamné
    finish({ cached: false });
    // Lancement suivant : le GGUF est là, le natif est retenu
    mod.unloadModel();
    p.status.mockImplementation(async () => STATUS);
    await mod.loadModel();
    expect(mod.modelReport().chosen).toMatchObject({ engine: "vulkan", device: "native" });
    expect(mod.modelReport().native).toBeNull();
    expect(FakeWorker.all).toHaveLength(1);
  });

  it("GGUF en arrière-plan : progression suivie, puis « done » — l'écran peut basculer sans attendre le lancement suivant", async () => {
    let progress, finish;
    const p = fakePlugin({ status: ABSENT, download: () => new Promise((r) => { finish = r; }) });
    p.addListener.mockImplementation(async (_, fn) => { progress = fn; return { remove() {} }; });
    await setup(p);
    const seen = [];
    const off = mod.onNativeDownload((s) => seen.push(s));
    const loading = mod.loadModel();
    await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    await ladderReady(FakeWorker.all[0]);
    await loading;
    await vi.waitFor(() => expect(p.download).toHaveBeenCalledTimes(1));
    progress({ loaded: NATIVE_MODEL.bytes * 0.42, total: NATIVE_MODEL.bytes });
    expect(mod.modelReport().nativeDownload).toEqual({ state: "running", pct: 42, detail: "" });
    finish({ cached: false });
    await vi.waitFor(() => expect(mod.modelReport().nativeDownload).toMatchObject({ state: "done", pct: 100 }));
    expect(seen.map((s) => s?.state)).toEqual(["running", "running", "running", "done"]);
    off();
    // Rechargement demandé par l'écran : le GGUF est là, le GPU natif est retenu, le suivi s'efface
    mod.unloadModel();
    p.status.mockImplementation(async () => STATUS);
    await mod.loadModel();
    expect(mod.modelReport().chosen).toMatchObject({ engine: "vulkan" });
    expect(mod.modelReport().nativeDownload).toBeNull();
  });

  it("natif absent ET voie JavaScript en échec complet : le GGUF est tout de même téléchargé (seule chance d'avoir le GPU)", async () => {
    const p = fakePlugin({ status: ABSENT, download: () => new Promise(() => {}) });
    await setup(p);
    const loading = mod.loadModel().catch((e) => e);
    await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    const w = FakeWorker.all[0];
    await vi.waitFor(() => expect(w.sent.length).toBeGreaterThan(0));
    w.emit({ type: "probe", probe: null });   // pas de WebGPU : processeur WASM seul
    await vi.waitFor(() => expect(w.load).toBeTruthy());
    w.emit({ type: "error", stage: "engine", message: "no available backend found" });
    expect((await loading).code).toBe("all_failed");
    await vi.waitFor(() => expect(p.download).toHaveBeenCalledTimes(1));
    expect(mod.modelReport().nativeDownload).toMatchObject({ state: "running" });
    mod.unloadModel();
  });

  it("natif absent, téléchargement en arrière-plan coupé : rien de condamné, le GGUF partiel n'est pas effacé", async () => {
    const p = fakePlugin({ status: { ...ABSENT, partialBytes: 50 * 2 ** 20 }, download: async () => { throw Object.assign(new Error("HTTP 503"), { code: "network" }); } });
    await setup(p);
    const loading = mod.loadModel();
    await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    expect(mod.modelReport().native).toEqual({ kind: "absent", detail: "50 Mo reçus" });
    await ladderReady(FakeWorker.all[0]);
    await loading;
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/téléchargement du modèle natif interrompu \(network\)/), expect.anything()));
    expect(mod.isModelReady()).toBe(true);
    expect(store.has("velohnav_ai_native_ko")).toBe(false);
    expect(p.deleteModels).not.toHaveBeenCalled();   // la reprise repartira du fichier partiel
  });

  it("greffon en échec (status rejette) : traité comme absent, la voie JavaScript part, aucune erreur", async () => {
    const p = fakePlugin();
    p.status.mockImplementation(async () => { throw new Error("plugin LocalLlm not implemented"); });
    await setup(p);
    const loading = mod.loadModel();
    await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    expect(p.load).not.toHaveBeenCalled();
    expect(mod.modelReport().native).toEqual({ kind: "unsupported", detail: "plugin LocalLlm not implemented" });
    await ladderReady(FakeWorker.all[0]);
    await expect(loading).resolves.toBeUndefined();
    expect(mod.modelReport().chosen).toMatchObject({ engine: "webgpu" });
  });

  it("appareil incompatible : la raison est dite, la voie JavaScript part", async () => {
    const p = fakePlugin({ status: { ...STATUS, supported: false, reason: "no-vulkan-1.2" } });
    await setup(p);
    mod.loadModel().catch(() => {});
    await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    expect(mod.modelReport().native).toEqual({ kind: "unsupported", detail: "no-vulkan-1.2" });
    expect(p.download).not.toHaveBeenCalled();
    mod.unloadModel();
  });

  it("Vulkan juste au premier tour, puis un mot faux (« weather », relevé sur téléphone) : écarté, processeur natif", async () => {
    const p = fakePlugin({ selfTest: { vulkan: [ok({ text: "Bonne nuit, cette question.<|im_end|>", stats: STATS }), ok({ text: "weather<|im_end|>", stats: STATS })] } });
    await setup(p);
    await mod.loadModel();
    // Le second tour reprend la réponse du premier, comme une vraie conversation
    expect(p.calls[1].rest).toContain("Bonne nuit, cette question.");
    expect(p.calls[1].rest).toContain(SECOND_TURN.question);
    const r = mod.modelReport();
    expect(r.chosen).toMatchObject({ engine: "native_cpu" });
    expect(r.tried).toEqual([{ id: "q4_0/vulkan", code: "selftest",
      detail: 'tour 2 one-word: "Bonne nuit, cette question.<|im_end|>" puis "weather<|im_end|>"' }]);
  });

  it("Vulkan figé au premier lancement (délai) : processeur natif cette fois, Vulkan REJOUÉ et retenu au suivant", async () => {
    vi.useFakeTimers();
    try {
      let hang = true;
      const p = fakePlugin();
      const load = p.load.getMockImplementation();
      p.load.mockImplementation((req) => (req.backend === "vulkan" && hang ? new Promise(() => {}) : load(req)));
      await setup(p);
      const first = mod.loadModel();
      await vi.advanceTimersByTimeAsync(121_000);
      await first;
      expect(mod.modelReport().chosen).toMatchObject({ engine: "native_cpu" });
      expect(JSON.parse(store.get("velohnav_ai_native_ko")).failed.vulkan).toMatch(/^transient: /);
      hang = false;
      mod.unloadModel();
      await mod.loadModel();
      expect(mod.modelReport().chosen).toMatchObject({ engine: "vulkan" });
      expect(JSON.parse(store.get("velohnav_ai_native_ko")).failed).toEqual({});
    } finally { vi.useRealTimers(); }
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

  it("greffon muet (status ne répond jamais) : 5 s au plus, puis la voie JavaScript", async () => {
    vi.useFakeTimers();
    try {
      const p = fakePlugin();
      p.status.mockImplementation(() => new Promise(() => {}));
      await setup(p);
      const loading = mod.loadModel();
      await vi.advanceTimersByTimeAsync(4_900);
      expect(FakeWorker.all).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(FakeWorker.all).toHaveLength(1);
      expect(mod.modelReport().native).toMatchObject({ kind: "unsupported", detail: expect.stringContaining("native status") });
      await ladderReady(FakeWorker.all[0]);
      await loading;
      expect(mod.modelReport().chosen).toMatchObject({ engine: "webgpu" });
      expect(p.load).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("natif prêt mais figé sur les DEUX moteurs : 150 s au total, puis la voie JavaScript ; rien de condamné, GGUF gardé", async () => {
    vi.useFakeTimers();
    try {
      const p = fakePlugin();
      p.load.mockImplementation(() => new Promise(() => {}));
      p.unload.mockImplementation(() => new Promise(() => {}));   // :llm muet, même pour s'arrêter
      await setup(p);
      const loading = mod.loadModel();
      // Vulkan : délai complet (initMs.native, 120 s), puis l'arrêt borné (5 s)
      await vi.advanceTimersByTimeAsync(126_000);
      expect(p.load.mock.calls.map((c) => c[0].backend)).toEqual(["vulkan", "cpu"]);
      expect(FakeWorker.all).toHaveLength(0);
      // Processeur natif : le reste du budget (jusqu'à 150 s), arrêt borné, voie JavaScript à 155 s
      await vi.advanceTimersByTimeAsync(28_000);
      expect(FakeWorker.all).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(FakeWorker.all).toHaveLength(1);
      const r = mod.modelReport();
      expect(r.tried.map((x) => [x.id, x.code])).toEqual([["q4_0/vulkan", "timeout"], ["q4_0/native_cpu", "timeout"]]);
      expect(r.native).toMatchObject({ kind: "timeout" });
      const ko = JSON.parse(store.get("velohnav_ai_native_ko")).failed;
      expect(ko.vulkan).toMatch(/^transient: /);
      expect(ko.cpu).toMatch(/^transient: /);
      expect(p.deleteModels).not.toHaveBeenCalled();
      await ladderReady(FakeWorker.all[0]);
      await loading;
      expect(mod.isModelReady()).toBe(true);
      expect(mod.modelReport().chosen).toMatchObject({ engine: "webgpu" });
    } finally { vi.useRealTimers(); }
  });

  it("processeur natif raccourci par le budget, deux lancements de suite : jamais condamné (seul un délai complet compte)", async () => {
    vi.useFakeTimers();
    try {
      const p = fakePlugin();
      p.load.mockImplementation(() => new Promise(() => {}));
      await setup(p);
      for (let i = 0; i < 2; i++) {
        const loading = mod.loadModel();
        await vi.advanceTimersByTimeAsync(156_000);
        await ladderReady(FakeWorker.all.at(-1));
        await loading;
        mod.unloadModel();
      }
      const ko = JSON.parse(store.get("velohnav_ai_native_ko")).failed;
      expect(ko.vulkan).not.toMatch(/^transient: /);   // deux délais complets : condamné (comme avant)
      expect(ko.cpu).toMatch(/^transient: /);          // 30 s seulement : rejoué
    } finally { vi.useRealTimers(); }
  });

  it("GGUF en arrière-plan qui ne reçoit plus rien : arrêté après 90 s, rien de condamné, le modèle reste prêt", async () => {
    vi.useFakeTimers();
    try {
      const p = fakePlugin({ status: ABSENT, download: () => new Promise(() => {}) });
      await setup(p);
      const loading = mod.loadModel();
      await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
      await ladderReady(FakeWorker.all[0]);
      await loading;
      await vi.waitFor(() => expect(p.download).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(89_000);
      expect(p.cancelDownload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(p.cancelDownload).toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/interrompu \(timeout\)/), expect.anything());
      expect(mod.isModelReady()).toBe(true);
      expect(store.has("velohnav_ai_native_ko")).toBe(false);
    } finally { vi.useRealTimers(); }
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
