// ── Hooks de présentation (pas de données métier : celles-ci restent
//    dans src/hooks/, propriété de la phase 1) ─────────────────────────
import { useEffect, useState } from "react";

/** État réseau navigateur/WebView (événements online/offline). */
export function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}

/** Horloge alignée sur la minute (pas de re-render chaque seconde). */
export function useMinuteClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let id;
    const tick = () => {
      setNow(new Date());
      id = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    id = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(id);
  }, []);
  return now;
}
