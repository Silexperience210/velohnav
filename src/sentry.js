// ── Sentry — monitoring + crash reporting VelohNav ──────────────────
// Activé UNIQUEMENT si VITE_SENTRY_DSN est défini dans l'env.
// Sans DSN, l'app tourne sans overhead (aucun import network, aucun send).
//
// Pour activer :
//   1. Créer un projet Sentry sur https://sentry.io (free tier : 5k events/mois)
//   2. Copier le DSN (format: https://xxx@yyy.ingest.sentry.io/zzz)
//   3. Ajouter dans .env.local : VITE_SENTRY_DSN="https://..."
//   4. Ou en CI : secrets.VITE_SENTRY_DSN + passer au build Vite

import * as Sentry from "@sentry/react";

const DSN = import.meta.env.VITE_SENTRY_DSN;
const ENV = import.meta.env.MODE; // "development" | "production"

export function initSentry() {
  if (!DSN) {
    console.log("[Sentry] Désactivé (VITE_SENTRY_DSN non défini)");
    return false;
  }

  Sentry.init({
    dsn: DSN,
    environment: ENV,
    release: import.meta.env.VITE_APP_VERSION || "velohnav@dev",

    // Sampling — 10% en prod pour rester dans le free tier
    tracesSampleRate: ENV === "production" ? 0.1 : 1.0,
    replaysSessionSampleRate: 0,            // pas de session replay (coûteux)
    replaysOnErrorSampleRate: ENV === "production" ? 0.1 : 0.5,

    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: false,
        blockAllMedia: true,                // ne pas capturer la caméra AR
      }),
    ],

    // Filtrage des erreurs bruit (ResizeObserver, AbortError annulations user, etc.)
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "Non-Error promise rejection captured",
      /^AbortError/,
      /Capacitor/,                          // erreurs Capacitor déjà loggées côté natif
    ],

    // Masquer les data sensibles avant envoi
    beforeSend(event) {
      // Retirer les params URL qui contiennent des clés API
      if (event.request?.url) {
        event.request.url = event.request.url
          .replace(/([?&])(apiKey|accessId|key)=[^&]+/gi, "$1$2=***");
      }
      // Retirer les clés depuis les breadcrumbs
      if (event.breadcrumbs) {
        event.breadcrumbs.forEach(b => {
          if (b.data?.url) b.data.url = b.data.url
            .replace(/([?&])(apiKey|accessId|key)=[^&]+/gi, "$1$2=***");
        });
      }
      return event;
    },
  });

  // Tag statique utile pour filtrer dans le dashboard Sentry
  Sentry.setTag("platform", window.Capacitor?.isNativePlatform?.() ? "android-native" : "web");
  Sentry.setTag("app", "velohnav");

  console.log(`[Sentry] Initialisé (env=${ENV})`);
  return true;
}

// Helper pour tagger le user courant (sans PII — juste une clé localStorage anonyme)
export function setSentryUser(id) {
  if (!DSN) return;
  Sentry.setUser(id ? { id } : null);
}

// Helper pour capturer manuellement un message (warn, info, error)
export function logSentry(level, message, extra) {
  if (!DSN) return;
  Sentry.captureMessage(message, { level, extra });
}

export { Sentry };
