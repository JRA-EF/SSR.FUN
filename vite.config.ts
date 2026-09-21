import path from 'path'
import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
// Dev/preview servers have no vercel.json rewrites, so mirror the one
// production rule the Documentation site needs: /docs and /docs/<slug>
// serve docs.html (Vercel does the same via vercel.json "rewrites").
const DOCS_PATH_RE = /^\/docs(?=\/|\?|$)/
function docsPathRewrite(): Plugin {
  const rewrite = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use((req, _res, next) => {
      if (req.url && DOCS_PATH_RE.test(req.url)) {
        const q = req.url.indexOf('?')
        req.url = '/docs.html' + (q >= 0 ? req.url.slice(q) : '')
      }
      next()
    })
  }
  return { name: 'ssr-docs-path-rewrite', configureServer: rewrite, configurePreviewServer: rewrite }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), docsPathRewrite()],
  // @solana/web3.js and friends assume a Node-like `global` -- see
  // src/polyfills.ts for the Buffer half of this fix.
  define: {
    global: 'globalThis',
  },
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
      // Additional entries: password-protected internal-only pages, each
      // built as its own page/bundle, entirely separate from the main app.
      input: {
        main: path.resolve(import.meta.dirname, './index.html'),
        // Public Documentation site (/docs) -- separate bundle, no wallet or
        // store code, served outside the closed-beta gate (middleware.ts).
        docs: path.resolve(import.meta.dirname, './docs.html'),
        internalStatus: path.resolve(import.meta.dirname, './internal-status.html'),
        internalFeedback: path.resolve(import.meta.dirname, './internal-feedback.html'),
        // Team feedback board (status of every public-form submission) -- see api/feedback/board.ts.
        internalFeedbackBoard: path.resolve(import.meta.dirname, './internal-feedback-board.html'),
        internalKpis: path.resolve(import.meta.dirname, './internal-kpis.html'),
        // Protocol-Admin one-click page: signs set_fee_settlement_keeper (plain
        // HTML + web3.js from CDN, no app bundle) -- see the file's header.
        internalSetKeeper: path.resolve(import.meta.dirname, './internal-set-keeper.html'),
        // Public feedback form (BotID-protected submit) -- see src/feedback/main.ts.
        feedback: path.resolve(import.meta.dirname, './feedback.html'),
      },
    },
  },
})
