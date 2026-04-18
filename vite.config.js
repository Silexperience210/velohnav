import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// PWA activé UNIQUEMENT pour le build web (pas pour Capacitor APK).
// Pour build APK : VITE_DISABLE_PWA=1 npm run build
const pwaDisabled = process.env.VITE_DISABLE_PWA === '1'

export default defineConfig({
  plugins: [
    react(),
    ...(pwaDisabled ? [] : [VitePWA({
      registerType: 'autoUpdate',
      base: './',
      injectRegister: 'auto',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
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
  // CRITIQUE : NE PAS marquer Capacitor en external — le bundle doit l'inclure
  // sinon le WebView Android fait import("@capacitor/core") qui résout en 404.
  // Capacitor est résolu via node_modules au build-time et le bridge natif
  // intercepte les appels @capacitor/* à runtime.
  build: {
    target: 'es2020',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.js', 'src/**/*.spec.js'],
  },
})
