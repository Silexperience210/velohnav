// Page du banc « conversation libre » (voir run.mjs). Utilise le VRAI worker de
// l'application (src/ai/modelWorker.js) et le vrai chemin d'affichage
// (systemPrompt, TOOLS, cleanReply, resolveModelOutput) : seule change la
// configuration de génération comparée.
import { VARIANTS } from "../../src/ai/modelPolicy.js";
import { TOOLS } from "../../src/ai/tools.js";
import { systemPrompt, resolveModelOutput } from "../../src/ai/assistant.js";
import { answerLocally } from "../../src/ai/localAnswers.js";
import { cleanReply } from "../../src/ai/localModel.js";
import fr from "../../src/locales/fr.js";
import { QUESTIONS, CONFIGS } from "./cases.js";

const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");
const params = new URLSearchParams(location.search);
const variant = VARIANTS[params.get("device") || "webgpu"];
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
  w.postMessage({ type: "generate", id, messages, tools: TOOLS, options });
});

try {
  const probe = once("probe");
  w.postMessage({ type: "probe" });
  const p = (await probe).probe;
  const ready = once("ready");
  w.postMessage({ type: "load", variant });
  const r = await ready;
  if (r.type === "error") throw new Error(r.message);
  await send({ type: "meta", device: variant.device, dtype: variant.dtype, probe: p, ua: navigator.userAgent });
  // Contexte vide : un outil appelé retombe sur l'assistant déterministe, ce n'est pas l'objet du banc.
  const ctx = { stations: [], t, now: new Date() };
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
  await send({ type: "fatal", message: String(e?.message || e) });
}
await send({ type: "done" });
