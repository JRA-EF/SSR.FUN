import './polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Apply the saved theme before first paint to avoid a flash. Default is light.
if (localStorage.getItem('ssrfun-theme') !== 'dark') {
  document.documentElement.dataset.theme = 'light'
}

// Dev server only (stripped from production builds): expose the app store on
// window so design sessions can stage UI states — e.g. a simulated connected
// wallet — from the console without a real wallet extension.
if (import.meta.env.DEV) {
  void import('@/store/useAppStore').then((m) => {
    ;(window as unknown as { __ssrStore: typeof m.useAppStore }).__ssrStore = m.useAppStore
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
