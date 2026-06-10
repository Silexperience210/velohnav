// ── useAvailability — historique de dispo + prédiction d'arrivée ───────
// PRINCIPE : l'app rafraîchit les stations toutes les 60s — autant en faire
// quelque chose. On agrège la dispo par (station, jour de semaine, quart
// d'heure) dans IndexedDB. Après quelques jours d'usage, on sait que
// "Hamilius, mardi 17h45 : 0.6 vélo en moyenne" → le Predictive Routing
// peut alerter AVANT que la station ne soit vide, sur la base de l'heure
// d'arrivée estimée.
//
// Pas de ML, pas de réseau : une moyenne mobile par bucket, mise à jour
// avec un n plafonné (CAP_N) — équivalent à une fenêtre exponentielle de
// quelques semaines, donc auto-adaptative aux changements saisonniers.
//
// Coût : ~110 stations × 7 jours × 96 quarts d'heure = 74k buckets max
// théoriques, mais en pratique seuls les buckets des heures où l'app
// tourne existent. Écriture throttlée à 1× / RECORD_THROTTLE_MS.

const DB_NAME     = "velohnav";
const DB_VERSION  = 4;
const AVAIL_STORE = "avail";
const CAP_N       = 20;            // fenêtre effective ~20 échantillons/bucket
const RECORD_THROTTLE_MS = 5 * 60 * 1000;

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB indisponible"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror   = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // Créer TOUS les stores (chaque ouvreur de la DB "velohnav" doit être
      // autonome — l'ordre d'ouverture des hooks n'est pas garanti)
      for (const name of ["stations", "meta", "ghosts", "routes", AVAIL_STORE]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: name === "stations" ? "id" : "key" });
        }
      }
    };
  });
  return dbPromise;
}

// ── Buckets temporels (purs, testés) ───────────────────────────────
export function timeBucket(date = new Date()) {
  const dow = date.getDay();                                   // 0-6
  const qh  = date.getHours() * 4 + Math.floor(date.getMinutes() / 15); // 0-95
  return { dow, qh };
}
export function bucketKey(stationId, dow, qh) {
  return `${stationId}_${dow}_${qh}`;
}

// ── Enregistrement (throttlé) ──────────────────────────────────────
let _lastRecordAt = 0;

/** Enregistre un snapshot de dispo pour toutes les stations LIVE. */
export async function recordAvailability(stations, now = new Date()) {
  if (Date.now() - _lastRecordAt < RECORD_THROTTLE_MS) return false;
  _lastRecordAt = Date.now();
  try {
    const db = await openDB();
    const { dow, qh } = timeBucket(now);
    const tx = db.transaction(AVAIL_STORE, "readwrite");
    const store = tx.objectStore(AVAIL_STORE);
    for (const s of stations) {
      if (s._mock || s.id == null) continue;
      const key = bucketKey(s.id, dow, qh);
      const req = store.get(key);
      req.onsuccess = () => {
        const prev = req.result || { key, id: s.id, dow, qh, n: 0, sumB: 0, sumD: 0 };
        // n plafonné : au-delà de CAP_N, on "oublie" proportionnellement
        // l'ancien — moyenne mobile exponentielle implicite.
        if (prev.n >= CAP_N) {
          prev.sumB = prev.sumB * (CAP_N - 1) / CAP_N;
          prev.sumD = prev.sumD * (CAP_N - 1) / CAP_N;
          prev.n = CAP_N - 1;
        }
        prev.n    += 1;
        prev.sumB += s.bikes ?? 0;
        prev.sumD += s.docks ?? 0;
        store.put(prev);
      };
    }
    return await new Promise((res) => {
      tx.oncomplete = () => res(true);
      tx.onerror    = () => res(false);
    });
  } catch (e) {
    console.warn("[Avail] record:", e?.message);
    return false;
  }
}

// ── Prédiction ─────────────────────────────────────────────────────
/**
 * Dispo attendue d'une station à un instant donné.
 * Agrège le bucket cible ± 1 quart d'heure (lisse la granularité).
 * @returns {{ bikes:number, docks:number, samples:number } | null}
 */
export async function predictAvailability(stationId, atDate = new Date()) {
  try {
    const db = await openDB();
    const { dow, qh } = timeBucket(atDate);
    const keys = [-1, 0, 1].map(off => {
      let q = qh + off, d = dow;
      if (q < 0)  { q += 96; d = (d + 6) % 7; }
      if (q > 95) { q -= 96; d = (d + 1) % 7; }
      return bucketKey(stationId, d, q);
    });
    const tx = db.transaction(AVAIL_STORE, "readonly");
    const store = tx.objectStore(AVAIL_STORE);
    const rows = await Promise.all(keys.map(k => new Promise(res => {
      const r = store.get(k);
      r.onsuccess = () => res(r.result || null);
      r.onerror   = () => res(null);
    })));
    let n = 0, sumB = 0, sumD = 0;
    for (const row of rows) {
      if (!row) continue;
      n += row.n; sumB += row.sumB; sumD += row.sumD;
    }
    if (n === 0) return null;
    return { bikes: sumB / n, docks: sumD / n, samples: n };
  } catch { return null; }
}
