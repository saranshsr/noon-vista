import { lazy, Suspense } from 'react'
import { MotionConfig } from 'motion/react'
import Dashboard from './pages/Dashboard'

// The Gallery is a dev surface behind ?view=gallery; almost no visitor ever
// loads it, so it must not cost the ones who don't anything.
const Gallery = lazy(() => import('./pages/Gallery'))
import { ErrorBoundary } from './components'
import { AtlasProvider } from './state/AtlasProvider'
import { SEEDED_PROJECT_ID } from './data/seed/noonAtlasSeed'

/**
 * App entry.
 *  - default            → the atlas Dashboard landing page (Figma 54:65001)
 *  - ?view=gallery      → the atoms / molecules / sidebar component gallery
 *
 * `?view=gallery` stays a read-once param — the Gallery is a dev surface, not a
 * place users navigate to and from. Everything else (`?project&mode&screen`) is
 * live routing: useUrlSync in the Dashboard keeps the query string and the app
 * state in lock-step, in both directions, so links deep-link and back/forward work.
 */
export default function App() {
  const params = new URLSearchParams(window.location.search)
  const view = params.get('view')
  const projectId = params.get('project') ?? SEEDED_PROJECT_ID

  if (view === 'gallery') {
    return (
      <ErrorBoundary>
        <Suspense fallback={null}>
          <Gallery />
        </Suspense>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      {/* Every Motion animation in the tree honours the OS reduce-motion setting.
          The older rAF code paths check useReducedMotion by hand; this is the same
          contract for everything declarative. */}
      <MotionConfig reducedMotion="user">
        <AtlasProvider initialProjectId={projectId}>
          <Dashboard />
        </AtlasProvider>
      </MotionConfig>
    </ErrorBoundary>
  )
}
