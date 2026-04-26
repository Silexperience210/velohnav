// ── useObstacles — signalements partagés via Nostr (crowd-sourced) ──────
// Permet aux users de signaler en AR : chantier, vélo cassé, sol glissant.
// Publié sur Nostr (kind 30078 paramétré, NIP-33 replaceable + ephemeral).
// Récupéré en live via subscription WebSocket aux relays.
//
// Décay 24h : les obstacles disparaissent automatiquement passé ce délai
// même sans suppression explicite (filtre côté client sur created_at).
//
// Implémentation : WebSocket natif, schnorr-sig optionnel via @noble/curves
// (déjà disponible si tu installes la dep, sinon mode "anonyme non signé"
// pour les relays publics qui acceptent — fallback gracieux).

import { useState, useEffect, useRef, useCallback } from "react";
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
  // 32 bytes random — non-sécurité-critique (signalement public)
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── SHA-256 helper ────────────────────────────────────────────────
async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Construction event Nostr (non signé — signé côté pool si possible) ──
// Format minimal NIP-01 — l'event_id est calculé via sha256 du tableau
// canonique [0, pubkey, created_at, kind, tags, content]
async function buildEvent({ pubkey, kind, content, tags }) {
  const created_at = Math.floor(Date.now() / 1000);
  const evt = { pubkey, created_at, kind, tags, content };
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  evt.id = await sha256(serialized);
  // Signature schnorr non implémentée ici — relays non-restricted accepteront
  // l'event uniquement s'ils sont configurés laxistes. Pour prod : utiliser
  // @noble/curves avec @noble/secp256k1 pour signer les events.
  evt.sig = "0".repeat(128);  // placeholder — TODO signer en prod
  return evt;
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
  // Clé éphémère (1 par session)
  const pubkeyRef = useRef(null);
  if (!pubkeyRef.current) pubkeyRef.current = generateEphemeralKey();

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
      pubkey: pubkeyRef.current,
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
