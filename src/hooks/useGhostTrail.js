// ── useGhostTrail — fantôme du meilleur temps sur trajets connus ───────
// Enregistre la suite des positions GPS horodatées de chaque trajet
// origine→destination, et stocke le meilleur (plus rapide) en IndexedDB.
// Au début d'une nav vers une destination déjà parcourue, démarre la
// rediffusion d'un "fantôme" virtuel qui suit la trace du meilleur run.
//
// Usage:
//   // Pendant la nav active, enregistrement automatique
//   const { ghostPos, hasGhost, bestTime, currentDelta } = useGhostTrail({
//     gpsPos, navStation, originStation, navMode, active: navMode !== null
//   });
//   // ghostPos = { lat, lng } de la position fantôme à l'instant t
//   // currentDelta = +/- secondes vs meilleur temps (négatif = on bat le record)

import { useState, useEffect, useRef, useCallback } from "react";
import { haversine } from "../utils.js";

const DB_NAME    = "velohnav";
const STORE      = "ghosts";
const DB_VERSION = 2;  // bumped pour ajouter le store ghosts
// Distance min entre 2 points enregistrés (anti-spam GPS)
const MIN_RECORD_DIST = 8;
// Distance max entre point et station pour être considéré comme "départ" / "arrivée"
const ENDPOINT_RADIUS = 30;

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("IndexedDB indisponible"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // Stores existants (compatibilité avec useStationsCache)
      if (!db.objectStoreNames.contains("stations"))
        db.createObjectStore("stations", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta"))
        db.createObjectStore("meta", { keyPath: "key" });
      // Nouveau store : ghosts (clé = "originId__destId__mode")
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: "key" });
    };
  });
  return dbPromise;
}

function ghostKey(originId, destId, mode) {
  return `${originId}__${destId}__${mode}`;
}

async function loadBestGhost(originId, destId, mode) {
  try {
    const db = await openDB();
    return await new Promise((res) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(ghostKey(originId, destId, mode));
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => res(null);
    });
  } catch { return null; }
}

async function saveGhost(originId, destId, mode, points) {
  if (!points || points.length < 2) return false;
  try {
    const db = await openDB();
    const totalTime = points[points.length - 1].t - points[0].t;
    const totalDist = points.reduce((acc, p, i) =>
      i === 0 ? 0 : acc + haversine(points[i-1].lat, points[i-1].lng, p.lat, p.lng), 0
    );
    const key = ghostKey(originId, destId, mode);
    const existing = await loadBestGhost(originId, destId, mode);
    // Garde uniquement le meilleur run
    if (existing && existing.totalTime <= totalTime) return false;
    return await new Promise((res) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        key, points, totalTime, totalDist, mode,
        savedAt: Date.now(),
      });
      tx.oncomplete = () => res(true);
      tx.onerror    = () => res(false);
    });
  } catch { return false; }
}

/**
 * Interpole la position fantôme à l'instant `elapsed` ms depuis le début,
 * en parcourant la liste de points horodatés du meilleur run.
 */
function interpolateGhost(points, elapsedMs) {
  if (!points || points.length < 2) return null;
  const t0 = points[0].t;
  const targetT = t0 + elapsedMs;
  // Recherche binaire du segment où le ghost se trouve
  let lo = 0, hi = points.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= targetT) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  if (targetT >= b.t) return { lat: b.lat, lng: b.lng, finished: true };
  const ratio = (targetT - a.t) / (b.t - a.t);
  return {
    lat: a.lat + (b.lat - a.lat) * ratio,
    lng: a.lng + (b.lng - a.lng) * ratio,
    finished: false,
  };
}

export function useGhostTrail({ gpsPos, navStation, originStation, navMode, active }) {
  const [ghostData, setGhostData]   = useState(null);  // best run loaded from IDB
  const [ghostPos,  setGhostPos]    = useState(null);  // current ghost position
  const [currentDelta, setDelta]    = useState(0);     // seconds vs best
  // Recording state
  const recordingRef = useRef([]);
  const startTimeRef = useRef(0);
  const startedRef   = useRef(false);

  const originId = originStation?.id;
  const destId   = navStation?.id;

  // Charger le meilleur run au démarrage de la nav
  useEffect(() => {
    if (!active || !originId || !destId || !navMode) {
      setGhostData(null); setGhostPos(null); setDelta(0);
      return;
    }
    let cancelled = false;
    loadBestGhost(originId, destId, navMode).then(g => {
      if (!cancelled) setGhostData(g);
    });
    return () => { cancelled = true; };
  }, [active, originId, destId, navMode]);

  // Enregistrement live des positions GPS
  useEffect(() => {
    if (!active || !gpsPos) {
      // Si on était en train d'enregistrer et qu'on coupe, on sauve le run
      if (startedRef.current && recordingRef.current.length >= 5 && originId && destId && navMode) {
        const last = recordingRef.current[recordingRef.current.length - 1];
        // Vérifie qu'on a bien atteint la zone de destination
        if (navStation && haversine(last.lat, last.lng, navStation.lat, navStation.lng) < ENDPOINT_RADIUS) {
          saveGhost(originId, destId, navMode, recordingRef.current);
        }
      }
      recordingRef.current = [];
      startedRef.current = false;
      return;
    }
    // Init le recording quand la nav démarre vraiment (user proche du départ)
    if (!startedRef.current && originStation &&
        haversine(gpsPos.lat, gpsPos.lng, originStation.lat, originStation.lng) < ENDPOINT_RADIUS) {
      startedRef.current = true;
      startTimeRef.current = Date.now();
      recordingRef.current = [{ lat: gpsPos.lat, lng: gpsPos.lng, t: 0 }];
      return;
    }
    if (!startedRef.current) return;
    // Append point si distance >= MIN_RECORD_DIST
    const last = recordingRef.current[recordingRef.current.length - 1];
    const d = haversine(last.lat, last.lng, gpsPos.lat, gpsPos.lng);
    if (d >= MIN_RECORD_DIST) {
      recordingRef.current.push({
        lat: gpsPos.lat, lng: gpsPos.lng,
        t: Date.now() - startTimeRef.current,
      });
    }
  }, [active, gpsPos?.lat, gpsPos?.lng, originId, destId, navMode]);

  // Tick d'animation pour faire avancer le fantôme à 5 fps
  useEffect(() => {
    if (!active || !ghostData || !startedRef.current) {
      setGhostPos(null);
      return;
    }
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const pos = interpolateGhost(ghostData.points, elapsed);
      setGhostPos(pos);
      // Calcul du delta : où en serait le ghost vs où on est
      if (pos && gpsPos) {
        // Trouve le point du ghost le plus proche de la position user
        let bestIdx = 0, bestDist = Infinity;
        for (let i = 0; i < ghostData.points.length; i++) {
          const p = ghostData.points[i];
          const dd = haversine(p.lat, p.lng, gpsPos.lat, gpsPos.lng);
          if (dd < bestDist) { bestDist = dd; bestIdx = i; }
        }
        // Le user est à ce point au temps `elapsed`. Le ghost l'était à `points[bestIdx].t`.
        // delta > 0 = on est en retard, delta < 0 = on bat le record
        const ghostTimeAtPos = ghostData.points[bestIdx].t;
        setDelta(Math.round((elapsed - ghostTimeAtPos) / 1000));
      }
    }, 200);  // 5 fps suffisant pour un fantôme
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ghostData?.key, gpsPos?.lat, gpsPos?.lng]);

  return {
    ghostPos,                          // {lat,lng,finished} | null
    hasGhost: !!ghostData,             // true si un meilleur run existe
    bestTime: ghostData?.totalTime,    // ms
    currentDelta,                      // secondes (+ retard, - avance)
  };
}
