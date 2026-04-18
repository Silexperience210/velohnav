// ── Sentry — crash reporting (lazy load, zero-cost sans DSN) ─────────
// CRITIQUE : pas d'import statique de @sentry/react — il charge 200 KB
// avec side-effects qui peuvent casser le WebView Android au boot.
// On lazy-load SEULEMENT si VITE_SENTRY_DSN est défini.

const DSN = import.meta.env.VITE_SENTRY_DSN;
const ENV = import.meta.env.MODE;

let _sentry = null;       // référence Sentry une fois chargé
let _loading = null;      // promise pour éviter double-init

export async function initSentry() {
  if (!DSN) {
    console.log("[Sentry] Désactivé (VITE_SENTRY_DSN non défini)");
    return false;
  }
  if (_sentry) return true;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      const S = await import("@sentry/react");
      S.init({
        dsn: DSN,
        environment: ENV,
        release: import.meta.env.VITE_APP_VERSION || "velohnav@dev",
        tracesSampleRate: ENV === "production" ? 0.1 : 1.0,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: ENV === "production" ? 0.1 : 0.5,
        integrations: [
          S.browserTracingIntegration(),
          S.replayIntegration({ maskAllText: false, blockAllMedia: true }),
        ],
        ignoreErrors: [
          "ResizeObserver loop limit exceeded",
          "ResizeObserver loop completed with undelivered notifications",
          "Non-Error promise rejection captured",
          /^AbortError/,
          /Capacitor/,
        ],
        beforeSend(event) {
          const scrub = (u) => u?.replace(/([?&])(apiKey|accessId|key)=[^&]+/gi, "$1$2=***");
          if (event.request?.url) event.request.url = scrub(event.request.url);
          event.breadcrumbs?.forEach(b => { if (b.data?.url) b.data.url = scrub(b.data.url); });
          return event;
        },
      });
      try {
        S.setTag("platform", window.Capacitor?.isNativePlatform?.() ? "android-native" : "web");
        S.setTag("app", "velohnav");
      } catch { /* noop */ }
      _sentry = S;
      console.log(`[Sentry] Initialisé (env=${ENV})`);
      return true;
    } catch (e) {
      // NE JAMAIS throw — une erreur Sentry ne doit JAMAIS casser l'app
      console.warn("[Sentry] init échoué (app continue):", e.message);
      return false;
    }
  })();
  return _loading;
}

// Capture défensive — noop si Sentry pas chargé
export function captureErr(err, extra) {
  try { _sentry?.captureException(err, extra ? { extra } : undefined); } catch {}
}

export function logSentry(level, message, extra) {
  try { _sentry?.captureMessage(message, { level, extra }); } catch {}
}

export function setSentryUser(id) {
  try { _sentry?.setUser(id ? { id } : null); } catch {}
}
