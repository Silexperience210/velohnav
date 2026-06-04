// ── useStationsCache — Cache IndexedDB des stations Vel'OH! ────────
// Permet l'offline : même sans réseau, les dernières stations récupérées
// avec leur état (vélos dispo, docks) restent accessibles.
// Mise à jour à chaque fetch JCDecaux réussi.

const DB_NAME    = "velohnav";
const STORE      = "stations";
const META_STORE = "meta";
const ROUTES_STORE = "routes";
const DB_VERSION = 3;  // bumped pour ajouter le store "routes"

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("IndexedDB indisponible"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror   = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE))       db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META_STORE))  db.createObjectStore(META_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains("ghosts"))    db.createObjectStore("ghosts", { keyPath: "key" });
      if (!db.objectStoreNames.contains(ROUTES_STORE)) db.createObjectStore(ROUTES_STORE, { keyPath: "key" });
    };
  });
  return dbPromise;
}

/** Stocker la liste complète des stations + timestamp. */
export async function saveStations(stations) {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE, META_STORE], "readwrite");
    const store = tx.objectStore(STORE);
    const meta  = tx.objectStore(META_STORE);
    // Clear + put all
    await new Promise((res, rej) => {
      const clearReq = store.clear();
      clearReq.onsuccess = res;
      clearReq.onerror   = rej;
    });
    for (const s of stations) store.put(s);
    meta.put({ key: "lastUpdate", ts: Date.now(), count: stations.length });
    return new Promise((res, rej) => {
      tx.oncomplete = () => res(true);
      tx.onerror    = () => rej(tx.error);
    });
  } catch (e) {
    console.warn("[StationsCache] saveStations:", e.message);
    return false;
  }
}

/** Charger les stations en cache. Retourne {stations, age} ou null. */
export async function loadStations() {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE, META_STORE], "readonly");
    const store = tx.objectStore(STORE);
    const meta  = tx.objectStore(META_STORE);

    const [stations, lastUpdate] = await Promise.all([
      new Promise((res, rej) => {
        const req = store.getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror   = () => rej(req.error);
      }),
      new Promise((res) => {
        const req = meta.get("lastUpdate");
        req.onsuccess = () => res(req.result || null);
        req.onerror   = () => res(null);
      })
    ]);

    if (!stations.length) return null;
    return {
      stations,
      lastUpdate: lastUpdate?.ts ?? null,
      age: lastUpdate?.ts ? Date.now() - lastUpdate.ts : null,
    };
  } catch (e) {
    console.warn("[StationsCache] loadStations:", e.message);
    return null;
  }
}

/** Supprimer le cache (si l'utilisateur veut reset). */
export async function clearStations() {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE, META_STORE], "readwrite");
    tx.objectStore(STORE).clear();
    tx.objectStore(META_STORE).clear();
    return new Promise((res) => { tx.oncomplete = () => res(true); });
  } catch { return false; }
}

// ── Cache OSRM routes ──────────────────────────────────────────────
export async function saveRoute(key, data) {
  try {
    const db = await openDB();
    const tx = db.transaction(ROUTES_STORE, "readwrite");
    tx.objectStore(ROUTES_STORE).put({ key, data, ts: Date.now() });
    return new Promise((res, rej) => { tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); });
  } catch (e) {
    console.warn("[RouteCache] save:", e.message);
    return false;
  }
}

export async function loadRoute(key, ttlMs = 30 * 60 * 1000) {
  try {
    const db = await openDB();
    const tx = db.transaction(ROUTES_STORE, "readonly");
    const req = tx.objectStore(ROUTES_STORE).get(key);
    const result = await new Promise((res) => { req.onsuccess = () => res(req.result); req.onerror = () => res(null); });
    if (!result) return null;
    if (Date.now() - result.ts > ttlMs) return null;
    return result.data;
  } catch (e) {
    console.warn("[RouteCache] load:", e.message);
    return null;
  }
}
