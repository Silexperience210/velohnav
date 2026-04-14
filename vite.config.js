import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // base './' obligatoire pour Capacitor Android (assets en chemin relatif)
      base: './',
      // Ne pas injecter dans index.html — on gère manuellement pour compatibilité Capacitor
      injectRegister: 'auto',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Cache JCDecaux API responses (stale-while-revalidate, 5min)
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
        description: 'AR bike-sharing — Luxembourg Vel\'OH!',
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
    }),
  ],
  base: './',
})
