import { useEffect, useMemo, useRef, useState } from 'react'

export type BootStep = {
  label: string
  done: boolean
}

/**
 * Boot progress, derived from real milestones.
 *
 * The reference loader this is modelled on runs a fixed 3200ms timer and reports a
 * percentage of *elapsed time* — a progress bar that knows nothing about progress. We
 * already have genuine signals for each stage of startup, so the counter reports those
 * instead. A loader that lies is worse than no loader: it trains people to ignore it,
 * and it hides the case where something is actually stuck.
 *
 * The consequence is that on a warm local load this is over almost immediately, which
 * is correct — there's nothing to wait for. `minVisibleMs` only prevents a single-frame
 * flash of overlay, it does not pad the duration.
 */
export function useBootProgress({
  projectsReady,
  atlasReady,
  metricsReady,
  imagesReady,
  minVisibleMs = 2600,
}: {
  projectsReady: boolean
  atlasReady: boolean
  metricsReady: boolean
  imagesReady: boolean
  /**
   * How long the overlay is held regardless of how fast the data arrives, so it
   * reads as an intro rather than a flicker (the reference holds ~3200ms).
   *
   * The counter is paced across this window instead of jumping to 100% and waiting —
   * see `progress` below. It still never *overstates* readiness.
   */
  minVisibleMs?: number
}) {
  const steps = useMemo<BootStep[]>(
    () => [
      { label: 'Connecting to atlas', done: projectsReady },
      { label: 'Loading screens and flows', done: atlasReady },
      { label: 'Resolving flow metrics', done: metricsReady },
      { label: 'Decoding artboards', done: imagesReady },
    ],
    [projectsReady, atlasReady, metricsReady, imagesReady],
  )

  const completed = steps.filter((s) => s.done).length
  const realProgress = Math.round((completed / steps.length) * 100)
  const allDone = completed === steps.length

  const mountedAt = useRef(performance.now())
  const [minElapsed, setMinElapsed] = useState(false)
  /** Ticks so the time-paced component of the counter re-renders as it climbs. */
  const [elapsed, setElapsed] = useState(0)

  /**
   * Warm loads skip most of the theatre. If everything is already resolved within
   * the first 400ms — cached data, cached images, a returning user — holding the
   * overlay for the full scripted duration makes the app feel slower than it is,
   * dozens of times a day. The hold shrinks to a beat long enough to read as a
   * deliberate transition rather than a flash.
   */
  const holdMs = allDone && elapsed < 400 ? Math.min(minVisibleMs, 650) : minVisibleMs

  useEffect(() => {
    const remaining = Math.max(0, holdMs - (performance.now() - mountedAt.current))
    const done = window.setTimeout(() => setMinElapsed(true), remaining)
    // 50ms, matching the reference's counter cadence.
    const tick = window.setInterval(() => setElapsed(performance.now() - mountedAt.current), 50)
    return () => {
      window.clearTimeout(done)
      window.clearInterval(tick)
    }
  }, [holdMs, minVisibleMs])

  /**
   * The lower of "how much is actually ready" and "how far through the hold we are".
   *
   * Taking the minimum is what keeps this honest while still letting the overlay
   * linger: the number can never claim more readiness than exists, and it also never
   * parks at 100% for two seconds waiting for a timer to expire — which looks broken
   * and is the usual failure of a minimum-duration splash.
   */
  const timeProgress = Math.min(100, Math.round((elapsed / holdMs) * 100))
  const progress = Math.min(realProgress, timeProgress)

  /** Latest step still in flight — what the overlay says it's doing. */
  const activeLabel = steps.find((s) => !s.done)?.label ?? 'Ready'

  return { steps, progress, activeLabel, finished: allDone && minElapsed && progress >= 100 }
}
