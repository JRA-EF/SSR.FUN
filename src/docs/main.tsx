import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The public Documentation site (/docs) is its own Vite entry (docs.html),
// deliberately separate from the main app bundle: no wallet adapters, no
// store, no RPC -- so it stays light and can be served outside the
// closed-beta site gate (see middleware.ts DOCS_PUBLIC_PREFIX). It reuses
// the native design tokens from src/index.css per the UI baseline.
import '../index.css'
import './docs.css'
import { DocsApp } from './DocsApp'

// Same first-paint theme rule as the main app (src/main.tsx): light unless
// the visitor chose dark, shared through the same localStorage key.
// Guarded: a browser with storage blocked throws here, which used to stop the
// whole docs app from rendering (a blank page).
let savedTheme: string | null = null
try {
  savedTheme = localStorage.getItem('ssrfun-theme')
} catch {
  savedTheme = null
}
if (savedTheme !== 'dark') {
  document.documentElement.dataset.theme = 'light'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DocsApp />
  </StrictMode>,
)
