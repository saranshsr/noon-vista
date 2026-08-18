import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { animate } from 'motion'
import type { AnimationPlaybackControls } from 'motion'

export interface Viewport {
  /** Screen-space x offset of the world origin, in px. */
  x: number
  /** Screen-space y offset of the world origin, in px. */
  y: number
  /** Zoom factor (1 = 100%). */
  scale: number
}

export const MIN_SCALE = 0.1
export const MAX_SCALE = 4
const ZOOM_SENSITIVITY = 0.02

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

/** Convert a screen point (relative to the canvas element) into world coordinates. */
export function screenToWorld(viewport: Viewport, sx: number, sy: number) {
  return {
    x: (sx - viewport.x) / viewport.scale,
    y: (sy - viewport.y) / viewport.scale,
  }
}

export interface ViewportController {
  viewport: Viewport
  /** Attach to the interactive canvas root. */
  ref: RefObject<HTMLDivElement | null>
  panning: boolean
  handlers: {
    onPointerDown: (e: ReactPointerEvent) => void
  }
  reset: () => void
  /**
   * Zoom about the viewport centre, eased.
   *
   * Deliberately animated: the +/− buttons and keys used to call the instant
   * `zoomAt` used by the wheel, so a click teleported the camera between zoom
   * levels with nothing to follow. The wheel keeps the instant path — it's
   * continuous input and already feels smooth — but a discrete step needs
   * interpolating or you lose your place on the plane.
   */
  zoomBy: (factor: number) => void
  /** Ease to an absolute zoom, holding the viewport centre. */
  zoomTo: (scale: number) => void
  /** Smoothly animate the viewport to a target pan/zoom (eased). */
  animateTo: (target: Partial<Viewport>, duration?: number) => void
  /** Set the viewport instantly, with no animation — for initial framing. */
  jumpTo: (target: Partial<Viewport>) => void
}

/**
 * Drives an infinite, pannable/zoomable canvas.
 * - Trackpad two-finger scroll → pan
 * - Ctrl/Cmd + scroll or pinch → zoom toward the cursor
 * - Left/middle drag on the background → pan
 */
export function useViewport(initial?: Partial<Viewport>): ViewportController {
  const [viewport, setViewport] = useState<Viewport>({
    x: initial?.x ?? 0,
    y: initial?.y ?? 0,
    scale: initial?.scale ?? 1,
  })
  const [panning, setPanning] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const drag = useRef({ active: false, lastX: 0, lastY: 0 })
  // Cleanup for the in-flight drag's window listeners, if any.
  const stopDrag = useRef<(() => void) | null>(null)
  // Latest viewport + any running focus animation (Motion playback controls).
  const vpRef = useRef(viewport)
  vpRef.current = viewport
  const anim = useRef<AnimationPlaybackControls | null>(null)

  const cancelAnim = useCallback(() => {
    anim.current?.stop()
    anim.current = null
  }, [])

  /**
   * Camera transitions ride a Motion spring rather than the easeOutCubic tween this
   * replaced. The interesting property is velocity continuity: mashing + three times
   * used to restart the ease from zero each press, which read as three separate
   * lurches — a spring interrupted mid-flight keeps its momentum, so a run of steps
   * feels like one accelerating move. `visualDuration` keeps the old call sites'
   * duration semantics; the slight bounce is the same material language as the
   * board springs.
   */
  const animateTo = useCallback(
    (target: Partial<Viewport>, duration = 450) => {
      cancelAnim()
      const from = vpRef.current
      const to = { ...from, ...target }
      if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setViewport(to)
        return
      }
      anim.current = animate(0, 1, {
        type: 'spring',
        visualDuration: duration / 1000,
        bounce: 0.12,
        onUpdate: (k) => {
          setViewport({
            x: from.x + (to.x - from.x) * k,
            y: from.y + (to.y - from.y) * k,
            scale: from.scale + (to.scale - from.scale) * k,
          })
        },
      })
    },
    [cancelAnim],
  )

  // Any direct interaction (drag, pan, zoom) cancels a running focus animation.
  useEffect(() => {
    window.addEventListener('pointerdown', cancelAnim, true)
    return () => window.removeEventListener('pointerdown', cancelAnim, true)
  }, [cancelAnim])

  // Wheel / trackpad: applied directly, no lerp.
  //
  // Trackpads already send smooth, high-frequency deltas — adding a lerp on top
  // just introduces lag that makes pinch-zoom and two-finger pan feel disconnected.
  // Programmatic transitions (button zoom, fit-all, focus) use `animateTo` for easing.
  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      cancelAnim()

      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        const factor = Math.exp(-e.deltaY * ZOOM_SENSITIVITY)
        setViewport((v) => {
          const newScale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE)
          const worldX = (cx - v.x) / v.scale
          const worldY = (cy - v.y) / v.scale
          return {
            scale: newScale,
            x: cx - worldX * newScale,
            y: cy - worldY * newScale,
          }
        })
      } else {
        setViewport((v) => ({
          ...v,
          x: v.x - e.deltaX,
          y: v.y - e.deltaY,
        }))
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [cancelAnim])

  // Drag-to-pan. Move/up are tracked on `window` rather than via pointer
  // capture so the very first drag after a zoom (or any re-render) is picked up
  // immediately — no stray click needed to "wake up" panning.
  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return // primary or middle only
    stopDrag.current?.() // clear any leftover listeners from a prior drag
    drag.current = { active: true, lastX: e.clientX, lastY: e.clientY }
    setPanning(true)

    const onMove = (ev: PointerEvent) => {
      if (!drag.current.active) return
      const dx = ev.clientX - drag.current.lastX
      const dy = ev.clientY - drag.current.lastY
      drag.current.lastX = ev.clientX
      drag.current.lastY = ev.clientY
      setViewport((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    }
    const end = () => {
      drag.current.active = false
      setPanning(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      stopDrag.current = null
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    stopDrag.current = end
  }, [])

  // Tear down a drag still in flight when the hook unmounts.
  useEffect(() => () => {
    stopDrag.current?.()
    cancelAnim()
  }, [cancelAnim])

  const reset = useCallback(() => setViewport({ x: 0, y: 0, scale: 1 }), [])

  const jumpTo = useCallback(
    (target: Partial<Viewport>) => {
      cancelAnim()
      setViewport((v) => ({ ...v, ...target }))
    },
    [cancelAnim],
  )

  /**
   * Ease to `scale`, holding the viewport centre fixed.
   *
   * The world point under the centre of the screen has to stay under the centre of
   * the screen, otherwise a zoom step also slides the plane sideways and you lose
   * track of where you were.
   */
  const zoomToScale = useCallback(
    (nextScale: number, duration = 260) => {
      const el = ref.current
      if (!el) return
      const v = vpRef.current
      const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE)
      if (scale === v.scale) return
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      const cx = el.clientWidth / 2
      const cy = el.clientHeight / 2
      const worldX = (cx - v.x) / v.scale
      const worldY = (cy - v.y) / v.scale
      animateTo({ scale, x: cx - worldX * scale, y: cy - worldY * scale }, duration)
    },
    [animateTo],
  )

  const zoomBy = useCallback(
    (factor: number) => zoomToScale(vpRef.current.scale * factor),
    [zoomToScale],
  )

  const zoomTo = useCallback((scale: number) => zoomToScale(scale), [zoomToScale])

  return {
    viewport,
    ref,
    panning,
    handlers: {
      onPointerDown,
    },
    reset,
    zoomBy,
    zoomTo,
    animateTo,
    jumpTo,
  }
}
