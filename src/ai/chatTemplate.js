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
// Autres familles (candidats de modelPolicy.js : NATIVE_CANDIDATES, évalués par
// scripts/bench-native/compare.mjs) : `template` choisit le gabarit, reproduit d'après le
// chat_template du dépôt de chaque modèle. Le moteur tokenise SANS ajouter de jeton de
// début (vh_llm.cpp : add_special = false) : chaque gabarit l'écrit lui-même.
//   lfm    LFM2.5         <|startoftext|><|im_start|>rôle\n…<|im_end|>\n
//   chatml Qwen2.5        <|im_start|>rôle\n…<|im_end|>\n, consigne Qwen par défaut
//   phi3   Phi-3-mini     <s><|rôle|>\n…<|end|>\n
//   zephyr TinyLlama chat <s><|rôle|>\n…</s>\n
// Le moteur s'arrête sur le jeton de fin de tour du modèle et rend « <|im_end|> » quelle que
// soit la famille : la lecture de la réponse (cleanReply) ne change pas.
//
// Module PUR, sans dépendance.

const QWEN_SYSTEM = "You are Qwen, created by Alibaba Cloud. You are a helpful assistant.";
// Outils dans la consigne. LFM2.5 : « List of tools: [...] » (son gabarit). Qwen2.5 : le bloc
// <tools> de son gabarit, réponses attendues en <tool_call>{…}</tool_call> (lues par
// tools.parseToolCalls) — sans lui, Qwen n'appelle jamais d'outil et INVENTE la réponse
// (banc compare.mjs : « Oui, il y a des vélos à la station Gare »). Phi-3 et TinyLlama n'ont
// aucun format d'outils dans leur gabarit : ils reçoivent le même bloc que Qwen.
const lfmTools = (system, tools) =>
  `${system}${system ? "\n" : ""}List of tools: [${tools.map((t) => (typeof t === "string" ? t : pyJson(t))).join(", ")}]`;
const hermesTools = (system, tools) => `${system}\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\n`
  + "You are provided with function signatures within <tools></tools> XML tags:\n<tools>"
  + tools.map((t) => `\n${typeof t === "string" ? t : pyJson(t)}`).join("")
  + "\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n"
  + "<tool_call>\n{\"name\": <function-name>, \"arguments\": <args-json-object>}\n</tool_call>";
const FAMILIES = {
  lfm: { bos: "<|startoftext|>", tools: lfmTools, turn: (r, c) => `<|im_start|>${r}\n${c}<|im_end|>\n`, gen: "<|im_start|>assistant\n" },
  chatml: { bos: "", tools: hermesTools, turn: (r, c) => `<|im_start|>${r}\n${c}<|im_end|>\n`, gen: "<|im_start|>assistant\n", defaultSystem: QWEN_SYSTEM },
  phi3: { bos: "<s>", tools: hermesTools, turn: (r, c) => `<|${r}|>\n${c}<|end|>\n`, gen: "<|assistant|>\n" },
  zephyr: { bos: "<s>", tools: hermesTools, turn: (r, c) => `<|${r}|>\n${c}</s>\n`, gen: "<|assistant|>\n" },
};
const family = (template = "lfm") => {
  const f = FAMILIES[template];
  if (!f) throw new Error(`gabarit inconnu : ${template}`);
  return f;
};

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
 * @param {{tools?: object[], addGenerationPrompt?: boolean, template?: string}} [opts]
 *   template : famille du gabarit (« lfm » par défaut)
 * @returns {string}
 */
export function formatChat(messages, { tools, addGenerationPrompt = true, template = "lfm" } = {}) {
  const fam = family(template);
  let msgs = messages;
  let system = "";
  if (msgs[0]?.role === "system") {
    system = text(msgs[0].content);
    msgs = msgs.slice(1);
  }
  if (!system && fam.defaultSystem) system = fam.defaultSystem;
  if (tools?.length) system = fam.tools(system, tools);
  let out = fam.bos;
  if (system) out += fam.turn("system", system);
  const lastAssistant = msgs.map((m) => m.role).lastIndexOf("assistant");
  msgs.forEach((m, i) => {
    let content = text(m.content);
    if (m.role === "assistant" && i !== lastAssistant && content.includes("</think>")) {
      content = content.split("</think>").at(-1).trim();
    }
    out += fam.turn(m.role, content);
  });
  if (addGenerationPrompt) out += fam.gen;
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
  const fam = family(opts.template);
  const prefix = head.length || opts.tools?.length || fam.defaultSystem ? formatChat(head, { ...opts, addGenerationPrompt: false }) : fam.bos;
  return full.startsWith(prefix) ? { prefix, rest: full.slice(prefix.length) } : { prefix: "", rest: full };
}
