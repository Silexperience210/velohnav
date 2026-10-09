// Mémoire disponible sur l'appareil, pour décider AVANT de charger le modèle
// (modelPolicy.memoryVerdict). Deux sources, de la plus fiable à la plus grossière :
//   - Android (Capacitor) : plugin natif DeviceMemory → ActivityManager.MemoryInfo
//     (mémoire libre réelle, seuil où le système commence à tuer, drapeau lowMemory) ;
//   - navigateur : navigator.deviceMemory (RAM TOTALE en Go, arrondie, plafonnée à 8).
// Aucune source : null (l'appelant décide — ici, on autorise : rien ne permet de juger).
import { withTimeout } from "./modelPolicy.js";

let plugin = null;

function isNative() {
  try { return globalThis.window?.Capacitor?.isNativePlatform?.() === true; } catch { return false; }
}

/** @returns {Promise<null | {availBytes?:number,totalBytes?:number,thresholdBytes?:number,lowMemory?:boolean,deviceMemoryGB?:number}>} */
export async function readMemoryInfo({ timeoutMs = 1500 } = {}) {
  if (isNative()) {
    try {
      if (!plugin) {
        const { registerPlugin } = await import("@capacitor/core");
        plugin = registerPlugin("DeviceMemory");
      }
      const r = await withTimeout(plugin.info(), timeoutMs, "memory info");
      if (Number.isFinite(r?.availBytes)) {
        return { availBytes: r.availBytes, totalBytes: r.totalBytes, thresholdBytes: r.thresholdBytes, lowMemory: !!r.lowMemory };
      }
    } catch { /* APK sans le plugin (ancienne version) : repli navigateur */ }
  }
  const dm = globalThis.navigator?.deviceMemory;
  return Number.isFinite(dm) ? { deviceMemoryGB: dm } : null;
}

/** Pour les tests : oublie le plugin enregistré. */
export function resetMemoryPlugin() { plugin = null; }
