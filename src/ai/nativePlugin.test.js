import { describe, it, expect, vi, afterEach } from "vitest";

// Le greffon tel que le rend vraiment registerPlugin (@capacitor/core 8, runtime) : un
// proxy dont CHAQUE propriété est une méthode native — `then` compris. Appelée par
// `await`, cette « méthode then » rejette sa propre promesse sans jamais appeler les
// rappels d'`await` : l'attente ne finit pas. Relevé sur le téléphone : « native status:
// no answer after 5 s », à chaque lancement.
function capacitorProxy(impl) {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === "$$typeof") return undefined;
      return (...args) => (impl[prop]
        ? Promise.resolve(impl[prop](...args))
        : Promise.reject(new Error(`"LocalLlm.${String(prop)}()" is not implemented on android`)).catch(() => {}).then(() => new Promise(() => {})));
    },
  });
}

describe("greffon LocalLlm : le proxy Capacitor n'est jamais rendu tel quel par une fonction async", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock("@capacitor/core"); vi.resetModules(); vi.restoreAllMocks(); });

  it("rendu par une fonction async, le proxy brut fait attendre sans fin (le défaut constaté)", async () => {
    const proxy = capacitorProxy({ status: () => ({ supported: true }) });
    const get = async () => proxy;
    const r = await Promise.race([get().then(() => "réponse"), new Promise((res) => setTimeout(() => res("rien"), 50))]);
    expect(r).toBe("rien");
  });

  it("nativeStatus répond aussitôt avec le vrai proxy (APK sur le téléphone)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const status = vi.fn(() => ({ supported: true, reason: "", device: "Xiaomi 2107113SG", soc: "QTI SM7325", modelExists: false }));
    vi.stubGlobal("Capacitor", { isNativePlatform: () => true, isPluginAvailable: () => true });
    vi.doMock("@capacitor/core", () => ({ registerPlugin: () => capacitorProxy({ status }) }));
    vi.resetModules();
    const { nativeStatus } = await import("./nativeModel.js");
    const t0 = Date.now();
    expect(await nativeStatus()).toMatchObject({ supported: true, soc: "QTI SM7325", modelExists: false });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(status).toHaveBeenCalledWith({ file: expect.stringMatching(/\.gguf$/) });
  });

  it("toutes les méthodes passent au greffon (téléchargement du GGUF compris)", async () => {
    const download = vi.fn(() => ({ cached: true }));
    const p = (await import("./nativeModel.js")).wrapPlugin(capacitorProxy({ download }));
    expect(typeof p.then).toBe("undefined");
    expect(await (async () => p)()).toBe(p);
    expect(await p.download({ file: "x.gguf" })).toEqual({ cached: true });
    expect(download).toHaveBeenCalledWith({ file: "x.gguf" });
  });
});
