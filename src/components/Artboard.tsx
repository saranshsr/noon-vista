import { useState } from 'react'
import type { CSSProperties } from 'react'

type ArtboardProps = {
  /** Screenshot rendered inside the phone frame. */
  src: string
  /** Caption shown above the frame. */
  label: string
  /**
   * In-focus artboards get a pink highlight ring and a full-opacity image;
   * out-of-focus ones dim to 0.2 with a 50% label. (Figma 14:9227)
   */
  focused?: boolean
  /**
   * Pointer is over the card.
   *
   * Previously the primary object in the entire app had no hover feedback at all —
   * just `cursor: grab` — so nothing signalled a board was interactive until you'd
   * already grabbed it. Hover sits deliberately between the resting and focused
   * states: it lifts the image out of the 0.2 dim and adds a white hairline ring,
   * but leaves the pink ring exclusively to the focused board so "hovered" is never
   * mistaken for "selected".
   */
  hovered?: boolean
  /**
   * In the multi-selection (the edit target). Gets a solid pink ring, distinct from the
   * focused board's translucent one. Drawn here, in world units, rather than as a fixed
   * CSS `box-shadow` on `.is-selected` — a fixed 1.5px lives inside the zoom-scaled world
   * layer, so it shrank to sub-pixel when zoomed out and multi-select looked like nothing
   * happened except on the one focused board.
   */
  selected?: boolean
  /** Card width in world px — every other dimension scales from this. */
  width?: number
  /** First-fold boards load eagerly so the boot's decode gate can't hang in a
      background tab (lazy images never start without intersection updates). */
  eager?: boolean
}

// Ratios captured 1:1 from Figma "Atlas Screen" (node 14:9227), base width 200.
const ASPECT = 433.33 / 200 // phone frame height ÷ width
const RADIUS = 13.333 / 200 // frame corner radius
const RING = 8.333 / 200 // in-focus highlight ring thickness
const GAP = 16 / 200 // label → frame gap
const LABEL = 16 / 200 // label font size
const FOCUS_PINK = 'rgba(247, 48, 111, 0.4)'
const SELECT_PINK = 'rgba(247, 48, 111, 0.95)' // solid — the edit target, louder than focus
const HOVER_RING = 'rgba(255, 255, 255, 0.14)'

/**
 * A phone "artboard" that sits on the atlas canvas as a card: a labelled
 * screenshot in a rounded black frame. Built 1:1 from the Figma component set.
 */
export function Artboard({
  src,
  label,
  focused = false,
  hovered = false,
  selected = false,
  width = 200,
  eager = false,
}: ArtboardProps) {
  const [retried, setRetried] = useState(false)
  const [failed, setFailed] = useState(false)
  // Priority: a selected board shows the solid edit-target ring even when it's also the
  // focused (last-added) one, so a multi-selection reads as a set rather than one board.
  const glowSpread = width * 0.18
  const ring = selected
    ? `0 0 0 ${width * RING * 0.7}px ${SELECT_PINK}, 0 0 ${glowSpread}px ${glowSpread * 0.4}px rgba(247, 48, 111, 0.25)`
    : focused
      ? `0 0 0 ${width * RING}px ${FOCUS_PINK}`
      : hovered
        ? `0 0 0 ${Math.max(1, width * 0.005)}px ${HOVER_RING}`
        : 'none'

  return (
    <div style={{ width, display: 'flex', flexDirection: 'column', gap: width * GAP }}>
      <span
        className="pixel atlas-board__label"
        style={
          {
            // Base (100%-zoom) size. The stylesheet grows this as you zoom out, via
            // the world layer's --canvas-scale, so labels stay readable instead of
            // shrinking into illegibility — which is what made a zoomed-out atlas a
            // field of anonymous grey rectangles.
            '--label-size': `${width * LABEL}px`,
            lineHeight: 1.2,
            textAlign: 'center',
            whiteSpace: 'nowrap',
            color: focused || hovered ? '#FFFFFF' : 'rgba(255, 255, 255, 0.62)',
          } as CSSProperties
        }
      >
        {label}
      </span>
      <div
        className={`atlas-board__frame${failed ? ' is-image-failed' : ''}`}
        style={{
          height: width * ASPECT,
          borderRadius: width * RADIUS,
          background: '#000000',
          overflow: 'hidden',
          boxShadow: ring,
        }}
      >
        <img
          src={failed ? undefined : retried ? `${src}?retry=1` : src}
          alt={label}
          draggable={false}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          /* One cache-busted retry, then give up legibly. A transient dev-server or
             CDN hiccup used to leave a permanently black frame with no way to tell a
             failed image from a dark screenshot. */
          onError={() => (retried ? setFailed(true) : setRetried(true))}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            // 0.3 at rest → 0.55 on hover → 1 when focused. Three legible steps.
            // Rest was 0.2, which made an unfocused board almost pure black and the
            // zoomed-out atlas an undifferentiated field of grey rectangles.
            opacity: focused ? 1 : hovered ? 0.55 : 0.3,
          }}
        />
      </div>
    </div>
  )
}
