// ── useDarkMode — détection automatique mode nuit ──────────────────
// Retourne true entre 20h00 et 06h00 locale, ou si l'utilisateur force
// le mode nuit via localStorage (clé velohnav_nightMode = "true").
// Utilisé par ARScreen pour basculer les couleurs du tracé en néon.

import { useState, useEffect } from "react";

function isNightTime() {
  const h = new Date().getHours();
  return h >= 20 || h < 6;
}

export function useDarkMode() {
  const [isNight, setIsNight] = useState(() => {
    const forced = localStorage.getItem("velohnav_nightMode");
    if (forced === "true") return true;
    if (forced === "false") return false;
    return isNightTime();
  });

  useEffect(() => {
    const forced = localStorage.getItem("velohnav_nightMode");
    if (forced) return; // l'user a forcé, on ne touche pas
    const id = setInterval(() => setIsNight(isNightTime()), 60_000);
    return () => clearInterval(id);
  }, []);

  return isNight;
}
