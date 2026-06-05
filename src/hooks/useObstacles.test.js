// Régression #2 (audit) : la vérification Schnorr BIP-340 des events Nostr
// entrants ne fonctionne QUE si `hashes.sha256` est configuré pour le
// schnorr.verify synchrone de @noble/secp256k1 v3. L'import de useObstacles.js
// effectue cette configuration ; ces tests garantissent qu'elle reste en place
// (sinon verifyEvent rejette TOUS les events, même valides → feature morte).

import { describe, it, expect } from "vitest";
import { schnorr } from "@noble/secp256k1";
import { verifyEvent } from "./useObstacles.js";

const bytesToHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// Construit un event Nostr signé exactement comme buildEvent() de useObstacles.
async function signEvent(sk, overrides = {}) {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 30078;
  const tags = [["t", "velohnav-obstacle"]];
  const content = '{"type":"hazard","lat":49.6,"lng":6.1}';
  const base = { pubkey, created_at, kind, tags, content, ...overrides };
  const serialized = JSON.stringify([0, base.pubkey, base.created_at, base.kind, base.tags, base.content]);
  const idBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)));
  const id = bytesToHex(idBytes);
  const sig = bytesToHex(await schnorr.signAsync(idBytes, sk));
  return { id, sig, ...base };
}

describe("verifyEvent — Schnorr BIP-340 Nostr", () => {
  it("accepte un event correctement signé", async () => {
    const sk = new Uint8Array(32);
    crypto.getRandomValues(sk);
    const evt = await signEvent(sk);
    expect(await verifyEvent(evt)).toBe(true);
  });

  it("rejette un event dont le contenu a été falsifié après signature", async () => {
    const sk = new Uint8Array(32);
    crypto.getRandomValues(sk);
    const evt = await signEvent(sk);
    evt.content = '{"type":"hazard","lat":50.0,"lng":6.1}'; // déplace l'obstacle
    expect(await verifyEvent(evt)).toBe(false);
  });

  it("rejette un event dont l'id ne correspond pas à la sérialisation", async () => {
    const sk = new Uint8Array(32);
    crypto.getRandomValues(sk);
    const evt = await signEvent(sk);
    evt.id = "00".repeat(32);
    expect(await verifyEvent(evt)).toBe(false);
  });

  it("rejette une signature valide mais produite par une autre clé", async () => {
    const sk = new Uint8Array(32);
    crypto.getRandomValues(sk);
    const evt = await signEvent(sk); // id + pubkey cohérents
    // Re-signe le MÊME id avec une autre clé : l'id matche toujours la
    // sérialisation (check id OK), mais schnorr.verify doit rejeter la sig.
    const other = new Uint8Array(32);
    crypto.getRandomValues(other);
    const idBytes = new Uint8Array(evt.id.length / 2);
    for (let i = 0; i < evt.id.length; i += 2) idBytes[i / 2] = parseInt(evt.id.substring(i, i + 2), 16);
    evt.sig = bytesToHex(await schnorr.signAsync(idBytes, other));
    expect(await verifyEvent(evt)).toBe(false);
  });
});
