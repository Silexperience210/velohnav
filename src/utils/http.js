// ── fetchJSON avec retry + backoff court ───────────────────────────
// Partagé par GBFS (cyclocity) et Transitous. Mesuré le 08/10/2026 : le
// serveur cyclocity réinitialise régulièrement la connexion TCP (jusqu'à 4
// échecs sur 5 appels consécutifs) → on retente vite plutôt que d'abandonner.
//
// Retente sur : erreur réseau (TypeError fetch), timeout, HTTP 429 / 5xx.
// Ne retente PAS sur les autres 4xx (requête invalide → inutile d'insister).

export const DEFAULT_BACKOFF_MS = [300, 800, 1600];

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

const isRetryableStatus = s => s === 429 || s >= 500;

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {number}   [opts.retries=3]      nombre de NOUVELLES tentatives après la 1re
 * @param {number[]} [opts.backoffMs]      délais entre tentatives (dernier réutilisé)
 * @param {number}   [opts.timeoutMs=8000] timeout par tentative
 * @param {object}   [opts.headers]
 * @param {Function} [opts.fetchImpl]      injectable (tests)
 * @param {Function} [opts.sleep]          injectable (tests)
 */
export async function fetchJSONWithRetry(url, {
  retries = 3,
  backoffMs = DEFAULT_BACKOFF_MS,
  timeoutMs = 8000,
  headers,
  fetchImpl = (...a) => fetch(...a),
  sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const r = await fetchImpl(url, { headers, signal: ctrl?.signal });
      if (!r.ok) {
        lastErr = new HttpError(r.status, url);
        if (isRetryableStatus(r.status)) continue;
        throw lastErr;
      }
      return await r.json();
    } catch (e) {
      if (e instanceof HttpError && !isRetryableStatus(e.status)) throw e;
      lastErr = e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr || new Error("fetch failed");
}

// Capacitor natif : fetch est routé par CapacitorHttp (natif) → les en-têtes
// comme User-Agent sont réellement envoyés. Détection au runtime (le bridge
// peut être injecté après le parse du module).
export function isNativePlatform() {
  try {
    return typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.() === true;
  } catch { return false; }
}
