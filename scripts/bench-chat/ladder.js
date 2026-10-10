// Page du banc « échelle des tentatives » (run.mjs, PAGE=ladder). Utilise la VRAIE
// façade (localModel.loadModel) et le vrai worker : sonde, choix, bascules, essai à vide.
//
// ?f16=1 : la sonde annonce shader-f16 même si le GPU ne l'a pas. Sert à rejouer pour de
// vrai le cas d'un GPU dont le fp16 échoue : les moteurs échouent réellement (q4f16
// « Sub requires f16 » sur l'EP natif, <|pad|> en boucle sur JSEP) et l'échelle doit
// continuer seule. Rien d'autre n'est simulé.
import { loadModel, generateDetailed, modelReport } from "../../src/ai/localModel.js";
import { systemPrompt } from "../../src/ai/assistant.js";
import fr from "../../src/locales/fr.js";

const t = (k, p = {}) => String(fr[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? "");
const params = new URLSearchParams(location.search);
const send = (o) => fetch("/__bench", { method: "POST", body: JSON.stringify(o) });

if (params.get("f16") === "1") {
  const Real = globalThis.Worker;
  globalThis.Worker = class extends Real {
    set onmessage(h) {
      super.onmessage = (ev) => {
        const d = ev.data;
        if (d?.type === "probe" && d.probe?.adapter) {
          d.probe = { ...d.probe, features: [...new Set([...(d.probe.features || []), "shader-f16"])] };
        }
        h?.(ev);
      };
    }
  };
}

const phases = [];
try {
  localStorage.clear();
  const t0 = performance.now();
  await loadModel(() => {}, (p) => phases.push(p));
  const loadMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const out = await generateDetailed(systemPrompt(t), [{ role: "user", content: "Je suis Silex" }], { maxNewTokens: 96 });
  await send({ type: "ladder", ok: true, loadMs, genMs: Math.round(performance.now() - t1), raw: out.raw,
               report: modelReport(), phases, stored: localStorage.getItem("velohnav_ai_attempts_ko") });
} catch (e) {
  await send({ type: "ladder", ok: false, code: e?.code, detail: e?.detail || String(e), report: modelReport(), phases });
}
await send({ type: "done" });
