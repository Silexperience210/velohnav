// ── Tests src/nostr/core.js — PoW NIP-13, intégrité, anti-futur ────────
import { describe, it, expect } from "vitest";
import {
  countLeadingZeroBits, minePow, hasValidPow, buildEvent, verifyEvent,
  generateEphemeralKey, bytesToHex, hexToBytes,
} from "./core.js";

describe("countLeadingZeroBits", () => {
  it("compte les nibbles à zéro", () => {
    expect(countLeadingZeroBits("ff" + "0".repeat(62))).toBe(0);
    expect(countLeadingZeroBits("0f" + "0".repeat(62))).toBe(4);
    expect(countLeadingZeroBits("00ff" + "0".repeat(60))).toBe(8);
  });
  it("compte les bits partiels du premier nibble non-nul", () => {
    // 0x1 = 0001 → 3 zéros de plus
    expect(countLeadingZeroBits("01" + "0".repeat(62))).toBe(4 + 3);
    // 0x2 = 0010 → 2 ; 0x4 = 0100 → 1 ; 0x8 = 1000 → 0
    expect(countLeadingZeroBits("02" + "0".repeat(62))).toBe(4 + 2);
    expect(countLeadingZeroBits("04" + "0".repeat(62))).toBe(4 + 1);
    expect(countLeadingZeroBits("08" + "0".repeat(62))).toBe(4 + 0);
  });
  it("id entièrement nul = 256 bits", () => {
    expect(countLeadingZeroBits("0".repeat(64))).toBe(256);
  });
});

describe("hex utils", () => {
  it("aller-retour bytes↔hex", () => {
    const b = new Uint8Array([0, 1, 15, 16, 255]);
    expect(hexToBytes(bytesToHex(b))).toEqual(b);
  });
});

describe("minePow + hasValidPow", () => {
  it("mine un event à 10 bits et le valide", async () => {
    const { pk } = generateEphemeralKey();
    const mined = await minePow({
      pubkeyHex: pk, kind: 30078,
      tags: [["t", "test"]], content: "{}", targetBits: 10,
    });
    expect(countLeadingZeroBits(mined.id)).toBeGreaterThanOrEqual(10);
    const nonceTag = mined.tags.find(t => t[0] === "nonce");
    expect(nonceTag).toBeTruthy();
    expect(parseInt(nonceTag[2], 10)).toBe(10);
    expect(hasValidPow({ id: mined.id, tags: mined.tags }, 10)).toBe(true);
  }, 20000);

  it("rejette un id difficile mais sans cible déclarée (anti-recyclage)", () => {
    expect(hasValidPow({ id: "0".repeat(64), tags: [] }, 10)).toBe(false);
    // Cible déclarée inférieure au minimum exigé → rejet
    expect(hasValidPow({ id: "0".repeat(64), tags: [["nonce", "1", "5"]] }, 10)).toBe(false);
  });
});

describe("buildEvent + verifyEvent", () => {
  it("event signé valide (sans PoW)", async () => {
    const { sk, pk } = generateEphemeralKey();
    const evt = await buildEvent({
      secretKey: sk, pubkeyHex: pk, kind: 30078,
      content: JSON.stringify({ hello: 1 }), tags: [["t", "x"]],
    });
    expect(await verifyEvent(evt)).toBe(true);
  });

  it("event signé + PoW 8 bits valide", async () => {
    const { sk, pk } = generateEphemeralKey();
    const evt = await buildEvent({
      secretKey: sk, pubkeyHex: pk, kind: 30078,
      content: "{}", tags: [["t", "x"]], powBits: 8,
    });
    expect(await verifyEvent(evt)).toBe(true);
    expect(hasValidPow(evt, 8)).toBe(true);
  }, 20000);

  it("rejette un contenu altéré (id ne matche plus)", async () => {
    const { sk, pk } = generateEphemeralKey();
    const evt = await buildEvent({
      secretKey: sk, pubkeyHex: pk, kind: 30078, content: "{}", tags: [],
    });
    expect(await verifyEvent({ ...evt, content: '{"hacked":true}' })).toBe(false);
  });

  it("SÉCU : rejette created_at dans le futur (bypass du décay 24h)", async () => {
    const { sk, pk } = generateEphemeralKey();
    const evt = await buildEvent({
      secretKey: sk, pubkeyHex: pk, kind: 30078, content: "{}", tags: [],
    });
    // Forge un event "de demain" avec id+sig RECALCULÉS correctement —
    // seule la garde temporelle peut le bloquer.
    const future = Math.floor(Date.now() / 1000) + 86400;
    const { eventId } = await import("./core.js");
    const { schnorr } = await import("@noble/secp256k1");
    const idBytes = eventId(pk, future, 30078, [], "{}");
    const sig = await schnorr.signAsync(idBytes, sk);
    const forged = {
      id: bytesToHex(idBytes), pubkey: pk, created_at: future,
      kind: 30078, tags: [], content: "{}", sig: bytesToHex(sig),
    };
    expect(await verifyEvent(forged)).toBe(false);
    expect(await verifyEvent(evt)).toBe(true); // le légitime passe toujours
  });
});
