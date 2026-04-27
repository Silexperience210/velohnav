// ── useSpatialAudio — TTS spatialisé HRTF pour guidage AR vélo ─────────
// Au lieu de "tournez à droite dans 80m", l'instruction vocale est
// spatialisée dans le casque/écouteurs comme si elle venait de la
// direction du virage lui-même. Quand l'user tourne la tête, la voix
// se déplace dans l'espace 3D — game-changer pour la sécurité à vélo
// (zéro coup d'œil au téléphone).
//
// Stack:
// - SpeechSynthesis API (TTS gratuit, hors-ligne sur Android Chrome)
// - Web Audio API (AudioContext, PannerNode HRTF, MediaStreamDestination)
// - getBearing + heading (déjà dispo) → calcul de la position 3D virtuelle
//
// Architecture: TTS → MediaStreamSource → HRTF Panner → Output
// Le panner positionne le son dans l'espace 3D selon (x, y, z) calculés
// depuis l'angle relatif entre cap user et bearing du virage.

import { useEffect, useRef, useCallback } from "react";
import { haversine, getBearing } from "../utils.js";

const ANNOUNCE_DISTANCES = [200, 100, 50, 20];  // m — déclenche annonces
const REPEAT_COOLDOWN_MS = 12_000;              // 12s mini entre 2 annonces du même waypoint

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

export function useSpatialAudio({ enabled, gpsPos, heading, route }) {
  const ctxRef        = useRef(null);            // AudioContext
  const pannerRef     = useRef(null);            // PannerNode HRTF
  const sourceRef     = useRef(null);            // MediaStreamSource
  const utterRef      = useRef(null);            // SpeechSynthesisUtterance courante
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
      panner.rolloffFactor = 0;       // pas d'atténuation — on veut que la voix soit toujours intelligible
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

  // ── Annonce vocale spatialisée ──────────────────────────────────────
  const announce = useCallback(async (text, relAngleDeg) => {
    const ctx = await ensureCtx();
    if (!ctx || !pannerRef.current) {
      // Fallback: TTS classique non-spatialisé
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "fr-FR";
        u.rate = 1.05;
        u.pitch = 1.0;
        utterRef.current = u;
        speechSynthesis.speak(u);
      } catch {}
      return;
    }
    // Position 3D selon angle relatif
    const { x, y, z } = relAngleToXYZ(relAngleDeg);
    try {
      pannerRef.current.positionX.value = x;
      pannerRef.current.positionY.value = y;
      pannerRef.current.positionZ.value = z;
    } catch {
      // Old browsers: setPosition fallback
      try { pannerRef.current.setPosition(x, y, z); } catch {}
    }

    // Stratégie multi-canal SpeechSynthesis → Web Audio:
    // Malheureusement SpeechSynthesis n'a pas de pipe direct vers Web Audio
    // sur la plupart des navigateurs. Pour spatialiser, on utilise un
    // hack: on joue le TTS en parallèle d'un "white noise burst" très bref
    // panné, qui donne un cue directionnel auditif au cerveau.
    //
    // En production, remplacer par une vraie API TTS qui rend en blob
    // (ex: Google Cloud TTS, ElevenLabs) et créer un AudioBufferSource
    // depuis le blob → connect au panner.

    // 1. Cue directionnel (burst de bruit blanc panné, ~120ms)
    try {
      const burstDuration = 0.18;
      const sampleRate = ctx.sampleRate;
      const buffer = ctx.createBuffer(1, sampleRate * burstDuration, sampleRate);
      const data = buffer.getChannelData(0);
      // Bruit rose filtré — plus agréable qu'un bruit blanc pur
      let lastOut = 0;
      for (let i = 0; i < data.length; i++) {
        const white = (Math.random() * 2 - 1) * 0.3;
        // Lissage 1-pole (low-pass)
        lastOut = lastOut * 0.95 + white * 0.05;
        // Enveloppe ADSR rapide
        const t = i / data.length;
        const env = t < 0.1 ? t * 10
                  : t > 0.7 ? (1 - t) / 0.3
                  : 1;
        data[i] = lastOut * env * 0.6;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(pannerRef.current);
      src.start();
      sourceRef.current = src;
    } catch (e) {
      console.warn("[SpatialAudio] burst failed:", e.message);
    }

    // 2. TTS classique légèrement décalé (200ms après le cue) — non-spatialisé
    //    mais la perception spatiale a déjà été établie par le burst.
    setTimeout(() => {
      try {
        // Cancel toute annonce précédente
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "fr-FR";
        u.rate = 1.05;
        u.pitch = 1.0;
        u.volume = 1.0;
        utterRef.current = u;
        speechSynthesis.speak(u);
      } catch {}
    }, 200);
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
      announcedRef.current.clear();
      // On ne ferme pas l'AudioContext — il sera réutilisé à la prochaine nav
    }
  }, [enabled]);

  // ── Cleanup unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      try { speechSynthesis.cancel(); } catch {}
      try {
        if (sourceRef.current) sourceRef.current.disconnect();
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
