import { describe, it, expect, vi, afterEach } from "vitest";
import {
  VARIANTS, LARGEST_TENSOR_BYTES, LIMITS, assessWebGPU, watchdog,
  initialProgress, progressReducer, withTimeout, selfTestVerdict, variantFor,
  ATTEMPTS, ENGINES, planAttempts, classifyFailure, deviceFingerprint, failureRecord, attemptById, gpuSetAside,
  gpuDeviceRequest, gpuSessionOptions, TRANSPOSE_NODES, isAdreno,
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
  it("le plus gros tenseur q4f16 est la table d'embeddings 4 bits (32 Mio pour LFM2.5-350M)", () => {
    expect(LARGEST_TENSOR_BYTES).toBe(33_554_432);
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

  it("limites mobiles courantes (256 Mio de tampon, 128 Mio de liaison) : accepté — elles recalaient Qwen", () => {
    expect(assessWebGPU(goodProbe({ limits: { maxBufferSize: 256 * 2 ** 20, maxStorageBufferBindingSize: 128 * 2 ** 20 } })).ok).toBe(true);
  });

  it("tampon trop petit (16 Mio) : refusé", () => {
    const r = assessWebGPU(goodProbe({ limits: { maxBufferSize: 16 * 2 ** 20, maxStorageBufferBindingSize: 16 * 2 ** 20 } }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/maxBufferSize 16 MiB/);
  });

  it("tampon assez grand mais liaison trop petite : refusé", () => {
    const r = assessWebGPU(goodProbe({ limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 16 * 2 ** 20 } }));
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

  it("variante q4 (calcul fp32) : un vrai GPU sans shader-f16 suffit", () => {
    expect(assessWebGPU(goodProbe({ features: ["subgroups"] }), { f16: false })).toEqual({ ok: true, reason: "ok" });
  });

  it("variante q4 : adaptateur logiciel toujours refusé (mesuré ~200 s par réponse), device toujours exigé", () => {
    expect(assessWebGPU(goodProbe({ isFallbackAdapter: true, features: [] }), { f16: false }).reason).toBe("software-adapter");
    expect(assessWebGPU(goodProbe({ features: [], device: { ok: false, error: "not-requested" } }), { f16: false }).ok).toBe(false);
  });
});

const ids = (plan) => plan.queue.map((a) => a.id);

describe("échelle des tentatives : le GPU d'abord, le processeur toujours en dernier", () => {
  it("ordre : q4f16 sur le GPU, q4 sur le GPU, q4 GPU « sur », puis processeur — un seul moteur par voie", () => {
    expect(ATTEMPTS.map((a) => a.id)).toEqual(["q4f16/webgpu", "q4/webgpu", "q4/webgpu/sur", "q4/wasm"]);
    // le moteur JSEP (build « all », 28,4 Mo) n'est plus embarqué : aucune tentative ne le demande
    expect(Object.keys(ENGINES).sort()).toEqual(["wasm", "webgpu"]);
  });

  it("GPU complet : toute l'échelle est tentée, dans l'ordre", () => {
    expect(ids(planAttempts({ probe: goodProbe() }))).toEqual(ATTEMPTS.map((a) => a.id));
  });

  it("vrai GPU sans shader-f16 (mesuré sur RTX 3060 / Chrome 151) : q4 sur le GPU d'abord, q4f16 écarté et dit pourquoi", () => {
    const p = planAttempts({ probe: goodProbe({ features: ["subgroups"] }) });
    expect(ids(p)).toEqual(["q4/webgpu", "q4/webgpu/sur", "q4/wasm"]);
    expect(p.skipped).toEqual([{ id: "q4f16/webgpu", reason: "no-shader-f16" }]);
  });

  it("pas de WebGPU, adaptateur logiciel ou device refusé : processeur seul", () => {
    for (const probe of [null, { adapter: false }, goodProbe({ isFallbackAdapter: true }), goodProbe({ device: { ok: false, error: "x" } })]) {
      expect(ids(planAttempts({ probe }))).toEqual(["q4/wasm"]);
    }
  });

  it("tentatives déjà en échec ici : sautées, avec leur raison", () => {
    const p = planAttempts({ probe: goodProbe(), failed: { "q4f16/webgpu": "Sub requires f16" } });
    expect(ids(p)[0]).toBe("q4/webgpu");
    expect(p.skipped[0]).toEqual({ id: "q4f16/webgpu", reason: "failed-before: Sub requires f16" });
  });

  it("le processeur n'est jamais écarté par la sonde", () => {
    expect(ids(planAttempts({ probe: null })).at(-1)).toBe("q4/wasm");
  });

  it("tout en échec : file vide (rien ne boucle)", () => {
    const failed = Object.fromEntries(ATTEMPTS.map((a) => [a.id, "x"]));
    expect(planAttempts({ probe: goodProbe(), failed }).queue).toEqual([]);
  });

  it("q4 sert au GPU et au processeur : mêmes fichiers", () => {
    expect(VARIANTS.webgpuQ4.files).toEqual(VARIANTS.wasm.files);
    expect(attemptById("q4/webgpu").variant.files).toEqual(attemptById("q4/wasm").variant.files);
    expect(variantFor("webgpu", "q4")).toBe(VARIANTS.webgpuQ4);
    expect(variantFor("webgpu")).toBe(VARIANTS.webgpu);
    expect(variantFor("wasm", "q4")).toBe(VARIANTS.wasm);
  });

  it("chaque tentative a un moteur cohérent avec son appareil", () => {
    for (const a of ATTEMPTS) expect(a.engine.device).toBe(a.variant.device);
    expect(attemptById("q4/wasm").engine).toBe(ENGINES.wasm);
    // le moteur importé par défaut par transformers.js n'a pas le noyau processeur
    expect(ATTEMPTS.filter((a) => a.engine === ENGINES.webgpu).every((a) => a.variant.device === "webgpu")).toBe(true);
  });
});

describe("échecs mémorisés : liés au modèle, à l'échelle et au GPU", () => {
  const fp = deviceFingerprint(goodProbe({ info: { vendor: "arm", architecture: "valhall" } }));

  it("empreinte : GPU annoncé compris ; sans GPU, « no-gpu »", () => {
    expect(fp).toMatch(/\|arm\/valhall$/);
    expect(deviceFingerprint(null)).toMatch(/\|no-gpu$/);
  });

  it("relu pour la même empreinte, ignoré pour une autre", () => {
    const stored = JSON.stringify({ fingerprint: fp, failed: { "q4f16/webgpu": "x" } });
    expect(failureRecord({ stored, fingerprint: fp })).toEqual({ "q4f16/webgpu": "x" });
    expect(failureRecord({ stored, fingerprint: "autre" })).toEqual({});
  });

  it("échecs « …/jsep » mémorisés avant le retrait de ce moteur : sans effet sur l'échelle", () => {
    const stored = JSON.stringify({ fingerprint: fp, failed: { "q4f16/jsep": "x", "q4/jsep": "y" } });
    const p = planAttempts({ probe: goodProbe(), failed: failureRecord({ stored, fingerprint: fp }) });
    expect(ids(p)).toEqual(["q4f16/webgpu", "q4/webgpu", "q4/webgpu/sur", "q4/wasm"]);
    expect(p.skipped).toEqual([]);
  });

  it("stockage illisible : rien de mémorisé", () => {
    expect(failureRecord({ stored: "{", fingerprint: fp })).toEqual({});
  });

  it("ancien « fp16 en échec » : q4f16 écarté (fichiers purgés, pas de second téléchargement)", () => {
    const f = failureRecord({ stored: null, legacyF16: "Sub requires f16", fingerprint: fp });
    expect(Object.keys(f)).toEqual(["q4f16/webgpu"]);
    expect(planAttempts({ probe: goodProbe(), failed: f }).queue[0].id).toBe("q4/webgpu");
  });
});

describe("essai à vide : « prêt » seulement si le modèle a généré", () => {
  it("texte lisible : accepté (sortie mesurée au banc)", () => {
    expect(selfTestVerdict("Bonjour ! Comment puis-je")).toEqual({ ok: true, reason: "ok" });
  });
  it("rien, ou pas un mot : refusé", () => {
    expect(selfTestVerdict(undefined).ok).toBe(false);
    expect(selfTestVerdict("").reason).toBe("no-word");
    expect(selfTestVerdict("!!! ...").reason).toBe("no-word");
  });
  it("charabia d'une autre écriture (« 地黎 », relevé sur téléphone) : refusé", () => {
    expect(selfTestVerdict("地黎 talk").reason).toBe("script");
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

  it("poids séparés (.onnx_data) : le graphe à 100 % ne suffit pas, il faut les poids", () => {
    let s = initialProgress(T0, ["onnx/model_q4f16.onnx", "onnx/model_q4f16.onnx_data"]);
    s = progressReducer(s, ev("onnx/model_q4f16.onnx", 183, 183), T0 + 1);
    expect(s.phase).toBe("download");
    expect(s.pct).toBe(99);   // pas de « 100 % » trompeur
    s = progressReducer(s, ev("onnx/model_q4f16.onnx_data", 100, 1000), T0 + 2);
    expect(s.phase).toBe("download");
    s = progressReducer(s, ev("onnx/model_q4f16.onnx_data", 1000, 1000), T0 + 3);
    expect(s).toMatchObject({ phase: "init", pct: 100, since: T0 + 3 });
  });

  it("depuis le cache, deux « done » : initialisation au second seulement", () => {
    let s = initialProgress(T0, ["onnx/model_q4.onnx", "onnx/model_q4.onnx_data"]);
    s = progressReducer(s, { status: "done", file: "/onnx/model_q4.onnx" }, T0 + 1);
    expect(s.phase).toBe("download");
    s = progressReducer(s, { status: "done", file: "/onnx/model_q4.onnx_data" }, T0 + 2);
    expect(s.phase).toBe("init");
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

describe("après l'échec d'une tentative : la suivante part d'elle-même", () => {
  const A = (id) => attemptById(id);

  it("échec moteur à l'initialisation, à l'import ou à l'essai à vide : tentative condamnée, on continue", () => {
    for (const phase of ["init", "engine"]) {
      for (const timedOut of [false, true]) {
        const d = classifyFailure({ attempt: A("q4/webgpu"), phase, timedOut });
        expect(d).toMatchObject({ condemn: true, continue: true, code: timedOut ? "init_timeout" : "init" });
      }
    }
  });

  it("q4f16 purgé dès que sa tentative GPU a échoué (plus aucune ne s'en sert)", () => {
    expect(classifyFailure({ attempt: A("q4f16/webgpu"), phase: "init" }).purgeDtype).toBe("q4f16");
  });

  it("q4 jamais purgé : le processeur s'en sert", () => {
    const failed = { "q4/webgpu": "x" };
    expect(classifyFailure({ attempt: A("q4/wasm"), phase: "init", failed }).purgeDtype).toBeNull();
    expect(classifyFailure({ attempt: A("q4/webgpu"), phase: "init" }).purgeDtype).toBeNull();
  });

  it("une coupure réseau ne condamne rien et arrête l'échelle (reprise au même endroit)", () => {
    for (const phase of ["setup", "download"]) {
      const d = classifyFailure({ attempt: A("q4f16/webgpu"), phase, timedOut: true });
      expect(d).toMatchObject({ condemn: false, continue: false, purgeDtype: null, code: `${phase}_timeout` });
    }
  });

  it("erreur de génération sur le GPU (cas mesuré « Sub requires f16 ») : condamnée ; délai dépassé : non", () => {
    expect(classifyFailure({ attempt: A("q4f16/webgpu"), phase: "generate" })).toMatchObject({ condemn: true, code: "generate" });
    expect(classifyFailure({ attempt: A("q4f16/webgpu"), phase: "generate", timedOut: true })).toMatchObject({ condemn: false, code: "generate_timeout" });
  });

  it("erreur de génération sur le processeur : rien après lui, rien de condamné", () => {
    expect(classifyFailure({ attempt: A("q4/wasm"), phase: "generate" })).toMatchObject({ condemn: false, code: "generate" });
  });

  it("chaque code produit a sa phrase en français et en anglais", async () => {
    const fr = (await import("../locales/fr.js")).default;
    const en = (await import("../locales/en.js")).default;
    const codes = new Set(["all_failed", "memory"]);
    for (const a of ATTEMPTS) {
      for (const phase of ["setup", "engine", "download", "init", "generate"]) {
        for (const timedOut of [false, true]) codes.add(classifyFailure({ attempt: a, phase, timedOut }).code);
      }
    }
    for (const code of codes) {
      expect(fr[`ui.ai.model.fail.${code}`], code).toBeTruthy();
      expect(en[`ui.ai.model.fail.${code}`], code).toBeTruthy();
    }
    for (const e of Object.keys(ENGINES)) {
      expect(fr[`ui.ai.model.engine.${e}`], e).toBeTruthy();
      expect(en[`ui.ai.model.engine.${e}`], e).toBeTruthy();
    }
    for (const d of ["q4f16", "q4"]) {
      expect(fr[`ui.ai.model.dtype.${d}`], d).toBeTruthy();
      expect(en[`ui.ai.model.dtype.${d}`], d).toBeTruthy();
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

describe("GPU mis de côté : la raison se lit (retour du téléphone : « processeur », sans pourquoi)", () => {
  const cpu = { id: "q4/wasm", dtype: "q4", device: "wasm", engine: "wasm", mb: 294 };
  it("GPU retenu, ou rien de retenu : rien à dire", () => {
    expect(gpuSetAside({ chosen: { id: "q4f16/webgpu", device: "webgpu" } })).toBeNull();
    expect(gpuSetAside({ chosen: null })).toBeNull();
    expect(gpuSetAside(null)).toBeNull();
  });
  it("pas de WebGPU : une seule raison pour les deux tentatives GPU, rien à rejouer", () => {
    const { skipped } = planAttempts({ probe: null });
    expect(gpuSetAside({ chosen: cpu, tried: [], skipped })).toEqual({
      reasons: [{ ids: ["q4f16/webgpu", "q4/webgpu", "q4/webgpu/sur"], kind: "no_webgpu", detail: "" }], retry: false, downloadMB: 0,
    });
  });
  it("GPU sans fp16 dont le q4 a échoué à ce démarrage : chaque raison, erreur exacte, rejouable sans téléchargement", () => {
    const probe = { adapter: true, features: [], limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30 }, device: { ok: true } };
    const { skipped } = planAttempts({ probe });
    const r = gpuSetAside({ chosen: cpu, skipped, tried: [{ id: "q4/webgpu", code: "init", detail: "OrtRun: Sub requires f16" }] });
    expect(r.reasons).toEqual([
      { ids: ["q4f16/webgpu"], kind: "no_f16", detail: "" },
      { ids: ["q4/webgpu"], kind: "failed", detail: "OrtRun: Sub requires f16" },
    ]);
    expect(r).toMatchObject({ retry: true, downloadMB: 0 });
  });
  it("échecs mémorisés d'un lancement précédent : dits comme tels, et rejouer q4f16 annonce son téléchargement", () => {
    const probe = { adapter: true, features: ["shader-f16"], limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30 }, device: { ok: true } };
    const { skipped } = planAttempts({ probe, failed: { "q4f16/webgpu": "init_timeout", "q4/webgpu": "init_timeout" } });
    const r = gpuSetAside({ chosen: cpu, skipped, tried: [] });
    expect(r.reasons).toEqual([{ ids: ["q4f16/webgpu", "q4/webgpu"], kind: "failed_before", detail: "init_timeout" }]);
    expect(r).toMatchObject({ retry: true, downloadMB: VARIANTS.webgpu.mb });
  });
  it("device refusé, limites trop basses : catégorie et détail", () => {
    const refused = planAttempts({ probe: { adapter: true, features: [], limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30 }, device: { ok: false, error: "OperationError" } } });
    expect(gpuSetAside({ chosen: cpu, skipped: refused.skipped }).reasons.at(-1)).toEqual({ ids: ["q4/webgpu", "q4/webgpu/sur"], kind: "device", detail: "OperationError" });
    const small = planAttempts({ probe: { adapter: true, features: ["shader-f16"], limits: { maxBufferSize: 2 ** 24, maxStorageBufferBindingSize: 2 ** 24 }, device: { ok: true } } });
    expect(gpuSetAside({ chosen: cpu, skipped: small.skipped }).reasons[0]).toMatchObject({ kind: "limits", detail: expect.stringMatching(/maxBufferSize 16 MiB/) });
  });
});

describe("GPU Adreno : device sans subgroups, réglage « sur », q4 avant q4f16", () => {
  // Retour du téléphone (Adreno, WebView 153) : q4f16 et q4 se chargent sur le GPU, puis
  // « Bonjour » → « 鹰 », « 龙 ». Cause relevée publiquement : la voie subgroups de
  // MatMulNBits (onnxruntime-web ≥ 1.30) sur Adreno.
  const adreno = goodProbe({ info: { vendor: "qualcomm", architecture: "adreno-7xx", description: "" } });

  it("device : toutes les fonctions de l'adaptateur sauf les subgroups ; limites au maximum", () => {
    const r = gpuDeviceRequest(
      new Set(["shader-f16", "subgroups", "subgroups-f16", "chromium-experimental-subgroup-matrix", "subgroup-size-control", "timestamp-query"]),
      { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupStorageSize: 32768, maxColorAttachments: 8 },
    );
    expect(r.requiredFeatures).toEqual(["shader-f16", "timestamp-query"]);
    expect(r.dropped).toEqual(["subgroups", "subgroups-f16", "chromium-experimental-subgroup-matrix", "subgroup-size-control"]);
    // seules les limites utiles au calcul ; une limite inconnue de l'adaptateur n'est pas inventée
    expect(r.requiredLimits).toEqual({ maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupStorageSize: 32768 });
  });

  it("session : device fourni ; « sur » = Transpose sur le processeur + NCHW ; q4f16 = accumulation fp32", () => {
    const dev = { fake: true };
    expect(gpuSessionOptions(attemptById("q4/webgpu"), dev)).toEqual({ executionProviders: [{ name: "webgpu", device: dev }] });
    const sur = gpuSessionOptions(attemptById("q4/webgpu/sur"), dev).executionProviders[0];
    expect(sur).toMatchObject({ name: "webgpu", device: dev, preferredLayout: "NCHW" });
    expect(sur.forceCpuNodeNames).toHaveLength(20);
    expect(gpuSessionOptions(attemptById("q4f16/webgpu"), dev).executionProviders[0].enableMatmulFp32Accumulation).toBe(true);
  });

  it("Transpose du graphe : deux par bloc conv (10 blocs), aucun dans les blocs d'attention", () => {
    expect(TRANSPOSE_NODES).toHaveLength(20);
    expect(TRANSPOSE_NODES.every((n) => /^\/model\/layers\.\d+\/conv\/Transpose_[12]$/.test(n))).toBe(true);
    expect(TRANSPOSE_NODES.some((n) => n.includes("layers.2/"))).toBe(false);   // couche 2 : attention
  });

  it("Adreno reconnu par le fabricant ou l'architecture", () => {
    expect(isAdreno(adreno)).toBe(true);
    expect(isAdreno(goodProbe({ info: { vendor: "", architecture: "", description: "Adreno (TM) 740" } }))).toBe(true);
    expect(isAdreno(goodProbe({ info: { vendor: "arm", architecture: "valhall" } }))).toBe(false);
    expect(isAdreno(null)).toBe(false);
  });

  it("Adreno : q4 GPU (déjà en cache), puis q4 « sur », puis q4f16 (255 Mo), puis processeur", () => {
    expect(ids(planAttempts({ probe: adreno }))).toEqual(["q4/webgpu", "q4/webgpu/sur", "q4f16/webgpu", "q4/wasm"]);
    // ailleurs, l'ordre reste celui de l'échelle
    expect(ids(planAttempts({ probe: goodProbe() }))).toEqual(ATTEMPTS.map((a) => a.id));
  });

  it("échecs GPU mémorisés AVEC subgroups (échelle 3) : oubliés, chaque tentative GPU est rejouée", () => {
    const fp = deviceFingerprint(adreno);
    const old = JSON.stringify({ fingerprint: fp.replace(/\|\d+\|/, "|3|"), failed: { "q4f16/webgpu": "self-test", "q4/webgpu": "self-test" } });
    expect(failureRecord({ stored: old, fingerprint: fp })).toEqual({});
  });
});
