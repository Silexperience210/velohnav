import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import ortEngine from './scripts/vite-ort-engine.mjs'

// PWA activé UNIQUEMENT pour le build web (pas pour Capacitor APK).
// Pour build APK : npm run build:apk (VITE_DISABLE_PWA=1)
const pwaDisabled = process.env.VITE_DISABLE_PWA === '1'

// Build sans PWA : un sw.js « coupe-circuit » remplace celui de Workbox. Un service
// worker installé par une APK construite par erreur avec la PWA (APK d'essai
// LFM2.5) survit aux mises à jour de l'application : il continuerait de servir
// l'ancienne version, et ses fichiers mis en cache SANS les en-têtes COOP/COEP
// (ses requêtes ne passent pas par IsolatingWebViewClient) font refuser le worker
// MapLibre à la page isolée → carte vide. À sa prochaine vérification, il est
// remplacé par celui-ci, qui vide les caches, se désinscrit et recharge la page.
const SW_KILL_SWITCH = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));
`
const swKillSwitch = () => ({
  name: 'velohnav-sw-kill-switch',
  generateBundle() { this.emitFile({ type: 'asset', fileName: 'sw.js', source: SW_KILL_SWITCH }) },
})

export default defineConfig({
  plugins: [
    react(),
    ...(pwaDisabled ? [swKillSwitch()] : [VitePWA({
      registerType: 'autoUpdate',
      base: './',
      // Enregistrement fait par main.jsx, jamais dans l'application native
      injectRegister: null,
      workbox: {
        // mjs : worker MapLibre — sans lui la carte ne s'initialise pas hors ligne
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.jcdecaux\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'jcdecaux-api',
              expiration: { maxEntries: 10, maxAgeSeconds: 300 },
            },
          },
          {
            urlPattern: /^https:\/\/corsproxy\.io\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'cors-proxy',
              expiration: { maxEntries: 5, maxAgeSeconds: 300 },
            },
          },
        ],
      },
      manifest: {
        name: 'VelohNav',
        short_name: 'VelohNav',
        description: "AR bike-sharing — Luxembourg Vel'OH!",
        theme_color: '#080c0f',
        background_color: '#080c0f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    })]),
  ],
  base: './',
  define: { __PWA__: JSON.stringify(!pwaDisabled) },
  // CRITIQUE : NE PAS marquer Capacitor en external — le bundle doit l'inclure
  // sinon le WebView Android fait import("@capacitor/core") qui résout en 404.
  // Capacitor est résolu via node_modules au build-time et le bridge natif
  // intercepte les appels @capacitor/* à runtime.
  build: {
    target: 'es2020',
    sourcemap: true,
  },
  // Le worker du modèle (src/ai/modelWorker.js) importe transformers.js, qui se
  // découpe en plusieurs morceaux : le format iife par défaut ne le permet pas.
  // ortEngine : transformers.js reçoit le moteur onnxruntime choisi par le worker
  // (sans lui, la variante processeur n'a pas ses noyaux — voir src/ai/ortEngine.js).
  worker: {
    format: 'es',
    plugins: () => [ortEngine()],
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.js', 'src/**/*.spec.js'],
  },
})
