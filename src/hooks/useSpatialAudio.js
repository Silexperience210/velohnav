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
import { waypointKey } from "../components/ar/navProgress.js";
import { getCurrentLang } from "../i18n.js";

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

// Phrases par langue (les seules du hook — gardées ici plutôt que dans les
// locales, pour que le texte prononcé et la voix restent appariés).
const PHRASES = {
  fr: {
    km: d => `${d} kilomètres`, m: d => `${d} mètres`, prefix: d => `Dans ${d}, `, on: " sur ",
    dir: { left: "tournez à gauche", right: "tournez à droite", "sharp left": "virage serré à gauche",
      "sharp right": "virage serré à droite", "slight left": "légère gauche", "slight right": "légère droite",
      uturn: "demi-tour", straight: "continuez tout droit" }, def: "continuez",
  },
  en: {
    km: d => `${d} kilometres`, m: d => `${d} metres`, prefix: d => `In ${d}, `, on: " onto ",
    dir: { left: "turn left", right: "turn right", "sharp left": "sharp left", "sharp right": "sharp right",
      "slight left": "bear left", "slight right": "bear right", uturn: "make a U-turn", straight: "continue straight" },
    def: "continue",
  },
};
/** Langue de synthèse : celle de l'interface (repli : français). */
export function ttsLang(lang = getCurrentLang()) {
  return PHRASES[lang] ? lang : "fr";
}
const VOICE_LOCALE = { fr: "fr-FR", en: "en-GB" };

/**
 * Phrase à prononcer selon manoeuvre + distance, dans la langue de l'interface
 * (avant : toujours en français, voix française, même interface en anglais).
 * Style concis et naturel ("dans 80m, à droite") — évite le robotique.
 */
export function buildAnnouncement(modifier, distance, streetName = "", lang = ttsLang()) {
  const P = PHRASES[lang] ?? PHRASES.fr;
  const dist = distance >= 1000
    ? P.km((distance / 1000).toFixed(1))
    : P.m(Math.round(distance / 10) * 10);
  const dir = P.dir[modifier] || P.def;
  const prefix = distance > 50 ? P.prefix(dist) : "";
  const phrase = `${prefix}${dir}${streetName ? P.on + streetName : ""}.`;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
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
async function fetchTTSBuffer(ctx, text, lang = "fr") {
  const cacheKey = `${lang}|${text}`;
  if (ttsCache.has(cacheKey)) return ttsCache.get(cacheKey);
  const url = `${GTTS_BASE}?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
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
    ttsCache.set(cacheKey, buffer);
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
  // Clé = position du point de manœuvre, PAS son index : l'itinéraire est
  // remplacé tous les 60 m et à chaque recalcul ; un index périmé faisait
  // sauter la première manœuvre du nouveau tracé (« déjà annoncée à 20 m »).
  const announcedRef  = useRef(new Map());       // waypointKey → { atDist, ts }
  const initFailedRef = useRef(false);

  // ── Init de l'AudioContext — SYNCHRONE ───────────────────────────────
  // Appelée depuis un geste (warmUp) : création ET resume() doivent partir
  // avant tout `await`, sinon iOS ne les rattache plus au geste. Avant :
  // `await ctx.resume()` puis seulement `ctxRef.current = ctx` — deux appels
  // rapprochés créaient deux contextes, et un resume() refusé (hors geste)
  // reste en attente pour toujours : l'annonce restait bloquée, sans repli.
  // Un contexte déjà créé mais « suspended » n'était jamais relancé.
  const ensureCtx = useCallback(() => {
    if (initFailedRef.current) return null;
    let ctx = ctxRef.current;
    if (!ctx || ctx.state === "closed") {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw new Error("Web Audio API indisponible");
        ctx = new Ctx();
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
      } catch (e) {
        console.warn("[SpatialAudio] init failed:", e.message);
        initFailedRef.current = true;
        return null;
      }
    }
    // Sans await : la promesse se résout quand le navigateur l'autorise.
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }, []);

  // Génération de version pour invalider les annonces obsolètes en flight.
  // Si une nouvelle annonce démarre avant que le fetch de la précédente
  // soit terminé, l'ancienne ne sera pas jouée.
  const announceVersionRef = useRef(0);

  // ── Annonce vocale spatialisée ──────────────────────────────────────
  const announce = useCallback(async (text, relAngleDeg) => {
    const myVersion = ++announceVersionRef.current;
    const ctx = ensureCtx();
    const lang = ttsLang();

    // Position 3D selon angle relatif
    const { x, y, z } = relAngleToXYZ(relAngleDeg);

    // Fallback SpeechSynthesis si Web Audio indisponible
    const fallbackTTS = () => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = VOICE_LOCALE[lang] ?? "fr-FR";
        u.rate = 1.05;
        u.pitch = 1.0;
        // cancel() suivi immédiatement de speak() perd l'énoncé sur certains
        // Chrome Android : on n'annule que si quelque chose parle, et on laisse
        // passer un court délai dans ce cas.
        if (speechSynthesis.speaking || speechSynthesis.pending) {
          speechSynthesis.cancel();
          setTimeout(() => speechSynthesis.speak(u), 80);
        } else {
          speechSynthesis.speak(u);
        }
      } catch {}
    };

    // Contexte non démarré (aucun geste encore) : une source jouerait du
    // silence sans erreur — la synthèse native a plus de chances d'être audible.
    if (!ctx || !pannerRef.current || ctx.state !== "running") return fallbackTTS();

    // Update position panner pour la prochaine source
    try {
      pannerRef.current.positionX.value = x;
      pannerRef.current.positionY.value = y;
      pannerRef.current.positionZ.value = z;
    } catch {
      try { pannerRef.current.setPosition(x, y, z); } catch {}
    }

    // Fetch TTS + decode → AudioBuffer
    const buffer = await fetchTTSBuffer(ctx, text, lang);

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
      const last = announced.get(waypointKey(wp));
      if (last?.atDist <= 20) { stepIdx++; continue; }
      break;
    }

    const wp = route.waypoints[stepIdx];
    if (!wp) return;

    const dist = haversine(gpsPos.lat, gpsPos.lng, wp.lat, wp.lng);
    const bear = getBearing(gpsPos.lat, gpsPos.lng, wp.lat, wp.lng);
    const rel  = ((bear - heading + 540) % 360) - 180;  // -180..+180

    // Trouve le seuil de distance le plus proche atteint
    const key = waypointKey(wp);
    const announceState = announced.get(key) || { atDist: Infinity, ts: 0 };
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
    const text = buildAnnouncement(wp.modifier, dist, wp.streetName || "");   // langue courante
    announce(text, rel);

    announced.set(key, { atDist: triggered, ts: Date.now() });
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

  // Sur iOS, un AudioContext créé hors geste reste « suspended » et tout
  // resume() ultérieur est ignoré : le guidage restait muet jusqu'au tap suivant.
  // On l'ouvre donc explicitement depuis les gestes de l'interface (startAR, startNav).
  return { speakNow, reset, warmUp: ensureCtx };
}
