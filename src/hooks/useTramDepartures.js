// ── useTramDepartures — départs T1 d'un arrêt : horaire + temps réel ──
// L'horaire embarqué (utils/tram.js) répond toujours, hors ligne compris.
// Quand la fiche est ouverte et le réseau disponible, les retards et
// suppressions publiés via Transitous sont appliqués par-dessus
// (cache 60 s partagé avec useTransit — pas de polling supplémentaire).
//
// → { estimated, dirs: { 0: [...], 1: [...] }, live: bool }

import { useEffect, useState } from "react";
import { TRAM, nextDepartures, mergeRealtime } from "../utils/tram.js";
import { fetchDepartures } from "./useTransit.js";
import { ATP_FEED_PREFIX } from "../utils/transitous.js";

const TICK = 15_000;     // recalcul de l'horaire (minutes d'attente)
const RT_EVERY = 60_000; // temps réel : au rythme du cache Transitous

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

export function useTramDepartures(stopIdx) {
  const [now, setNow] = useState(() => Date.now());
  const [rt, setRt] = useState(null);

  // Horloge : un tick toutes les 15 s tant que la fiche est ouverte
  useEffect(() => {
    if (stopIdx == null) return;
    setNow(Date.now());
    const id = setInterval(() => { if (isVisible()) setNow(Date.now()); }, TICK);
    return () => clearInterval(id);
  }, [stopIdx]);

  // Temps réel : à l'ouverture puis chaque minute ; échec silencieux (horaire seul)
  useEffect(() => {
    setRt(null);
    if (stopIdx == null) return;
    const stop = TRAM.stops[stopIdx];
    if (!stop) return;
    let dead = false;
    const load = async () => {
      if (!isVisible() || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
      const deps = await fetchDepartures(ATP_FEED_PREFIX + stop.id, 12);
      if (!dead && deps) setRt(deps);
    };
    load();
    const id = setInterval(load, RT_EVERY);
    return () => { dead = true; clearInterval(id); };
  }, [stopIdx]);

  if (stopIdx == null) return null;
  const sched = nextDepartures(stopIdx, new Date(now));
  const dirs = { 0: mergeRealtime(sched.dirs[0], rt), 1: mergeRealtime(sched.dirs[1], rt) };
  return { estimated: sched.estimated, dirs, live: [...dirs[0], ...dirs[1]].some(d => d.live) };
}
