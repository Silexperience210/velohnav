// ── src/nostr/ghosts.js — Ghost Trails partagés via Nostr ─────────────
// "Trackmania urbain" : le meilleur run local de chaque paire de stations
// est publié sur Nostr (anonyme, clé éphémère). À chaque nav, on récupère
// le record MONDIAL du segment et on court contre le fantôme le plus
// rapide (local ou mondial).
//
// ANTI-CHEAT (plausibilité — on ne peut pas prouver un trajet, mais on
// peut rejeter l'impossible) :
//   - vitesse moyenne plafonnée par mode (32 km/h vélo, 10 km/h marche)
//   - vitesse max par segment plafonnée (anti-téléportation GPS)
//   - durée minimale 30s, timestamps strictement croissants depuis t=0
//   - bounding box Luxembourg (pas de run "Gare→Kirchberg" tracé à Tokyo)
//   - cohérence totalTime déclaré vs timestamps des points
//   - PoW NIP-13 (POW_BITS_GHOST) + signature + created_at non-futur
//
// Format event : kind 30078, d = velohnav-ghost-{origin}__{dest}__{mode}
// (NIP-33 paramétré : le relay ne garde que le DERNIER event par (pubkey,d) —
// chaque pubkey éphémère ne pollue donc pas l'historique).
// content = { v:1, mode, totalTime, totalDist, points:[[lat,lng,tMs],...] }

import {
  DEFAULT_RELAYS, generateEphemeralKey, buildEvent, verifyEvent, hasValidPow,
} from "./core.js";
import { haversine } from "../utils.js";

const KIND_GHOST = 30078;
export const POW_BITS_GHOST = 15; // ~33k hash — publié 1× en fin de trajet

// Bornes de plausibilité par mode (m/s)
const SPEED_LIMITS = {
  cycling: { avgMax: 9.0,  segMax: 15.0 }, // 32.4 km/h moyen, 54 km/h pointe (descente + jitter GPS)
  walking: { avgMax: 2.8,  segMax: 5.0 },  // 10 km/h moyen
};
const MIN_DURATION_MS = 30_000;
const MAX_POINTS      = 250;   // downsample avant publication (taille event)
const MIN_POINTS      = 5;

// Bounding box Grand-Duché (large) — un ghost Vel'OH! hors de ça est absurde
const BBOX = { latMin: 49.40, latMax: 49.90, lngMin: 5.70, lngMax: 6.55 };

const fetchTimeoutMs = 4000;

// ── Plausibilité d'un run (pure, testée) ───────────────────────────
export function isPlausibleRun({ points, totalTime, mode }) {
  if (!Array.isArray(points) || points.length < MIN_POINTS || points.length > MAX_POINTS + 10) return false;
  const limits = SPEED_LIMITS[mode];
  if (!limits) return false;

  const duration = points[points.length - 1].t - points[0].t;
  if (!(duration >= MIN_DURATION_MS)) return false;
  // totalTime déclaré doit coller aux timestamps (±10%)
  if (totalTime && Math.abs(totalTime - duration) > duration * 0.1 + 2000) return false;

  let pathDist = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (typeof p.lat !== "number" || typeof p.lng !== "number" || typeof p.t !== "number") return false;
    if (p.lat < BBOX.latMin || p.lat > BBOX.latMax || p.lng < BBOX.lngMin || p.lng > BBOX.lngMax) return false;
    if (i === 0) { if (p.t !== 0) return false; continue; }
    const prev = points[i - 1];
    const dt = p.t - prev.t;
    if (dt <= 0) return false; // timestamps strictement croissants
    const d = haversine(prev.lat, prev.lng, p.lat, p.lng);
    // Anti-téléportation : vitesse instantanée du segment
    if (d / (dt / 1000) > limits.segMax) return false;
    pathDist += d;
  }
  if (pathDist < 100) return false; // run de 80m = bruit GPS, pas un trajet
  const avgSpeed = pathDist / (duration / 1000);
  return avgSpeed <= limits.avgMax;
}

// ── Downsample uniforme → MAX_POINTS (garde premier + dernier) ─────
export function downsamplePoints(points, max = MAX_POINTS) {
  if (points.length <= max) return points;
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

function ghostDTag(originId, destId, mode) {
  return `velohnav-ghost-${originId}__${destId}__${mode}`;
}

// Clé éphémère lazy (pas au module-load : crypto absent côté tests SSR)
let _key = null;
function getKey() {
  if (!_key) _key = generateEphemeralKey();
  return _key;
}

// ── Publication du meilleur run ────────────────────────────────────
// Fire-and-forget : ouvre des WS éphémères, publie, ferme. Pas de pool
// permanent — on publie 1 event par trajet terminé, pas besoin de garder
// 3 sockets ouvertes.
export async function publishGhost({ originId, destId, mode, points, totalTime, totalDist }) {
  const slim = downsamplePoints(points).map(p => ({
    lat: Math.round(p.lat * 1e5) / 1e5,   // 5 décimales ≈ 1.1m — suffisant
    lng: Math.round(p.lng * 1e5) / 1e5,
    t:   Math.round(p.t),
  }));
  // On ne publie JAMAIS un run qu'on rejetterait nous-mêmes à la réception
  if (!isPlausibleRun({ points: slim, totalTime, mode })) {
    return { success: false, reason: "run non plausible (vitesse/durée)" };
  }
  const key = getKey();
  const content = JSON.stringify({
    v: 1, mode,
    totalTime: Math.round(totalTime),
    totalDist: Math.round(totalDist),
    points: slim.map(p => [p.lat, p.lng, p.t]),
  });
  const evt = await buildEvent({
    secretKey: key.sk, pubkeyHex: key.pk,
    kind: KIND_GHOST, content,
    powBits: POW_BITS_GHOST,
    tags: [
      ["d", ghostDTag(originId, destId, mode)],
      ["t", "velohnav-ghost"],
    ],
  });

  let sent = 0;
  await Promise.all(DEFAULT_RELAYS.map(url => new Promise(resolve => {
    let ws;
    const done = () => { try { ws?.close(); } catch {} resolve(); };
    const timer = setTimeout(done, fetchTimeoutMs);
    try {
      ws = new WebSocket(url);
      ws.onopen  = () => { try { ws.send(JSON.stringify(["EVENT", evt])); sent++; } catch {} };
      // Attend l'ACK ["OK", id, ...] ou le timeout
      ws.onmessage = (e) => {
        try { const m = JSON.parse(e.data); if (m[0] === "OK" && m[1] === evt.id) { clearTimeout(timer); done(); } } catch {}
      };
      ws.onerror = () => { clearTimeout(timer); done(); };
    } catch { clearTimeout(timer); done(); }
  })));
  return { success: sent > 0, eventId: evt.id, relaysSent: sent };
}

// ── Récupération du record mondial d'un segment ────────────────────
// Ouvre des WS éphémères vers les relays, REQ filtré sur le #d exact,
// collecte jusqu'à EOSE/timeout, valide tout (sig + PoW + plausibilité),
// retourne le run VALIDE le plus rapide ou null.
export async function fetchWorldGhost(originId, destId, mode, { timeoutMs = fetchTimeoutMs } = {}) {
  const dTag = ghostDTag(originId, destId, mode);
  const candidates = [];

  await Promise.all(DEFAULT_RELAYS.map(url => new Promise(resolve => {
    let ws;
    const subId = "vg-" + Math.random().toString(36).slice(2, 8);
    const done = () => { try { ws?.send(JSON.stringify(["CLOSE", subId])); ws?.close(); } catch {} resolve(); };
    const timer = setTimeout(done, timeoutMs);
    try {
      ws = new WebSocket(url);
      ws.onopen = () => {
        ws.send(JSON.stringify(["REQ", subId, { kinds: [KIND_GHOST], "#d": [dTag], limit: 30 }]));
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m[0] === "EVENT" && m[1] === subId && m[2]) candidates.push(m[2]);
          if (m[0] === "EOSE" && m[1] === subId) { clearTimeout(timer); done(); }
        } catch {}
      };
      ws.onerror = () => { clearTimeout(timer); done(); };
    } catch { clearTimeout(timer); done(); }
  })));

  // Dédup par id puis validation complète
  const seen = new Set();
  let best = null;
  for (const evt of candidates) {
    if (seen.has(evt.id)) continue;
    seen.add(evt.id);
    try {
      if (!hasValidPow(evt, POW_BITS_GHOST)) continue;
      if (!(await verifyEvent(evt))) continue;
      const data = JSON.parse(evt.content);
      if (data.v !== 1 || data.mode !== mode || !Array.isArray(data.points)) continue;
      const points = data.points.map(([lat, lng, t]) => ({ lat, lng, t }));
      if (!isPlausibleRun({ points, totalTime: data.totalTime, mode })) continue;
      if (!best || data.totalTime < best.totalTime) {
        best = {
          points,
          totalTime: data.totalTime,
          totalDist: data.totalDist ?? 0,
          mode,
          pubkey: evt.pubkey,
          source: "world",
        };
      }
    } catch {}
  }
  return best;
}
