/**
 * Board and connector geometry — the pure maths behind the atlas canvas,
 * extracted from `AtlasBoards.tsx` so it can be unit-tested and reused by the
 * minimap, fit-to-content and export paths without dragging a component along.
 *
 * Every constant and formula here is byte-identical to the pre-refactor version;
 * the ratios come 1:1 from the Figma card component (node 14:9227).
 */

import type { Box, Vec } from '../domain/types'

/** Card width in world px — every other dimension derives from this. */
export const CARD_W = 200

/** Label line box ≈ 19.2 */
export const LABEL_H = CARD_W * (16 / 200) * 1.2
/** Label → frame gap = 16 */
export const GAP = CARD_W * (16 / 200)
/** Phone frame height ≈ 433.33 */
export const FRAME_H = CARD_W * (433.33 / 200)

export const CONNECTOR_COLOR = 'rgba(255, 255, 255, 0.35)'

/** The screenshot-frame box of a board in world coordinates (the arrow anchor). */
export function frameBox(p: Vec): Box {
  return { x: p.x, y: p.y + LABEL_H + GAP, w: CARD_W, h: FRAME_H }
}

/**
 * Gap between a frame edge and where its connector actually begins.
 *
 * Without it the line runs into the artboard and the arrowhead is half-buried in the
 * frame, which reads as unfinished — as if the drawing were clipped rather than
 * designed. Holding the curve off the board and marking the attachment with a tick on
 * the edge makes the connection read as docked into a port.
 */
/**
 * Socket geometry — a lead off the frame edge into a square pad.
 *
 * Rings were the wrong shape for this product. Nothing else in it is circular: the
 * background is a plus-grid, the typeface is pixel, the hover marks are square corner
 * brackets, every hairline is 1px and straight. A hollow circle filled with opaque
 * black, straddling the board's own pink focus ring, read as a sticker rather than a
 * connector — and the soft halo behind it read as a smudge.
 *
 * A short lead out of the edge into a small square pad is the same vocabulary as a
 * component pin on a board: rectilinear, hairline, and unmistakably *attached*. The pad
 * sits entirely outside the frame so it never muddies the focus ring, and "active" is a
 * solid fill rather than a blur — a crisp binary instead of a glow.
 */
/** Length of the lead from the frame edge to the pad. */
export const PORT_LEAD = 7
/** Half-width of the square pad. */
export const PORT_PAD = 3.4
/** Distance from the frame edge to where the curve begins (pad's outer face). */
export const PORT_STANDOFF = PORT_LEAD + PORT_PAD * 2
/**
 * Length of the shared trunk: the straight run every connector makes, perpendicular to
 * the edge, before it is allowed to curve.
 *
 * This is what makes the bundling real rather than approximate. Because sockets are no
 * longer spread along the edge, every flow leaving a board in a given direction starts at
 * the *same* point and runs the *same* distance along the *same* normal — so the stems
 * coincide exactly and ten flows out of the homepage draw as one stem with a fan at the
 * end of it. The previous version only used this as a floor on the bezier handle length,
 * which made the runs merely parallel-ish; they still separated from the first pixel.
 */
export const PORT_TRUNK = 46

export interface ConnectorGeometry {
  /** SVG path data for the curve, from standoff point to standoff point. */
  d: string
  /** Where the curve starts — held off the source frame by PORT_STANDOFF. */
  tail: Vec
  /** Where the curve ends — held off the target frame, arrowhead sits here. */
  tip: Vec
  /** Arrowhead rotation in degrees. */
  deg: number
  /** Source socket: edge anchor, lead end, and the outward normal. */
  portFrom: { edge: Vec; pad: Vec; n: Vec }
  /** Target socket: edge anchor, lead end, and the outward normal. */
  portTo: { edge: Vec; pad: Vec; n: Vec }
}

/*
 * There is deliberately no `PortSlot` / `spreadAlongEdge` here any more.
 *
 * Sockets used to be fanned along each frame edge so every connector had its own
 * attachment point. It did reduce crossings, but it made each board look like a
 * pin-header — a dozen pads at irregular spacings, none of them landing on the edge's
 * midpoint — and the boards read as busier than the graph actually is. One socket per
 * direction is cleaner, and with the shared trunk below it costs nothing in legibility:
 * co-directional flows now overlap *exactly* for the length of the trunk, which reads as
 * a single cable, rather than as several near-parallel lines at slightly wrong angles.
 */

/**
 * A connector between two frame boxes: out of S's facing edge, along a shared trunk,
 * curving across, then along T's trunk and into T's edge.
 *
 * The trunk segments are what bundle the graph. Both ends leave and arrive perpendicular
 * for a fixed `PORT_TRUNK`, so every flow sharing a direction out of a board traces the
 * identical stem before diverging — the ten-way fan-out from the homepage draws as one
 * cable that splits, instead of ten curves that separate immediately and cross.
 *
 * Known limitation, unchanged: the facing edge is chosen by a plain `|dx| vs |dy|`
 * compare, so a curve can still pass over an intervening board. That needs a collision
 * check against the other frames, which is a routing problem rather than a bundling one.
 */
export function connectorPath(s: Box, t: Box): ConnectorGeometry {
  const sc = { x: s.x + s.w / 2, y: s.y + s.h / 2 }
  const tc = { x: t.x + t.w / 2, y: t.y + t.h / 2 }
  const dx = tc.x - sc.x
  const dy = tc.y - sc.y

  let a: Vec // start anchor (edge midpoint of S)
  let an: Vec // outward normal at S
  let b: Vec // end anchor (edge midpoint of T)
  let bn: Vec // outward normal at T
  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal: use left/right edges.
    const right = dx >= 0
    a = { x: right ? s.x + s.w : s.x, y: sc.y }
    an = { x: right ? 1 : -1, y: 0 }
    b = { x: right ? t.x : t.x + t.w, y: tc.y }
    bn = { x: right ? -1 : 1, y: 0 }
  } else {
    // Vertical: use top/bottom edges.
    const down = dy >= 0
    a = { x: sc.x, y: down ? s.y + s.h : s.y }
    an = { x: 0, y: down ? 1 : -1 }
    b = { x: tc.x, y: down ? t.y : t.y + t.h }
    bn = { x: 0, y: down ? -1 : 1 }
  }

  // Hold both ends off their frames along the outward normal, so the curve floats in
  // front of the board rather than colliding with it.
  const aOut = { x: a.x + an.x * PORT_STANDOFF, y: a.y + an.y * PORT_STANDOFF }
  const bOut = { x: b.x + bn.x * PORT_STANDOFF, y: b.y + bn.y * PORT_STANDOFF }

  // The bundle: a straight, shared run perpendicular to each edge. Identical for every
  // flow leaving the same board in the same direction, so their stems coincide exactly.
  const aTrunk = { x: aOut.x + an.x * PORT_TRUNK, y: aOut.y + an.y * PORT_TRUNK }
  const bTrunk = { x: bOut.x + bn.x * PORT_TRUNK, y: bOut.y + bn.y * PORT_TRUNK }

  // Handles are measured between the trunk ends, not the pads — using the full span would
  // double-count the trunk and overshoot, kinking the join where the straight meets the
  // curve. Scaled well under half so the curve stays taut at long distances.
  const span = Math.hypot(bTrunk.x - aTrunk.x, bTrunk.y - aTrunk.y)
  const h = Math.max(12, span * 0.42)
  const c1 = { x: aTrunk.x + an.x * h, y: aTrunk.y + an.y * h }
  const c2 = { x: bTrunk.x + bn.x * h, y: bTrunk.y + bn.y * h }

  // Arrowhead points into T along -bn (perpendicular to the edge).
  const deg = (Math.atan2(-bn.y, -bn.x) * 180) / Math.PI

  return {
    d:
      `M ${aOut.x} ${aOut.y} L ${aTrunk.x} ${aTrunk.y} ` +
      `C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${bTrunk.x} ${bTrunk.y} ` +
      `L ${bOut.x} ${bOut.y}`,
    tail: aOut,
    tip: bOut,
    deg,
    portFrom: { edge: a, pad: { x: a.x + an.x * PORT_LEAD, y: a.y + an.y * PORT_LEAD }, n: an },
    portTo: { edge: b, pad: { x: b.x + bn.x * PORT_LEAD, y: b.y + bn.y * PORT_LEAD }, n: bn },
  }
}

/*
 * There is deliberately no `atlasInitialViewport(vw, vh, rect)` here any more.
 *
 * Deriving the opening camera from a window size measured by a *parent* component
 * is a trap: on first paint that height can still be 0, the scale then clamps to
 * MIN_SCALE, and because `useViewport` freezes its initial value at mount the camera
 * stays stranded at 10% zoom with the entry screen off-screen and nothing thrown.
 * `InfiniteCanvas`'s `initialFocus` prop measures the canvas element itself instead,
 * which cannot fail that way. Pass a world-space rect, not a computed viewport.
 */

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'
export type DistributeAxis = 'h' | 'v'

/**
 * New positions that align a set of boards to a shared edge or centre.
 *
 * Aligns against the *frame* box, not the label-inclusive top-left: a designer lining up
 * "left edges" means the phone frames, not an invisible caption band above them. Returns
 * only the boards that actually move, so the caller records one clean edit.
 *
 * `position` is the card's top-left (label + frame); `frameBox` adds the label offset. We
 * solve in frame space, then subtract that offset back out to get the position to store.
 */
export function alignPositions(
  items: { id: string; position: Vec }[],
  edge: AlignEdge,
): { id: string; position: Vec }[] {
  if (items.length < 2) return []
  const boxes = items.map((it) => ({ it, fb: frameBox(it.position) }))
  const minX = Math.min(...boxes.map((b) => b.fb.x))
  const maxX = Math.max(...boxes.map((b) => b.fb.x + b.fb.w))
  const minY = Math.min(...boxes.map((b) => b.fb.y))
  const maxY = Math.max(...boxes.map((b) => b.fb.y + b.fb.h))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2

  const out: { id: string; position: Vec }[] = []
  for (const { it, fb } of boxes) {
    let fx = fb.x
    let fy = fb.y
    switch (edge) {
      case 'left': fx = minX; break
      case 'right': fx = maxX - fb.w; break
      case 'hcenter': fx = cx - fb.w / 2; break
      case 'top': fy = minY; break
      case 'bottom': fy = maxY - fb.h; break
      case 'vcenter': fy = cy - fb.h / 2; break
    }
    // Convert the target frame corner back to the card's stored top-left.
    const next = { x: it.position.x + (fx - fb.x), y: it.position.y + (fy - fb.y) }
    if (next.x !== it.position.x || next.y !== it.position.y) out.push({ id: it.id, position: next })
  }
  return out
}

/**
 * New positions that space boards evenly along one axis, keeping the two extremes fixed
 * and equalising the *gaps* between frames (not centre-to-centre, which looks uneven when
 * boards differ in size). Needs at least three to mean anything.
 */
export function distributePositions(
  items: { id: string; position: Vec }[],
  axis: DistributeAxis,
): { id: string; position: Vec }[] {
  if (items.length < 3) return []
  const boxes = items.map((it) => ({ it, fb: frameBox(it.position) }))
  const size = (b: (typeof boxes)[number]) => (axis === 'h' ? b.fb.w : b.fb.h)
  const start = (b: (typeof boxes)[number]) => (axis === 'h' ? b.fb.x : b.fb.y)
  const sorted = [...boxes].sort((a, b) => start(a) - start(b))

  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = start(last) - (start(first) + size(first))
  const totalInner = sorted.slice(1, -1).reduce((sum, b) => sum + size(b), 0)
  const gap = (span - totalInner) / (sorted.length - 1)

  const out: { id: string; position: Vec }[] = []
  let cursor = start(first) + size(first) + gap
  for (const b of sorted.slice(1, -1)) {
    const targetStart = cursor
    const delta = targetStart - start(b)
    if (delta !== 0) {
      const next =
        axis === 'h'
          ? { x: b.it.position.x + delta, y: b.it.position.y }
          : { x: b.it.position.x, y: b.it.position.y + delta }
      out.push({ id: b.it.id, position: next })
    }
    cursor += size(b) + gap
  }
  return out
}

/** A live alignment guide: a world-space line the dragged board snapped to. */
export type AlignGuide = { axis: 'x' | 'y'; at: number; from: number; to: number }

/**
 * Snap a dragging board's position to its neighbours' edges/centres, and report the guide
 * lines to draw — the Figma "smart guide" behaviour.
 *
 * Compares the dragged frame's three vertical lines (left / centre-x / right) against every
 * other frame's three, and likewise horizontally, snapping each axis independently to the
 * nearest match within `tolerance` (a world distance; callers pass screen-px ÷ zoom so it
 * feels constant). Returns the adjusted top-left plus one guide per snapped axis, each
 * spanning both involved frames so the line visibly connects them.
 */
export function resolveAlign(
  draggedPos: Vec,
  others: { position: Vec }[],
  tolerance: number,
): { position: Vec; guides: AlignGuide[] } {
  const fb = frameBox(draggedPos)
  const vLines = [fb.x, fb.x + fb.w / 2, fb.x + fb.w] // left, cx, right
  const hLines = [fb.y, fb.y + fb.h / 2, fb.y + fb.h] // top, cy, bottom

  let bestX: { delta: number; at: number; other: Box; line: number } | null = null
  let bestY: { delta: number; at: number; other: Box; line: number } | null = null

  for (const o of others) {
    const ob = frameBox(o.position)
    const oV = [ob.x, ob.x + ob.w / 2, ob.x + ob.w]
    const oH = [ob.y, ob.y + ob.h / 2, ob.y + ob.h]
    for (const line of vLines) {
      for (const ol of oV) {
        const d = Math.abs(line - ol)
        if (d <= tolerance && (!bestX || d < bestX.delta))
          bestX = { delta: d, at: ol, other: ob, line }
      }
    }
    for (const line of hLines) {
      for (const ol of oH) {
        const d = Math.abs(line - ol)
        if (d <= tolerance && (!bestY || d < bestY.delta))
          bestY = { delta: d, at: ol, other: ob, line }
      }
    }
  }

  const position = { ...draggedPos }
  const guides: AlignGuide[] = []
  if (bestX) {
    position.x += bestX.at - bestX.line // shift so the matched line lands exactly
    const snapped = frameBox(position)
    guides.push({
      axis: 'x',
      at: bestX.at,
      from: Math.min(snapped.y, bestX.other.y),
      to: Math.max(snapped.y + snapped.h, bestX.other.y + bestX.other.h),
    })
  }
  if (bestY) {
    position.y += bestY.at - bestY.line
    const snapped = frameBox(position)
    guides.push({
      axis: 'y',
      at: bestY.at,
      from: Math.min(snapped.x, bestY.other.x),
      to: Math.max(snapped.x + snapped.w, bestY.other.x + bestY.other.w),
    })
  }
  return { position, guides }
}

/** The bounding box of every board's frame — fit-to-content / minimap extents. */
export function boardsBounds(positions: Vec[]): Box | null {
  if (!positions.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of positions) {
    const fb = frameBox(p)
    minX = Math.min(minX, fb.x)
    minY = Math.min(minY, p.y) // include the label above the frame
    maxX = Math.max(maxX, fb.x + fb.w)
    maxY = Math.max(maxY, fb.y + fb.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Full card height: label line, gap, then the phone frame. */
export const CARD_H = LABEL_H + GAP + FRAME_H

/** Clearance kept between settled cards, in world px. Cards never touch, let alone stack. */
const SETTLE_GAP = 16

/**
 * Where a released card (or rigid group of cards) may actually come to rest.
 *
 * Cards are allowed to pass OVER each other freely mid-gesture — blocking during the
 * drag would fight the throw physics and make group drags unpredictable — but they are
 * never allowed to SETTLE overlapping. On release, this computes the smallest nudge
 * that separates the moving card(s) from everything static, and the caller commits the
 * nudged position instead of the raw one.
 *
 * Mechanics: iterative minimum-translation. Each pass finds the deepest remaining
 * overlap (by area) between a moving card and a static one, and pushes the whole
 * moving set along the shallower axis of that pair — whichever direction moves the
 * centres apart. Pushing the *set* by one shared delta is what keeps a multi-selected
 * arrangement rigid; members were separated before the drag, and one shared delta
 * can't fold them onto each other. The loop re-checks after every push because a
 * nudge can create a new overlap with a neighbour; 24 passes is far beyond what a
 * dense wall of cards needs to open a slot.
 *
 * `quantum` (the grid pitch, when snap is on) rounds every push UP to a grid multiple,
 * so a resolved card still sits on the lattice the user asked for. Rounding up rather
 * than to-nearest, because rounding a push down can leave the overlap it was meant to
 * clear.
 *
 * Returns the DELTA to add to every moving position — {0,0} means the release was
 * already clean.
 */
export function resolveOverlap(moving: Vec[], statics: Vec[], quantum = 0): Vec {
  const g = SETTLE_GAP
  let dx = 0
  let dy = 0

  const roundUp = (v: number) =>
    quantum > 0 ? Math.sign(v) * Math.ceil(Math.abs(v) / quantum) * quantum : v

  for (let pass = 0; pass < 24; pass++) {
    let bestArea = 0
    let push: Vec | null = null

    for (const m of moving) {
      const mx = m.x + dx
      const my = m.y + dy
      for (const s of statics) {
        // Overlap of the two cards, with the static one grown by the clearance gap.
        const ox = Math.min(mx + CARD_W, s.x + CARD_W + g) - Math.max(mx, s.x - g)
        const oy = Math.min(my + CARD_H, s.y + CARD_H + g) - Math.max(my, s.y - g)
        if (ox <= 0 || oy <= 0) continue
        const area = ox * oy
        if (area <= bestArea) continue
        bestArea = area
        // Push along the shallower axis, away from the static card's centre. Dead
        // centre (a card dropped exactly on top) breaks the tie rightward/downward.
        if (ox <= oy) {
          const dir = mx + CARD_W / 2 >= s.x + CARD_W / 2 ? 1 : -1
          push = { x: roundUp(dir * ox), y: 0 }
        } else {
          const dir = my + CARD_H / 2 >= s.y + CARD_H / 2 ? 1 : -1
          push = { x: 0, y: roundUp(dir * oy) }
        }
      }
    }

    if (!push) break
    dx += push.x
    dy += push.y
  }

  return { x: dx, y: dy }
}
