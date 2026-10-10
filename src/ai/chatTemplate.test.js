import { describe, it, expect } from "vitest";
import { formatChat, splitPrompt, pyJson } from "./chatTemplate.js";
import CASES from "../__fixtures__/lfm25_chat_template.json";

// Texte attendu = sortie de apply_chat_template (transformers.js) sur le vrai tokenizer de
// LFM2.5, figée par scripts/bench-native/template.mjs.
describe("gabarit LFM2.5 du moteur natif — identique à celui de transformers.js", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(formatChat(c.messages, { tools: c.tools, addGenerationPrompt: c.addGenerationPrompt })).toBe(c.expected);
    });
  }
});

describe("splitPrompt — consigne commune, puis la suite", () => {
  for (const c of CASES) {
    it(`préfixe + suite = prompt complet (${c.name})`, () => {
      const { prefix, rest } = splitPrompt(c.messages, { tools: c.tools, addGenerationPrompt: c.addGenerationPrompt });
      expect(prefix + rest).toBe(c.expected);
    });
  }

  it("la consigne ne dépend pas de la question : même préfixe pour deux questions", () => {
    const sys = { role: "system", content: "Réponds en français." };
    const a = splitPrompt([sys, { role: "user", content: "bonjour" }]);
    const b = splitPrompt([sys, { role: "user", content: "il pleut ?" }, { role: "assistant", content: "Non." }, { role: "user", content: "merci" }]);
    expect(a.prefix).toBe(b.prefix);
    expect(a.prefix).toBe("<|startoftext|><|im_start|>system\nRéponds en français.<|im_end|>\n");
    expect(a.rest).toBe("<|im_start|>user\nbonjour<|im_end|>\n<|im_start|>assistant\n");
  });

  it("sans consigne : préfixe réduit au jeton de début", () => {
    expect(splitPrompt([{ role: "user", content: "x" }]).prefix).toBe("<|startoftext|>");
  });
});

it("pyJson : séparateurs à la Python, accents conservés", () => {
  expect(pyJson({ a: [1, "é"], b: {}, c: null, d: true })).toBe('{"a": [1, "é"], "b": {}, "c": null, "d": true}');
});
