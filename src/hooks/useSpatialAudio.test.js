// Annonces vocales : langue de l'interface.
import { describe, it, expect } from "vitest";
import { buildAnnouncement, ttsLang } from "./useSpatialAudio.js";

describe("buildAnnouncement", () => {
  it("français par défaut", () => {
    expect(buildAnnouncement("left", 120, "", "fr")).toBe("Dans 120 mètres, tournez à gauche.");
  });
  it("anglais quand l'interface est en anglais (défaut corrigé : toujours en français)", () => {
    expect(buildAnnouncement("right", 120, "", "en")).toBe("In 120 metres, turn right.");
    expect(buildAnnouncement("uturn", 30, "", "en")).toBe("Make a U-turn.");
  });
  it("kilomètres et nom de rue", () => {
    expect(buildAnnouncement("slight left", 1500, "Rue du Fort", "fr"))
      .toBe("Dans 1.5 kilomètres, légère gauche sur Rue du Fort.");
  });
  it("langue inconnue → français", () => {
    expect(ttsLang("de")).toBe("fr");
    expect(ttsLang("en")).toBe("en");
  });
});
