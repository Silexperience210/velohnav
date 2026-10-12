import { describe, it, expect } from "vitest";
import { keyboardOpen, KEYBOARD_MIN_PX } from "./hooks.js";

describe("keyboardOpen — clavier virtuel déduit de la hauteur visible", () => {
  it("clavier ouvert : la hauteur visible chute nettement", () => {
    expect(keyboardOpen(780, 420)).toBe(true);
  });
  it("barre d'adresse ou de navigation qui bouge : pas un clavier", () => {
    expect(keyboardOpen(780, 724)).toBe(false);
    expect(keyboardOpen(780, 780 - KEYBOARD_MIN_PX)).toBe(false);
  });
});
