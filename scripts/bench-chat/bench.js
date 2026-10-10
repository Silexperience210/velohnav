// Page du banc « conversation libre » (voir run.mjs). Utilise le VRAI worker de
// l'application (src/ai/modelWorker.js) et le vrai chemin d'affichage
// (systemPrompt avec ses outils, cleanReply, resolveModelOutput) : seule change la
// configuration de génération comparée.
import { VARIANTS, SELF_TEST } from "../../src/ai/modelPolicy.js";
import { systemPrompt, resolveModelOutput } from "../../src/ai/assistant.js";
import { answerLocally } from "../../src/ai/localAnswers.js";
import { cleanReply, generationOptions } from "../../src/ai/localModel.js";
import { readModelOutput } from "../../src/ai/tools.js";
import fr from "../../src/locales/fr.js";
import { QUESTIONS, CONFIGS, CONVERSATION } from "./cases.js";

const SELF_TEST_MESSAGES = SELF_TEST.messages;
const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");
const params = new URLSearchParams(location.search);
// « webgpu », « wasm », ou « <device>-<dtype> » (ex. webgpu-q4) pour essayer une autre quantification.
const [devName, dtypeOver] = (params.get("device") || "webgpu").split("-");
const base = VARIANTS[devName] ?? { device: devName };
const variant = dtypeOver
  ? { ...base, device: devName, dtype: dtypeOver, files: [`onnx/model_${dtypeOver}.onnx`, `onnx/model_${dtypeOver}.onnx_data`], file: `onnx/model_${dtypeOver}.onnx`, bytes: {} }
  : base;
const only = params.get("configs")?.split(",");
const send = (o) => fetch("/__bench", { method: "POST", body: JSON.stringify(o) });
const log = (s) => { document.getElementById("log").textContent += s + "\n"; };

const w = new Worker(new URL("../../src/ai/modelWorker.js", import.meta.url), { type: "module" });
const once = (type) => new Promise((res) => {
  const h = ({ data }) => { if (data.type === type || data.type === "error") { w.removeEventListener("message", h); res(data); } };
  w.addEventListener("message", h);
});
let seq = 0;
const generate = (messages, options) => new Promise((res) => {
  const id = ++seq;
  const h = ({ data }) => { if (data.type === "result" && data.id === id) { w.removeEventListener("message", h); res(data); } };
  w.addEventListener("message", h);
  w.postMessage({ type: "generate", id, messages, options });
});

try {
  const probe = once("probe");
  w.postMessage({ type: "probe" });
  const p = (await probe).probe;
  const ready = once("ready");
  const engine = params.get("engine") || (variant.device === "wasm" ? "wasm" : "webgpu");
  const t0load = performance.now();
  // ATTEMPT=q4/webgpu/sur (run.mjs) : réglage GPU d'une tentative de l'échelle
  w.postMessage({ type: "load", variant, engine, attemptId: params.get("attempt") || undefined });
  const r = await ready;
  if (r.type === "error") throw new Error(`${r.message}\n   journal : ${JSON.stringify(r.log)}`);
  await send({ type: "meta", attempt: params.get("attempt"), gpu: r.gpu, device: variant.device, dtype: variant.dtype, engine, probe: p, ua: navigator.userAgent,
               isolated: self.crossOriginIsolated, cores: navigator.hardwareConcurrency,
               loadMs: Math.round(performance.now() - t0load), selfTest: r.selfTest, selfTestMs: r.selfTestMs });
  // Contexte vide : un outil appelé retombe sur l'assistant déterministe, ce n'est pas l'objet du banc.
  const ctx = { stations: [], t, now: new Date() };
  if (params.get("mode") === "prefixe") {
    // Comme AIScreen : « warm » dès le modèle prêt, puis les questions. Un message sans
    // consigne, mis en file derrière, marque la fin du calcul anticipé.
    const system = { role: "system", content: systemPrompt(t) };
    let t0 = performance.now();
    w.postMessage({ type: "warm", system: system.content });
    await generate(SELF_TEST_MESSAGES, { max_new_tokens: 1, do_sample: false });
    const warmMs = Math.round(performance.now() - t0);
    log(`consigne calculée d'avance en ${warmMs} ms`);
    for (const q of QUESTIONS.slice(0, Number(params.get("n")) || 3)) {
      t0 = performance.now();
      const out = await generate([system, { role: "user", content: q }], generationOptions({ maxNewTokens: 24 }));
      const ms = Math.round(performance.now() - t0);
      await send({ type: "row", cfg: `prefixe (anticipé ${warmMs} ms)`, q, reachesModel: true, raw: out.text ?? "", error: out.error, ms });
      log(`${q} → ${out.error ? "ERREUR " + out.error : out.text} (${ms} ms)`);
    }
    await send({ type: "done" });
    throw null;
  }
  if (params.get("mode") === "conversation") {
    // Conversation réelle (cases.CONVERSATION), comme AIScreen.sendText : historique de
    // CHAT_TURNS messages où n'entrent que les réponses libres montrées, options de
    // l'application. Une erreur du worker est rapportée telle quelle (l'application,
    // elle, la rattrapait sans rien dire).
    let aiHistory = [];
    for (const q of CONVERSATION) {
      const local = answerLocally(q, { t, stations: [] });
      const hist = [...aiHistory, { role: "user", content: q }].slice(-6);
      const messages = [{ role: "system", content: systemPrompt(t) }, ...hist];
      const t0 = performance.now();
      const out = await generate(messages, generationOptions({ maxNewTokens: Number(params.get("max")) || 96 }));
      const ms = Math.round(performance.now() - t0);
      const raw = out.text ?? "";
      const cleaned = cleanReply(raw);
      const read = out.error ? null : readModelOutput(cleaned);
      const shown = out.error ? { source: "fallback", reason: "generate", text: local.text }
        : resolveModelOutput(cleaned, ctx, local);
      await send({ type: "row", cfg: "conversation", q, reachesModel: local.unknown === true, raw, error: out.error, ms,
                   cleaned, read: read && (read.kind === "invalid" ? `invalid:${read.reason}` : read.kind),
                   source: shown.source, reason: shown.reason, shown: shown.text });
      if (shown.source === "model") aiHistory = [...hist, { role: "assistant", content: shown.text }];
      log(`${q} → ${out.error ? "ERREUR " + out.error : raw}`);
    }
    await send({ type: "done" });
    throw null;
  }
  for (const cfg of CONFIGS.filter((c) => !only || only.includes(c.id))) {
    for (const q of QUESTIONS) {
      const local = answerLocally(q, { t, stations: [] });
      const messages = [{ role: "system", content: systemPrompt(t) }, { role: "user", content: q }];
      const t0 = performance.now();
      const out = await generate(messages, { max_new_tokens: 96, ...cfg.options });
      const ms = Math.round(performance.now() - t0);
      const raw = out.text ?? "";
      const shown = out.error ? null : resolveModelOutput(cleanReply(raw), ctx, { text: "<repli local>" });
      await send({ type: "row", cfg: cfg.id, q, reachesModel: local.unknown === true, raw, error: out.error, ms,
                   source: shown?.source, reason: shown?.reason, shown: shown?.text });
      log(`${cfg.id} | ${q} → ${raw}`);
    }
  }
} catch (e) {
  if (e !== null) await send({ type: "fatal", message: String(e?.message || e) });
}
await send({ type: "done" });
