import { describe, it, expect, vi, afterEach } from "vitest";
import {
  VARIANTS, LARGEST_TENSOR_BYTES, LIMITS, assessWebGPU, planLoad, watchdog,
  initialProgress, progressReducer, decideAfterFailure, withTimeout,
} from "./modelPolicy.js";

// Sonde d'un GPU capable de porter q4f16, modifiée cas par cas.
const goodProbe = (over = {}) => ({
  adapter: true,
  isFallbackAdapter: false,
  features: ["shader-f16", "subgroups"],
  limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 30 },
  device: { ok: true },
  ...over,
});

describe("sonde WebGPU : la présence d'un adaptateur ne suffit pas", () => {
  it("le plus gros tenseur q4f16 est la table d'embeddings fp16 (≈ 260 Mio pour le 0.5B)", () => {
    expect(LARGEST_TENSOR_BYTES).toBe(272_269_312);
  });

  it("GPU complet : q4f16 autorisé", () => {
    expect(assessWebGPU(goodProbe())).toEqual({ ok: true, reason: "ok" });
  });

  it("pas de navigator.gpu, ou pas d'adaptateur : refusé", () => {
    expect(assessWebGPU(null).ok).toBe(false);
    expect(assessWebGPU({ adapter: false }).reason).toBe("no-adapter");
  });

  it("adaptateur logiciel : refusé", () => {
    expect(assessWebGPU(goodProbe({ isFallbackAdapter: true })).reason).toBe("software-adapter");
  });

  it("sans shader-f16 (q4f16 calcule en fp16) : refusé", () => {
    expect(assessWebGPU(goodProbe({ features: ["subgroups"] })).reason).toBe("no-shader-f16");
  });

  it("limites mobiles courantes (256 Mio de tampon, 128 Mio de liaison) : refusé", () => {
    const r = assessWebGPU(goodProbe({ limits: { maxBufferSize: 256 * 2 ** 20, maxStorageBufferBindingSize: 128 * 2 ** 20 } }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/maxBufferSize 256 MiB/);
  });

  it("tampon assez grand mais liaison trop petite : refusé", () => {
    const r = assessWebGPU(goodProbe({ limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 128 * 2 ** 20 } }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/maxStorageBufferBindingSize/);
  });

  it("limites exactement suffisantes : accepté", () => {
    const n = LARGEST_TENSOR_BYTES;
    expect(assessWebGPU(goodProbe({ limits: { maxBufferSize: n, maxStorageBufferBindingSize: n } })).ok).toBe(true);
  });

  it("limites annoncées mais device refusé ou sans réponse : refusé", () => {
    expect(assessWebGPU(goodProbe({ device: { ok: false, error: "requestDevice: no answer after 10 s" } })).reason)
      .toMatch(/^device: requestDevice/);
    expect(assessWebGPU(goodProbe({ device: undefined })).ok).toBe(false);
  });

  it("limites absentes : refusé (jamais d'engagement à l'aveugle)", () => {
    expect(assessWebGPU(goodProbe({ limits: undefined })).ok).toBe(false);
  });
});

describe("plan de chargement", () => {
  it("sonde favorable : WebGPU / q4f16", () => {
    expect(planLoad({ webgpuKnownBroken: false, assessment: { ok: true, reason: "ok" } }).variant).toBe(VARIANTS.webgpu);
  });

  it("sonde défavorable : WASM / q4 directement, AVANT tout téléchargement", () => {
    const p = planLoad({ webgpuKnownBroken: false, assessment: { ok: false, reason: "no-shader-f16" } });
    expect(p.variant).toBe(VARIANTS.wasm);
    expect(p.reason).toBe("no-shader-f16");
  });

  it("échec WebGPU déjà constaté : WASM même si la sonde est favorable", () => {
    const p = planLoad({ webgpuKnownBroken: true, assessment: { ok: true, reason: "ok" } });
    expect(p.variant).toBe(VARIANTS.wasm);
  });

  it("pas de sonde du tout : WASM", () => {
    expect(planLoad({ webgpuKnownBroken: false, assessment: null }).variant).toBe(VARIANTS.wasm);
  });
});

describe("chien de garde : un blocage finit toujours en échec explicite", () => {
  const T0 = 1_000_000;

  it("démarrage silencieux au-delà de setupMs", () => {
    const s = { phase: "setup", since: T0, lastActivity: T0, device: "wasm" };
    expect(watchdog(s, T0 + LIMITS.setupMs)).toBeNull();
    expect(watchdog(s, T0 + LIMITS.setupMs + 1)).toMatchObject({ phase: "setup", timedOut: true });
  });

  it("téléchargement : seule l'absence de données compte, pas la durée totale", () => {
    const s = { phase: "download", since: T0, lastActivity: T0 + 3_600_000, device: "wasm" };
    expect(watchdog(s, T0 + 3_600_000 + 1000)).toBeNull(); // une heure, mais des octets arrivent
    expect(watchdog(s, T0 + 3_600_000 + LIMITS.stallMs + 1)).toMatchObject({ phase: "download", seconds: 90 });
  });

  it("initialisation (le cas observé : figé à 100 %) bornée selon le moteur", () => {
    const gpu = { phase: "init", since: T0, lastActivity: T0, device: "webgpu" };
    expect(watchdog(gpu, T0 + LIMITS.initMs.webgpu)).toBeNull();
    expect(watchdog(gpu, T0 + LIMITS.initMs.webgpu + 1)).toMatchObject({ phase: "init", timedOut: true, seconds: 180 });
    const cpu = { ...gpu, device: "wasm" };
    expect(watchdog(cpu, T0 + LIMITS.initMs.webgpu + 1)).toBeNull();
    expect(watchdog(cpu, T0 + LIMITS.initMs.wasm + 1)).toMatchObject({ seconds: 300 });
  });
});

describe("progression : 100 % n'est que la fin du téléchargement", () => {
  const T0 = 5_000;
  const ev = (file, loaded, total, status = "progress") => ({ status, file, loaded, total });

  it("le premier événement du hub fait quitter la phase de démarrage", () => {
    const s = progressReducer(initialProgress(T0), { status: "initiate", file: "config.json" }, T0 + 10);
    expect(s.phase).toBe("download");
    expect(s.lastActivity).toBe(T0 + 10);
  });

  it("pourcentage agrégé sur les fichiers de taille connue", () => {
    let s = initialProgress(T0);
    s = progressReducer(s, ev("tokenizer.json", 100, 100), T0 + 1);
    s = progressReducer(s, ev("onnx/model_q4f16.onnx", 0, 900), T0 + 2);
    expect(s.pct).toBe(10);
    s = progressReducer(s, ev("onnx/model_q4f16.onnx", 400, 900), T0 + 3);
    expect(s.pct).toBe(50);
    expect(s.phase).toBe("download");
  });

  it("un petit fichier à 100 % ne fait PAS passer en initialisation", () => {
    const s = progressReducer(initialProgress(T0), ev("config.json", 10, 10), T0 + 1);
    expect(s.phase).toBe("download");
  });

  it("le fichier .onnx à 100 % ouvre la phase d'initialisation et son délai", () => {
    let s = progressReducer(initialProgress(T0), ev("onnx/model_q4f16.onnx", 10, 900), T0 + 1);
    s = progressReducer(s, ev("onnx/model_q4f16.onnx", 900, 900), T0 + 50);
    expect(s).toMatchObject({ phase: "init", pct: 100, since: T0 + 50 });
    // Ensuite plus rien ne la fait bouger : le délai d'init court depuis 100 %.
    const later = progressReducer(s, { status: "done", file: "onnx/model_q4f16.onnx" }, T0 + 99);
    expect(later.since).toBe(T0 + 50);
  });

  it("« done » du .onnx sans progression (lecture depuis le cache) : initialisation aussi", () => {
    const s = progressReducer(initialProgress(T0), { status: "done", file: "onnx/model_q4.onnx" }, T0 + 1);
    expect(s.phase).toBe("init");
  });

  it("événement vide : état inchangé", () => {
    const s0 = initialProgress(T0);
    expect(progressReducer(s0, null, T0 + 1)).toBe(s0);
  });
});

describe("décision après échec : repli explicite, jamais deux téléchargements d'office", () => {
  it("WebGPU qui échoue ou se bloque à l'initialisation : mémorisé, q4f16 purgé, WASM proposé", () => {
    for (const timedOut of [false, true]) {
      const d = decideAfterFailure({ device: "webgpu", phase: "init", timedOut });
      expect(d.code).toBe(timedOut ? "webgpu_init_timeout" : "webgpu_init");
      expect(d.markWebGPUBroken).toBe(true);
      expect(d.purgeDtype).toBe("q4f16");
      expect(d.next).toBe(VARIANTS.wasm);
    }
  });

  it("aucune décision ne relance automatiquement un téléchargement", () => {
    for (const device of ["webgpu", "wasm"]) {
      for (const phase of ["setup", "download", "init", "generate"]) {
        for (const timedOut of [false, true]) {
          expect(decideAfterFailure({ device, phase, timedOut }).autoRetry).toBe(false);
        }
      }
    }
  });

  it("une coupure réseau ne condamne pas le GPU", () => {
    const d = decideAfterFailure({ device: "webgpu", phase: "download", timedOut: true });
    expect(d).toMatchObject({ code: "download_timeout", markWebGPUBroken: false, purgeDtype: null, next: VARIANTS.webgpu });
  });

  it("échec WASM : rien à purger, rien à mémoriser", () => {
    expect(decideAfterFailure({ device: "wasm", phase: "init" })).toMatchObject({ code: "wasm_init", markWebGPUBroken: false, purgeDtype: null });
    expect(decideAfterFailure({ device: "wasm", phase: "setup", timedOut: true }).code).toBe("setup_timeout");
  });

  it("chaque code produit a sa phrase en français et en anglais", async () => {
    const fr = (await import("../locales/fr.js")).default;
    const en = (await import("../locales/en.js")).default;
    for (const device of ["webgpu", "wasm"]) {
      for (const phase of ["setup", "download", "init", "generate"]) {
        for (const timedOut of [false, true]) {
          const key = `ui.ai.model.fail.${decideAfterFailure({ device, phase, timedOut }).code}`;
          expect(fr[key], key).toBeTruthy();
          expect(en[key], key).toBeTruthy();
        }
      }
      expect(fr[`ui.ai.model.engine.${device}`]).toBeTruthy();
      expect(en[`ui.ai.model.engine.${device}`]).toBeTruthy();
    }
  });
});

describe("délai d'expiration", () => {
  afterEach(() => vi.useRealTimers());

  it("laisse passer une promesse qui aboutit à temps", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it("propage le rejet d'origine", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
  });

  it("une promesse qui ne se résout JAMAIS finit en erreur marquée timedOut, et libère la ressource", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const p = withTimeout(new Promise(() => {}), 10_000, "requestDevice", onTimeout);
    const check = expect(p).rejects.toMatchObject({ timedOut: true, message: "requestDevice: no answer after 10 s" });
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("n'appelle pas onTimeout quand la promesse aboutit", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    await withTimeout(Promise.resolve("ok"), 10_000, "x", onTimeout);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
