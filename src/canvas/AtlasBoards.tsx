import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { CanvasSection } from './CanvasSection'
import { useCanvas } from './CanvasContext'
import { Artboard } from '../components'
import { CARD_W, FRAME_H, GAP, LABEL_H, connectorPath, frameBox, resolveAlign, resolveOverlap } from './boardGeometry'
import type { AlignGuide } from './boardGeometry'
import { GRID_UNIT } from './crossGrid'
import { gridField } from './gridField'
import { PHYSICS, clampVelocity, scaledPhysics, startFlight, tiltFromVelocity, velocityFromSamples } from './boardPhysics'
import type { Sample } from './boardPhysics'
import { sfx } from '../utils/sfx'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { AtlasConnectors } from './AtlasConnectors'
import type { FlowWeight } from './AtlasConnectors'
import type { Flow, FlowId, Screen, ScreenId, Vec } from '../domain/types'

/**
 * The noon Atlas — screens and flows laid out on the infinite plane.
 *
 * A pure view: the graph arrives as props from the data layer instead of being
 * hardcoded here, and board positions live in the atlas snapshot rather than local
 * state. What's left is rendering and gestures.
 *
 * Boards are draggable and tappable:
 *  · drag  → move a board anywhere; its connectors re-shape to follow.
 *  · tap   → that board becomes the focused variant and the camera pans/zooms
 *            so it sits centred at 60% of the viewport height.
 *
 * Connectors live in `AtlasConnectors`, which is split out because it re-renders on
 * zoom (screen-constant hit areas) while these memoised boards must not.
 */

type AtlasBoardsProps = {
  screens: Screen[]
  flows: Flow[]
  /** id of the currently focused screen (controlled by the page). */
  focusedId: ScreenId
  /** The entry screen — the camera target after a layout reset. */
  rootScreenId: ScreenId
  /**
   * A board was tapped. `additive` = Shift was held.
   *
   * Reports intent only — the page owns the selection rule and decides what happens to
   * `focusedId` and the camera. Replaced a pair of callbacks (`onFocus` on a plain tap,
   * plus a locally-merged selection change) that could disagree about what was selected.
   */
  onSelect: (id: ScreenId, additive: boolean) => void
  /** Double-click a board — selects it and asks the page to open its name for editing. */
  onRenameRequest?: (id: ScreenId) => void
  /**
   * Drag lifecycle, split deliberately. `onScreenDrag` fires on every pointermove
   * (~60/s) and must stay local; only `onScreenDragEnd` is allowed to persist.
   * The names are the guardrail: wiring a repository write to `onScreenDrag`
   * should read as obviously wrong to the next person.
   */
  onScreenDragStart?: (id: ScreenId) => void
  onScreenDrag: (id: ScreenId, position: Vec) => void
  onScreenDragEnd: (id: ScreenId, position: Vec) => void
  /** Bumped when positions changed externally (a reset) → re-frame the root. */
  layoutRev?: number
  /**
   * Bumped on every focus request, even one that re-selects the current screen.
   *
   * Without this, clicking the breadcrumb for the screen you're already on did
   * nothing at all: the camera effect keys on `focusedId`, and re-selecting the
   * same id doesn't change it, so the effect never re-ran. You could pan away and
   * then find the crumb for the current screen was the one crumb that couldn't
   * bring you back.
   */
  focusNonce?: number
  /**
   * Snap dragged boards to the grid the canvas already draws.
   *
   * `GRID_UNIT` has been exported from `crossGrid` and unused all along, so boards
   * could land a pixel off a line the user can literally see behind them.
   */
  snapToGrid?: boolean
  /** Screens to de-emphasise (focus isolation). Empty means show everything. */
  isolatedIds?: ReadonlySet<ScreenId> | null
  /**
   * When false, boards ignore pointer-down entirely so the drag falls through to the
   * canvas and pans it. This is what makes the Pan tool mean something — it was a lit
   * button with no effect, since dragging a board always moved it regardless.
   */
  boardsDraggable?: boolean
  /** Currently selected boards. Multi-select is additive with shift. */
  selectedIds?: ReadonlySet<ScreenId>
  onSelectionChange?: (ids: Set<ScreenId>) => void
  /** Move every selected board by one delta — a group drag. */
  onGroupDrag?: (delta: Vec) => void
  onGroupDragEnd?: () => void
  /** Per-flow metrics, for connector width and drop-off tint. */
  flowWeights?: Map<FlowId, FlowWeight>
  selectedFlowId?: FlowId | null
  onSelectFlow?: (id: FlowId | null) => void
  onHoverFlow?: (id: FlowId | null, at?: { x: number; y: number }) => void
  /**
   * Draw-flow tool active. Boards stop dragging and instead become flow sources: a
   * pointer-down starts a rubber-band, and releasing over another board creates the edge.
   */
  drawFlowMode?: boolean
  onCreateFlow?: (from: ScreenId, to: ScreenId) => void
  /** Re-point one end of an existing flow (dragging a selected edge's handle). */
  onReconnectFlow?: (id: FlowId, patch: { from?: ScreenId; to?: ScreenId }) => void
}

export function AtlasBoards({
  screens,
  flows,
  focusedId,
  rootScreenId,
  onSelect,
  onRenameRequest,
  onScreenDragStart,
  onScreenDrag,
  onScreenDragEnd,
  layoutRev = 0,
  focusNonce = 0,
  snapToGrid = false,
  isolatedIds = null,
  boardsDraggable = true,
  selectedIds,
  onSelectionChange,
  onGroupDrag,
  onGroupDragEnd,
  flowWeights,
  selectedFlowId = null,
  onSelectFlow,
  onHoverFlow,
  drawFlowMode = false,
  onCreateFlow,
  onReconnectFlow,
}: AtlasBoardsProps) {
  const { focusRect, screenToWorld, getScale } = useCanvas()
  const [hoveredFlowId, setHoveredFlowId] = useState<FlowId | null>(null)

  /**
   * Publish every board's frame to the grid field, so the mesh behind them bends around
   * their silhouettes.
   *
   * This effect runs on render, which during a drag *or* a momentum flight is the local
   * optimistic position — both paths report through `onScreenDrag`, so the mesh follows
   * the board continuously without needing a second channel.
   */
  useEffect(() => {
    gridField.replaceRects(
      screens.map((s) => {
        const box = frameBox(s.position)
        return [s.id, { x: box.x, y: box.y, w: box.w, h: box.h }] as const
      }),
    )
  }, [screens])
  /** Live alignment guides while a single board drags. Cleared on drag end. */
  const [guides, setGuides] = useState<AlignGuide[]>([])

  /**
   * Boards gliding to their de-overlapped resting spot. The class this drives is what
   * turns the post-release nudge from a teleport into a slide; it must be gone again
   * quickly, or the next live drag would fight a lingering transition.
   */
  const [settlingIds, setSettlingIds] = useState<ReadonlySet<ScreenId>>(new Set())
  const settleTimers = useRef(new Map<ScreenId, number>())
  const markSettling = (id: ScreenId) => {
    setSettlingIds((prev) => new Set(prev).add(id))
    const timers = settleTimers.current
    window.clearTimeout(timers.get(id))
    timers.set(
      id,
      window.setTimeout(() => {
        setSettlingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        timers.delete(id)
      }, 450),
    )
  }
  /**
   * Live rubber-band gesture — draw OR reconnect.
   *
   * `anchorId` is the fixed end (source for a fresh draw; the untouched end for a
   * reconnect). `end` says which end is moving, so the preview curve keeps the right
   * direction when the *source* handle is the one being dragged. `flowId` is set only when
   * reconnecting an existing edge.
   */
  type Draft = {
    kind: 'create' | 'reconnect'
    anchorId: ScreenId
    end: 'from' | 'to'
    cursor: Vec
    overId: ScreenId | null
    flowId?: FlowId
  }
  const [draft, setDraft] = useState<Draft | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  /** Live rubber-band rect in world coords while dragging on empty canvas. */
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // O(1) position lookup for the connector layer. A linear `.find` per flow would
  // be O(flows × screens) on every drag frame.
  const byId = useMemo(() => new Map(screens.map((s) => [s.id, s])), [screens])

  const focusRectRef = useRef(focusRect)
  focusRectRef.current = focusRect
  const byIdRef = useRef(byId)
  byIdRef.current = byId

  // Whenever the focused screen changes — from a board tap OR a breadcrumb click
  // — fly the camera to it. Skip the first run: the initial viewport already
  // frames the entry screen.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    const screen = byIdRef.current.get(focusedId)
    // Guard: a focused id can outlive its screen once screens are deletable, and
    // `frameBox(undefined)` throws — which, with no error boundary above, used to
    // mean a white page.
    if (screen) focusRectRef.current(frameBox(screen.position))
  }, [focusedId, focusNonce])

  // Layout reset — re-frame the entry screen. Skip the first run (the initial
  // viewport already did this, and re-framing on mount double-animates).
  const firstLayout = useRef(true)
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false
      return
    }
    const root = byIdRef.current.get(rootScreenId)
    if (root) focusRectRef.current(frameBox(root.position))
  }, [layoutRev, rootScreenId])

  /**
   * Rubber-band selection.
   *
   * Bound on the world layer rather than the canvas root so it only starts on empty
   * plane — a drag that begins on a board is that board's drag, and a marquee that
   * hijacked it would make boards unmovable.
   */
  const onMarqueeDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    // Only the world layer itself, never a descendant (i.e. never a board).
    if (e.target !== e.currentTarget) return
    // A click on empty plane while an edge is armed cancels it, rather than starting a
    // marquee that the draw-flow mode has no use for.
    if (draftRef.current) {
      cancelDraft()
      return
    }
    if (!onSelectionChange) return
    const host = (e.currentTarget as HTMLElement).closest('.atlas-canvas') as HTMLElement | null
    if (!host) return
    const rect = host.getBoundingClientRect()
    const start = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
    const additive = e.shiftKey
    const base = additive && selectedIds ? new Set(selectedIds) : new Set<ScreenId>()
    let moved = false

    const move = (ev: PointerEvent) => {
      const p = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top)
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) * 1 > 3) moved = true
      if (!moved) return
      const box = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      }
      setMarquee(box)
      const hit = new Set(base)
      for (const sc of screens) {
        const fb = frameBox(sc.position)
        // Intersection, not containment — grazing a board should catch it, which is
        // what people expect from a marquee.
        if (
          fb.x < box.x + box.w &&
          fb.x + fb.w > box.x &&
          fb.y < box.y + box.h &&
          fb.y + fb.h > box.y
        ) {
          hit.add(sc.id)
        }
      }
      onSelectionChange(hit)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setMarquee(null)
      // A click on empty plane with no drag clears the selection.
      if (!moved && !additive) onSelectionChange(new Set())
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Tear down the in-progress draw-flow gesture: cursor tracker, key listener, state. */
  const draftCleanup = useRef<(() => void) | null>(null)
  const cancelDraft = () => {
    draftCleanup.current?.()
    draftCleanup.current = null
    setDraft(null)
  }

  /**
   * Draw-flow, as click-to-arm rather than press-drag.
   *
   * A press-drag needs you to hold the button and move before anything appears, so the
   * connector was invisible until you'd already committed to a direction. Now the first
   * click *arms* a source: the rubber-band shows at once and follows the bare cursor, and a
   * second click on another board commits. Clicking the source again, clicking empty plane,
   * or Escape cancels.
   *
   * The preview curve uses the real `connectorPath`, so it docks into the same socket and
   * carries the same trunk the committed edge will — what you preview is what you get.
   */
  /** Begin a draft (create or reconnect) and start tracking the bare cursor + Escape. */
  const beginDraft = (init: Draft, e: ReactPointerEvent) => {
    const host = (e.currentTarget as HTMLElement).closest('.atlas-canvas') as HTMLElement | null
    if (!host) return
    const rect = host.getBoundingClientRect()
    const toWorld = (cx: number, cy: number) => screenToWorld(cx - rect.left, cy - rect.top)
    const hitBoard = (c: Vec): ScreenId | null => {
      for (const sc of screens) {
        if (sc.id === init.anchorId) continue
        const fb = frameBox(sc.position)
        if (c.x >= fb.x && c.x <= fb.x + fb.w && c.y >= fb.y && c.y <= fb.y + fb.h) return sc.id
      }
      return null
    }
    const first = toWorld(e.clientX, e.clientY)
    setDraft({ ...init, cursor: first, overId: hitBoard(first) })
    const move = (ev: PointerEvent) => {
      const c = toWorld(ev.clientX, ev.clientY)
      setDraft({ ...init, cursor: c, overId: hitBoard(c) })
    }
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') cancelDraft()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('keydown', key)
    draftCleanup.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('keydown', key)
    }
  }

  /**
   * A board was clicked in draw-flow mode. First click arms it as the source; a later click
   * on a *different* board commits the edge. Either way the gesture then resets.
   */
  const onFlowClick = (id: ScreenId, e: ReactPointerEvent) => {
    const d = draftRef.current
    if (!d) {
      beginDraft({ kind: 'create', anchorId: id, end: 'to', cursor: { x: 0, y: 0 }, overId: null }, e)
      return
    }
    if (id !== d.anchorId) commitDraft(id)
    cancelDraft()
  }

  /**
   * Grab a selected edge's endpoint handle and drag it to another board to re-point it.
   * Press-drag here (not click-to-arm): you're already pressing on the handle, and the
   * commit is on release over a board.
   */
  const startReconnect = (flowId: FlowId, end: 'from' | 'to', anchorId: ScreenId, e: ReactPointerEvent) => {
    e.stopPropagation()
    beginDraft({ kind: 'reconnect', flowId, end, anchorId, cursor: { x: 0, y: 0 }, overId: null }, e)
    const up = () => {
      window.removeEventListener('pointerup', up)
      const d = draftRef.current
      if (d && d.overId && d.overId !== d.anchorId) commitDraft(d.overId)
      cancelDraft()
    }
    window.addEventListener('pointerup', up)
  }

  /** Commit the current draft onto `targetId` — create a new edge or re-point an existing one. */
  const commitDraft = (targetId: ScreenId) => {
    const d = draftRef.current
    if (!d) return
    if (d.kind === 'create') {
      onCreateFlow?.(d.anchorId, targetId)
    } else if (d.flowId) {
      // The moving end becomes `targetId`; the anchor stays put.
      onReconnectFlow?.(d.flowId, d.end === 'from' ? { from: targetId } : { to: targetId })
    }
  }

  /**
   * Single-board drag, with smart-alignment snapping.
   *
   * Wraps the raw `onScreenDrag`: snaps the dragged frame's edges/centres to neighbours
   * within ~6 screen px (converted to world by the live zoom, so it feels constant), draws
   * a guide per snapped axis, and forwards the adjusted position. Only for a lone board —
   * aligning a whole group to one neighbour is ambiguous, so a group drag skips this and
   * clears any guides.
   */
  const dragWithGuides = (id: ScreenId, pos: Vec) => {
    const others = screens.filter((s) => s.id !== id)
    const { position, guides: g } = resolveAlign(pos, others, 6 / getScale())
    setGuides(g)
    onScreenDrag(id, position)
  }

  return (
    <>
      {/* Full-plane hit layer for the marquee. Sits behind everything and only reacts
          to pointer-downs that land on it directly. */}
      {onSelectionChange && (
        <div className="atlas-marquee-host" onPointerDown={onMarqueeDown} aria-hidden />
      )}

      {marquee && (
        <div
          className="atlas-marquee"
          aria-hidden
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}

      {/* Draw-flow preview. A separate SVG from AtlasConnectors so the ~60/s cursor
          updates don't re-render all the committed edges. Positioned at world origin like
          the connector layer, so path coords are world coords. */}
      {draft && (() => {
        const anchor = byId.get(draft.anchorId)
        if (!anchor) return null
        const over = draft.overId ? byId.get(draft.overId) : null
        // Snap to the target's real frame when hovering one; otherwise a point at the cursor.
        const movingBox = over
          ? frameBox(over.position)
          : { x: draft.cursor.x - 1, y: draft.cursor.y - 1, w: 2, h: 2 }
        const anchorBox = frameBox(anchor.position)
        // Keep the arrow pointing the true direction: if the *source* handle is moving,
        // the drawn edge runs movingBox → anchor; otherwise anchor → movingBox.
        const geo =
          draft.end === 'from'
            ? connectorPath(movingBox, anchorBox)
            : connectorPath(anchorBox, movingBox)
        return (
          <svg
            className="atlas-draft"
            style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
            aria-hidden
          >
            <path
              d={geo.d}
              fill="none"
              stroke="#F7306F"
              strokeWidth={2}
              strokeDasharray="6 5"
              className={over ? 'atlas-draft__line is-target' : 'atlas-draft__line'}
            />
          </svg>
        )
      })()}

      {/* Smart-alignment guides while dragging. World-space, so the coords are world
          coords; screen-constant thickness comes from dividing by zoom. */}
      {guides.length > 0 && (
        <svg
          className="atlas-guides"
          style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
          aria-hidden
        >
          {guides.map((g, i) =>
            g.axis === 'x' ? (
              <line key={i} x1={g.at} y1={g.from} x2={g.at} y2={g.to} className="atlas-guide" strokeWidth={1 / getScale()} />
            ) : (
              <line key={i} x1={g.from} y1={g.at} x2={g.to} y2={g.at} className="atlas-guide" strokeWidth={1 / getScale()} />
            ),
          )}
        </svg>
      )}

      <AtlasConnectors
        flows={flows}
        screenById={byId}
        focusedId={focusedId}
        isolatedIds={isolatedIds}
        selectedFlowId={selectedFlowId}
        hoveredFlowId={hoveredFlowId}
        weights={flowWeights}
        onSelectFlow={onSelectFlow ?? (() => {})}
        onHoverFlow={(id, at) => {
          setHoveredFlowId(id)
          onHoverFlow?.(id, at)
        }}
      />

      {screens.map((screen) => (
        <DraggableBoard
          key={screen.id}
          id={screen.id}
          label={screen.label}
          src={screen.imageUrl}
          pos={screen.position}
          focused={focusedId === screen.id}
          dimmed={!!isolatedIds && !isolatedIds.has(screen.id)}
          snapToGrid={snapToGrid}
          draggable={boardsDraggable}
          selected={!!selectedIds?.has(screen.id)}
          groupSize={selectedIds?.size ?? 0}
          /*
           * Reports the *intent* — which board, and whether Shift was held — and lets the
           * parent apply the selection rule.
           *
           * It used to merge the next set here, from the `selectedIds` prop. That's a
           * stale read: two shift-clicks inside one frame both see the same pre-render
           * value, so the second overwrites the first and one board silently fails to be
           * added. Owning the rule in one place also lets `focusedId` follow the
           * selection, which is what makes the inspector describe something you've
           * actually got selected.
           */
          onSelect={onSelect}
          onRenameRequest={onRenameRequest}
          drawFlowMode={drawFlowMode}
          onFlowClick={onFlowClick}
          isFlowSource={draft?.anchorId === screen.id}
          isFlowTarget={draft?.overId === screen.id}
          onGroupDrag={onGroupDrag}
          onGroupDragEnd={onGroupDragEnd}
          onDragStart={onScreenDragStart}
          onDrag={dragWithGuides}
          settling={settlingIds.has(screen.id)}
          onDragEnd={(sid, p) => {
            // Commit the *snapped* position, or the board would jump back to the raw drop
            // point on release — the guide would have been a lie.
            const { position } = resolveAlign(
              p,
              screens.filter((s) => s.id !== sid),
              6 / getScale(),
            )
            // Cards may pass over each other mid-gesture but never settle overlapping:
            // the smallest de-overlapping nudge is applied here, at the same commit
            // point that already owns align-snapping — so both the placed and the
            // thrown release paths (flight onRest also exits through this callback)
            // resolve identically, and undo restores the pre-drag spot either way.
            const others = screens
              .filter((s) => s.id !== sid)
              .map((s) => s.position)
            const d = resolveOverlap([position], others, snapToGrid ? GRID_UNIT : 0)
            const settled = { x: position.x + d.x, y: position.y + d.y }
            if (d.x !== 0 || d.y !== 0) {
              markSettling(sid)
              // Stream the settled position through the live-move channel too:
              // `commitScreenPosition` persists exactly what it's handed, but it does
              // NOT dispatch it locally — it trusts the drag stream to have put it in
              // state already. True for a raw release; not for a nudged one.
              onScreenDrag(sid, settled)
            }
            setGuides([])
            onScreenDragEnd(sid, settled)
          }}
        />
      ))}

      {/* Reconnect handles — grabbable dots on the selected edge's two ends. Rendered LAST
          so they sit above the boards and the connector hit-paths; otherwise a click on a
          handle would land on the connector underneath and just re-select the edge. Sized
          in world units ÷ zoom so they stay a constant on-screen dot. */}
      {!draft && selectedFlowId && onReconnectFlow && (() => {
        const flow = flows.find((f) => f.id === selectedFlowId)
        const from = flow && byId.get(flow.from)
        const to = flow && byId.get(flow.to)
        if (!flow || !from || !to) return null
        const geo = connectorPath(frameBox(from.position), frameBox(to.position))
        const rad = 5 / getScale()
        return (
          <svg
            className="atlas-reconnect"
            style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}
            aria-hidden
          >
            <circle
              className="atlas-reconnect-handle"
              cx={geo.portFrom.pad.x}
              cy={geo.portFrom.pad.y}
              r={rad}
              onPointerDown={(e) => startReconnect(flow.id, 'from', flow.to, e)}
            />
            <circle
              className="atlas-reconnect-handle"
              cx={geo.portTo.pad.x}
              cy={geo.portTo.pad.y}
              r={rad}
              onPointerDown={(e) => startReconnect(flow.id, 'to', flow.from, e)}
            />
          </svg>
        )
      })()}
    </>
  )
}

type DraggableBoardProps = {
  id: ScreenId
  label: string
  src: string
  pos: Vec
  focused: boolean
  dimmed?: boolean
  snapToGrid?: boolean
  draggable?: boolean
  selected?: boolean
  /** How many boards are selected — a drag on a selected board moves them all. */
  groupSize?: number
  onSelect?: (id: ScreenId, additive: boolean) => void
  onRenameRequest?: (id: ScreenId) => void
  /** Draw-flow tool: a click arms this board as a source, or commits an armed edge to it. */
  drawFlowMode?: boolean
  onFlowClick?: (id: ScreenId, e: ReactPointerEvent) => void
  /** This board is the source / current target of an in-progress draw-flow gesture. */
  isFlowSource?: boolean
  isFlowTarget?: boolean
  onGroupDrag?: (delta: Vec) => void
  onGroupDragEnd?: () => void
  onDragStart?: (id: ScreenId) => void
  onDrag: (id: ScreenId, next: Vec) => void
  onDragEnd: (id: ScreenId, position: Vec) => void
  /** Gliding to a de-overlapped resting spot — drives the settle transition. */
  settling?: boolean
}

/**
 * A board that can be dragged around the plane, or tapped to focus it.
 *
 * Memoised, and reads the live zoom via `getScale()` rather than taking it as a
 * prop, so panning and zooming the canvas do not re-render 17 artboards.
 */
const DraggableBoard = memo(function DraggableBoard({
  id,
  label,
  src,
  pos,
  focused,
  dimmed = false,
  snapToGrid = false,
  draggable = true,
  selected = false,
  groupSize = 0,
  onSelect,
  onRenameRequest,
  drawFlowMode = false,
  onFlowClick,
  isFlowSource = false,
  isFlowTarget = false,
  onGroupDrag,
  onGroupDragEnd,
  onDragStart,
  onDrag,
  onDragEnd,
  settling = false,
}: DraggableBoardProps) {
  const { getScale, screenToWorld } = useCanvas()
  const reducedMotion = useReducedMotion()
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  /** Coasting after release. Keeps the lifted styling on until the board settles. */
  const [flying, setFlying] = useState(false)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{
    startX: number
    startY: number
    base: Vec
    moved: boolean
    /** Where the board actually ended up. The gesture is the authority on this. */
    last: Vec
    /** Previous frame's position, so a group drag can send a delta. */
    prev: Vec
  } | null>(null)

  /** Recent world positions, for the release velocity estimate. */
  const samples = useRef<Sample[]>([])
  /** Cancels an in-flight throw. */
  const flight = useRef<(() => void) | null>(null)
  /** Grid cell the board's centre was last in, for the tick sound. */
  const cell = useRef('')
  const lastTick = useRef(0)
  /** The canvas element, needed to project the visible viewport into world space. */
  const host = useRef<HTMLElement | null>(null)

  const isGroup = selected && groupSize > 1

  /** The board's full footprint in world units — label, gap and frame. */
  const BOARD_SIZE = { w: CARD_W, h: LABEL_H + GAP + FRAME_H }

  /**
   * Bank the board into its motion.
   *
   * Written as custom properties rather than a full `transform`, so the CSS rule stays
   * the single author of the composed transform. Setting `transform` inline here would
   * silently defeat the hover lift and the drag scale, which are declared in the sheet.
   */
  const applyTilt = (v: Vec) => {
    const el = boardRef.current
    if (!el || reducedMotion) return
    const { rx, ry } = tiltFromVelocity(v, getScale())
    el.style.setProperty('--tilt-x', `${rx.toFixed(2)}deg`)
    el.style.setProperty('--tilt-y', `${ry.toFixed(2)}deg`)
  }

  const clearTilt = () => {
    const el = boardRef.current
    if (!el) return
    el.style.removeProperty('--tilt-x')
    el.style.removeProperty('--tilt-y')
  }

  /** Stop a coast — grabbing a moving board must take control of it immediately. */
  const cancelFlight = () => {
    flight.current?.()
    flight.current = null
    setFlying(false)
    clearTilt()
  }

  useEffect(() => cancelFlight, [])

  /**
   * A grid-crossing tick while the board is being dragged.
   *
   * Rate-limited and pitch-jittered, both for the same reason: a board dragged fast
   * crosses many cells per second, and an un-throttled run of the identical sample is
   * a machine-gun rather than a texture.
   */
  const tickOnGridCross = (pos: Vec) => {
    const cx = Math.floor((pos.x + BOARD_SIZE.w / 2) / GRID_UNIT)
    const cy = Math.floor((pos.y + BOARD_SIZE.h / 2) / GRID_UNIT)
    const key = `${cx},${cy}`
    if (key === cell.current) return
    cell.current = key
    const now = performance.now()
    if (now - lastTick.current < 25) return
    lastTick.current = now
    sfx.play(0.035, 1 + (Math.random() - 0.5) * 0.3)
  }

  /**
   * Release the board and let it coast.
   *
   * Walls are the *visible viewport* projected into world coordinates, re-read every
   * frame. An absolute world boundary would be worse than none: you'd watch a board sail
   * off-screen and stop somewhere you can't see, against an edge you had no way to
   * anticipate. Bouncing off what you can actually see keeps the throw legible.
   */
  const throwBoard = (from: Vec, v: Vec, config: ReturnType<typeof scaledPhysics>) => {
    setFlying(true)
    flight.current = startFlight(
      from,
      v,
      {
        size: BOARD_SIZE,
        walls: () => {
          const el = host.current
          const w = el?.clientWidth ?? window.innerWidth
          const h = el?.clientHeight ?? window.innerHeight
          const tl = screenToWorld(0, 0)
          const br = screenToWorld(w, h)
          const m = config.boundaryMargin
          return {
            minX: tl.x + m,
            minY: tl.y + m,
            maxX: br.x - m,
            maxY: br.y - m,
          }
        },
        onFrame: (pos, vel) => {
          onDrag(id, pos)
          applyTilt(vel)
        },
        onBounce: ({ at, force }) => {
          // The grid ripples from the point of contact — the impact is felt by the plane,
          // not just by the board, which is what sells the two as one material system.
          gridField.pulse(at.x, at.y, force)
          if (force > 0.02) {
            // Quadratic, so a glancing knock stays almost silent while a hard throw lands.
            sfx.play(0.015 + force * force * 0.135, 0.8)
          }
        },
        onRest: (pos) => {
          flight.current = null
          setFlying(false)
          clearTilt()
          onDragEnd(id, pos)
        },
      },
      config,
    )
  }

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    // Draw-flow tool: a click arms this board as a source (or commits an armed edge to
    // it). Not a drag — the parent tracks the bare cursor so the line shows immediately.
    if (drawFlowMode && onFlowClick) {
      e.stopPropagation()
      onFlowClick(id, e)
      return
    }
    // Pan tool: don't consume the event, so the canvas handles it as a pan. Deliberately
    // gives up tap-to-focus while panning, which is how every canvas tool behaves.
    if (!draggable) return
    e.stopPropagation() // don't let the canvas pan
    // Grabbing a coasting board must hand control straight back to the pointer.
    cancelFlight()
    host.current = (e.currentTarget as HTMLElement).closest('.atlas-canvas') as HTMLElement | null
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      base: pos,
      moved: false,
      last: pos,
      prev: pos,
    }
    samples.current = [{ x: pos.x, y: pos.y, t: performance.now() }]
    cell.current = ''

    const onPointerMove = (ev: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const dxs = ev.clientX - d.startX
      const dys = ev.clientY - d.startY
      if (!d.moved && Math.hypot(dxs, dys) > 4) {
        d.moved = true
        setDragging(true)
        // Capture the pre-drag position exactly once, for rollback on write failure.
        onDragStart?.(id)
      }
      if (d.moved) {
        const scale = getScale()
        const raw = { x: d.base.x + dxs / scale, y: d.base.y + dys / scale }
        d.last = snapToGrid
          ? {
              x: Math.round(raw.x / GRID_UNIT) * GRID_UNIT,
              y: Math.round(raw.y / GRID_UNIT) * GRID_UNIT,
            }
          : raw
        // Dragging one of several selected boards moves the whole set by the same
        // delta, so relative arrangement is preserved.
        // Sampled in *world* units, so the release velocity is in the same space the
        // flight integrates in and a throw feels the same at any zoom level.
        const now = performance.now()
        samples.current.push({ x: d.last.x, y: d.last.y, t: now })
        if (samples.current.length > PHYSICS.velocitySampleCount) samples.current.shift()
        applyTilt(velocityFromSamples(samples.current, now))
        tickOnGridCross(d.last)

        if (isGroup && onGroupDrag) {
          const delta = { x: d.last.x - d.prev.x, y: d.last.y - d.prev.y }
          d.prev = d.last
          onGroupDrag(delta)
        } else {
          onDrag(id, d.last)
        }
      }
    }
    const end = () => {
      const d = drag.current
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      setDragging(false)
      // Persist once, at the end of the gesture, with the position the gesture
      // computed — NOT one read back out of React state, which may not have
      // committed yet if pointerup shares a task with the last pointermove.
      if (d?.moved) {
        if (isGroup && onGroupDragEnd) {
          // A group is not thrown. Seventeen boards coasting and bouncing off the walls
          // independently would scatter a layout the user arranged on purpose, and
          // there's no reading of "flick a selection" that means that.
          clearTilt()
          onGroupDragEnd()
        } else {
          // Snapshot the tuning at the zoom the release happened at, so a camera move
          // mid-flight can't retune the physics underneath a throw already in progress.
          const config = scaledPhysics(getScale())
          const v = clampVelocity(
            velocityFromSamples(samples.current, performance.now()),
            config.maxVelocity,
          )
          // Under the threshold the board is being *placed*, not thrown — coasting a
          // careful placement by a few units would feel like the tool disagreeing.
          if (!reducedMotion && Math.hypot(v.x, v.y) > config.momentumThreshold) {
            throwBoard(d.last, v, config)
          } else {
            clearTilt()
            onDragEnd(id, d.last)
          }
        }
      } else if (d) {
        // One callback for both: Shift-click extends the selection, a plain tap
        // replaces it. The page decides what that means for focus and the camera.
        onSelect?.(id, e.shiftKey)
      }
      drag.current = null
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  return (
    <CanvasSection x={pos.x} y={pos.y} width={CARD_W} className={settling ? 'is-settling' : undefined}>
      <div
        ref={boardRef}
        className={`atlas-board${dragging ? ' is-dragging' : ''}${flying ? ' is-flying' : ''}${dimmed ? ' is-dimmed' : ''}${draggable ? '' : ' is-pan-mode'}${selected ? ' is-selected' : ''}${drawFlowMode ? ' is-flow-mode' : ''}${isFlowSource ? ' is-flow-source' : ''}${isFlowTarget ? ' is-flow-target' : ''}`}
        onPointerDown={onPointerDown}
        /* Double-click renames. The editor itself lives in the 1:1 chrome panel, not on
           the board — see `ScreenTitle`. */
        onDoubleClick={
          onRenameRequest
            ? (e) => {
                e.stopPropagation()
                onRenameRequest(id)
              }
            : undefined
        }
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <Artboard src={src} label={label} focused={focused} hovered={hovered} selected={selected} width={CARD_W} />
      </div>
    </CanvasSection>
  )
})
