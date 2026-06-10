// ── useObstacles — signalements partagés via Nostr (crowd-sourced) ──────
// Permet aux users de signaler en AR : chantier, vélo cassé, sol glissant.
// Publié sur Nostr (kind 30078 paramétré, NIP-33 replaceable + ephemeral).
// Récupéré en live via subscription WebSocket aux relays.
//
// Décay 24h : les obstacles disparaissent automatiquement passé ce délai
// même sans suppression explicite (filtre côté client sur created_at + tag
// NIP-40 expiration).
//
// SÉCURITÉ (v3.3) :
//   - Signature Schnorr BIP-340 (intégrité) — clé éphémère anonyme/session.
//   - PoW NIP-13 (anti-spam) : chaque event doit prouver POW_BITS_OBSTACLE
//     bits de travail. Coût négligeable pour un user (<1s, miné en async
//     sans bloquer l'UI), prohibitif pour un flood de masse.
//   - created_at futur rejeté (sinon bypass trivial du décay 24h en
//     publiant un event daté de demain). Géré dans core.verifyEvent.
//
// Architecture: pool WebSocket multi-relay singleton, reconnect auto avec
// backoff, dedup par event_id côté client.

import { useState, useEffect, useRef, useCallback } from "react";
import { haversine } from "../utils.js";
import {
  DEFAULT_RELAYS, generateEphemeralKey, buildEvent, verifyEvent, hasValidPow,
} from "../nostr/core.js";

// Kind custom VelohNav — #d-tag commence par "velohnav-obstacle-"
// (NIP-33 replaceable parameterized event)
const KIND_OBSTACLE = 30078;
const DECAY_MS      = 24 * 60 * 60 * 1000;  // 24h
const VISIBILITY_RADIUS_M = 1500;            // affichage local

// PoW NIP-13 exigé sur les obstacles. 18 bits ≈ 262k hash SHA-256 :
// <1s sur un smartphone récent, ~3s sur du bas de gamme — une fois par
// signalement. Un spammeur voulant publier 10 000 faux "Danger" paie
// ~1-3h de CPU au lieu de 0. Les events sans PoW sont REJETÉS à la
// réception (les anciens events pré-v3.3 expirent en 24h de toute façon).
export const POW_BITS_OBSTACLE = 18;

export const OBSTACLE_TYPES = {
  construction: { label: "Chantier",      icon: "🚧", color: "#F5820D" },
  broken_bike:  { label: "Vélo cassé",    icon: "🚲", color: "#E03E3E" },
  slippery:     { label: "Sol glissant",  icon: "💧", color: "#60A5FA" },
  hazard:       { label: "Danger",        icon: "⚠️", color: "#FFD700" },
};

// Ré-export pour compat tests existants
export { verifyEvent };

// ── Parsing d'event obstacle reçu ──────────────────────────────────
async function parseObstacle(evt) {
  if (evt.kind !== KIND_OBSTACLE) return null;
  try {
    // 1. Anti-spam : PoW NIP-13 obligatoire (check le moins cher en premier)
    if (!hasValidPow(evt, POW_BITS_OBSTACLE)) return null;
    // 2. Intégrité : id + signature Schnorr + created_at pas dans le futur
    const valid = await verifyEvent(evt);
    if (!valid) { console.warn("[Nostr] Event signature invalide", evt.id); return null; }
    const data = JSON.parse(evt.content);
    if (typeof data.lat !== "number" || typeof data.lng !== "number") return null;
    if (!OBSTACLE_TYPES[data.type]) return null;
    // 3. Décay 24h
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
// La Map `seen` est au niveau du pool (singleton) pour persister entre
// unmount/remount du hook (ex: user désactive puis réactive la caméra).
class NostrPool {
  constructor(relays = DEFAULT_RELAYS) {
    this.relays = relays;
    this.sockets = new Map();         // url → WebSocket
    this.subscribers = new Set();     // listeners pour events reçus
    this.seen = new Map();            // event_id → obstacle (dedup persisté)
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
      ws.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg[0] === "EVENT" && msg[1] === this.subId && msg[2]) {
            const obs = await parseObstacle(msg[2]);
            if (obs && !this.seen.has(obs.id)) {
              this.seen.set(obs.id, obs);
              this.subscribers.forEach(cb => cb(obs, this.allObstacles()));
            }
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

  /** Retourne la liste de tous les obstacles vus, en élaguant ceux qui ont expiré. */
  allObstacles() {
    const now = Date.now();
    const fresh = [];
    for (const [id, o] of this.seen) {
      if (now - o.createdAt > DECAY_MS) {
        this.seen.delete(id);
      } else {
        fresh.push(o);
      }
    }
    return fresh;
  }

  subscribe(cb) {
    this.subscribers.add(cb);
    // Notify immediately of all known obstacles to avoid losing history on remount
    if (this.seen.size > 0) {
      // Async pour ne pas bloquer la subscription
      Promise.resolve().then(() => cb(null, this.allObstacles()));
    }
    return () => this.subscribers.delete(cb);
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

// Cleanup global au fermeture de l'app / rechargement de page
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    _pool?.close();
    _pool = null;
  });
}

// ── Hook React ────────────────────────────────────────────────────
export function useObstacles(gpsPos, { enabled = true, relays = DEFAULT_RELAYS } = {}) {
  const [obstacles, setObstacles] = useState([]);
  // Clé éphémère (1 par session) — { sk: Uint8Array, pk: hex string }
  const keyRef = useRef(null);
  if (!keyRef.current) keyRef.current = generateEphemeralKey();

  // Subscription au pool — reçoit (latest, fullList) à chaque event ou au mount
  useEffect(() => {
    if (!enabled) return;
    const pool = getPool();
    const unsub = pool.subscribe((latest, fullList) => {
      // fullList est garanti par le pool — utilisé pour bootstrapper après remount
      setObstacles(fullList);
    });
    return () => unsub();
  }, [enabled]);

  // Filtrage par proximité GPS
  const visible = obstacles.filter(o => {
    if (!gpsPos) return false;
    if (Date.now() - o.createdAt > DECAY_MS) return false;
    return haversine(gpsPos.lat, gpsPos.lng, o.lat, o.lng) <= VISIBILITY_RADIUS_M;
  });

  // Publication d'un nouveau signalement — mine le PoW NIP-13 (async, avec
  // yields : l'UI reste fluide), puis signe et broadcast.
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
      powBits: POW_BITS_OBSTACLE,
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
