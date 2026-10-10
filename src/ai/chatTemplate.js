// Gabarit de conversation de LFM2.5, écrit à la main pour le moteur natif (llama.cpp).
//
// La voie WebGPU / processeur applique le gabarit du tokenizer (apply_chat_template de
// transformers.js). Le moteur natif, lui, reçoit un texte déjà mis en forme : il ne
// connaît que des jetons. Ce module reproduit EXACTEMENT chat_template.jinja du dépôt
// (onnx-community/LFM2.5-350M-ONNX, identique à celui du GGUF de LiquidAI) — vérifié
// caractère pour caractère contre transformers.js par scripts/bench-native/template.mjs,
// dont la sortie est figée dans chatTemplate.test.js. Même modèle, même consigne, mêmes
// outils : les deux voies voient le même prompt.
//
// Module PUR, sans dépendance.

const BOS = "<|startoftext|>";

/**
 * JSON à la manière du filtre `tojson` de Jinja (Python) : séparateurs « , » et « : »,
 * non-ASCII conservé. JSON.stringify écrit sans espaces : le modèle verrait une liste
 * d'outils différente de celle de l'entraînement et du gabarit de l'autre voie.
 */
export function pyJson(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(", ")}}`;
  return JSON.stringify(v);
}

const text = (c) => (typeof c === "string" ? c
  : Array.isArray(c) ? c.map((it) => (it?.type === "text" ? it.text : it?.type === "image" ? "<image>" : pyJson(it))).join("")
  : String(c ?? ""));

/**
 * @param {Array<{role: string, content: string}>} messages
 * @param {{tools?: object[], addGenerationPrompt?: boolean}} [opts]
 * @returns {string}
 */
export function formatChat(messages, { tools, addGenerationPrompt = true } = {}) {
  let msgs = messages;
  let system = "";
  if (msgs[0]?.role === "system") {
    system = text(msgs[0].content);
    msgs = msgs.slice(1);
  }
  if (tools?.length) {
    system += `${system ? "\n" : ""}List of tools: [${tools.map((t) => (typeof t === "string" ? t : pyJson(t))).join(", ")}]`;
  }
  let out = BOS;
  if (system) out += `<|im_start|>system\n${system}<|im_end|>\n`;
  const lastAssistant = msgs.map((m) => m.role).lastIndexOf("assistant");
  msgs.forEach((m, i) => {
    let content = text(m.content);
    if (m.role === "assistant" && i !== lastAssistant && content.includes("</think>")) {
      content = content.split("</think>").at(-1).trim();
    }
    out += `<|im_start|>${m.role}\n${content}<|im_end|>\n`;
  });
  if (addGenerationPrompt) out += "<|im_start|>assistant\n";
  return out;
}

/**
 * Le prompt en deux morceaux : la consigne (système + outils), commune à toutes les
 * questions, et la suite. Le moteur natif garde l'état du modèle à la fin de la consigne
 * et ne recalcule que la suite — l'équivalent de promptCache.js pour l'autre voie.
 * `prefix + rest` vaut toujours formatChat(messages, opts).
 */
export function splitPrompt(messages, opts = {}) {
  const full = formatChat(messages, opts);
  const head = messages[0]?.role === "system" ? [messages[0]] : [];
  const prefix = head.length || opts.tools?.length ? formatChat(head, { ...opts, addGenerationPrompt: false }) : BOS;
  return full.startsWith(prefix) ? { prefix, rest: full.slice(prefix.length) } : { prefix: "", rest: full };
}
