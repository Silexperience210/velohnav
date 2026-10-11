import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { checkCached, ensureIntact } from "./modelIntegrity.js";
import { hubFileUrl, verifiedKey, integrityVerdict, VARIANTS, classifyFailure, ATTEMPTS } from "./modelPolicy.js";

// Faux cache (API Cache du navigateur) : clé = URL, valeur = octets, relus par morceaux
// de 1 Mio comme un corps en flux.
const chunked = (u8) => new ReadableStream({
  start(c) { for (let i = 0; i < u8.length; i += 2 ** 20) c.enqueue(u8.slice(i, i + 2 ** 20)); c.close(); },
});
class FakeCache {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); this.puts = []; this.deletes = []; }
  async match(url) { return this.map.has(url) ? new Response(chunked(this.map.get(url))) : undefined; }
  async put(url, res) { this.puts.push(url); this.map.set(url, new Uint8Array(await res.arrayBuffer())); }
  async delete(url) { this.deletes.push(url); return this.map.delete(url); }
}

const FILE = "onnx/model_q4.onnx_data";
const URL_ = hubFileUrl(FILE);
const body = new Uint8Array(3 * 2 ** 20).map((_, i) => (i * 7) & 0xff);   // 3 Mio, contenu connu
const sha = (u8) => createHash("sha256").update(u8).digest("hex");
const want = { bytes: body.length, sha256: sha(body) };

describe("intégrité d'un fichier du modèle en cache", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it("fichier exact : haché une fois, marqué vérifié ; la fois suivante il n'est plus relu", async () => {
    const cache = new FakeCache({ [URL_]: body });
    expect(await checkCached(cache, FILE, want)).toEqual({ ok: true, reason: "ok" });
    expect(cache.puts).toEqual([verifiedKey(URL_, want.sha256)]);
    const spy = vi.spyOn(cache, "match");
    expect(await checkCached(cache, FILE, want)).toEqual({ ok: true, reason: "verified" });
    expect(spy).toHaveBeenCalledTimes(1);   // seule la marque est lue
  });

  it("fichier TRONQUÉ (le cas que transformers.js complète en silence par des zéros) : retiré du cache", async () => {
    const cache = new FakeCache({ [URL_]: body.slice(0, body.length - 1000) });
    const v = await checkCached(cache, FILE, want);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe(`size ${body.length - 1000} != ${body.length}`);
    expect(cache.deletes).toEqual([URL_]);
    expect(cache.puts).toEqual([]);
  });

  it("bonne taille, contenu altéré : SHA-256 différent, retiré du cache", async () => {
    const bad = body.slice(); bad[12345] ^= 1;
    const cache = new FakeCache({ [URL_]: bad });
    const v = await checkCached(cache, FILE, want);
    expect(v).toMatchObject({ ok: false });
    expect(v.reason).toMatch(/^sha256 /);
    expect(cache.map.has(URL_)).toBe(false);
  });

  it("absent du cache : rien à vérifier (transformers.js le téléchargera, vérifié au lancement suivant)", async () => {
    expect(await checkCached(new FakeCache(), FILE, want)).toEqual({ ok: true, reason: "absent" });
  });

  it("une marque pour une AUTRE empreinte ne vaut pas vérification", async () => {
    const cache = new FakeCache({ [URL_]: body.slice(0, 10), [verifiedKey(URL_, "0".repeat(64))]: new Uint8Array(1) });
    expect((await checkCached(cache, FILE, want)).ok).toBe(false);
  });

  it("signes de vie pendant la lecture : le chien de garde ne prend pas le hachage pour un blocage", async () => {
    const big = new Uint8Array(20 * 2 ** 20);
    const cache = new FakeCache({ [URL_]: big });
    const sign = vi.fn();
    await checkCached(cache, FILE, { bytes: big.length, sha256: sha(big) }, sign);
    expect(sign.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("variante entière : fichier faux → retéléchargé → revérifié ; faux encore → erreur « integrity »", async () => {
    const variant = { files: [FILE], bytes: { [FILE]: want.bytes }, sha256: { [FILE]: want.sha256 } };
    const good = new FakeCache({ [URL_]: body.slice(0, 5) });
    const seen = await ensureIntact(good, variant, async (f) => { good.map.set(hubFileUrl(f), body); });
    expect(seen.map((x) => x.reason)).toEqual([`refetched: size 5 != ${body.length}`, "ok"]);

    const still = new FakeCache({ [URL_]: body.slice(0, 5) });
    const err = await ensureIntact(still, variant, async (f) => { still.map.set(hubFileUrl(f), body.slice(0, 7)); }).catch((e) => e);
    expect(err).toMatchObject({ stage: "integrity" });
    expect(err.message).toContain(`size 7 != ${body.length}`);
  });
});

describe("empreintes des fichiers (révision épinglée)", () => {
  it("chaque fichier de chaque variante a sa taille et son SHA-256", () => {
    for (const v of Object.values(VARIANTS)) {
      for (const f of v.files) {
        expect(v.bytes[f]).toBeGreaterThan(0);
        expect(v.sha256[f]).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it("verdict : taille d'abord, puis empreinte", () => {
    expect(integrityVerdict({ bytes: 3, sha256: "a" }, { bytes: 4, sha256: "a" })).toMatchObject({ ok: false, reason: "size 3 != 4" });
    expect(integrityVerdict({ bytes: 4, sha256: "b".repeat(64) }, { bytes: 4, sha256: "a".repeat(64) }).reason).toMatch(/^sha256 /);
    expect(integrityVerdict({ bytes: 4, sha256: "a" }, { bytes: 4, sha256: "a" })).toEqual({ ok: true, reason: "ok" });
  });

  it("un fichier faux deux fois arrête le chargement sans rien condamner (réseau ou stockage, pas le moteur)", () => {
    const wasm = ATTEMPTS.find((a) => a.id === "q4/wasm");
    expect(classifyFailure({ attempt: wasm, phase: "integrity" })).toMatchObject({ condemn: false, continue: false, code: "integrity" });
  });
});
