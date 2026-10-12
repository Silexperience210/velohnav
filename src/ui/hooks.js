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

/** Écart (px) entre la hauteur de référence et la hauteur visible au-delà duquel
 *  le clavier virtuel est considéré ouvert (barres du navigateur : bien moins). */
export const KEYBOARD_MIN_PX = 120;
export const keyboardOpen = (fullH, visibleH) => fullH - visibleH > KEYBOARD_MIN_PX;

/**
 * Clavier virtuel : publie la hauteur réellement visible (visualViewport) dans
 * --vn-vvh, que .vn-app adopte. Que la WebView rétrécisse avec le clavier ou non
 * (bord à bord, Android 15+), la saisie reste au-dessus du clavier.
 * Référence = plus grande hauteur vue, remise à zéro quand la largeur change (rotation).
 * @returns {boolean} clavier ouvert
 */
export function useKeyboardViewport() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const root = document.documentElement;
    let full = 0, width = vv.width;
    const sync = () => {
      if (Math.abs(vv.width - width) > 1) { width = vv.width; full = 0; }
      full = Math.max(full, vv.height);
      root.style.setProperty("--vn-vvh", `${Math.round(vv.height)}px`);
      // La page ne doit pas rester décalée par le défilement automatique vers le champ
      if (window.scrollY) window.scrollTo(0, 0);
      setOpen(keyboardOpen(full, vv.height));
    };
    sync();
    vv.addEventListener("resize", sync);
    return () => { vv.removeEventListener("resize", sync); root.style.removeProperty("--vn-vvh"); };
  }, []);
  return open;
}
