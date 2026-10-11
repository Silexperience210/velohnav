import { describe, it, expect } from "vitest";
import { journalEntry, withReply, parseJournal, pushEntry, replaceLast, gpuStreak, formatJournal, onGpu, JOURNAL_MAX } from "./launchJournal.js";

const AT = new Date(2026, 9, 11, 19, 12, 5).getTime();
const NATIVE = {
  chosen: { id: "q4_0/vulkan", engine: "vulkan", device: "native", dtype: "q4_0", gpuName: "Adreno (TM) 642L", kv: "f32", loadMs: 4200,
    mem: { rssMB: 412, peakMB: 455, pssMB: 690, gfxMB: 268 }, sysMB: 820, selfTestRaw: ["Bonjour !<|im_end|>", "Bien sûr, je peux t'aider.<|im_end|>"] },
  tried: [], skipped: [], gpu: null, native: null,
};
const WEBGPU_SUR = {
  chosen: { id: "q4/webgpu/sur", engine: "webgpu", device: "webgpu", gpuMode: "sur", loadMs: 9000, selfTestRaw: ["Bonjour", "Bien sûr"] },
  tried: [{ id: "q4/webgpu", code: "init", detail: "self-test script: \"鹰\"" }],
  skipped: [], gpu: { adapter: true, vendor: "qualcomm", architecture: "adreno-6xx", description: "" },
  native: { kind: "absent", detail: "" },
};
const CPU = { chosen: { id: "q4/wasm", engine: "wasm", device: "wasm", selfTestRaw: [] }, tried: [], skipped: [{ id: "q4/webgpu", reason: "failed-before: x" }] };

describe("journal des chargements", () => {
  it("GPU : Vulkan natif et WebGPU comptent, le processeur non", () => {
    expect(onGpu(journalEntry(NATIVE, { at: AT }))).toBe(true);
    expect(onGpu(journalEntry(WEBGPU_SUR, { at: AT }))).toBe(true);
    expect(onGpu(journalEntry(CPU, { at: AT }))).toBe(false);
    expect(onGpu(journalEntry({ chosen: null }, { at: AT, error: { code: "all_failed" } }))).toBe(false);
  });

  it("tours 1 et 2 gardés, pas au-delà ; sorties brutes, marqueurs compris", () => {
    let e = journalEntry(NATIVE, { at: AT });
    e = withReply(e, { raw: "Bonsoir !<|im_end|>", stats: { tokens: 5, tps: 41.2, ms: 121, genOnly: true, mem: { rssMB: 430, peakMB: 470 } } });
    e = withReply(e, { raw: "weather<|im_end|>", stats: { tokens: 2, tps: 30 } });
    const third = withReply(e, { raw: "x", stats: {} });
    expect(third).toBe(e);
    expect(e.replies.map((r) => r.raw)).toEqual(["Bonsoir !<|im_end|>", "weather<|im_end|>"]);
  });

  it("10 entrées au plus ; stockage absent ou corrompu : journal vide", () => {
    let j = [];
    for (let i = 0; i < 14; i++) j = pushEntry(j, journalEntry(NATIVE, { at: AT + i }));
    expect(j).toHaveLength(JOURNAL_MAX);
    expect(j[0].at).toBe(AT + 4);
    expect(parseJournal(JSON.stringify(j))).toHaveLength(JOURNAL_MAX);
    expect(parseJournal(null)).toEqual([]);
    expect(parseJournal("{oops")).toEqual([]);
    expect(replaceLast(j, { ...j.at(-1), replies: [{ raw: "r" }] }).at(-1).replies).toEqual([{ raw: "r" }]);
  });

  it("bilan des 5 derniers lancements : le critère d'acceptation se lit directement", () => {
    const j = [CPU, NATIVE, NATIVE, WEBGPU_SUR, NATIVE, NATIVE].map((r, i) => journalEntry(r, { at: AT + i }));
    expect(gpuStreak(j)).toEqual({ n: 5, gpu: 5 });
    expect(gpuStreak(j.slice(0, 3))).toEqual({ n: 3, gpu: 2 });
  });

  it("texte copiable : voie, GPU, mémoire, essai à vide et tours bruts, raisons des écarts", () => {
    let a = journalEntry(NATIVE, { at: AT });
    a = withReply(a, { raw: "Bonsoir !<|im_end|>", stats: { tokens: 5, tps: 41.2, genOnly: true, mem: { rssMB: 430, peakMB: 470 } } });
    const b = journalEntry(WEBGPU_SUR, { at: AT + 60_000 });
    const c = journalEntry({ chosen: null, tried: [{ id: "q4/wasm", code: "init", detail: "OOM" }], skipped: [] }, { at: AT + 120_000, error: { code: "all_failed", detail: "q4/wasm → init" } });
    expect(formatJournal([a, b, c])).toBe([
      "2026-10-11 19:14:05 · ÉCHEC · all_failed : q4/wasm → init",
      "  essayé : q4/wasm → init (OOM)",
      "",
      "2026-10-11 19:13:05 · GPU · q4/webgpu/sur (sur) · qualcomm adreno-6xx · prêt 9.0 s",
      "  essai 1 : \"Bonjour\"",
      "  essai 2 : \"Bien sûr\"",
      "  natif écarté : absent",
      "  essayé : q4/webgpu → init (self-test script: \"鹰\")",
      "",
      "2026-10-11 19:12:05 · GPU · q4_0/vulkan · Adreno (TM) 642L · prêt 4.2 s · kv f32",
      "  mém : :llm rss 412 Mo, pic 455 Mo, pss 690 Mo, gpu 268 Mo · système 820 Mo",
      "  essai 1 : \"Bonjour !<|im_end|>\"",
      "  essai 2 : \"Bien sûr, je peux t'aider.<|im_end|>\"",
      "  tour 1 : 5 j, 41.2 j/s · rss 430 Mo, pic 470 Mo · \"Bonsoir !<|im_end|>\"",
    ].join("\n"));
  });
});
