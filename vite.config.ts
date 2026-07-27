import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Ported SSR.FUN-MERGE pages import "@/..." (their own convention) and
      // "wouter" for routing. FABLE has no "@" alias of its own, so this is
      // additive; the wouter alias points at a shim backed by FABLE's existing
      // hash router so the whole app keeps a single router mechanism instead
      // of installing wouter's real (history-API-based) router alongside it.
      '@': path.resolve(import.meta.dirname, './src/merge'),
      wouter: path.resolve(import.meta.dirname, './src/merge/lib/wouter-shim.tsx'),
    },
  },
  build: {
    rollupOptions: {
      // Second entry: the password-protected /internal/status dashboard.
      // Built as its own page/bundle, entirely separate from the main app.
      input: {
        main: path.resolve(import.meta.dirname, './index.html'),
        internalStatus: path.resolve(import.meta.dirname, './internal-status.html'),
      },
    },
  },
})
