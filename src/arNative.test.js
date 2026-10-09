// Défaut 1 — « l'AR ne fonctionne pas au lancement » : ARCore répondait
// ERROR_NOT_AUTHORIZED. Ce qui relève du code est vérifié ici ; la partie Kotlin
// (bascule immédiate, encart explicatif) n'est pas exécutable sans SDK Android.
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const startNavigation = vi.fn(async () => {});
vi.mock("@capacitor/core", () => ({ registerPlugin: () => ({ startNavigation }) }));

const { launchNativeArNav, resetArNavPlugin } = await import("./utils.js");
const { setLang } = await import("./i18n.js");

const RACINE = path.resolve(__dirname, "..");
const lire = (p) => fs.readFileSync(path.join(RACINE, p), "utf8");

describe("launchNativeArNav — ce que reçoit l'activité native", () => {
  beforeEach(() => { startNavigation.mockClear(); resetArNavPlugin(); });

  it("transmet la langue de l'interface (textes natifs en fr/en)", async () => {
    setLang("en");
    expect(await launchNativeArNav(49.6, 6.13, "Gare", "walking", "")).toBe(true);
    expect(startNavigation.mock.calls[0][0]).toMatchObject({ lang: "en", travelMode: "walking", webGuidance: false });
    setLang("fr");
  });

  it("signale que le guidage WebView tourne derrière (encart « Vue AR boussole »)", async () => {
    await launchNativeArNav(49.6, 6.13, "Gare", "bicycling", "", { webGuidance: true });
    expect(startNavigation.mock.calls[0][0].webGuidance).toBe(true);
  });

  it("renvoie false sans lever si le natif refuse", async () => {
    startNavigation.mockRejectedValueOnce(new Error("boom"));
    expect(await launchNativeArNav(49.6, 6.13, "Gare")).toBe(false);
  });
});

describe("clé ARCore — la CI et Gradle parlent du même fichier", () => {
  it("la clé écrite par la CI dans local.properties est lue par build.gradle (défaut corrigé)", () => {
    const ci = lire(".github/workflows/apk.yml");
    const gradle = lire("android/app/build.gradle");
    // La CI écrit la clé dans local.properties…
    expect(ci).toMatch(/MAPS_API_KEY=.*>>\s*android\/local\.properties/);
    // …or project.findProperty() ne lit pas ce fichier : sans chargement explicite,
    // la clé du manifest était vide et ARCore répondait ERROR_NOT_AUTHORIZED.
    expect(gradle).toMatch(/rootProject\.file\("local\.properties"\)/);
    expect(gradle).toMatch(/getProperty\("MAPS_API_KEY"\)/);
  });

  it("la procédure administrateur est documentée", () => {
    const doc = lire("docs/ARCORE.md");
    for (const mot of ["ARCore API", "com.silexperience.velohnav", "SHA-1", "DEBUG_KEYSTORE_BASE64"])
      expect(doc).toContain(mot);
  });
});

// Défaut 2 — « il le dit impossible et veut passer en GPS à chaque fois » : sans
// clé Google, l'AR locale d'ARCore marche, mais l'activité la traitait comme un
// échec. La géométrie est testée en Kotlin (GroundAnchorTest, JVM) ; ici, les
// garde-fous lisibles dans les sources, faute de SDK Android dans `vitest`.
describe("AR ancrée au sol — la clé Google est un bonus, pas une condition", () => {
  const AR = "android/app/src/main/java/com/silexperience/velohnav/ar/";
  const activite = lire(AR + "ArNavigationActivity.kt");
  const vm = lire(AR + "ArNavigationViewModel.kt");
  const textes = lire(AR + "ArStrings.kt");

  it("détecte les plans de sol, et ne demande Geospatial que si une clé existe", () => {
    expect(activite).toMatch(/planeFindingMode\s*=\s*Config\.PlaneFindingMode\.HORIZONTAL/);
    expect(activite).toMatch(/geospatialMode = if \(viewModel\.apiKeyPresent\)/);
  });

  it("une erreur Geospatial (clé absente ou refusée) ne fait plus passer en GPS seul", () => {
    const onEarth = vm.slice(vm.indexOf("private fun onEarth"), vm.indexOf("// ── Progression"));
    expect(onEarth).toContain("geoBonusOff");
    expect(onEarth).not.toContain("fallbackToGps");
    // Seules les vraies impossibilités mènent au GPS seul
    expect(vm).toMatch(/fallbackToGps\(FallbackReason\.NO_TRACKING\)/);
    expect(vm).toMatch(/fallbackToGps\(FallbackReason\.NO_COMPASS\)/);
  });

  it("le mode au sol est annoncé comme un mode à part entière, en fr et en en", () => {
    expect(textes).toContain("AR ANCRÉE AU SOL");
    expect(textes).toContain("GROUND-ANCHORED AR");
    expect(textes).toContain("sans compte ni clé");
    // Plus d'encart « AR précise indisponible » faute de clé
    expect(textes).not.toContain("AR PRÉCISE INDISPONIBLE");
    expect(textes).not.toMatch(/compilée sans clé/);
  });

  it("l'image ARCore est traitée sur l'instant (essai d'impact), pas reportée", () => {
    const cb = activite.slice(activite.indexOf("v.onSessionUpdated"), activite.indexOf("v.onSessionFailed"));
    expect(cb).toContain("viewModel.onArFrame(session, frame, v)");
    expect(cb).not.toContain("mainHandler.post");
  });

  it("les tests natifs de géométrie tournent en CI", () => {
    expect(lire(".github/workflows/apk.yml")).toMatch(/testDebugUnitTest/);
  });
});
