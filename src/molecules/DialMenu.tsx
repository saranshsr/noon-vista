import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Glyphs, TOOLS } from './CommandBar'
import type { Tool, ToolId } from './CommandBar'
import { ScrambleText } from '../components/ScrambleText'
import { sfx } from '../utils/sfx'
import { useReducedMotion } from '../hooks/useReducedMotion'

/**
 * The tool dial — a radial menu that opens at the cursor.
 *
 * Ported from robot-components' `DialMenu`. The bottom command bar it replaces held
 * thirteen 30px tiles in a strip; this holds the same commands as 64px icon-and-label
 * tiles on a ring, revealed one at a time from the centre outward, with the whole rig
 * tilting toward the pointer in a shallow 3D space.
 *
 * Three things were changed from the reference on purpose:
 *
 *  1. **No `backdrop-filter` on the hub.** The reference declares `blur(8px)` on its
 *     centre disc, but puts `perspective: 800` and a `transform`/`preserve-3d` container
 *     above it — each of which establishes a backdrop root, so that blur has never
 *     actually rendered. What you see in the reference is the flat `rgba(28,28,28,0.35)`
 *     fill underneath. Copying the declaration would import a dead property and, worse,
 *     imply this surface is glass when it can't be. Copied the result, not the intent.
 *
 *  2. **Springs on `motion/react` (motion.dev), declaratively.** The tile choreography is
 *     fully derivable from state (revealed count, hover, closing, page spin), so each tile
 *     renders a `motion.div` with a computed target instead of an imperative spring API.
 *     Tilt, mouse-follow and ring angle still run in a rAF loop writing to refs, which is
 *     how `GridCanvas` already works — Motion is for targets, not for per-frame physics.
 *
 *  3. **Our glyphs, our palette.** The reference uses 20px lucide icons and a blue
 *     scramble; this uses the hand-drawn 1px-stroke glyphs the command bar already owns
 *     and noon pink, so the dial reads as part of this app rather than a transplant.
 *
 * Disabled tools are a concept the reference doesn't have. They're shown dimmed and
 * unclickable rather than omitted, for the reason stated in `CommandBar`: a visibly
 * disabled control communicates a roadmap, an absent one communicates nothing.
 */

/** Ring radius the tiles sit on, and the decorative ring just outside them. */
const ITEM_RADIUS = 125
const RING_RADIUS = 110
const ITEM_SIZE = 64
/** First tile at twelve o'clock. */
const START_ANGLE = -90

const MAX_TILT = 12
/** Cursor distance, in px, at which the tilt saturates. */
const TILT_RANGE = 200
const TILT_LERP = 0.1
/** How far the rig drifts against the cursor, and the cap on that drift. */
const FOLLOW_STRENGTH = 0.12
const MAX_OFFSET = 25
const POSITION_LERP = 0.08

/** Stagger between tiles appearing — quicker on a page change than on first open. */
const REVEAL_STEP_OPEN = 50
const REVEAL_STEP_PAGE = 25
/**
 * Stagger between tiles *leaving*.
 *
 * Deliberately faster than the entrance. An entrance is an invitation and can afford to
 * unfold; an exit is an acknowledgement and reads as sluggish if it takes the same time.
 * The chrome's matching fade is in the stylesheet (`.dial.is-closing`, 140ms).
 */
const EXIT_STEP = 22

/** Which tools live on which ring, in order. */
type Page = { name: string; ids: ToolId[] }
const PAGES: Page[] = [
  { name: 'Tools', ids: ['select', 'pan', 'drawFlow', 'delete', 'addScreen', 'filter'] },
  { name: 'View', ids: ['isolate', 'minimap', 'snap'] },
]

const byId = new Map(TOOLS.map((t) => [t.id, t]))

export function DialMenu({
  open,
  at,
  activeTool,
  toggles,
  onSelect,
  onClose,
}: {
  open: boolean
  /** Where it was summoned, in client coordinates. */
  at: { x: number; y: number }
  activeTool: ToolId
  toggles: Partial<Record<ToolId, boolean>>
  onSelect: (id: ToolId) => void
  onClose: () => void
}) {
  const reducedMotion = useReducedMotion()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const tiltRef = useRef<HTMLDivElement | null>(null)
  const needleRef = useRef<SVGSVGElement | null>(null)
  const parallaxRefs = useRef<(HTMLDivElement | null)[]>([])

  const [page, setPage] = useState(0)
  const [revealed, setRevealed] = useState(0)
  const [hovered, setHovered] = useState<ToolId | null>(null)
  /** Cursor is over the hub, which is the exit — swaps the label to ✕ CLOSE. */
  const [hubHot, setHubHot] = useState(false)
  /**
   * Mount is held past `open` going false so the dial can animate out.
   *
   * Without this the component returned `null` the instant it was closed, so the ring
   * blinked out of existence — it had a staggered entrance and no exit at all. `closing`
   * hands the springs over to the exit runner and stops every other effect from resetting
   * state mid-flight.
   */
  const [mounted, setMounted] = useState(false)
  const [closing, setClosing] = useState(false)
  /** Guards against re-entering the exit if `open` churns while it runs. */
  const exiting = useRef(false)
  const [spinKey, setSpinKey] = useState(0)
  const [direction, setDirection] = useState<1 | -1>(1)

  const items = useMemo(
    () => PAGES[page].ids.map((id) => byId.get(id)).filter(Boolean) as Tool[],
    [page],
  )
  const count = items.length

  /** Ring geometry for one index. */
  const seatOf = useCallback(
    (index: number, total: number, offsetDeg = 0) => {
      const a = ((START_ANGLE + (360 / total) * index + offsetDeg) * Math.PI) / 180
      return { x: Math.cos(a) * ITEM_RADIUS, y: Math.sin(a) * ITEM_RADIUS }
    },
    [],
  )

  // Tile transforms. Unrevealed tiles sit collapsed at the centre on first open, or
  // rotated a third of a turn back around the ring on a page change — so a page turn
  // reads as the ring spinning rather than as everything blinking.
  // Under reduced motion the tiles start already seated, so nothing blooms.

  /**
   * Open/close lifecycle, including the exit animation.
   *
   * The tiles retract to the centre in *reverse* reveal order, so the ring unwinds the way
   * it wound up rather than collapsing all at once. A descending pitch mirrors the rising
   * one on open, which makes the pair read as one gesture with two directions.
   */
  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      exiting.current = false
      return
    }
    if (!mounted || exiting.current) return
    exiting.current = true
    setClosing(true)

    if (reducedMotion) {
      setMounted(false)
      setClosing(false)
      return
    }

    let done = false
    const finish = () => {
      if (done) return
      done = true
      setMounted(false)
      setClosing(false)
    }

    const n = count
    let tick = 0
    const ticker = window.setInterval(() => {
      tick++
      sfx.play(0.02, Math.max(0.55, 1.35 - tick * 0.09))
      if (tick >= n) window.clearInterval(ticker)
    }, EXIT_STEP)

    // The i=0 tile retracts last (reverse order); its onAnimationComplete calls
    // `finishExit`. The timeout is belt and braces — an interrupted animation may
    // never complete, and a dial that failed to unmount would sit invisible over
    // the canvas swallowing clicks.
    finishExit.current = finish
    const bail = window.setTimeout(finish, (n - 1) * EXIT_STEP + 420)

    return () => {
      window.clearInterval(ticker)
      window.clearTimeout(bail)
    }
  }, [open, mounted, count, reducedMotion])

  // Tile targets are computed per-render (see the motion.div below) — the imperative
  // spring API this replaced needed an effect to re-seat tiles on every state change;
  // a declarative target needs only the state.
  useEffect(() => {
    if (!closing && !open) setRevealed(0)
  }, [open, closing])

  /** Set by the exit effect; called by the last retracting tile's completion. */
  const finishExit = useRef<(() => void) | null>(null)

  /** Reveal the tiles one at a time, with an ascending click per tile. */
  useEffect(() => {
    if (!open) return
    if (reducedMotion) {
      setRevealed(count)
      return
    }
    setRevealed(0)
    let n = 0
    const step = spinKey === 0 ? REVEAL_STEP_OPEN : REVEAL_STEP_PAGE
    const id = window.setInterval(() => {
      n++
      setRevealed(n)
      // Rising pitch as the ring fills — the sound reports progress, not just presence.
      if (spinKey === 0) sfx.play(0.025, 0.9 + n * 0.08)
      if (n >= count) window.clearInterval(id)
    }, step)
    return () => window.clearInterval(id)
  }, [open, count, page, spinKey, reducedMotion])

  /** Scroll to turn the ring to the next page. */
  useEffect(() => {
    if (!open) return
    let last = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const now = performance.now()
      if (now - last < 350) return
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX
      if (Math.abs(delta) < 30) return
      last = now
      const forward = delta > 0
      setDirection(forward ? 1 : -1)
      setPage((p) => (p + (forward ? 1 : PAGES.length - 1)) % PAGES.length)
      setSpinKey((k) => k + 1)
      sfx.play(0.03, forward ? 1.1 : 0.9)
    }
    // Capture, so the canvas's own wheel-to-zoom never fires while the dial is up.
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [open])

  /** Escape or a click outside closes. */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Deferred a tick, or the very click that opened the dial closes it again.
    const t = window.setTimeout(() => {
      window.addEventListener('mousedown', onDown)
      window.addEventListener('keydown', onKey, true)
    }, 10)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])

  /**
   * Reset per-open state — keyed on `mounted`, NOT on `open`.
   *
   * Resetting on `open` would snap `page` back to 0 the moment closing began. On page two
   * that changes the tile count from three to six mid-exit, so three tiles would pop into
   * existence just to animate away. The reset has to wait until the dial is actually gone.
   */
  useEffect(() => {
    if (!mounted) {
      setPage(0)
      setSpinKey(0)
      setHovered(null)
      setHubHot(false)
    }
  }, [mounted])

  /**
   * Tilt, drift and needle, all in one rAF loop writing straight to the DOM.
   *
   * None of this belongs in React state: it updates every frame off raw mouse position,
   * and re-rendering nine tiles at 60fps to move a container by two degrees would be
   * pure waste.
   */
  // Keyed on `mounted` rather than `open` so the rig keeps tracking the cursor through the
  // exit. Stopping it on `open` froze the tilt at whatever angle it held, which read as the
  // dial locking up a frame before it left.
  useEffect(() => {
    if (!mounted || reducedMotion) return

    let raf = 0
    const mouse = { x: at.x, y: at.y }
    const spawn = { x: at.x, y: at.y }
    const pos = { x: at.x, y: at.y }
    const tilt = { x: 0, y: 0 }
    let needle = 0
    let needleTarget = 0

    if (rootRef.current) {
      rootRef.current.style.left = `${at.x}px`
      rootRef.current.style.top = `${at.y}px`
    }

    const onMove = (e: MouseEvent) => {
      mouse.x = e.clientX
      mouse.y = e.clientY
    }

    const tick = () => {
      // Drift *against* the cursor, so the ring leans away as you reach across it. Capped,
      // or a cursor thrown to the far edge would drag the whole dial off screen.
      let ox = -(mouse.x - spawn.x) * FOLLOW_STRENGTH
      let oy = -(mouse.y - spawn.y) * FOLLOW_STRENGTH
      const od = Math.hypot(ox, oy)
      if (od > MAX_OFFSET) {
        ox = (ox / od) * MAX_OFFSET
        oy = (oy / od) * MAX_OFFSET
      }
      pos.x += (spawn.x + ox - pos.x) * POSITION_LERP
      pos.y += (spawn.y + oy - pos.y) * POSITION_LERP

      const dx = mouse.x - pos.x
      const dy = mouse.y - pos.y

      // Once the cursor leaves the ring, the whole dial creeps toward it — quintic, so it
      // barely moves for a small reach and follows properly for a big one.
      if (Math.hypot(dx, dy) > ITEM_RADIUS + 20) {
        const sx = mouse.x - spawn.x
        const sy = mouse.y - spawn.y
        const n = Math.min(1, Math.hypot(sx, sy) / 250)
        const pull = 0.001 + n * n * n * n * n * 0.06
        spawn.x += sx * pull
        spawn.y += sy * pull
      }

      if (Math.hypot(dx, dy) > 20) needleTarget = (Math.atan2(dy, dx) * 180) / Math.PI
      let diff = needleTarget - needle
      while (diff > 180) diff -= 360
      while (diff < -180) diff += 360
      needle += diff * 0.15

      const nx = Math.max(-1, Math.min(1, dx / TILT_RANGE))
      const ny = Math.max(-1, Math.min(1, dy / TILT_RANGE))
      tilt.x += (-ny * MAX_TILT - tilt.x) * TILT_LERP
      tilt.y += (nx * MAX_TILT - tilt.y) * TILT_LERP

      if (tiltRef.current) {
        tiltRef.current.style.transform = `rotateX(${tilt.x.toFixed(2)}deg) rotateY(${tilt.y.toFixed(2)}deg)`
      }
      if (needleRef.current) {
        needleRef.current.style.transform = `rotate(${(needle - 30).toFixed(2)}deg)`
      }
      // Tile contents shift against the tilt, which is what gives the tiles thickness.
      for (const el of parallaxRefs.current) {
        if (el) el.style.transform = `translate(${(-tilt.y * 0.15).toFixed(2)}px, ${(tilt.x * 0.15).toFixed(2)}px)`
      }
      if (rootRef.current) {
        rootRef.current.style.left = `${pos.x.toFixed(1)}px`
        rootRef.current.style.top = `${pos.y.toFixed(1)}px`
      }
      raf = requestAnimationFrame(tick)
    }

    window.addEventListener('mousemove', onMove)
    raf = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(raf)
    }
  }, [mounted, at, reducedMotion])

  // Render while mounted, not while open — the gap between the two is the exit.
  if (!mounted) return null

  const ringBox = (RING_RADIUS + 24) * 2
  const settled = revealed >= count

  return (
    <div
      ref={rootRef}
      className={`dial${closing ? ' is-closing' : ''}`}
      style={{ left: at.x, top: at.y }}
      // The dial is summoned by a right-click; don't let a second one stack another.
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={tiltRef} className="dial__tilt">
        {/* Static outer ring, plus a needle that swings to point at the cursor. */}
        <div
          className="dial__rings"
          style={{ left: -(RING_RADIUS + 24), top: -(RING_RADIUS + 24), width: ringBox, height: ringBox }}
        >
          <svg width={ringBox} height={ringBox} aria-hidden>
            <circle
              cx={RING_RADIUS + 24}
              cy={RING_RADIUS + 24}
              r={RING_RADIUS + 16}
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
          </svg>
          <svg ref={needleRef} className="dial__needle" width={ringBox} height={ringBox} aria-hidden>
            <path
              d={`M ${RING_RADIUS + 24 + RING_RADIUS + 16} ${RING_RADIUS + 24}
                  A ${RING_RADIUS + 16} ${RING_RADIUS + 16} 0 0 1
                  ${RING_RADIUS + 24 + Math.cos(Math.PI / 3) * (RING_RADIUS + 16)}
                  ${RING_RADIUS + 24 + Math.sin(Math.PI / 3) * (RING_RADIUS + 16)}`}
              fill="none"
              stroke="rgba(247,48,111,0.55)"
              strokeWidth={2}
              strokeLinecap="round"
            />
          </svg>
        </div>

        {/*
          The centre disc is the exit.
          Cancelling by returning to the middle is the radial-menu idiom — you are already
          heading back through it after rejecting a tile — and it means the gesture has a
          target rather than relying on Escape or a click into empty canvas, neither of
          which is visible. Hovering swaps the page name for an ✕ and CLOSE so the
          affordance announces itself instead of having to be guessed at.
          Flat, not glass — see the note at the top of this file.
        */}
        <button
          type="button"
          className="dial__hub"
          aria-label="Close tools"
          title="Close  Esc"
          onMouseEnter={() => {
            setHubHot(true)
            sfx.play(0.015, 1.05)
          }}
          onMouseLeave={() => setHubHot(false)}
          onClick={(e) => {
            e.stopPropagation()
            sfx.play(0.03, 0.7)
            onClose()
          }}
        />

        {/* Page name and the segment ring that indexes the pages. Pointer-transparent so
            the hub button underneath stays clickable through it. */}
        <div className="dial__label" style={{ opacity: closing ? 0 : settled ? 1 : 0 }}>
          {/* Reuses the project's existing scramble rather than shipping a second
              implementation of one. The reference lerps the colour from blue to white
              across the same window; that's done here in CSS off the remount instead
              (`dial-page-flash`), so no JS is duplicated to get it. `key` forces the
              scramble to re-run even if two pages ever share a name. */}
          {hubHot ? (
            <span className="dial__page-name is-exit">
              <span className="dial__exit-glyph">{Glyphs.close}</span>
              <span className="pixel-square">CLOSE</span>
            </span>
          ) : (
            <span className="pixel-square dial__page-name">
              <ScrambleText
                key={spinKey}
                text={PAGES[page].name.toUpperCase()}
                scrambleSpeed={28}
                maxIterations={3}
              />
            </span>
          )}
          <svg className="dial__pages" width={110} height={110} aria-hidden>
            {PAGES.map((_, i) => {
              const seg = 360 / PAGES.length
              const gap = PAGES.length > 2 ? 12 : 20
              const a0 = ((-90 + i * seg + gap / 2) * Math.PI) / 180
              const a1 = ((-90 + (i + 1) * seg - gap / 2) * Math.PI) / 180
              const r = 48
              const large = seg - gap > 180 ? 1 : 0
              return (
                <path
                  key={i}
                  d={`M ${55 + r * Math.cos(a0)} ${55 + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${55 + r * Math.cos(a1)} ${55 + r * Math.sin(a1)}`}
                  fill="none"
                  stroke={i === page ? 'rgba(247,48,111,0.75)' : 'rgba(255,255,255,0.12)'}
                  strokeWidth={3}
                  strokeLinecap="round"
                />
              )
            })}
          </svg>
        </div>

        {items.map((tool, i) => {
          const disabled = !!tool.why
          const isHovered = hovered === tool.id
          const isOn =
            tool.id === 'select' || tool.id === 'pan' || tool.id === 'drawFlow'
              ? activeTool === tool.id
              : !!toggles[tool.id]
          const live = i < revealed

          return (
            <motion.div
              key={tool.id}
              className={`dial__seat${disabled ? ' is-disabled' : ''}${isOn ? ' is-on' : ''}`}
              style={{
                width: ITEM_SIZE,
                height: ITEM_SIZE,
                // The seat's box is centred on the ring origin; the animated x/y then
                // carry it out to its place — a tile blooms from the middle.
                marginLeft: -ITEM_SIZE / 2,
                marginTop: -ITEM_SIZE / 2,
                pointerEvents: live && !disabled ? 'auto' : 'none',
              }}
              initial={
                reducedMotion
                  ? { ...seatOf(i, count), scale: 1, opacity: 1 }
                  : { x: 0, y: 0, scale: 0, opacity: 0 }
              }
              animate={(() => {
                if (closing) return { x: 0, y: 0, scale: 0, opacity: 0 }
                const seat = seatOf(i, count)
                if (live)
                  return {
                    x: seat.x,
                    y: seat.y,
                    scale: hovered === tool.id ? 1.08 : 1,
                    opacity: 1,
                  }
                // Unrevealed: staged at the centre on first open, or a third of a turn
                // back around the ring on a page change — a page turn reads as the ring
                // spinning rather than as everything blinking.
                const staging = spinKey === 0 ? { x: 0, y: 0 } : seatOf(i, count, direction * 60)
                return { ...staging, scale: spinKey === 0 ? 0 : 0.6, opacity: 0 }
              })()}
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : closing
                    ? {
                        type: 'spring',
                        stiffness: 520,
                        damping: 26,
                        // Retract in reverse reveal order — the ring unwinds the way it
                        // wound up rather than collapsing all at once.
                        delay: ((count - 1 - i) * EXIT_STEP) / 1000,
                      }
                    : spinKey === 0
                      ? { type: 'spring', stiffness: 600, damping: 28 }
                      : { type: 'spring', stiffness: 350, damping: 22, delay: (i * 15) / 1000 }
              }
              onAnimationComplete={() => {
                // The i=0 tile carries the longest exit delay, so its completion is the
                // whole ring's.
                if (closing && i === 0) finishExit.current?.()
              }}
              onMouseEnter={() => {
                if (disabled) return
                setHovered(tool.id)
                sfx.play(0.015, 1.2)
              }}
              onMouseLeave={() => setHovered(null)}
              onClick={(e) => {
                e.stopPropagation()
                if (disabled) return
                sfx.playRandomized(0.04, 0.85, 0.1)
                onSelect(tool.id)
                onClose()
              }}
              title={disabled ? `${tool.label} — ${tool.why}` : tool.hint ? `${tool.label}  ${tool.hint}` : tool.label}
              aria-label={tool.label}
            >
              <span className="dial__face" aria-hidden />
              <div className="dial__content" ref={(el) => { parallaxRefs.current[i] = el }}>
                <span className="dial__glyph">{tool.glyph}</span>
                <span className="dial__caption">{tool.short ?? tool.label}</span>
              </div>
              {isHovered && !disabled && <span className="dial__hover-ring" aria-hidden />}
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
