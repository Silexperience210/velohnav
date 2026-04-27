// ── useSpatialAudio — TTS spatialisé HRTF pour guidage AR vélo ─────────
// Au lieu de "tournez à droite dans 80m", l'instruction vocale est
// spatialisée dans le casque/écouteurs comme si elle venait de la
// direction du virage lui-même. Quand l'user tourne la tête, la voix
// se déplace dans l'espace 3D — game-changer pour la sécurité à vélo
// (zéro coup d'œil au téléphone).
//
// Stack:
// - TTS gratuit via Google Translate (endpoint public, no key, MP3 24kHz)
// - Web Audio API (AudioContext, PannerNode HRTF, AudioBufferSource)
// - Fallback: SpeechSynthesis natif si réseau down ou TTS échoue
// - getBearing + heading → calcul de la position 3D virtuelle
//
// Architecture:
//   fetch(translate.google.com/translate_tts) → arrayBuffer (MP3)
//   → ctx.decodeAudioData → AudioBuffer
//   → AudioBufferSource → HRTF Panner → ctx.destination
// Le panner positionne la voix dans l'espace 3D selon (x, y, z) calculés
// depuis l'angle relatif entre cap user et bearing du virage.
//
// Cache: les annonces communes ("Tournez à droite", "Continuez tout droit"...)
// sont mises en cache (Map en mémoire) pour éviter de re-fetch à chaque
// trigger — plus rapide + économise data mobile.

import { useEffect, useRef, useCallback } from "react";
import { haversine, getBearing } from "../utils.js";

const ANNOUNCE_DISTANCES = [200, 100, 50, 20];  // m — déclenche annonces
const REPEAT_COOLDOWN_MS = 12_000;              // 12s mini entre 2 annonces du même waypoint
const TTS_TIMEOUT_MS     = 4500;                // timeout fetch TTS — fallback si lent
// Endpoint public Google Translate TTS — gratuit, no auth, ~200 char max par requête
const GTTS_BASE = "https://translate.google.com/translate_tts";

// Cache des AudioBuffers pour annonces récurrentes — Map<text, AudioBuffer>
// Évite de re-fetch + re-décoder les phrases standards.
const ttsCache = new Map();
const CACHE_MAX_ENTRIES = 50;

/**
 * Convertit (angle relatif, distance) en coordonnées 3D pour le PannerNode.
 * Le user est à l'origine (0,0,0), face = -Z, droite = +X, haut = +Y.
 * On encode la voix à 1m de distance pour rester audible (le PannerNode
 * applique l'atténuation distance lui-même, mais on veut que ça reste
 * intelligible — d'où la distance fixe 1m + indication de direction pure).
 */
function relAngleToXYZ(relDeg) {
  // relDeg : -180..180, 0 = devant, +90 = à droite, -90 = à gauche
  const rad = (relDeg * Math.PI) / 180;
  const x = Math.sin(rad);     // gauche/droite
  const y = 0;                 // pas de haut/bas
  const z = -Math.cos(rad);    // devant/derrière (Z négatif = devant en Web Audio)
  return { x, y, z };
}

/**
 * Phrase à prononcer selon manoeuvre + distance.
 * Style concis et naturel ("dans 80m, à droite") — évite le robotique.
 */
function buildAnnouncement(modifier, distance, streetName = "") {
  const dist = distance >= 1000
    ? `${(distance / 1000).toFixed(1)} kilomètres`
    : `${Math.round(distance / 10) * 10} mètres`;
  const dir = ({
    "left":        "tournez à gauche",
    "right":       "tournez à droite",
    "sharp left":  "virage serré à gauche",
    "sharp right": "virage serré à droite",
    "slight left": "légère gauche",
    "slight right":"légère droite",
    "uturn":       "demi-tour",
    "straight":    "continuez tout droit",
  })[modifier] || "continuez";
  const prefix = distance > 50 ? `Dans ${dist}, ` : "";
  return streetName
    ? `${prefix}${dir} sur ${streetName}.`
    : `${prefix}${dir}.`;
}

/**
 * Fetch + decode un mp3 TTS depuis Google Translate.
 * Retourne un AudioBuffer prêt à connecter au panner, ou null si échec.
 * Cache automatique sur le texte (max CACHE_MAX_ENTRIES entrées).
 *
 * Stratégie réseau:
 * 1. CapacitorHttp si dispo (Capacitor Android/iOS) — bypass CORS native
 * 2. fetch() classique sinon — fonctionne en dev (vite proxy) ou si le
 *    WebView accepte la requête sans CORS strict
 */
async function fetchTTSBuffer(ctx, text) {
  if (ttsCache.has(text)) return ttsCache.get(text);
  const url = `${GTTS_BASE}?ie=UTF-8&q=${encodeURIComponent(text)}&tl=fr&client=tw-ob`;
  let arrayBuffer = null;

  // Tentative #1 : CapacitorHttp (native Android/iOS — bypass CORS)
  try {
    const Cap = window.Capacitor;
    if (Cap?.isNativePlatform?.() && Cap.Plugins?.CapacitorHttp) {
      const r = await Cap.Plugins.CapacitorHttp.request({
        url,
        method: "GET",
        responseType: "arraybuffer",
        connectTimeout: TTS_TIMEOUT_MS,
        readTimeout: TTS_TIMEOUT_MS,
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android) VelohNav",
          "Accept": "audio/mpeg, */*",
        },
      });
      if (r.status === 200 && r.data) {
        // CapacitorHttp retourne soit ArrayBuffer, soit base64 selon plateforme
        if (typeof r.data === "string") {
          // Base64 → Uint8Array → ArrayBuffer
          const binStr = atob(r.data);
          const bytes = new Uint8Array(binStr.length);
          for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
          arrayBuffer = bytes.buffer;
        } else {
          arrayBuffer = r.data;
        }
      }
    }
  } catch (e) {
    console.warn("[SpatialAudio] CapacitorHttp failed, fallback fetch:", e.message);
  }

  // Tentative #2 : fetch standard (sera bloqué par CORS en browser desktop, OK en dev avec proxy)
  if (!arrayBuffer) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);
      const r = await fetch(url, { signal: ctrl.signal, mode: "cors" });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      arrayBuffer = await r.arrayBuffer();
    } catch (e) {
      console.warn("[SpatialAudio] fetch TTS failed:", e.message);
      return null;
    }
  }

  // Décodage MP3 → AudioBuffer
  try {
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    // Cache LRU: éviction si trop d'entrées
    if (ttsCache.size >= CACHE_MAX_ENTRIES) {
      const firstKey = ttsCache.keys().next().value;
      ttsCache.delete(firstKey);
    }
    ttsCache.set(text, buffer);
    return buffer;
  } catch (e) {
    console.warn("[SpatialAudio] decodeAudioData failed:", e.message);
    return null;
  }
}

export function useSpatialAudio({ enabled, gpsPos, heading, route }) {
  const ctxRef        = useRef(null);            // AudioContext
  const pannerRef     = useRef(null);            // PannerNode HRTF
  const currentSrcRef = useRef(null);            // AudioBufferSource en cours
  const announcedRef  = useRef(new Map());       // waypointIdx → { distAnnonced, ts }
  const initFailedRef = useRef(false);

  // ── Init lazy de l'AudioContext (nécessite un user gesture sur iOS) ──
  const ensureCtx = useCallback(async () => {
    if (initFailedRef.current) return null;
    if (ctxRef.current && ctxRef.current.state !== "closed") return ctxRef.current;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error("Web Audio API indisponible");
      const ctx = new Ctx();
      // Resume si suspended (souvent sur Android Chrome au boot)
      if (ctx.state === "suspended") await ctx.resume();
      // PannerNode HRTF — modèle 3D le plus réaliste
      const panner = ctx.createPanner();
      panner.panningModel  = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance   = 1;
      panner.maxDistance   = 10;
      panner.rolloffFactor = 0;       // pas d'atténuation — voix toujours intelligible
      panner.coneInnerAngle  = 360;
      panner.coneOuterAngle  = 0;
      panner.coneOuterGain   = 0;
      panner.connect(ctx.destination);
      ctxRef.current = ctx;
      pannerRef.current = panner;
      return ctx;
    } catch (e) {
      console.warn("[SpatialAudio] init failed:", e.message);
      initFailedRef.current = true;
      return null;
    }
  }, []);

  // Génération de version pour invalider les annonces obsolètes en flight.
  // Si une nouvelle annonce démarre avant que le fetch de la précédente
  // soit terminé, l'ancienne ne sera pas jouée.
  const announceVersionRef = useRef(0);

  // ── Annonce vocale spatialisée ──────────────────────────────────────
  const announce = useCallback(async (text, relAngleDeg) => {
    const myVersion = ++announceVersionRef.current;
    const ctx = await ensureCtx();

    // Position 3D selon angle relatif
    const { x, y, z } = relAngleToXYZ(relAngleDeg);

    // Fallback SpeechSynthesis si Web Audio indisponible
    const fallbackTTS = () => {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "fr-FR";
        u.rate = 1.05;
        u.pitch = 1.0;
        speechSynthesis.speak(u);
      } catch {}
    };

    if (!ctx || !pannerRef.current) return fallbackTTS();

    // Update position panner pour la prochaine source
    try {
      pannerRef.current.positionX.value = x;
      pannerRef.current.positionY.value = y;
      pannerRef.current.positionZ.value = z;
    } catch {
      try { pannerRef.current.setPosition(x, y, z); } catch {}
    }

    // Fetch TTS + decode → AudioBuffer
    const buffer = await fetchTTSBuffer(ctx, text);

    // Si une annonce plus récente a été déclenchée pendant le fetch,
    // on abandonne celle-ci (sa situation est probablement obsolète).
    if (myVersion !== announceVersionRef.current) return;

    if (!buffer) {
      // Réseau down ou TTS rejette: SpeechSynthesis fallback (non-spatialisé
      // mais audible). Le user reste guidé même en zone sans data.
      return fallbackTTS();
    }

    // Cancel toute source précédente (coupe les annonces qui se chevauchent)
    try {
      if (currentSrcRef.current) {
        currentSrcRef.current.stop();
        currentSrcRef.current.disconnect();
      }
    } catch {}

    // Connect: source → panner → destination
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(pannerRef.current);
    src.start();
    currentSrcRef.current = src;
    src.onended = () => {
      if (currentSrcRef.current === src) currentSrcRef.current = null;
    };
  }, [ensureCtx]);

  // ── Update de la position du panner à chaque frame heading ──────────
  // Note : on ne peut pas vraiment "déplacer" une voix déjà en cours de
  // synthèse (limitation API), donc on update la position du panner
  // uniquement pour le PROCHAIN burst. Le cerveau humain compense bien
  // grâce à la persistance auditive.
  // (Pas de useEffect ici — la position est appliquée à chaque appel announce)

  // ── Logique principale: scan distance prochain virage + déclenchement ──
  useEffect(() => {
    if (!enabled || !gpsPos || !route?.waypoints?.length || heading === null) return;

    // Calcule le waypoint courant: le premier non encore "passé" (dist <30m)
    // ou le plus proche en avant. Évite de devoir lifter le `step` state.
    let stepIdx = 0;
    const announced = announcedRef.current;
    while (stepIdx < route.waypoints.length - 1) {
      const wp = route.waypoints[stepIdx];
      const d = haversine(gpsPos.lat, gpsPos.lng, wp.lat, wp.lng);
      if (d < 25) { stepIdx++; continue; }
      // Vérifie qu'on n'a pas déjà annoncé l'arrivée à <20m de ce waypoint
      const last = announced.get(stepIdx);
      if (last?.atDist <= 20) { stepIdx++; continue; }
      break;
    }

    const wp = route.waypoints[stepIdx];
    if (!wp) return;

    const dist = haversine(gpsPos.lat, gpsPos.lng, wp.lat, wp.lng);
    const bear = getBearing(gpsPos.lat, gpsPos.lng, wp.lat, wp.lng);
    const rel  = ((bear - heading + 540) % 360) - 180;  // -180..+180

    // Trouve le seuil de distance le plus proche atteint
    const announceState = announced.get(stepIdx) || { atDist: Infinity, ts: 0 };
    let triggered = null;
    for (const threshold of ANNOUNCE_DISTANCES) {
      if (dist <= threshold && announceState.atDist > threshold) {
        triggered = threshold;
        break;
      }
    }

    if (!triggered) return;
    if (Date.now() - announceState.ts < REPEAT_COOLDOWN_MS) return;

    // Annonce !
    const text = buildAnnouncement(wp.modifier, dist, wp.streetName || "");
    announce(text, rel);

    announced.set(stepIdx, { atDist: triggered, ts: Date.now() });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, gpsPos?.lat, gpsPos?.lng, heading, route]);

  // ── Cleanup à la fin de la nav ──────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      try { speechSynthesis.cancel(); } catch {}
      try {
        if (currentSrcRef.current) {
          currentSrcRef.current.stop();
          currentSrcRef.current.disconnect();
          currentSrcRef.current = null;
        }
      } catch {}
      announcedRef.current.clear();
      // On ne ferme pas l'AudioContext — il sera réutilisé à la prochaine nav
    }
  }, [enabled]);

  // ── Cleanup unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      try { speechSynthesis.cancel(); } catch {}
      try {
        if (currentSrcRef.current) {
          currentSrcRef.current.stop();
          currentSrcRef.current.disconnect();
        }
        if (pannerRef.current) pannerRef.current.disconnect();
        if (ctxRef.current && ctxRef.current.state !== "closed") ctxRef.current.close();
      } catch {}
    };
  }, []);

  // ── Fonction publique pour test manuel / annonce arrivée ─────────
  const speakNow = useCallback((text, relAngleDeg = 0) => announce(text, relAngleDeg), [announce]);
  const reset = useCallback(() => { announcedRef.current.clear(); }, []);

  return { speakNow, reset };
}
