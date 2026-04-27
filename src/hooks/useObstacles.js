// ── useObstacles — signalements partagés via Nostr (crowd-sourced) ──────
// Permet aux users de signaler en AR : chantier, vélo cassé, sol glissant.
// Publié sur Nostr (kind 30078 paramétré, NIP-33 replaceable + ephemeral).
// Récupéré en live via subscription WebSocket aux relays.
//
// Décay 24h : les obstacles disparaissent automatiquement passé ce délai
// même sans suppression explicite (filtre côté client sur created_at + tag
// NIP-40 expiration).
//
// Signature: Schnorr BIP-340 via @noble/secp256k1 — events validés par tous
// les relays Nostr standards. Clé éphémère (32-byte privkey) générée à la
// session, jamais persistée. L'identité du reporter est anonyme et non liée
// à une vraie identité Nostr.
//
// Architecture: pool WebSocket multi-relay singleton, reconnect auto avec
// backoff, dedup par event_id côté client.

import { useState, useEffect, useRef, useCallback } from "react";
import { schnorr } from "@noble/secp256k1";
import { haversine } from "../utils.js";

// Relays Nostr publics — à compléter selon préférence
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];
// Kind custom VelohNav — #d-tag commence par "velohnav-obstacle-"
// (NIP-33 replaceable parameterized event)
const KIND_OBSTACLE = 30078;
const DECAY_MS      = 24 * 60 * 60 * 1000;  // 24h
const VISIBILITY_RADIUS_M = 1500;            // affichage local

export const OBSTACLE_TYPES = {
  construction: { label: "Chantier",      icon: "🚧", color: "#F5820D" },
  broken_bike:  { label: "Vélo cassé",    icon: "🚲", color: "#E03E3E" },
  slippery:     { label: "Sol glissant",  icon: "💧", color: "#60A5FA" },
  hazard:       { label: "Danger",        icon: "⚠️", color: "#FFD700" },
};

// ── Génération clé éphémère anonyme ───────────────────────────────
// Pour signer les events sans exposer une vraie identité Nostr de l'user.
// Session-only : nouvelle clé à chaque ouverture d'app.
function generateEphemeralKey() {
  // Utilise l'API standard @noble: 32 bytes random + dérive la pubkey x-only
  const sk = new Uint8Array(32);
  crypto.getRandomValues(sk);
  // schnorr.getPublicKey retourne 32 bytes (x-only, BIP-340)
  const pk = schnorr.getPublicKey(sk);
  return { sk, pk: bytesToHex(pk) };
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i*2, 2), 16);
  return out;
}

// ── Construction event Nostr (signé Schnorr BIP-340) ──────────────
// Format NIP-01 : event_id = sha256(canonical_serialization), sig = Schnorr.
// Compatible avec tous les relays publics standards.
async function buildEvent({ secretKey, pubkeyHex, kind, content, tags }) {
  const created_at = Math.floor(Date.now() / 1000);
  const serialized = JSON.stringify([0, pubkeyHex, created_at, kind, tags, content]);
  // event_id = sha256 du serialized
  const idBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized))
  );
  const id = bytesToHex(idBytes);
  // Signature Schnorr BIP-340 — async (utilise crypto.subtle pour HMAC-SHA-256)
  const sigBytes = await schnorr.signAsync(idBytes, secretKey);
  return {
    id,
    pubkey: pubkeyHex,
    created_at,
    kind,
    tags,
    content,
    sig: bytesToHex(sigBytes),
  };
}

// ── Parsing d'event obstacle reçu ──────────────────────────────────
function parseObstacle(evt) {
  if (evt.kind !== KIND_OBSTACLE) return null;
  try {
    const data = JSON.parse(evt.content);
    if (typeof data.lat !== "number" || typeof data.lng !== "number") return null;
    if (!OBSTACLE_TYPES[data.type]) return null;
    // Décay 24h
    if (Date.now() / 1000 - evt.created_at > DECAY_MS / 1000) return null;
    return {
      id:        evt.id,
      pubkey:    evt.pubkey,
      type:      data.type,
      lat:       data.lat,
      lng:       data.lng,
      note:      data.note ?? "",
      createdAt: evt.created_at * 1000,
    };
  } catch { return null; }
}

// ── Pool de connexions WebSocket multi-relay ──────────────────────
// Stratégie minimaliste : 1 WS par relay, message broadcasté vers tous.
class NostrPool {
  constructor(relays = DEFAULT_RELAYS) {
    this.relays = relays;
    this.sockets = new Map();         // url → WebSocket
    this.subscribers = new Set();     // listeners pour events reçus
    this.subId = "velohnav-obs-" + Math.random().toString(36).slice(2, 10);
  }

  connect() {
    this.relays.forEach(url => this._connectOne(url));
  }

  _connectOne(url) {
    if (this.sockets.has(url)) return;
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        // Subscribe aux obstacles récents (depuis 24h)
        const since = Math.floor((Date.now() - DECAY_MS) / 1000);
        ws.send(JSON.stringify(["REQ", this.subId, {
          kinds: [KIND_OBSTACLE],
          since,
          "#t": ["velohnav-obstacle"],  // tag canonique
        }]));
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg[0] === "EVENT" && msg[1] === this.subId && msg[2]) {
            const obs = parseObstacle(msg[2]);
            if (obs) this.subscribers.forEach(cb => cb(obs));
          }
        } catch {}
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        this.sockets.delete(url);
        // Reconnect avec backoff
        setTimeout(() => this._connectOne(url), 5000 + Math.random() * 5000);
      };
      this.sockets.set(url, ws);
    } catch {}
  }

  publish(evt) {
    const msg = JSON.stringify(["EVENT", evt]);
    let sent = 0;
    this.sockets.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); sent++; } catch {}
      }
    });
    return sent;
  }

  subscribe(cb) { this.subscribers.add(cb); return () => this.subscribers.delete(cb); }

  close() {
    this.sockets.forEach(ws => {
      try { ws.send(JSON.stringify(["CLOSE", this.subId])); ws.close(); } catch {}
    });
    this.sockets.clear();
  }
}

// ── Singleton pool — partagé entre toutes les instances du hook ────
let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new NostrPool();
    _pool.connect();
  }
  return _pool;
}

// ── Hook React ────────────────────────────────────────────────────
export function useObstacles(gpsPos, { enabled = true, relays = DEFAULT_RELAYS } = {}) {
  const [obstacles, setObstacles] = useState([]);
  // Clé éphémère (1 par session) — { sk: Uint8Array, pk: hex string }
  const keyRef = useRef(null);
  if (!keyRef.current) keyRef.current = generateEphemeralKey();

  // Subscription au pool
  useEffect(() => {
    if (!enabled) return;
    const pool = getPool();
    const seen = new Map();  // id → obstacle (dedup)
    const unsub = pool.subscribe((obs) => {
      seen.set(obs.id, obs);
      // Refresh list filtré par gps proximité
      setObstacles(Array.from(seen.values()));
    });
    return () => unsub();
  }, [enabled]);

  // Filtrage par proximité GPS
  const visible = obstacles.filter(o => {
    if (!gpsPos) return false;
    if (Date.now() - o.createdAt > DECAY_MS) return false;
    return haversine(gpsPos.lat, gpsPos.lng, o.lat, o.lng) <= VISIBILITY_RADIUS_M;
  });

  // Publication d'un nouveau signalement
  const report = useCallback(async ({ type, lat, lng, note = "" }) => {
    if (!OBSTACLE_TYPES[type] || typeof lat !== "number" || typeof lng !== "number") {
      throw new Error("Type ou coordonnées invalides");
    }
    const content = JSON.stringify({ type, lat, lng, note });
    const dTag = `velohnav-obstacle-${Math.round(lat*1e4)}-${Math.round(lng*1e4)}-${Date.now()}`;
    const evt = await buildEvent({
      secretKey: keyRef.current.sk,
      pubkeyHex: keyRef.current.pk,
      kind: KIND_OBSTACLE,
      content,
      tags: [
        ["d", dTag],
        ["t", "velohnav-obstacle"],
        ["t", `velohnav-${type}`],
        ["g", `${lat.toFixed(4)},${lng.toFixed(4)}`],
        ["expiration", String(Math.floor((Date.now() + DECAY_MS) / 1000))],
      ],
    });
    const sent = getPool().publish(evt);
    return { success: sent > 0, eventId: evt.id, relaysSent: sent };
  }, []);

  return { obstacles: visible, report, totalKnown: obstacles.length };
}
