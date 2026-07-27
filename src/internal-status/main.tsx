import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Reuses the main app's design tokens (dark theme is the default :root, and
// this page never sets data-theme="light", so it always renders dark).
import '../index.css'
import './dashboard.css'
import { Dashboard } from './Dashboard'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
)
