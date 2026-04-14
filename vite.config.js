import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // IMPORTANT : base './' obligatoire pour Capacitor Android.
  // Sans ça, les assets (JS/CSS) sont chargés en chemin absolu et cassent dans le WebView natif.
  base: './',
})
