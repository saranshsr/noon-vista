import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import './index.css'
import App from './App.tsx'

// Retune visual-edit overlay — renders in dev only. Lazy-loaded so the ~500KB
// package is code-split out of the production bundle. Toggle with Alt/⌥+D.
const Retune = import.meta.env.DEV
  ? lazy(() => import('retune').then((m) => ({ default: m.Retune })))
  : () => null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Suspense fallback={null}>
      <Retune />
    </Suspense>
  </StrictMode>,
)
