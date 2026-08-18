import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Reuses the main app's design tokens, same fixed-dark-mode convention as
// ../internal-status/main.tsx (this page never sets data-theme, so it
// always renders the default dark token set).
import '../index.css'
import '../internal-status/dashboard.css'
import './kpis.css'
import { KpiDashboard } from './Dashboard'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KpiDashboard />
  </StrictMode>,
)
