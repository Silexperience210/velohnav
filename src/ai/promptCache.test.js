import { describe, it, expect } from "vitest";
import { reusablePrefix, prefixMessages, shareable, copyCache } from "./promptCache.js";

class FakeCache {
  constructor(entries) { Object.assign(this, entries); }
  update(entries) { Object.assign(this, entries); }
}

describe("reusablePrefix", () => {
  it("rend la longueur du préfixe quand le prompt le prolonge", () => {
    expect(reusablePrefix([1, 2, 3, 4, 5], [1, 2, 3])).toBe(3);
  });

  it("compare les identifiants int64 (BigInt64Array) de transformers.js", () => {
    expect(reusablePrefix(BigInt64Array.from([1n, 2n, 3n, 9n]), BigInt64Array.from([1n, 2n, 3n]))).toBe(3);
  });

  it("0 si un seul jeton diffère : consigne ou outils changés (langue, par exemple)", () => {
    expect(reusablePrefix([1, 2, 7, 4], [1, 2, 3])).toBe(0);
  });

  it("0 si le prompt ne prolonge pas le préfixe : il faut au moins un jeton à calculer", () => {
    expect(reusablePrefix([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(reusablePrefix([1, 2], [1, 2, 3])).toBe(0);
  });

  it("0 sans préfixe", () => {
    expect(reusablePrefix([1, 2], [])).toBe(0);
    expect(reusablePrefix([1, 2], null)).toBe(0);
  });
});

describe("prefixMessages", () => {
  const system = { role: "system", content: "consigne" };
  const user = { role: "user", content: "Bonjour" };

  it("la consigne système seule", () => {
    expect(prefixMessages([system, user])).toEqual([system]);
  });

  it("rien sans consigne système (essai à vide) ni sans question", () => {
    expect(prefixMessages([user])).toBe(null);
    expect(prefixMessages([system])).toBe(null);
    expect(prefixMessages([])).toBe(null);
  });
});

describe("shareable", () => {
  it("oui si tous les tenseurs sont en mémoire JS (moteur processeur)", () => {
    expect(shareable(new FakeCache({ a: { location: "cpu" }, b: { location: "cpu" } }))).toBe(true);
  });

  it("non sur WebGPU : transformers.js détruit les tampons d'un cache qu'il remplace", () => {
    expect(shareable(new FakeCache({ a: { location: "cpu" }, b: { location: "gpu-buffer" } }))).toBe(false);
  });

  it("non si vide", () => {
    expect(shareable(new FakeCache({}))).toBe(false);
    expect(shareable(null)).toBe(false);
  });
});

describe("copyCache", () => {
  it("une génération qui remplace les entrées de la copie laisse le préfixe intact", () => {
    const k = { location: "cpu", id: "k" };
    const prefix = new FakeCache({ "past_key_values.2.key": k });
    const copy = copyCache(prefix);
    expect(copy).toBeInstanceOf(FakeCache);
    copy.update({ "past_key_values.2.key": { location: "cpu", id: "k+1" } });
    expect(prefix["past_key_values.2.key"]).toBe(k);
    expect(copyCache(prefix)["past_key_values.2.key"]).toBe(k);
  });
});
