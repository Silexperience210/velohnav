// Défaut 3 — « l'IA locale consomme trop de mémoire, l'APK plante et redémarre ».
// Le WebView était tué par le système : on mesure l'empreinte, on choisit un modèle
// qui tient, on refuse proprement s'il ne tient pas, et on rend la mémoire.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_DTYPE_SUFFIX_MAPPING } from "../../node_modules/@huggingface/transformers/src/utils/dtypes.js";
import { buildResourcePaths } from "../../node_modules/@huggingface/transformers/src/utils/hub.js";
import {
  VARIANTS, MODEL, hubFileUrl, MEMORY, estimatePeakBytes, memoryVerdict, heaviestVariant,
  LEGACY_MODEL_DIRS, cacheHeaders,
} from "./modelPolicy.js";

const GB = 1e9;
// Plugin natif DeviceMemory simulé (vi.mock est remonté en tête : variable via vi.hoisted)
const { memInfo } = vi.hoisted(() => ({ memInfo: vi.fn() }));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => ({ info: () => memInfo() }) }));

describe("empreinte : pourquoi le 1.5B tuait l'application", () => {
  // Tailles relevées sur le Hub (API /tree) pour les fichiers q4f16
  const ancien = { mb: 1222, dtype: "q4f16", device: "webgpu" };   // Qwen2.5-1.5B
  it("pic estimé : ≈ 4,0 Go pour le 1.5B, ≈ 1,08 Go (GPU) et 1,2 Go (CPU) pour LFM2.5-350M", () => {
    expect(estimatePeakBytes(ancien) / GB).toBeCloseTo(3.98, 1);
    expect(estimatePeakBytes(VARIANTS.webgpu) / GB).toBeCloseTo(1.08, 1);
    expect(estimatePeakBytes(VARIANTS.wasm) / GB).toBeCloseTo(1.2, 1);
  });
  it("téléphone à 3 Go libres (8 Go de RAM, appli carte ouverte) : 1.5B refusé, LFM2.5 accepté", () => {
    const info = { availBytes: 3.0 * GB, thresholdBytes: 0.25 * GB, lowMemory: false };
    expect(memoryVerdict(info, ancien).ok).toBe(false);
    expect(memoryVerdict(info, heaviestVariant()).ok).toBe(true);
  });
  it("le facteur 3 = fichier lu en JS + copie dans le tas WASM + poids de travail", () => {
    expect(MEMORY.peakFactor).toBe(3);
  });
});

describe("memoryVerdict — refuser avant de s'engager", () => {
  const v = VARIANTS.webgpu;
  it("Android signale lowMemory : refus", () => {
    expect(memoryVerdict({ availBytes: 5 * GB, thresholdBytes: 0, lowMemory: true }, v))
      .toMatchObject({ ok: false, reason: "low-memory" });
  });
  it("mémoire libre au-dessus du seuil système insuffisante : refus, chiffres pour le message", () => {
    const r = memoryVerdict({ availBytes: 1.2 * GB, thresholdBytes: 0.3 * GB }, v);
    expect(r).toMatchObject({ ok: false, reason: "insufficient", availMB: 900 });
    expect(r.needMB).toBe(Math.round(estimatePeakBytes(v) / 1e6));
  });
  it("assez de mémoire : accepté", () => {
    expect(memoryVerdict({ availBytes: 2.5 * GB, thresholdBytes: 0.3 * GB }, v).ok).toBe(true);
  });
  it("navigateur : seule la RAM totale est connue (deviceMemory)", () => {
    expect(memoryVerdict({ deviceMemoryGB: 2 }, v)).toMatchObject({ ok: false, reason: "small-device" });
    expect(memoryVerdict({ deviceMemoryGB: 4 }, v).ok).toBe(true);
  });
  it("aucune information : autorisé (rien ne permet de juger)", () => {
    expect(memoryVerdict(null, v)).toMatchObject({ ok: true, reason: "unknown" });
  });
});

describe("fichiers du modèle — même nom et même clé de cache que transformers.js", () => {
  it("le fichier de chaque variante suit la table de suffixes de transformers.js", () => {
    for (const x of Object.values(VARIANTS)) {
      expect(x.file).toBe(`onnx/model${DEFAULT_DTYPE_SUFFIX_MAPPING[x.dtype]}.onnx`);
      // + le fichier de poids séparé, nommé comme getExternalDataChunkNames (1 bloc)
      expect(x.files).toEqual([x.file, `${x.file}_data`]);
    }
  });
  it("URL = clé de cache calculée par transformers.js lui-même, révision épinglée comprise", () => {
    for (const x of Object.values(VARIANTS)) for (const f of x.files) {
      expect(hubFileUrl(f)).toBe(buildResourcePaths(MODEL.id, f, { revision: MODEL.revision }).remoteURL);
    }
    expect(hubFileUrl("onnx/model_q4f16.onnx_data"))
      .toBe(`https://huggingface.co/onnx-community/LFM2.5-350M-ONNX/resolve/${MODEL.revision}/onnx/model_q4f16.onnx_data`);
  });
  it("tailles annoncées déduites des octets exacts : 255 Mo (q4f16) et 294 Mo (q4)", () => {
    expect(VARIANTS.webgpu.mb).toBe(255);
    expect(VARIANTS.wasm.mb).toBe(294);
    expect(VARIANTS.webgpu.bytes["onnx/model_q4f16.onnx_data"]).toBe(254_965_760);
  });
});

describe("contrôle préalable : besoins du NOUVEAU modèle", () => {
  it("variante la plus exigeante = q4 (294 Mo), pas l'ancien q8 de Qwen (512 Mo)", () => {
    expect(heaviestVariant()).toBe(VARIANTS.wasm);
    expect(memoryVerdict(null, heaviestVariant()).needMB).toBe(1197);   // 294 × 3 + 300 Mio
  });
  it("téléphone à 1,5 Go libres au-dessus du seuil : refusé avec Qwen (1,85 Go), accepté désormais", () => {
    const info = { availBytes: 1.8 * GB, thresholdBytes: 0.3 * GB };
    expect(memoryVerdict(info, { mb: 512 }).ok).toBe(false);
    expect(memoryVerdict(info, heaviestVariant()).ok).toBe(true);
  });
});

describe("relecture du cache sans réallocations (Content-Length)", () => {
  it("en-tête absent : forcé à la taille connue", () => {
    expect(cacheHeaders(new Headers({ "content-type": "application/octet-stream" }), 254_965_760).get("content-length"))
      .toBe("254965760");
  });
  it("en-tête présent : conservé", () => {
    expect(cacheHeaders({ "content-length": "12" }, 99).get("content-length")).toBe("12");
  });
  it("taille inconnue : rien d'inventé", () => {
    expect(cacheHeaders(null, undefined).get("content-length")).toBeNull();
  });
});

// ── Façade : contrôle préalable et déchargement, avec un faux worker ──────────
class FakeWorker {
  static all = [];
  constructor() { this.sent = []; this.terminated = false; FakeWorker.all.push(this); }
  postMessage(m) { this.sent.push(m); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage?.({ data }); }
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("façade : la mémoire est contrôlée avant, et rendue après", () => {
  let mod, store;

  beforeEach(async () => {
    vi.resetModules();
    // Import dynamique du plugin préchargé hors horloge simulée (le chargeur de
    // modules de Vitest attend sur de vrais minuteurs)
    await import("@capacitor/core");
    vi.useFakeTimers();
    FakeWorker.all = [];
    store = new Map([["velohnav_ai_webgpu_ko", "1"]]);   // WASM direct : pas de sonde
    memInfo.mockReset();
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("localStorage", { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    mod = await import("./localModel.js");
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const native = (info) => {
    vi.stubGlobal("window", { Capacitor: { isNativePlatform: () => true } });
    memInfo.mockResolvedValue(info);
  };

  it("Android sans assez de mémoire : refus « memory », AUCUN worker créé, rien téléchargé", async () => {
    native({ availBytes: 1.2e9, totalBytes: 4e9, thresholdBytes: 2.2e8, lowMemory: false });
    const outcome = mod.loadModel().then(() => "resolved", (e) => e);
    await flush();
    const e = await outcome;
    expect(e).toMatchObject({ name: "ModelError", code: "memory", availMB: 980 });
    expect(e.needMB).toBe(1197);   // 294 Mo × 3 + 300 Mio de marge
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("Android avec assez de mémoire : le chargement part", async () => {
    native({ availBytes: 3.5e9, totalBytes: 8e9, thresholdBytes: 2.2e8, lowMemory: false });
    mod.loadModel().catch(() => {});
    await flush();
    expect(memInfo).toHaveBeenCalledTimes(1);   // la source native a bien été lue
    expect(console.info).toHaveBeenCalledWith(expect.stringMatching(/mémoire : ok \(/));
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.all[0].sent[0]).toMatchObject({ type: "load", variant: { dtype: "q4" } });
  });

  it("navigateur à 2 Go de RAM : refus", async () => {
    vi.stubGlobal("navigator", { deviceMemory: 2 });
    const e = await mod.loadModel().then(() => "resolved", (x) => x);
    expect(e.code).toBe("memory");
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("désactiver la conversation libre : worker arrêté, modèle plus prêt", async () => {
    const loading = mod.loadModel();
    await flush();
    const w = FakeWorker.all[0];
    w.emit({ type: "ready" });
    await loading;
    expect(mod.isModelReady()).toBe(true);
    mod.unloadModel();
    expect(w.terminated).toBe(true);
    expect(mod.isModelReady()).toBe(false);
  });

  it("désactiver pendant le téléchargement : chargement interrompu (« cancelled »), worker arrêté", async () => {
    const outcome = mod.loadModel().then(() => "resolved", (e) => e);
    await flush();
    const w = FakeWorker.all[0];
    w.emit({ type: "progress", ev: { status: "progress", file: "onnx/model_q4.onnx_data", loaded: 1e6, total: 3e8 } });
    mod.unloadModel();
    expect(await outcome).toMatchObject({ code: "cancelled" });
    expect(w.terminated).toBe(true);
    // et rien ne reste armé : le chien de garde ne se déclenche plus
    await vi.advanceTimersByTimeAsync(400_000);
    expect(FakeWorker.all).toHaveLength(1);
  });

  it("désactiver pendant le contrôle mémoire : aucun worker ne démarre ensuite", async () => {
    native({ availBytes: 3.5e9, thresholdBytes: 2e8 });
    const outcome = mod.loadModel().then(() => "resolved", (e) => e);
    mod.unloadModel();
    await flush();
    expect(await outcome).toMatchObject({ code: "cancelled" });
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("purge des anciens modèles : Qwen 0.5B et 1.5B retirés du cache, LFM2.5 intact, une fois par session", async () => {
    const keys = [
      "https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct/resolve/main/onnx/model_q4f16.onnx",
      "https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct/resolve/main/config.json",
      "https://huggingface.co/onnx-community/Qwen2.5-1.5B-Instruct/resolve/main/onnx/model_q4f16.onnx",
      hubFileUrl("onnx/model_q4.onnx_data"),
    ].map((url) => ({ url }));
    const deleted = [];
    const cache = { keys: async () => keys, delete: async (r) => { deleted.push(r.url); return true; } };
    const open = vi.fn(async () => cache);
    vi.stubGlobal("caches", { open });
    expect(LEGACY_MODEL_DIRS).toEqual(["Qwen2.5-1.5B-Instruct", "Qwen2.5-0.5B-Instruct"]);
    mod.purgeLegacyModels();
    await flush();
    expect(open).toHaveBeenCalledWith("transformers-cache");
    expect(deleted).toHaveLength(3);
    expect(deleted.some((u) => u.includes("LFM2.5"))).toBe(false);
    mod.purgeLegacyModels();
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("échec du chargement : worker arrêté, mémoire rendue, aucun minuteur qui reste armé", async () => {
    const outcome = mod.loadModel().then(() => "resolved", (e) => e);
    await flush();
    const w = FakeWorker.all[0];
    w.emit({ type: "error", message: "RangeError: Array buffer allocation failed" });
    expect(await outcome).toMatchObject({ name: "ModelError" });
    expect(w.terminated).toBe(true);
    expect(mod.isModelReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(FakeWorker.all).toHaveLength(1);
  });

  it("après déchargement, une nouvelle activation recharge (worker neuf)", async () => {
    const l1 = mod.loadModel(); await flush();
    FakeWorker.all[0].emit({ type: "ready" }); await l1;
    mod.unloadModel();
    const l2 = mod.loadModel(); await flush();
    expect(FakeWorker.all).toHaveLength(2);
    FakeWorker.all[1].emit({ type: "ready" });
    await expect(l2).resolves.toBeUndefined();
  });
});
