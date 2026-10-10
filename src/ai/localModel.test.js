import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chooseVariant, cleanReply } from "./localModel.js";

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

// Sorties brutes du banc (scripts/bench-chat, LFM2.5-350M q4) : la réponse s'arrête à la
// fin de tour, et une génération coupée par max_new_tokens n'est jamais montrée coupée.
describe("nettoyage de la sortie brute", () => {
  it.each([
    ["fin de tour : jeton retiré", "Bonjour !<|im_end|>", "Bonjour !"],
    ["rien après la fin de tour", "Bonjour !<|im_end|><|im_start|>user\nbuck", "Bonjour !"],
    ["coupée : ramenée à la dernière phrase complète",
      "Voici une blague :\nLes vélos sont trop lourds pour le trottinage ! 😄\n\n(Bonus : on pourrait aussi dire : \"Pourquoi les vélos portent-ils des sacs",
      "Voici une blague :\nLes vélos sont trop lourds pour le trottinage !"],
    ["coupée sans phrase complète : rien", "地黎 talk\"talk\" buck", ""],
    ["appel d'outil complet conservé", "<|tool_call_start|>[weather()]<|tool_call_end|><|im_end|>", "<|tool_call_start|>[weather()]<|tool_call_end|>"],
    ["appel d'outil coupé laissé à la validation", '<|tool_call_start|>[route(destination="Ga', '<|tool_call_start|>[route(destination="Ga'],
  ])("%s", (_, raw, out) => {
    expect(cleanReply(raw)).toBe(out);
  });
});

// ── Façade rejouée avec un faux worker ──────────────────────────────
// Un worker par tentative (un moteur onnxruntime par worker). Le passage d'une tentative
// à la suivante se fait sans rien demander ; seul l'échec de TOUTES remonte.
class FakeWorker {
  static all = [];
  constructor() { this.sent = []; this.terminated = false; FakeWorker.all.push(this); }
  postMessage(m) { this.sent.push(m); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage?.({ data }); }
  get load() { return this.sent.find((m) => m.type === "load"); }
}

const GOOD_PROBE = {
  adapter: true, isFallbackAdapter: false, info: { vendor: "arm", architecture: "valhall" }, features: ["shader-f16"],
  limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 31 }, device: { ok: true },
};
const NO_F16_PROBE = { ...GOOD_PROBE, features: ["subgroups"] };
const MB = 254_965_760;   // model_q4f16.onnx_data
const GRAPH = 182_827;    // model_q4f16.onnx
// Contrôle mémoire (asynchrone) avant chaque worker
const flush = () => vi.advanceTimersByTimeAsync(0);
const progress = (file, loaded, total) => ({ type: "progress", ev: { status: "progress", file, loaded, total } });
const last = () => FakeWorker.all.at(-1);
const filesDone = (w) => { for (const f of w.load.variant.files) w.emit(progress(f, 10, 10)); };
const SUB_F16 = "failed to call OrtRun(). Sub requires f16 but the device does not support it.";

describe("façade : l'échelle des tentatives, sans rien demander", () => {
  let mod, store;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeWorker.all = [];
    store = new Map();
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("localStorage", {
      getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    mod = await import("./localModel.js");
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("cas du propriétaire : le GPU refuse tout, le modèle démarre SUR LE PROCESSEUR sans erreur ni clic", async () => {
    const phases = [];
    const loading = mod.loadModel(() => {}, (p) => phases.push(p));
    await flush();
    const w1 = last();
    expect(w1.sent[0]).toEqual({ type: "probe" });
    w1.emit({ type: "probe", probe: GOOD_PROBE });
    expect(w1.load).toMatchObject({ engine: "webgpu", variant: { dtype: "q4f16", device: "webgpu" } });
    filesDone(w1);
    w1.emit({ type: "error", message: SUB_F16, log: ["error: shader_helper.cc:416 Program Sub requires f16"] });
    await flush();
    // q4f16 avec l'autre moteur GPU : mêmes fichiers, aucun téléchargement, pas de nouvelle sonde
    const w2 = last();
    expect(w1.terminated).toBe(true);
    expect(w2).not.toBe(w1);
    expect(w2.sent.some((m) => m.type === "probe")).toBe(false);
    expect(w2.load).toMatchObject({ engine: "jsep", variant: { dtype: "q4f16" } });
    filesDone(w2);
    w2.emit({ type: "ready", selfTest: "" });   // <|pad|> en boucle : rien de lisible (mesuré)
    await flush();
    const w3 = last();
    expect(w3.load).toMatchObject({ engine: "webgpu", variant: { dtype: "q4", device: "webgpu" } });
    filesDone(w3);
    w3.emit({ type: "error", message: "GPU validation error" });
    await flush();
    const w4 = last();
    expect(w4.load).toMatchObject({ engine: "jsep", variant: { dtype: "q4" } });
    filesDone(w4);
    await vi.advanceTimersByTimeAsync(181_000);   // bloqué : le chien de garde tranche
    await flush();
    const w5 = last();
    expect(w4.terminated).toBe(true);
    expect(w5.load).toMatchObject({ engine: "wasm", variant: { dtype: "q4", device: "wasm" } });
    filesDone(w5);
    w5.emit({ type: "ready", selfTest: "Bonjour ! Comment puis-", loadMs: 41_000 });
    await expect(loading).resolves.toBeUndefined();
    expect(mod.isModelReady()).toBe(true);

    const r = mod.modelReport();
    expect(r.chosen).toMatchObject({ id: "q4/wasm", engine: "wasm", device: "wasm", dtype: "q4", mb: 294, loadMs: 41_000 });
    expect(r.tried.map((x) => [x.id, x.code])).toEqual([
      ["q4f16/webgpu", "init"], ["q4f16/jsep", "init"], ["q4/webgpu", "init"], ["q4/jsep", "init_timeout"],
    ]);
    // le message du moteur ET la ligne de journal qui l'explique sont conservés
    expect(r.tried[0].detail).toContain("Sub requires f16");
    expect(r.tried[0].detail).toContain("shader_helper.cc:416");
    expect(r.gpu).toMatchObject({ vendor: "arm", architecture: "valhall", f16: true });
    expect(mod.chatModelMB()).toBe(294);
    // chaque bascule annoncée à l'interface : quelle tentative, sur quel moteur
    expect(phases.filter((p) => p.phase === "download").map((p) => p.attempt))
      .toEqual(["q4f16/webgpu", "q4f16/jsep", "q4/webgpu", "q4/jsep", "q4/wasm"]);
    // q4f16 purgé une fois ses deux moteurs condamnés — jamais q4, qui sert au processeur
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(/^\[IA\] retenu : q4\/wasm/));
  });

  it("au lancement suivant : les tentatives en échec ne sont pas rejouées, le processeur part directement", async () => {
    store.set("velohnav_ai_attempts_ko", JSON.stringify({
      fingerprint: (await import("./modelPolicy.js")).deviceFingerprint(GOOD_PROBE),
      failed: { "q4f16/webgpu": "a", "q4f16/jsep": "b", "q4/webgpu": "c", "q4/jsep": "d" },
    }));
    const loading = mod.loadModel();
    await flush();
    last().emit({ type: "probe", probe: GOOD_PROBE });
    expect(FakeWorker.all).toHaveLength(1);
    expect(last().load).toMatchObject({ engine: "wasm" });
    last().emit({ type: "ready", selfTest: "Bonjour !" });
    await loading;
    expect(mod.modelReport().skipped.map((x) => x.id)).toEqual(["q4f16/webgpu", "q4f16/jsep", "q4/webgpu", "q4/jsep"]);
  });

  it("GPU sans shader-f16 (mesuré sur un vrai GPU) : q4 sur le GPU d'emblée, un seul téléchargement", async () => {
    const loading = mod.loadModel();
    await flush();
    last().emit({ type: "probe", probe: NO_F16_PROBE });
    expect(last().load).toMatchObject({ engine: "webgpu", variant: { dtype: "q4", device: "webgpu" } });
    last().emit({ type: "ready", selfTest: "Bonjour !", loadMs: 4106 });
    await loading;
    expect(mod.modelReport().chosen).toMatchObject({ id: "q4/webgpu", device: "webgpu" });
  });

  it("toutes les voies échouent : UNE erreur, « all_failed », avec chaque raison ; aucune boucle", async () => {
    const outcome = mod.loadModel().then(() => "resolved", (e) => e);
    await flush();
    last().emit({ type: "probe", probe: GOOD_PROBE });
    for (let i = 0; i < 5; i++) {
      const w = last();
      filesDone(w);
      w.emit({ type: "error", message: `échec ${w.load.variant.dtype}/${w.load.engine}` });
      await flush();
    }
    const e = await outcome;
    expect(e).toMatchObject({ name: "ModelError", code: "all_failed" });
    expect(e.attempts).toHaveLength(5);
    expect(e.detail).toContain("q4/wasm → init (échec q4/wasm)");
    expect(FakeWorker.all).toHaveLength(5);
    // Rechargement sans « Réessayer » : rien n'est retenté, aucun worker créé
    const again = await mod.loadModel().then(() => "resolved", (x) => x);
    expect(again.code).toBe("all_failed");
    expect(FakeWorker.all).toHaveLength(5);
    // « Réessayer » après all_failed : les échecs sont oubliés, l'échelle repart du début
    mod.forgetFailures();
    mod.loadModel().catch(() => {});
    await flush();
    expect(last().load).toMatchObject({ engine: "webgpu", variant: { dtype: "q4f16" } });
  });

  it("erreur avant tout fichier reçu (hors ligne : config.json introuvable) : arrêt sans rien condamner", async () => {
    const outcome = mod.loadModel().then(() => "resolved", (e) => e);
    await flush();
    last().emit({ type: "probe", probe: GOOD_PROBE });
    last().emit({ type: "error", message: "TypeError: Failed to fetch" });
    expect(await outcome).toMatchObject({ code: "setup" });
    expect(FakeWorker.all).toHaveLength(1);
    expect(store.has("velohnav_ai_attempts_ko")).toBe(false);
  });

  it("le moteur lui-même refuse de se charger : propre à la tentative, la suivante part", async () => {
    mod.loadModel().catch(() => {});
    await flush();
    last().emit({ type: "probe", probe: GOOD_PROBE });
    last().emit({ type: "error", stage: "engine", message: "Failed to fetch dynamically imported module" });
    await flush();
    expect(last().load).toMatchObject({ engine: "jsep" });
  });

  it("coupure réseau pendant le téléchargement : erreur dite, rien de condamné, reprise au même endroit", async () => {
    const outcome = mod.loadModel().then(() => "resolved", (e) => e);
    await flush();
    const w = last();
    w.emit({ type: "probe", probe: GOOD_PROBE });
    w.emit(progress("onnx/model_q4f16.onnx_data", 1000, MB));
    await vi.advanceTimersByTimeAsync(92_000);
    expect(await outcome).toMatchObject({ code: "download_timeout", seconds: 90 });
    expect(w.terminated).toBe(true);
    expect(store.has("velohnav_ai_attempts_ko")).toBe(false);
    mod.loadModel().catch(() => {});
    await flush();
    expect(last().load).toMatchObject({ engine: "webgpu", variant: { dtype: "q4f16" } });
  });

  it("WebGPU figé à 100 % : le graphe à 100 % ne suffit pas, puis délai d'initialisation, puis tentative suivante", async () => {
    const pcts = [], phases = [];
    mod.loadModel((x) => pcts.push(x), (x) => phases.push(x)).catch(() => {});
    await flush();
    const w = last();
    w.emit({ type: "probe", probe: GOOD_PROBE });
    w.emit(progress("onnx/model_q4f16.onnx", GRAPH, GRAPH));
    expect(phases.at(-1)).toMatchObject({ phase: "download", device: "webgpu", attempt: "q4f16/webgpu" });
    w.emit(progress("onnx/model_q4f16.onnx_data", MB / 2, MB));
    w.emit(progress("onnx/model_q4f16.onnx_data", MB, MB));
    expect(pcts.at(-1)).toBe(100);
    expect(phases.at(-1)).toMatchObject({ phase: "init", engine: "webgpu" });
    await vi.advanceTimersByTimeAsync(179_000);
    expect(w.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.terminated).toBe(true);
    expect(last().load).toMatchObject({ engine: "jsep" });
    expect(mod.modelReport().tried).toEqual([{ id: "q4f16/webgpu", code: "init_timeout", detail: "timeout 180 s" }]);
  });

  it("« prêt » exige l'essai à vide : sans texte, ou charabia, la tentative est écartée", async () => {
    mod.loadModel().catch(() => {});
    await flush();
    last().emit({ type: "probe", probe: GOOD_PROBE });
    for (const selfTest of [undefined, "", "地黎 talk"]) {
      const w = last();
      w.emit({ type: "ready", selfTest });
      await flush();
      expect(w.terminated).toBe(true);
      expect(mod.isModelReady()).toBe(false);
    }
    expect(mod.modelReport().tried.map((x) => x.detail.split(":")[0]))
      .toEqual(["self-test no-output", "self-test no-word", "self-test script"]);
  });

  it("anciennes clés : « fp16 en échec » repris (pas de second téléchargement q4f16), « GPU condamné » non — q4 sur le GPU retenté", async () => {
    store.set("velohnav_ai_f16_ko", "Sub requires f16");
    store.set("velohnav_ai_webgpu_ko", "1");
    mod.loadModel().catch(() => {});
    await flush();
    last().emit({ type: "probe", probe: GOOD_PROBE });
    expect(last().load).toMatchObject({ engine: "webgpu", variant: { dtype: "q4", device: "webgpu" } });
    expect(store.has("velohnav_ai_f16_ko")).toBe(false);
    expect(store.has("velohnav_ai_webgpu_ko")).toBe(false);
    expect(Object.keys(JSON.parse(store.get("velohnav_ai_attempts_ko")).failed).sort()).toEqual(["q4f16/jsep", "q4f16/webgpu"]);
  });

  it("q4f16 chargé mais la génération échoue (cas mesuré) : erreur dite, tentative écartée, `recover` → la suivante se charge", async () => {
    const loading = mod.loadModel();
    await flush();
    const w = last();
    w.emit({ type: "probe", probe: GOOD_PROBE });
    w.emit({ type: "ready", selfTest: "Bonjour !" });
    await loading;
    const reply = mod.generateDetailed("sys", [{ role: "user", content: "Je suis Silex" }]).then(() => "resolved", (e) => e);
    await vi.advanceTimersByTimeAsync(0);
    w.emit({ type: "result", id: w.sent.at(-1).id, error: SUB_F16 });
    expect(await reply).toMatchObject({ code: "generate", detail: SUB_F16, recover: true });
    expect(w.terminated).toBe(true);
    expect(mod.isModelReady()).toBe(false);
    expect(JSON.parse(store.get("velohnav_ai_attempts_ko")).failed["q4f16/webgpu"]).toContain("Sub requires f16");
    mod.loadModel().catch(() => {});
    await flush();
    expect(last().load).toMatchObject({ engine: "jsep", variant: { dtype: "q4f16" } });
  });

  it("une réponse qui ne vient jamais : délai, worker arrêté, erreur generate_timeout, rien de condamné", async () => {
    const loading = mod.loadModel();
    await flush();
    const w = last();
    w.emit({ type: "probe", probe: null });
    w.emit({ type: "ready", selfTest: "Bonjour !" });
    await loading;
    const outcome = mod.generate("sys", [{ role: "user", content: "salut" }]).then(() => "resolved", (e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.sent.at(-1).type).toBe("generate");
    // processeur : délai long (une passe coûte ~1,8 s mesurée) — 180 s ne suffisent pas
    await vi.advanceTimersByTimeAsync(181_000);
    expect(w.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(420_000);
    expect(await outcome).toMatchObject({ code: "generate_timeout", seconds: 600 });
    expect(w.terminated).toBe(true);
    expect(mod.isModelReady()).toBe(false);
    expect(store.has("velohnav_ai_attempts_ko")).toBe(false);
  });

  it("une réponse normale traverse le worker et est nettoyée", async () => {
    const loading = mod.loadModel();
    await flush();
    const w = last();
    w.emit({ type: "probe", probe: null });
    w.emit({ type: "ready", selfTest: "Bonjour !" });
    await loading;
    const reply = mod.generate("sys", [{ role: "user", content: "salut" }]);
    await vi.advanceTimersByTimeAsync(0);
    const req = w.sent.at(-1);
    // Messages bruts : c'est le worker qui applique le gabarit du modèle
    expect(req.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "salut" }]);
    w.emit({ type: "result", id: req.id, text: "Bonjour !<|im_end|>" });
    await expect(reply).resolves.toBe("Bonjour !");
  });

  it("generateDetailed rend aussi la sortie BRUTE, marqueurs compris", async () => {
    const loading = mod.loadModel();
    await flush();
    const w = last();
    w.emit({ type: "probe", probe: null });
    w.emit({ type: "ready", selfTest: "Bonjour !" });
    await loading;
    const reply = mod.generateDetailed("sys", [{ role: "user", content: "Je suis Silex" }]);
    await vi.advanceTimersByTimeAsync(0);
    const req = w.sent.at(-1);
    w.emit({ type: "result", id: req.id, text: "<|tool_call_start|>[weather()<|im_end|>" });
    await expect(reply).resolves.toEqual({
      raw: "<|tool_call_start|>[weather()<|im_end|>",
      text: "<|tool_call_start|>[weather()",
    });
  });

  it("erreur du moteur pendant la génération sur le processeur : rejetée avec son message, rien après lui", async () => {
    const loading = mod.loadModel();
    await flush();
    const w = last();
    w.emit({ type: "probe", probe: null });
    w.emit({ type: "ready", selfTest: "Bonjour !" });
    await loading;
    const reply = mod.generateDetailed("sys", [{ role: "user", content: "Je suis Silex" }]).then(() => "resolved", (e) => e);
    await vi.advanceTimersByTimeAsync(0);
    w.emit({ type: "result", id: w.sent.at(-1).id, error: "boom" });
    const e = await reply;
    expect(e).toMatchObject({ code: "generate", detail: "boom" });
    expect(e.recover).toBe(false);
  });
});
