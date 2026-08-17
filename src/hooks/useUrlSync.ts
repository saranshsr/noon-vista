/**
 * Deep links and back/forward — the URL as a second representation of where you are.
 *
 * `?project=<slug>&mode=<map|screens>&screen=<id>` is kept in lock-step with the
 * Dashboard's state, in both directions:
 *
 *   state → URL   An effect writes the query string whenever project, mode or the
 *                 focused screen changes. Focus changes PUSH (they're navigation —
 *                 the thing you'd want Back to undo); everything else REPLACES, so
 *                 toggling Map/Screens doesn't bloat history with entries nobody
 *                 thinks of as places.
 *
 *   URL → state   `popstate` reads the query string back and applies it. A screen
 *                 that belongs to a *different* project can't be focused until that
 *                 project's snapshot arrives, so the screen id parks in
 *                 `pendingScreenRef` and an effect applies it the moment the
 *                 snapshot contains it. The same mechanism serves the initial page
 *                 load, which is what makes a pasted link land on the exact screen
 *                 rather than the project root.
 *
 * Loop safety is structural rather than flag-based: the write effect compares the
 * URL it would write against the URL that's already there and skips the no-op, so
 * "popstate → setState → write effect" terminates instead of echoing. The one flag
 * (`pendingScreenRef`) exists because during a cross-project restore the state is
 * legitimately *behind* the URL, and writing during that window would clobber the
 * very parameter we're still trying to apply.
 *
 * Scope note: `range` is deliberately absent — no UI sets a TimeRange yet, so
 * there is no state to reflect. The Gallery (`?view=gallery`) stays a read-once
 * dev surface, untouched by this hook.
 */

import { useEffect, useRef } from 'react'
import type { AtlasSnapshot, ProjectId, ScreenId } from '../domain/types'
import type { AtlasMode } from '../molecules/TopSwitch'

const MODES: AtlasMode[] = ['map', 'screens']

function readParams() {
  const p = new URLSearchParams(window.location.search)
  const mode = p.get('mode')
  return {
    project: p.get('project'),
    mode: MODES.includes(mode as AtlasMode) ? (mode as AtlasMode) : null,
    screen: p.get('screen'),
  }
}

export function useUrlSync(args: {
  projectId: ProjectId | null
  selectProject: (id: ProjectId) => void
  mode: AtlasMode
  switchMode: (mode: AtlasMode) => void
  focusedId: ScreenId | null
  focusScreen: (id: ScreenId) => void
  snapshot: AtlasSnapshot | null
}) {
  // selectProject and switchMode are only ever called from the popstate listener,
  // which reads them through argsRef so the subscription never has to re-bind.
  const { projectId, mode, focusedId, focusScreen, snapshot } = args

  // The latest callbacks, readable from listeners without re-subscribing.
  const argsRef = useRef(args)
  argsRef.current = args

  /** A screen the URL names but the current snapshot can't focus yet. */
  const pendingScreenRef = useRef<ScreenId | null>(readParams().screen)

  // ── URL → state: apply a parked screen once its snapshot arrives ──────────
  useEffect(() => {
    const pending = pendingScreenRef.current
    if (!pending || !snapshot) return
    if (snapshot.screens.some((s) => s.id === pending)) {
      pendingScreenRef.current = null
      focusScreen(pending)
    } else if (snapshot.project.id === argsRef.current.projectId) {
      // The right project loaded and the screen isn't in it — a stale or foreign
      // link. Drop it rather than holding URL writes hostage forever.
      pendingScreenRef.current = null
    }
  }, [snapshot, focusScreen])

  // ── URL → state: back/forward ──────────────────────────────────────────────
  useEffect(() => {
    const onPopState = () => {
      const url = readParams()
      const current = argsRef.current
      if (url.project && url.project !== current.projectId) {
        pendingScreenRef.current = url.screen
        current.selectProject(url.project)
      } else if (url.screen && url.screen !== current.focusedId) {
        pendingScreenRef.current = url.screen
        // Nudge the apply effect even if the snapshot reference hasn't changed.
        if (current.snapshot?.screens.some((s) => s.id === url.screen)) {
          pendingScreenRef.current = null
          current.focusScreen(url.screen)
        }
      }
      if (url.mode && url.mode !== current.mode) current.switchMode(url.mode)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // ── state → URL ────────────────────────────────────────────────────────────
  useEffect(() => {
    // Until the snapshot is in and any parked screen applied, the URL is ahead of
    // the state — writing now would erase the destination mid-journey.
    if (!snapshot || !projectId || pendingScreenRef.current) return

    const url = new URL(window.location.href)
    const before = url.searchParams.toString()
    const prevScreen = url.searchParams.get('screen')

    url.searchParams.set('project', projectId)
    url.searchParams.set('mode', mode)
    if (focusedId) url.searchParams.set('screen', focusedId)
    else url.searchParams.delete('screen')

    if (url.searchParams.toString() === before) return

    // A focus change is navigation; everything else is adjustment.
    if (focusedId && prevScreen && focusedId !== prevScreen) {
      window.history.pushState(null, '', url)
    } else {
      window.history.replaceState(null, '', url)
    }
  }, [projectId, mode, focusedId, snapshot])
}
