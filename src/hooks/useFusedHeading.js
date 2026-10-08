// ── useFusedHeading — fusion boussole magnétique + course GPS ──────────
// PROBLÈME : en ville (trams, voitures, structures métalliques, Pont
// Adolphe...), le magnétomètre dérive de ±15-25°. Tout l'AR (pins, tracé
// de route, audio spatial) hérite de ce biais.
//
// SOLUTION : quand on se DÉPLACE, le cap GPS (bearing entre positions
// successives, "course over ground") est insensible au magnétisme et
// devient très fiable au-delà de ~5 km/h. On fusionne :
//
//   vitesse ~0        → 100% magnétomètre (le GPS ne donne aucun cap à l'arrêt)
//   vitesse ≥ 16 km/h → 85% course GPS / 15% magnéto
//   entre les deux    → pondération linéaire
//
// Le blend est CIRCULAIRE (350° et 10° sont à 20° l'un de l'autre, pas 340°).
// La course GPS expire après COURSE_TTL_MS sans mouvement (on re-bascule
// doucement vers le magnétomètre quand on s'arrête à un feu).

import { useState, useRef, useMemo, useEffect } from "react";
import { getBearing, haversine } from "../utils.js";

// ── Fonctions pures (exportées pour tests) ─────────────────────────

/** Différence angulaire signée a→b dans [-180, 180]. */
export function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}

/**
 * Mélange circulaire : part de `mag` et tourne de w × (chemin le plus court
 * vers `course`). w=0 → magnéto pur, w=1 → course GPS pure.
 */
export function blendHeadings(mag, course, w) {
  if (mag == null && course == null) return null;
  if (course == null || w <= 0) return mag;
  if (mag == null) return (course + 360) % 360;
  return (mag + angleDiff(mag, course) * Math.min(Math.max(w, 0), 1) + 360) % 360;
}

/**
 * Poids de la course GPS selon la vitesse (m/s).
 *   ≤ 1.5 m/s (5.4 km/h)  → 0    (marche lente/arrêt : course GPS bruitée)
 *   ≥ 4.5 m/s (16 km/h)   → 0.85 (vélo : course GPS dominante)
 */
export function speedWeight(speedMs) {
  const MIN = 1.5, FULL = 4.5, MAX_W = 0.85;
  if (!Number.isFinite(speedMs) || speedMs <= MIN) return 0;
  if (speedMs >= FULL) return MAX_W;
  return MAX_W * (speedMs - MIN) / (FULL - MIN);
}

// ── Hook ───────────────────────────────────────────────────────────
const MIN_MOVE_M    = 4;       // déplacement mini pour calculer une course (anti-jitter)
const MAX_SPEED_MS  = 30;      // m/s (~108 km/h) : au-delà, c'est un saut GPS, pas un déplacement
const MAX_ACC_M     = 30;      // m : fix trop imprécis pour en tirer une course
const MAX_DT_MS     = 15_000;  // gap GPS trop long → repartir de zéro
const COURSE_TTL_MS = 5_000;   // course périmée après 5s sans mouvement
const COURSE_EMA    = 0.35;    // lissage de la course (le GPS "saute" un peu)

/**
 * @param {number|null} magHeading — cap magnétique (useCompass)
 * @param {{lat,lng}|null} gpsPos
 * @returns {number|null} cap fusionné, drop-in remplaçant de magHeading
 */
export function useFusedHeading(magHeading, gpsPos) {
  // {course, speed, at} — state pour déclencher le re-render quand le GPS bouge
  const [gpsCourse, setGpsCourse] = useState(null);
  const prevRef   = useRef(null);   // { lat, lng, time }
  const courseRef = useRef(null);   // course lissée (EMA circulaire)

  useEffect(() => {
    if (!gpsPos) { prevRef.current = null; return; }
    const now  = Date.now();
    const prev = prevRef.current;
    if (!prev) { prevRef.current = { lat: gpsPos.lat, lng: gpsPos.lng, time: now }; return; }

    const dt = now - prev.time;
    if (dt <= 250) return; // ticks GPS trop rapprochés — pas exploitable
    // Un fix à ±40 m peut déplacer l'ancre de plusieurs dizaines de mètres sans
    // qu'on ait bougé : on recale l'ancre sans toucher au cap.
    if (gpsPos.acc != null && gpsPos.acc > MAX_ACC_M) {
      prevRef.current = { lat: gpsPos.lat, lng: gpsPos.lng, time: now };
      return;
    }
    const dist = haversine(prev.lat, prev.lng, gpsPos.lat, gpsPos.lng);
    if (dist < MIN_MOVE_M) {
      // Immobile : on garde prev comme ancre (la course expirera via TTL)
      if (dt > MAX_DT_MS) prevRef.current = { lat: gpsPos.lat, lng: gpsPos.lng, time: now };
      return;
    }
    const raw   = getBearing(prev.lat, prev.lng, gpsPos.lat, gpsPos.lng);
    const speed = dist / (dt / 1000);
    // Saut de position (tunnel, glitch réseau) : recaler l'ancre sans corriger le
    // cap, sinon toute la scène AR pivote d'un coup.
    if (speed > MAX_SPEED_MS) {
      prevRef.current = { lat: gpsPos.lat, lng: gpsPos.lng, time: now };
      return;
    }
    // EMA circulaire — amortit les sauts de course dus au bruit GPS
    courseRef.current = courseRef.current == null
      ? raw
      : (courseRef.current + angleDiff(courseRef.current, raw) * COURSE_EMA + 360) % 360;
    prevRef.current = { lat: gpsPos.lat, lng: gpsPos.lng, time: now };
    setGpsCourse({ course: courseRef.current, speed, at: now });
  }, [gpsPos?.lat, gpsPos?.lng]);

  // Expiration de la course : sans ce minuteur, elle n'était réévaluée qu'au
  // prochain tick boussole — immobile, la zone morte de 1,5° peut n'en produire
  // aucun, et une course périmée restait appliquée indéfiniment.
  const [expiredAt, setExpiredAt] = useState(0);
  useEffect(() => {
    if (!gpsCourse) return;
    const id = setTimeout(() => setExpiredAt(gpsCourse.at), COURSE_TTL_MS + 50);
    return () => clearTimeout(id);
  }, [gpsCourse]);

  return useMemo(() => {
    if (!gpsCourse || expiredAt === gpsCourse.at || Date.now() - gpsCourse.at > COURSE_TTL_MS) return magHeading;
    const w = speedWeight(gpsCourse.speed);
    const fused = blendHeadings(magHeading, gpsCourse.course, w);
    return fused == null ? null : Math.round(fused) % 360;
  }, [magHeading, gpsCourse, expiredAt]);
}
