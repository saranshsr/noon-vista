import { useEffect, useRef } from 'react'
import type { Section } from '../domain/types'

/** `top` is the vertical CENTRE of the band's visible slice, in viewport px. */
export type HoveredSection = { sectionId: string; top: number; left: number }

type MasterImageProps = {
  width?: number
  /** Number (px) or a CSS length like '100%' so the preview can fill a flex column. */
  height?: number | string
  /** the screenshot to render inside the phone frame */
  src?: string
  alt?: string
  /**
   * Hover targets tiled over the image, in render order. Comes from the atlas
   * snapshot and is scoped to the screen being previewed.
   *
   * This used to be a module-level constant of *homepage* sections, applied to
   * whatever image the inspector happened to be showing — so hovering "Mega Deals"
   * over the Cart preview reported homepage numbers for a section the Cart doesn't
   * have. Sections are per-screen data now, and a screen with none simply gets no
   * hover targets.
   */
  sections?: Section[]
  /** hover a section block → its id + on-screen rect (null when leaving) */
  onHoverSection?: (info: HoveredSection | null) => void
}

/**
 * Figma: Master Image (node 25:27389) — a screen mockup in a 264×572 phone frame.
 * The image renders full-width / natural-height and the frame scrolls vertically.
 * Full-width section blocks are tiled over the image as hover targets; hovering one
 * surfaces that section so the dashboard can show a StatsBar for it.
 */
export function MasterImage({
  width = 264,
  height = 572,
  src = '/images/homepage.jpg',
  alt = 'Screen preview',
  sections,
  onHoverSection,
}: MasterImageProps) {
  const blocks = sections ?? []

  /**
   * Hover is re-derived from the live pointer position, not captured at mouseenter.
   *
   * The enter-event version reported each band's rect once, when the pointer crossed
   * into it — and the preview SCROLLS. Scrolling moves the bands under a stationary
   * cursor, so the reported rect went stale instantly: the stats card and its leader
   * line sat pinned to where the band USED to be, and browsers only re-fire boundary
   * events after scrolling settles, so the hovered band itself lagged. One rAF-throttled
   * hit-test, run on both mousemove and scroll, keeps the section id and its rect true
   * to the frame.
   */
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mouse = useRef<{ x: number; y: number } | null>(null)
  const raf = useRef(0)
  const callbackRef = useRef(onHoverSection)
  callbackRef.current = onHoverSection

  const report = () => {
    raf.current = 0
    const host = hostRef.current
    const emit = callbackRef.current
    if (!host || !emit) return
    if (!mouse.current) {
      emit(null)
      return
    }
    const hit = document.elementFromPoint(mouse.current.x, mouse.current.y)
    const band = (hit?.closest?.('[data-section-id]') ?? null) as HTMLElement | null
    if (!band || !host.contains(band)) {
      emit(null)
      return
    }
    const r = band.getBoundingClientRect()
    // Anchor on the VISIBLE slice of the band, not its full extent. A tall widget
    // half-scrolled out of the preview reports a rect that reaches past the
    // viewport — pointing the leader line at its geometric top means pointing at a
    // clipped, invisible spot. The stats describe what you can see; the anchor
    // sits in the middle of exactly that.
    const hostRect = host.getBoundingClientRect()
    const visibleTop = Math.max(r.top, hostRect.top)
    const visibleBottom = Math.min(r.bottom, hostRect.bottom)
    emit({
      sectionId: band.dataset.sectionId as string,
      top: (visibleTop + Math.max(visibleTop, visibleBottom)) / 2,
      left: r.left,
    })
  }
  const schedule = () => {
    if (!raf.current) raf.current = requestAnimationFrame(report)
  }
  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  return (
    <div
      ref={hostRef}
      onMouseMove={(e) => {
        mouse.current = { x: e.clientX, y: e.clientY }
        schedule()
      }}
      onScroll={schedule}
      onMouseLeave={() => {
        mouse.current = null
        schedule()
      }}
      style={{
        width,
        height,
        flex: '0 0 auto',
        borderRadius: 16,
        overflowY: 'auto',
        overflowX: 'hidden',
        background: 'rgba(255, 255, 255, 0.04)',
      }}
    >
      <div style={{ position: 'relative', width: '100%' }}>
        <img src={src} alt={alt} style={{ display: 'block', width: '100%', height: 'auto' }} />

        {/* Section blocks — transparent, full width, heights proportional to each
            section's weight; each reports itself to the dashboard on hover. */}
        {blocks.length > 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
            {blocks.map((s) => (
              // Passive targets: the container's hit-test owns hover reporting (see
              // above), these only carry the id and the :hover highlight.
              <div
                key={s.id}
                data-section-id={s.id}
                className="master-image__section"
                style={{ flex: s.weight, width: '100%' }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
