import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Reuses the main app's design tokens, same convention as
// src/internal-feedback/main.tsx -- this page never sets data-theme, so it
// always renders the default (dark) token set.
import '../index.css'
import './board.css'
import { Board } from './Board'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Board />
  </StrictMode>,
)
