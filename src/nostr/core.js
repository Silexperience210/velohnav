// ── src/nostr/core.js — socle Nostr partagé VelohNav ──────────────────
// Fonctions communes aux features Nostr (obstacles, ghost trails) :
//   - sérialisation / id / signature NIP-01 (Schnorr BIP-340 via @noble)
//   - vérification d'events entrants
//   - Proof-of-Work NIP-13 (mining + validation) — défense anti-spam
//   - garde-fous temporels (created_at futur = rejet)
//
// SÉCURITÉ : la signature Schnorr garantit l'INTÉGRITÉ d'un event, pas sa
// VÉRACITÉ. Avec des clés éphémères anonymes, n'importe qui peut générer
// des milliers d'identités. Le PoW NIP-13 rend le flood coûteux : chaque
// event doit prouver ~2^bits hachages SHA-256. À 18 bits, un user légitime
// paie <1s de CPU une fois ; un spammeur paie 1s × 10 000 events.

import { schnorr, hashes } from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2";

// @noble/secp256k1 v3 : schnorr.verify (synchrone) exige un sha256 synchrone
// configuré globalement, sinon il renvoie false pour TOUTE signature.
if (!hashes.sha256) hashes.sha256 = sha256;

// Relays publics par défaut — partagés par toutes les features VelohNav.
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

// Tolérance d'horloge : un created_at plus de 5 min dans le futur = rejet.
// Sans ça, un attaquant peut publier created_at = now + 30 jours et
// contourner tout décay basé sur l'âge de l'event.
export const MAX_CLOCK_SKEW_S = 300;

// ── Hex utils ──────────────────────────────────────────────────────
export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ── Clé éphémère anonyme (session-only, jamais persistée) ──────────
export function generateEphemeralKey() {
  const sk = new Uint8Array(32);
  crypto.getRandomValues(sk);
  const pk = schnorr.getPublicKey(sk); // 32 bytes x-only BIP-340
  return { sk, pk: bytesToHex(pk) };
}

// ── Sérialisation NIP-01 + id (sha256 SYNCHRONE via @noble) ────────
// Synchrone exprès : le mining PoW itère des centaines de milliers de
// hachages — crypto.subtle (async) serait ~10× plus lent par overhead
// de Promise. @noble/hashes est déjà une dépendance du projet.
export function eventId(pubkeyHex, created_at, kind, tags, content) {
  const serialized = JSON.stringify([0, pubkeyHex, created_at, kind, tags, content]);
  return sha256(new TextEncoder().encode(serialized)); // Uint8Array(32)
}

// ── NIP-13 : comptage des bits de zéro en tête d'un id hex ─────────
export function countLeadingZeroBits(hexId) {
  let count = 0;
  for (let i = 0; i < hexId.length; i++) {
    const nibble = parseInt(hexId[i], 16);
    if (nibble === 0) { count += 4; continue; }
    // 1→3 zéros, 2-3→2, 4-7→1, 8-15→0
    count += Math.clz32(nibble) - 28;
    break;
  }
  return count;
}

/**
 * Mine un nonce NIP-13 tel que l'id de l'event ait >= targetBits zéros.
 * Async avec yields périodiques pour ne jamais bloquer l'UI (la nav AR
 * tourne à 30 fps pendant qu'on mine).
 *
 * @returns {{ id: string, created_at: number, tags: Array }} prêt à signer
 * @throws si le cap d'itérations est atteint (P ≈ e^-16 à cap=16×2^bits)
 */
export async function minePow({ pubkeyHex, kind, tags, content, targetBits = 18 }) {
  const created_at = Math.floor(Date.now() / 1000);
  const maxIter = Math.min(2 ** (targetBits + 4), 2 ** 24);
  const YIELD_EVERY = 20_000;
  for (let nonce = 0; nonce < maxIter; nonce++) {
    const powTags = [...tags, ["nonce", String(nonce), String(targetBits)]];
    const idBytes = eventId(pubkeyHex, created_at, kind, powTags, content);
    const idHex = bytesToHex(idBytes);
    if (countLeadingZeroBits(idHex) >= targetBits) {
      return { id: idHex, idBytes, created_at, tags: powTags };
    }
    if (nonce % YIELD_EVERY === YIELD_EVERY - 1) {
      // Laisse respirer l'event loop (rendu AR, GPS, audio)
      await new Promise(r => setTimeout(r, 0));
    }
  }
  throw new Error(`PoW: cible ${targetBits} bits non atteinte en ${maxIter} itérations`);
}

/**
 * Valide le PoW d'un event entrant.
 * Exige : difficulté réelle de l'id >= minBits ET tag nonce déclarant une
 * cible >= minBits (NIP-13 : empêche de "recycler" un id naturellement
 * chanceux — l'auteur doit avoir VISÉ la difficulté).
 */
export function hasValidPow(evt, minBits) {
  if (countLeadingZeroBits(evt.id) < minBits) return false;
  const nonceTag = (evt.tags || []).find(t => t[0] === "nonce");
  if (!nonceTag) return false;
  const declared = parseInt(nonceTag[2], 10);
  return Number.isFinite(declared) && declared >= minBits;
}

// ── Construction d'event signé (avec PoW optionnel) ────────────────
export async function buildEvent({ secretKey, pubkeyHex, kind, content, tags, powBits = 0 }) {
  let id, idBytes, created_at, finalTags;
  if (powBits > 0) {
    ({ id, idBytes, created_at, tags: finalTags } =
      await minePow({ pubkeyHex, kind, tags, content, targetBits: powBits }));
  } else {
    created_at = Math.floor(Date.now() / 1000);
    finalTags  = tags;
    idBytes    = eventId(pubkeyHex, created_at, kind, finalTags, content);
    id         = bytesToHex(idBytes);
  }
  const sigBytes = await schnorr.signAsync(idBytes, secretKey);
  return { id, pubkey: pubkeyHex, created_at, kind, tags: finalTags, content, sig: bytesToHex(sigBytes) };
}

// ── Vérification complète d'un event entrant ───────────────────────
// id recalculé + signature Schnorr + created_at pas dans le futur.
export async function verifyEvent(evt) {
  try {
    // Garde-fou temporel — voir MAX_CLOCK_SKEW_S
    if (evt.created_at > Date.now() / 1000 + MAX_CLOCK_SKEW_S) return false;
    const idBytes = eventId(evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content);
    if (bytesToHex(idBytes) !== evt.id) return false;
    return schnorr.verify(hexToBytes(evt.sig), idBytes, hexToBytes(evt.pubkey));
  } catch { return false; }
}
