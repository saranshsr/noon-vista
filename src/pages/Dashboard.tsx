import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { InfiniteCanvas, AtlasBoards, AtlasShell, Minimap, boardsBounds, frameBox, resolveOverlap, GRID_UNIT } from '../canvas'
import type { CanvasApi, FlowWeight } from '../canvas'
import {
  TopNav,
  TopSwitch,
  RightNav,
  BreadcrumbsTab,
  Sidebar,
  StatsBar,
  CommandPalette,
  ShortcutSheet,
  LoadingOverlay,
  ZoomBar,
  DialMenu,
  EdgeCard,
  MultiSelectPanel,
} from '../molecules'
import type { AtlasMode, HoveredSection, NeighbourRow, ToolId } from '../molecules'
import { MinimisedFloatingMenu, Button, PixelCascade, PanelSwap } from '../components'
import { flowPathTo, formatMetric } from '../domain'
import type { Flow, FlowId, MetricScope, MetricSet, ScreenId } from '../domain'
import { useAtlas, useAtlasActions } from '../state/AtlasProvider'
import { useMetricSet, useMetrics } from '../state/useMetrics'
import { useProjects } from '../state/useProjects'
import { useHotkeys } from '../hooks/useHotkeys'
import { useUrlSync } from '../hooks/useUrlSync'
import { SHORTCUTS, bindShortcuts } from '../hooks/shortcuts'
import type { ShortcutId } from '../hooks/shortcuts'
import { useBootProgress } from '../state/useBootProgress'
import { useViewPrefs } from '../state/useViewPrefs'
import { ScreensView } from './ScreensView'
import { AnimatePresence, motion } from 'motion/react'

/**
 * noon Atlas — main landing page (Figma node 54:65001).
 *
 * Two layers, exactly as the design is authored:
 *  · z-index 0   — the infinite x-y plane (grid canvas, pannable / zoomable).
 *  · z-index 100 — the fixed app chrome floating above the plane. Nothing here
 *                  pans; the widgets are pinned to the viewport.
 *
 * The chrome container is pointer-events:none so a drag that lands in the gaps
 * between widgets falls through to the canvas and pans it; each widget re-enables
 * pointer events for itself.
 *
 * Layout / spacing is 1:1 with Figma:
 *  · Top bar     — full width, padding 8×20, space-between (menu · pills · stats)
 *  · Right Nav   — top 62, right 20, fills the height to the bottom
 *  · Breadcrumbs — bottom-left, 20 from each edge
 *  · Zoom HUD    — bottom-centre, mirroring the mode switch at top-centre
 *  · Sidenav     — the project pill expands (morphs) into the Sidebar, top-left
 *
 * Responsiveness: the chrome renders at 1:1 and is NOT scaled. It used to be authored
 * against a 1600×1000 reference and scaled uniformly by `--ui-scale`, but that scaler —
 * whether implemented as `transform: scale()` or `zoom` — establishes a backdrop root,
 * which is why no panel in here could ever blur. See `.dashboard__chrome` for the
 * measurements. The plane below fills the viewport at its own zoom, as before.
 *
 * The graph arrives from the data layer via `AtlasProvider`; this file owns only
 * ephemeral UI state (which panels are open, which mode, what's hovered/selected).
 */

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/**
 * Horizontal inset of the section-stats card from the right edge, in design space.
 * Shared with `--section-card-inset` in the stylesheet — this used to be the literal
 * `375` typed independently in both places, which would silently misalign the pink
 * leader line the first time either moved.
 */
const SECTION_CARD_INSET = 440

/**
 * Below this zoom the details panel slides away and the screen reads as deselected;
 * above it the panel returns. A focused screen sits at ~1.25× (see `focusRect`), and
 * fit-all lands near 0.13×, so 0.5 is comfortably between "looking at one screen" and
 * "looking at the whole map" — you have to actively zoom out of a screen to dismiss it.
 * The panel's 500ms `right` transition makes the show/hide a slide rather than a cut.
 */
const PANEL_MIN_ZOOM = 0.5

/** Tracks the live viewport size (updates on resize). */
function useViewportSize() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

/**
 * Magnifier, drawn inline — the icon set has no search mark, and this keeps it in the
 * same 1px-stroke idiom as the zoom HUD's fit glyph.
 */
function SearchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden focusable="false">
      <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.2" />
      <path d="M9.4 9.4L12.5 12.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  )
}

/** MetricSet → the `{label, value}` rows the StatsBar / Row components render. */
function toStatRows(set: MetricSet | null, which: 'primary' | 'secondary') {
  return (set?.[which] ?? []).map((m) => ({ label: m.label, value: formatMetric(m) }))
}

export default function Dashboard() {
  const { w: vw, h: vh } = useViewportSize()

  const { status, snapshot, graph, error, projectId, layoutRev, history } = useAtlas()
  const actions = useAtlasActions()
  const { projects } = useProjects()

  const [mode, setMode] = useState<AtlasMode>('map')
  /**
   * Mode changes are deferred: `switchMode` records the target and starts a wipe, and
   * the swap only happens once `PixelWipe` reports the screen is covered. That's what
   * keeps the change from ever being seen — the alternative (swap now, animate over
   * the top) shows the new view assembling behind the blocks.
   */
  /**
   * Bumped on each mode change to replay the cascade. The mode itself changes
   * immediately — the incoming view masks itself in over the outgoing one, so there's
   * nothing to defer and no intermediate blank state to hide.
   */
  /** Set when the inspector should open once the cascade has finished. */
  const [panelPending, setPanelPending] = useState(false)
  const [cascadeKey, setCascadeKey] = useState(0)
  /** True while the incoming view is still assembling, so the old one stays beneath. */
  const [cascading, setCascading] = useState(false)
  const switchMode = useCallback((next: AtlasMode) => {
    setMode((prev) => {
      if (prev === next) return prev
      setCascadeKey((n) => n + 1)
      setCascading(true)
      // Leaving Map: dismiss the inspector immediately so it slides out *with* the
      // transition rather than being cut off by it. Returning: hold it closed and let
      // the cascade finish first, then slide in — the same sequencing as opening a
      // screen from the grid.
      setRightNavOpen(false)
      if (next === 'map') setPanelPending(true)
      return next
    })
  }, [])
  const [navOpen, setNavOpen] = useState(false)
  /**
   * Kept mounted through its exit. It had an entrance animation and no exit, so the
   * panel grew in gracefully and then simply blinked out of existence.
   */
  const [navClosing, setNavClosing] = useState(false)
  const closeNav = useCallback(() => {
    setNavClosing(true)
    window.setTimeout(() => {
      setNavOpen(false)
      setNavClosing(false)
    }, 180)
  }, [])
  const [section, setSection] = useState<HoveredSection | null>(null)
  const [focusedId, setFocusedId] = useState<ScreenId | null>(null)
  const [focusNonce, setFocusNonce] = useState(0)
  const [selectedFlowId, setSelectedFlowId] = useState<FlowId | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [rightNavOpen, setRightNavOpen] = useState(false)
  const [activeTool, setActiveTool] = useState<ToolId>('select')
  /**
   * The tool dial. `at` is where it was summoned in client coordinates — a right-click
   * point on the canvas, or a point just above the bar's trigger.
   */
  const [dial, setDial] = useState<{ open: boolean; at: { x: number; y: number } }>({
    open: false,
    at: { x: 0, y: 0 },
  })
  const openDial = useCallback((at: { x: number; y: number }) => setDial({ open: true, at }), [])
  const closeDial = useCallback(() => setDial((d) => ({ ...d, open: false })), [])
  const { prefs, toggle: togglePref } = useViewPrefs()
  const toggles = useMemo<Partial<Record<ToolId, boolean>>>(
    () => ({ snap: prefs.snap, minimap: prefs.minimap, isolate: prefs.isolate }),
    [prefs],
  )
  /** Live viewport rect in world units, for the minimap's frame. */
  /** Multi-selected boards. Separate from `focusedId`, which drives the inspector. */
  const [selectedIds, setSelectedIds] = useState<Set<ScreenId>>(new Set())
  /**
   * Mirrors `selectedIds` but is updated synchronously by `selectBoard`, so two clicks in
   * one frame compose instead of the second overwriting the first.
   */
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds

  /**
   * The selection rule, in one place.
   *
   * `selectedIds` is the **edit target**; `focusedId` is the **camera/inspector subject**,
   * and is always the most recently *added* member of a non-empty selection. Before this,
   * the two were independent — ⌘A selected seventeen boards while the inspector still
   * described one, and every edit had to guess which set it acted on.
   *
   * `selectedIdsRef` is kept a step ahead of the render deliberately. Merging from the
   * `selectedIds` state value meant two shift-clicks inside a single frame both read the
   * same pre-render set, so the second silently discarded the first.
   *
   * Only a plain tap flies the camera. Re-framing on every shift-click while someone
   * assembles a ten-board selection would be unusable.
   */
  const selectBoard = useCallback((id: ScreenId, additive: boolean) => {
    const prev = selectedIdsRef.current
    const removing = additive && prev.has(id)
    const next = additive ? new Set(prev) : new Set<ScreenId>()
    if (removing) next.delete(id)
    else next.add(id)
    selectedIdsRef.current = next
    setSelectedIds(next)

    // Deselecting leaves the inspector where it is; there's no new subject to show.
    if (removing) return
    setFocusedId(id)
    setSelectedFlowId(null)
    setRightNavOpen(true)
    if (!additive) setFocusNonce((n) => n + 1)
  }, [])

  /**
   * A complete set from the marquee. It computes its own base at pointer-down, so it's
   * already immune to the stale-read problem above — this just keeps the ref in step and
   * makes sure the inspector is describing something inside the new selection.
   */
  const changeSelection = useCallback((ids: Set<ScreenId>) => {
    selectedIdsRef.current = ids
    setSelectedIds(ids)
    setFocusedId((current) => {
      if (ids.size === 0) return current
      if (current && ids.has(current)) return current
      return [...ids][ids.size - 1]
    })
  }, [])

  /**
   * Transient one-line confirmation for a destructive or refused edit. Auto-dismisses;
   * carries an Undo when the action was actually performed.
   */
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * Which screen's title is open for editing, or null.
   *
   * Holds an id rather than a boolean deliberately. As a boolean it needed an effect to
   * close the editor when the subject changed — and that effect fired on the very
   * `focusedId` change that opening the editor causes, so a double-click opened and
   * instantly closed it. Keyed by id, the editor is open iff it's open *for the screen
   * currently in the panel*, and a subject change closes it with no effect at all.
   */
  const [renamingId, setRenamingId] = useState<ScreenId | null>(null)
  useEffect(() => {
    if (!notice) return
    // Long enough to read a count and reach for Undo, short enough not to become chrome.
    const t = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(t)
  }, [notice])
  /** Which connector the pointer is on, and where — drives the hover stat card. */
  const [hoveredFlow, setHoveredFlow] = useState<{ id: FlowId; x: number; y: number } | null>(null)
  const [viewRect, setViewRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  /**
   * Tool clicks split two ways: `select`/`pan` are exclusive modes, everything else is
   * an independent switch. Treating them all as one "active tool" would mean turning
   * the minimap on silently dropped you out of whatever mode you were in.
   */
  /**
   * Delete every selected screen, plus the flows touching them.
   *
   * Guards the root. `rootScreenId` is the breadcrumb origin, the initial camera target and
   * the reset baseline, so deleting it would break three things silently. Refused with a
   * reason rather than allowed and papered over — re-pointing the root of an atlas is a
   * decision, not a side effect of a keystroke.
   */
  const deleteSelection = useCallback(() => {
    if (!snapshot) return
    // A selected connector takes priority: pressing Delete with an edge selected removes
    // the edge, not whatever boards happen to also be in the selection.
    if (selectedFlowId) {
      const flow = snapshot.flows.find((f) => f.id === selectedFlowId)
      actions.deleteFlow(selectedFlowId)
      setSelectedFlowId(null)
      if (flow) {
        const from = snapshot.screens.find((s) => s.id === flow.from)?.label ?? flow.from
        const to = snapshot.screens.find((s) => s.id === flow.to)?.label ?? flow.to
        setNotice(`Flow ${from} → ${to} removed`)
      }
      return
    }
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (ids.includes(snapshot.rootScreenId)) {
      const label = snapshot.screens.find((s) => s.id === snapshot.rootScreenId)?.label
      setNotice(`Can’t delete ${label ?? 'the entry screen'} — it’s the atlas’s entry point.`)
      return
    }
    const flowCount = snapshot.flows.filter((f) => selectedIds.has(f.from) || selectedIds.has(f.to))
      .length
    actions.deleteScreens(ids)
    changeSelection(new Set())
    if (focusedId && ids.includes(focusedId)) setFocusedId(snapshot.rootScreenId)
    // A truthful count plus a real undo, rather than a confirmation dialog: the operation is
    // reversible, and a modal in front of a reversible action is friction.
    setNotice(
      `${ids.length} screen${ids.length === 1 ? '' : 's'}` +
        (flowCount ? ` and ${flowCount} flow${flowCount === 1 ? '' : 's'}` : '') +
        ' removed',
    )
  }, [snapshot, selectedIds, selectedFlowId, actions, focusedId, changeSelection])

  /**
   * Keyboard nudge of the selection by one grid unit (⇧ → ten).
   *
   * On the current selection, so a tap-then-nudge works (a tap selects). Snapped to
   * `GRID_UNIT` so nudged boards land on the same lines the grid draws and a dragged
   * board snaps to — otherwise nudging and dragging would disagree about "aligned".
   * `preventDefault` because ⌥+← is browser Back on some platforms.
   */
  const nudge = useCallback(
    (e: KeyboardEvent, dx: number, dy: number) => {
      e.preventDefault()
      const ids = [...selectedIds]
      if (ids.length === 0) return
      const step = e.shiftKey ? GRID_UNIT * 10 : GRID_UNIT
      actions.nudgeSelection(ids, { x: dx * step, y: dy * step })
    },
    [selectedIds, actions],
  )

  const handleTool = useCallback(
    (id: ToolId) => {
      if (id === 'select' || id === 'pan' || id === 'drawFlow') setActiveTool(id)
      else if (id === 'snap' || id === 'minimap' || id === 'isolate') togglePref(id)
      else if (id === 'delete') deleteSelection()
    },
    [togglePref, deleteSelection],
  )
  /**
   * Mirrors the camera's zoom for the command bar's readout. The canvas owns the
   * viewport; this is a subscription, not a second source of truth.
   */
  const [zoom, setZoom] = useState(1)

  /** The live camera, published by InfiniteCanvas so hotkeys can drive it. */
  const cameraRef = useRef<CanvasApi | null>(null)

  /**
   * Hold Space to pan, release to return to the previous tool — the convention in every
   * canvas app. Tracked separately from `activeTool` so it restores whatever you were
   * using rather than always dropping you back to Select.
   */
  const [spaceHeld, setSpaceHeld] = useState(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const t = e.target
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.isContentEditable)) return
      e.preventDefault()
      setSpaceHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    // Losing focus mid-hold would otherwise leave you stuck in Pan.
    const blur = () => setSpaceHeld(false)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
  const effectiveTool: ToolId = spaceHeld ? 'pan' : activeTool

  useEffect(() => {
    const r = requestAnimationFrame(() => setRightNavOpen(true))
    return () => cancelAnimationFrame(r)
  }, [])

  /**
   * Keep the command bar's percentage in step with the camera.
   *
   * Sampled on an interval rather than lifting the viewport into page state: the
   * viewport changes every pan frame, and re-rendering the whole dashboard 60 times a
   * second to update one label would undo the context-splitting work done earlier.
   * Only a *changed* scale sets state, so a pan costs nothing.
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      const cam = cameraRef.current
      if (!cam) return
      const s = cam.getScale()
      setZoom((prev) => (Math.abs(prev - s) > 0.0005 ? s : prev))
      // World-space rect of what's on screen, for the minimap frame.
      const vp = cam.getViewport()
      const el = document.querySelector<HTMLElement>('.atlas-canvas')
      if (el && el.clientWidth > 0) {
        const next = {
          x: -vp.x / vp.scale,
          y: -vp.y / vp.scale,
          w: el.clientWidth / vp.scale,
          h: el.clientHeight / vp.scale,
        }
        setViewRect((prev) =>
          !prev ||
          Math.abs(prev.x - next.x) > 1 ||
          Math.abs(prev.y - next.y) > 1 ||
          Math.abs(prev.w - next.w) > 1
            ? next
            : prev,
        )
      }
    }, 120)
    return () => window.clearInterval(id)
  }, [])

  // Adopt the snapshot's entry screen, and re-adopt if the project changes or the
  // focused screen stops existing.
  useEffect(() => {
    if (!snapshot) return
    const stillThere = focusedId && snapshot.screens.some((s) => s.id === focusedId)
    if (!stillThere) setFocusedId(snapshot.rootScreenId || (snapshot.screens[0]?.id ?? null))
  }, [snapshot, focusedId])

  /**
   * The selection as screens, in the order they were added — so the panel's list reads as
   * the order you clicked, not the atlas's internal order.
   */
  const selectedScreens = useMemo(() => {
    if (!snapshot || selectedIds.size < 2) return []
    const byId = new Map(snapshot.screens.map((s) => [s.id, s]))
    return [...selectedIds].map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s)
  }, [snapshot, selectedIds])

  /**
   * Metrics for the selected screens only — one batched read, and `useMetrics` caches by
   * scope, so the sets are already warm if you've hovered these in the Screens grid.
   */
  const selectedScopes = useMemo<MetricScope[]>(
    () => selectedScreens.map((sc) => ({ kind: 'screen', screenId: sc.id })),
    [selectedScreens],
  )
  const { data: selectedMetrics } = useMetrics(selectedScopes)
  const screenMetricsById = useMemo(() => {
    const map = new Map<ScreenId, MetricSet>()
    for (const set of selectedMetrics ?? []) {
      if (set.scope.kind === 'screen') map.set(set.scope.screenId, set)
    }
    return map
  }, [selectedMetrics])

  const focusScreen = useCallback((id: ScreenId) => {
    setFocusedId(id)
    setFocusNonce((n) => n + 1)
    // Selecting a screen and interrogating an edge are different intents; keeping a
    // stale edge selected while the panel shows a screen would be incoherent.
    setSelectedFlowId(null)
    setRightNavOpen(true)
  }, [])

  // Deep links: `?project&mode&screen` mirrors this state, and popstate applies it
  // back — see useUrlSync for the contract.
  useUrlSync({
    projectId,
    selectProject: actions.selectProject,
    mode,
    switchMode,
    focusedId,
    focusScreen,
    snapshot,
  })

  /**
   * Opening a screen from the grid: switch, focus, but hold the panel until the cascade
   * has finished. Sliding a panel in while the view behind it is still assembling put
   * two unrelated animations on screen at once.
   */
  const openOnMap = useCallback(
    (id: ScreenId) => {
      switchMode('map')
      setFocusedId(id)
      setFocusNonce((n) => n + 1)
      setSelectedFlowId(null)
      setRightNavOpen(false)
      setPanelPending(true)
    },
    [switchMode],
  )
  const onCascadeDone = useCallback(() => {
    setCascading(false)
    if (panelPending) {
      setPanelPending(false)
      setRightNavOpen(true)
    }
  }, [panelPending])

  const rootScreenId = snapshot?.rootScreenId ?? null
  const resetAtlas = useCallback(() => {
    if (rootScreenId) focusScreen(rootScreenId)
    actions.resetLayout()
  }, [actions, focusScreen, rootScreenId])

  const focused = useMemo(
    () => snapshot?.screens.find((s) => s.id === focusedId) ?? snapshot?.screens[0] ?? null,
    [snapshot, focusedId],
  )

  /**
   * Panel visibility splits from panel *intent*. `rightNavOpen` is the intent — set when
   * you focus a screen, cleared by the close button — and it drives the camera inset so a
   * focused screen always lands left of where the panel will be. `panelVisible` gates the
   * actual slide-in on live zoom: zoom out past the threshold and the panel leaves (the
   * screen reads as deselected); zoom back in and it returns, because the intent persisted.
   */
  const panelVisible = rightNavOpen && zoom >= PANEL_MIN_ZOOM

  const crumbs = useMemo(() => {
    if (!graph || !snapshot || !focused) return []
    const path = flowPathTo(graph, snapshot.rootScreenId, focused.id)
    return path.map((s, i) => ({
      id: s.id,
      label: s.label,
      state: i === path.length - 1 ? ('current' as const) : ('past' as const),
      arrow: i !== 0,
    }))
  }, [graph, snapshot, focused])

  const focusedSections = useMemo(
    () => (snapshot && focused ? snapshot.sections.filter((s) => s.screenId === focused.id) : []),
    [snapshot, focused],
  )

  // ── Metrics ──────────────────────────────────────────────────────────────
  const screenScope = useMemo<MetricScope | null>(
    () => (focused ? { kind: 'screen', screenId: focused.id } : null),
    [focused],
  )
  const { data: screenMetrics } = useMetricSet(screenScope)

  const sectionScope = useMemo<MetricScope | null>(
    () => (section ? { kind: 'section', sectionId: section.sectionId } : null),
    [section],
  )
  const { data: sectionMetrics } = useMetricSet(sectionScope)
  const hoveredSection = useMemo(
    () => focusedSections.find((s) => s.id === section?.sectionId) ?? null,
    [focusedSections, section],
  )

  /**
   * Every flow's metrics, in one batched read.
   *
   * The canvas needs a number for *all* edges simultaneously in order to size and
   * tint them relative to each other, so this is genuinely a whole-graph query
   * rather than N per-edge ones — and it means clicking any edge opens its inspector
   * with no further fetch.
   */
  const allFlowScopes = useMemo<MetricScope[]>(
    () => (snapshot?.flows ?? []).map((f) => ({ kind: 'flow', flowId: f.id })),
    [snapshot?.flows],
  )
  const { data: allFlowMetrics } = useMetrics(allFlowScopes)

  const flowMetricById = useMemo(() => {
    const map = new Map<FlowId, MetricSet>()
    for (const set of allFlowMetrics ?? []) {
      if (set.scope.kind === 'flow') map.set(set.scope.flowId, set)
    }
    return map
  }, [allFlowMetrics])

  /** Just the two fields the connectors encode, derived from the same fetch. */
  const flowWeights = useMemo(() => {
    if (!allFlowMetrics) return undefined
    const map = new Map<FlowId, FlowWeight>()
    for (const [id, set] of flowMetricById) {
      const users = set.primary.find((m) => m.key === 'flow_users')?.value
      const dropOff = set.secondary.find((m) => m.key === 'flow_drop_off')?.value
      if (users != null && dropOff != null) map.set(id, { users, dropOff })
    }
    return map
  }, [allFlowMetrics, flowMetricById])

  // ── The two flow tabs on the screen inspector ────────────────────────────
  const outFlows = useMemo<Flow[]>(
    () => (graph && focused ? (graph.flowsFrom.get(focused.id) ?? []) : []),
    [graph, focused],
  )
  const inFlows = useMemo<Flow[]>(
    () => (graph && focused ? (graph.flowsTo.get(focused.id) ?? []) : []),
    [graph, focused],
  )

  const toNeighbourRows = useCallback(
    (flows: Flow[], side: 'from' | 'to'): NeighbourRow[] =>
      flows.flatMap((flow) => {
        const otherId = side === 'to' ? flow.to : flow.from
        const other = snapshot?.screens.find((s) => s.id === otherId)
        if (!other) return [] // dangling flow — skip rather than render a blank row
        const set = flowMetricById.get(flow.id)
        const users = set?.primary.find((m) => m.key === 'flow_users')
        const share = set?.primary.find((m) => m.key === 'flow_share')
        return [
          {
            screenId: other.id,
            label: other.label,
            imageUrl: other.imageUrl,
            value: users ? formatMetric(users) : undefined,
            sub: share ? formatMetric(share) : undefined,
          },
        ]
      }),
    [snapshot, flowMetricById],
  )

  const navigateTo = useMemo(() => toNeighbourRows(outFlows, 'to'), [outFlows, toNeighbourRows])
  const reachedFrom = useMemo(() => toNeighbourRows(inFlows, 'from'), [inFlows, toNeighbourRows])

  // ── The selected edge ────────────────────────────────────────────────────
  const selectedFlow = useMemo(
    () => snapshot?.flows.find((f) => f.id === selectedFlowId) ?? null,
    [snapshot, selectedFlowId],
  )
  const selectedEdge = useMemo(() => {
    if (!selectedFlow || !snapshot) return null
    const from = snapshot.screens.find((s) => s.id === selectedFlow.from)
    const to = snapshot.screens.find((s) => s.id === selectedFlow.to)
    if (!from || !to) return null
    return { flow: selectedFlow, from, to, metrics: flowMetricById.get(selectedFlow.id) ?? null }
  }, [selectedFlow, snapshot, flowMetricById])

  const selectFlow = useCallback((id: FlowId | null) => {
    setSelectedFlowId(id)
    // Deliberately does NOT open the right-hand panel. Connector stats live on hover (the
    // EdgeCard) — a click just *selects* the edge, which is what surfaces its reconnect
    // handles and lets ⌫ delete it. The old side panel that popped up to show the same
    // numbers hover already shows was redundant, so it's gone.
    if (id) setRightNavOpen(false)
  }, [])

  // ── Section-stats card geometry ──────────────────────────────────────────
  // These used to divide by `uiScale` to convert viewport pixels into the chrome's
  // scaled design space. The chrome is no longer scaled (see `.dashboard__chrome` —
  // the scaler was what stopped every panel blurring), so the two spaces are now the
  // same and the conversion is gone rather than left as a divide by 1.
  const spaceW = vw
  const spaceH = vh
  const statsTop = section ? clamp(section.top, 72, spaceH - 360) : 0
  const cardRightX = spaceW - SECTION_CARD_INSET
  const connectorY = statsTop + 32
  const connectorWidth = section ? Math.max(0, section.left - cardRightX) : 0

  const hasGraph = !!snapshot && snapshot.screens.length > 0
  const canvasReady = status === 'ready' && hasGraph && !!focused

  /**
   * Whether the first artboards have actually decoded. Checked against the real <img>
   * elements rather than assumed, so "Decoding artboards" means what it says.
   */
  const [imagesReady, setImagesReady] = useState(false)
  useEffect(() => {
    if (!canvasReady || imagesReady) return
    let cancelled = false
    const check = () => {
      if (cancelled) return
      const imgs = [...document.querySelectorAll<HTMLImageElement>('.atlas-board__frame img')]
      // A handful is enough — waiting on all 17 would hold the overlay on an
      // off-screen image nobody is looking at.
      const sample = imgs.slice(0, 4)
      if (sample.length > 0 && sample.every((i) => i.complete)) setImagesReady(true)
      else window.setTimeout(check, 80)
    }
    check()
    return () => {
      cancelled = true
    }
  }, [canvasReady, imagesReady])

  const boot = useBootProgress({
    projectsReady: projects.length > 0,
    atlasReady: status === 'ready' && !!snapshot,
    /**
     * `!!allFlowMetrics` alone is vacuously true: before a snapshot exists there are
     * no flow scopes, so `useMetrics` resolves to `[]` on the first render and an
     * empty array is truthy. That reported "metrics resolved" while the two steps
     * before it were still pending — a checklist that ticks out of order tells you
     * nothing. Require the flows to exist and be covered, and treat a genuinely
     * flow-less project as nothing to resolve.
     */
    metricsReady:
      status === 'ready' &&
      !!snapshot &&
      (snapshot.flows.length === 0 || (allFlowMetrics?.length ?? 0) > 0),
    // An empty project has no artboards to decode, so don't wait for them.
    imagesReady: imagesReady || (status === 'ready' && !hasGraph),
  })

  /** Entry screen's frame, for the canvas to measure itself against. */
  const rootFrame = useMemo(() => {
    if (!snapshot || snapshot.screens.length === 0) return undefined
    const root =
      snapshot.screens.find((s) => s.id === snapshot.rootScreenId) ?? snapshot.screens[0]
    return frameBox(root.position)
    // Keyed on the project, not positions: this is the *initial* framing and must
    // not re-fire every time a board is dragged.
  }, [snapshot?.project.id, snapshot?.rootScreenId, snapshot?.screens.length])

  /** Bounds of every board, for fit-to-content. */
  /**
   * Focus isolation: the focused screen and everything one hop away, in either
   * direction. One hop rather than a configurable depth because at this graph size
   * two hops from the homepage is the entire atlas, which isolates nothing.
   */
  const isolatedIds = useMemo(() => {
    if (!toggles.isolate || !graph || !focused) return null
    const set = new Set<ScreenId>([focused.id])
    for (const id of graph.adjacency.get(focused.id) ?? []) set.add(id)
    for (const id of graph.reverse.get(focused.id) ?? []) set.add(id)
    return set
  }, [toggles.isolate, graph, focused])

  const contentBounds = useMemo(
    () => boardsBounds((snapshot?.screens ?? []).map((s) => s.position)) ?? undefined,
    [snapshot?.screens],
  )

  // ── Keyboard ─────────────────────────────────────────────────────────────
  /**
   * Walk the graph with the arrow keys — the traversal that a *graph* product
   * should have and a generic canvas can't: right follows an outbound flow, left
   * steps back along an inbound one, up/down cycle the siblings that share a parent.
   */
  const walk = useCallback(
    (direction: 'out' | 'in' | 'next' | 'prev') => {
      if (!graph || !focused) return
      if (direction === 'out') {
        const next = graph.adjacency.get(focused.id)?.[0]
        if (next) focusScreen(next)
        return
      }
      if (direction === 'in') {
        const prev = graph.reverse.get(focused.id)?.[0]
        if (prev) focusScreen(prev)
        return
      }
      const parent = graph.reverse.get(focused.id)?.[0]
      const siblings = parent ? (graph.adjacency.get(parent) ?? []) : []
      if (siblings.length < 2) return
      const i = siblings.indexOf(focused.id)
      if (i === -1) return
      const step = direction === 'next' ? 1 : -1
      focusScreen(siblings[(i + step + siblings.length) % siblings.length])
    },
    [graph, focused, focusScreen],
  )

  /**
   * One handler per `ShortcutId`. Typed as a total record, so adding a shortcut to the
   * table without wiring it — or wiring one that isn't in the table — is a compile error
   * rather than a silently dead key or an undocumented one.
   */
  const shortcutHandlers = useMemo<Record<ShortcutId, (e: KeyboardEvent) => void>>(
    () => ({
      palette: (e) => {
        e.preventDefault()
        setShortcutsOpen(false)
        setPaletteOpen((v) => !v)
      },
      shortcuts: () => setShortcutsOpen((v) => !v),
      dismiss: () => {
        // Order matters, and it was wrong: `selectedIds` was cleared *before*
        // `shortcutsOpen`, so with the sheet open over a selection the first Escape
        // silently cleared something invisible and appeared to do nothing. Topmost
        // surface first, then canvas state.
        if (paletteOpen) return setPaletteOpen(false)
        if (shortcutsOpen) return setShortcutsOpen(false)
        if (selectedFlowId) return setSelectedFlowId(null)
        if (selectedIds.size > 0) return changeSelection(new Set())
        if (navOpen) return closeNav()
        setRightNavOpen(false)
      },
      selectAll: (e) => {
        e.preventDefault()
        if (snapshot) changeSelection(new Set(snapshot.screens.map((sc) => sc.id)))
      },
      undo: (e) => {
        e.preventDefault()
        actions.undo()
      },
      redo: (e) => {
        e.preventDefault()
        actions.redo()
      },
      toolSelect: () => setActiveTool('select'),
      toolPan: () => setActiveTool('pan'),
      toggleIsolate: () => handleTool('isolate'),
      toggleMinimap: () => handleTool('minimap'),
      toggleSnap: () => handleTool('snap'),
      deleteSelection: (e) => {
        e.preventDefault()
        deleteSelection()
      },
      nudgeLeft: (e) => nudge(e, -1, 0),
      nudgeRight: (e) => nudge(e, 1, 0),
      nudgeUp: (e) => nudge(e, 0, -1),
      nudgeDown: (e) => nudge(e, 0, 1),
      modeMap: () => hasGraph && switchMode('map'),
      modeScreens: () => hasGraph && switchMode('screens'),
      fitAll: () => cameraRef.current?.fitContent(),
      focusCurrent: () =>
        focused && cameraRef.current?.focusRect(frameBox(focused.position)),
      zoomIn: () => cameraRef.current?.zoomBy(1.6),
      zoomOut: () => cameraRef.current?.zoomBy(1 / 1.6),
      zoomReset: () => cameraRef.current?.zoomTo(1),
      walkOut: (e) => {
        e.preventDefault()
        walk('out')
      },
      walkIn: (e) => {
        e.preventDefault()
        walk('in')
      },
      walkNext: (e) => {
        e.preventDefault()
        walk('next')
      },
      walkPrev: (e) => {
        e.preventDefault()
        walk('prev')
      },
    }),
    [
      paletteOpen,
      shortcutsOpen,
      selectedFlowId,
      selectedIds,
      navOpen,
      closeNav,
      snapshot,
      actions,
      handleTool,
      deleteSelection,
      nudge,
      hasGraph,
      switchMode,
      focused,
      walk,
    ],
  )

  // Split by `whileModal`: ⌘K, Escape and `?` keep working with a dialog open; everything
  // else is suspended, because single-letter keys used to fire *behind* the shortcut
  // sheet — reading the sheet and pressing `M` silently switched mode.
  const modalShortcuts = useMemo(() => SHORTCUTS.filter((s) => s.whileModal), [])
  const canvasShortcuts = useMemo(() => SHORTCUTS.filter((s) => !s.whileModal), [])

  useHotkeys(bindShortcuts(modalShortcuts, shortcutHandlers), true)
  useHotkeys(bindShortcuts(canvasShortcuts, shortcutHandlers), !paletteOpen && !shortcutsOpen)

  const paletteCommands = useMemo(
    () => [
      { id: 'cmd-map', label: 'Go to Map', hint: 'View', run: () => switchMode('map') },
      { id: 'cmd-screens', label: 'Go to Screens', hint: 'View', run: () => switchMode('screens') },
      {
        id: 'cmd-fit',
        label: 'Fit all screens',
        hint: 'View',
        run: () => cameraRef.current?.fitContent(),
      },
      { id: 'cmd-reset', label: 'Reset layout', hint: 'Edit', run: resetAtlas },
      {
        id: 'cmd-shortcuts',
        label: 'Keyboard shortcuts',
        hint: 'Help',
        run: () => setShortcutsOpen(true),
      },
    ],
    [resetAtlas, switchMode],
  )

  return (
    <div
      className="dashboard"
      /* Right-click summons the tool dial at the pointer. Bound here rather than on the
         canvas element so it also works over a board, and suppressed while the dial is
         already up so a second right-click can't stack another ring. Only in Map mode —
         Screens has no tools to offer, and swallowing the native menu there would be
         taking something away for nothing. */
      onContextMenu={(e) => {
        if (mode !== 'map' || !canvasReady) return
        e.preventDefault()
        if (dial.open) closeDial()
        else openDial({ x: e.clientX, y: e.clientY })
      }}
      style={
        {
          '--section-card-inset': `${SECTION_CARD_INSET}px`,
        } as CSSProperties
      }
    >
      {/* z-index 0 — the plane. Deliberately stays mounted while Screens mode is
          showing, only hidden, so the camera survives the round trip. */}
      {canvasReady && snapshot && (
        <InfiniteCanvas
          key={snapshot.project.id}
          initialFocus={rootFrame}
          contentBounds={contentBounds}
          controllerRef={cameraRef}
          hidden={mode !== 'map' && !cascading}
          showControls={false}
          /* Reserve the panel's footprint (width 340 + 20 right margin) so a focused
             screen centres in the space left of it. Mirrors `--rightnav-w` in the CSS —
             dropped from 620 when the panel went from two columns to one. */
          focusRightInset={rightNavOpen ? 360 : 0}
        >
          <AtlasBoards
            screens={snapshot.screens}
            flows={snapshot.flows}
            focusedId={focusedId ?? snapshot.rootScreenId}
            rootScreenId={snapshot.rootScreenId}
            onSelect={selectBoard}
            onRenameRequest={(id) => {
              selectBoard(id, false)
              setRenamingId(id)
            }}
            onScreenDragStart={actions.beginScreenDrag}
            onScreenDrag={actions.dragScreen}
            onScreenDragEnd={actions.commitScreenPosition}
            layoutRev={layoutRev}
            focusNonce={focusNonce}
            snapToGrid={!!toggles.snap}
            isolatedIds={isolatedIds}
            boardsDraggable={effectiveTool === 'select'}
            selectedIds={selectedIds}
            onSelectionChange={changeSelection}
            onGroupDrag={(delta) => actions.dragGroup([...selectedIds], delta)}
            onGroupDragEnd={() => {
              // A group settles like a single card: never overlapping anything outside
              // it. The set is pushed by ONE shared delta so the arrangement the user
              // made stays rigid — members can't be folded onto each other by a nudge
              // they all receive equally.
              const ids = [...selectedIds]
              const d = snapshot
                ? resolveOverlap(
                    snapshot.screens
                      .filter((s) => selectedIds.has(s.id))
                      .map((s) => s.position),
                    snapshot.screens
                      .filter((s) => !selectedIds.has(s.id))
                      .map((s) => s.position),
                    toggles.snap ? GRID_UNIT : 0,
                  )
                : { x: 0, y: 0 }
              if (d.x !== 0 || d.y !== 0) {
                // Through nudgeSelection, NOT dragGroup+commitGroup: an immediate
                // commit would read the reducer's pre-nudge positions (state hasn't
                // flushed within this tick). The nudge's trailing debounce commits
                // after state settles, and coalesces drag + nudge into one undo entry.
                actions.nudgeSelection(ids, d)
              } else {
                actions.commitGroup(ids)
              }
            }}
            flowWeights={flowWeights}
            selectedFlowId={selectedFlowId}
            onSelectFlow={selectFlow}
            onHoverFlow={(id, at) =>
              setHoveredFlow(id && at ? { id, x: at.x, y: at.y } : null)
            }
            drawFlowMode={effectiveTool === 'drawFlow'}
            onCreateFlow={(from, to) =>
              // Create, select (so its handles show), and drop back to Select so the next
              // click doesn't draw again. No panel pops — connector detail is hover-only.
              actions.createFlow(from, to, (flow) => {
                setActiveTool('select')
                selectFlow(flow.id)
              })
            }
            onReconnectFlow={(id, patch) => actions.reconnectFlow(id, patch)}
          />
        </InfiniteCanvas>
      )}

      {(mode === 'screens' || cascading) && canvasReady && snapshot && graph && (
        <PixelCascade
          cascadeKey={cascadeKey}
          direction={mode === 'screens' ? 'in' : 'out'}
          onDone={onCascadeDone}
        >
          <ScreensView
            snapshot={snapshot}
            graph={graph}
            focusedId={focusedId}
            onOpenScreen={openOnMap}
          />
        </PixelCascade>
      )}

      {!canvasReady &&
        (status === 'error' ? (
        <AtlasShell
          title="Couldn’t load this atlas"
          detail={error?.message}
          action={
            <Button onClick={actions.reload}>Try again</Button>
          }
        />
        ) : status === 'loading' || status === 'idle' ? (
          <AtlasShell title="Loading atlas…" />
        ) : (
          <AtlasShell
            title="No screens yet"
            detail={`“${snapshot?.project.name ?? 'This project'}” doesn’t have any screens mapped. Pick another project from Explore.`}
            action={
              <Button variant="accent" onClick={() => setNavOpen(true)}>
                Open Explore
              </Button>
            }
          />
        ))}

      {/* z-index 100 — fixed chrome floating above the plane */}
      <div className="dashboard__chrome">
        <header className="dashboard__topbar">
          <div className="dashboard__widget">
            {!navOpen && (
              <MinimisedFloatingMenu
                label={snapshot?.project.name ?? 'noon Atlas'}
                onClick={() => setNavOpen(true)}
              />
            )}
          </div>
          <div className="dashboard__widget dashboard__topbar-right">
            {/* Search sits quietly until wanted: a dim glyph that comes up to full
                strength on hover, with the shortcut in its tooltip. Reachable by
                mouse without adding another labelled control to the bar. */}
            {hasGraph && (
              <button
                type="button"
                className="atlas-search-trigger"
                onClick={() => setPaletteOpen(true)}
                aria-label="Search screens, flows and projects"
                title="Search  ⌘K"
              >
                <SearchGlyph />
              </button>
            )}
            <TopNav
              variant="right"
              screenCount={snapshot?.screens.length ?? 0}
              pathCount={snapshot?.flows.length ?? 0}
              onReset={hasGraph ? resetAtlas : undefined}
            />
          </div>
        </header>

        <div className="dashboard__widget dashboard__switch">
          <TopSwitch active={mode} onChange={hasGraph ? switchMode : undefined} />
        </div>

        {navOpen && (
          <div
            className={`dashboard__widget dashboard__sidenav${navClosing ? ' is-closing' : ''}`}
          >
            <Sidebar
              fill
              onToggle={closeNav}
              projects={projects}
              activeProjectId={projectId}
              onSelectProject={(id) => {
                actions.selectProject(id)
                closeNav()
              }}
            />
          </div>
        )}

        {/* The right panel is one slot with two occupants: a selected flow takes
            precedence over the focused screen, because clicking an edge is a more
            specific intent than having a screen focused. */}
        {mode === 'map' && focused && (
          <div className={`dashboard__widget dashboard__right-nav${panelVisible ? ' is-open' : ''}`}>
            <PanelSwap
              swapKey={
                selectedScreens.length > 1
                  ? `multi-${selectedScreens.length}`
                  : `screen-${focused?.id ?? 'none'}`
              }
            >
            {selectedScreens.length > 1 ? (
              <MultiSelectPanel
                screens={selectedScreens}
                metricsById={screenMetricsById}
                canDelete={!!snapshot && !selectedIds.has(snapshot.rootScreenId)}
                onAlign={(edge) => actions.alignSelection([...selectedIds], edge)}
                onDistribute={(axis) => actions.distributeSelection([...selectedIds], axis)}
                onDelete={deleteSelection}
                onFocusScreen={focusScreen}
                onClose={() => changeSelection(new Set())}
              />
            ) : (
              focused && (
                <RightNav
                  simulated={!!screenMetrics?.mocked}
                  title={focused.label}
                  screenId={focused.id}
                  src={focused.previewUrl ?? focused.imageUrl}
                  sections={focusedSections}
                  device={focused.device}
                  primary={toStatRows(screenMetrics, 'primary')}
                  secondary={toStatRows(screenMetrics, 'secondary')}
                  navigateTo={navigateTo}
                  reachedFrom={reachedFrom}
                  onRename={(label) => actions.renameScreen(focused.id, label)}
                  editing={renamingId === focused.id}
                  onEditingChange={(next) => setRenamingId(next ? focused.id : null)}
                  onSelectScreen={focusScreen}
                  onHoverSection={setSection}
                  onClose={() => setRightNavOpen(false)}
                />
              )
            )}
            </PanelSwap>
          </div>
        )}

        {mode === 'map' && hoveredSection && sectionMetrics && !selectedEdge && (
          <>
            <div
              className="dashboard__connector"
              style={{ top: connectorY, left: cardRightX, width: connectorWidth }}
            />
            <div className="dashboard__section-stats" style={{ top: statsTop }}>
              <StatsBar
                animate
                title={hoveredSection.name}
                primary={toStatRows(sectionMetrics, 'primary')}
                secondary={toStatRows(sectionMetrics, 'secondary')}
              />
            </div>
          </>
        )}

        {/* Zoom, bottom-right. Slides left of the inspector when it's open — the two
            share the 20px right inset, and the panel's lower corner reaches down into
            the bar's row. Undo/redo is keyboard-only (⌘Z / ⇧⌘Z, in the shortcut
            sheet); the destructive-edit toast below still carries a visible Undo. */}
        {mode === 'map' && canvasReady && (
          <div
            className={`dashboard__widget dashboard__zoombar${
              rightNavOpen && focused ? ' is-shifted' : ''
            }`}
          >
            <ZoomBar
              scale={zoom}
              onZoomIn={() => cameraRef.current?.zoomBy(1.6)}
              onZoomOut={() => cameraRef.current?.zoomBy(1 / 1.6)}
              onResetZoom={() => cameraRef.current?.zoomTo(1)}
              onFit={contentBounds ? () => cameraRef.current?.fitContent() : undefined}
            />
          </div>
        )}

        {/* The tool dial — summoned by right-clicking the plane, and the only tool
            touchpoint now that the command bar's chip is gone. Rendered as a sibling
            of the chrome because it opens anywhere on the plane and must not be
            clipped by, or positioned relative to, any bar. */}
        {mode === 'map' && (
          <DialMenu
            open={dial.open}
            at={dial.at}
            activeTool={effectiveTool}
            toggles={toggles}
            onSelect={handleTool}
            onClose={closeDial}
          />
        )}

        {/* Destructive-edit confirmation, anchored above the command bar.
            The panel animates its *children* rather than itself — this sits inside
            `.dashboard__chrome`, and a transform on the toast would establish a backdrop
            root and silently kill its own glass. */}
        <AnimatePresence>
        {notice && (
          <motion.div
            key="notice"
            className="dashboard__widget dashboard__notice"
            role="status"
            initial={{ opacity: 0, bottom: 12 }}
            animate={{ opacity: 1, bottom: 20 }}
            exit={{ opacity: 0, bottom: 12 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <span className="pixel dashboard__notice-text">{notice}</span>
            {history.canUndo && (
              <button
                type="button"
                className="tool-control dashboard__notice-undo"
                onClick={() => {
                  actions.undo()
                  setNotice(null)
                }}
              >
                <span className="pixel">Undo</span>
              </button>
            )}
          </motion.div>
        )}
        </AnimatePresence>

        {mode === 'map' && toggles.minimap && canvasReady && snapshot && graph && (
          <div className="dashboard__widget dashboard__minimap">
            <Minimap
              screens={snapshot.screens}
              flows={snapshot.flows}
              focusedId={focusedId}
              viewport={viewRect}
              onPan={(world, opts) => cameraRef.current?.panTo(world, opts)}
            />
          </div>
        )}

        {mode === 'map' && crumbs.length > 0 && (
          <div className="dashboard__widget dashboard__breadcrumbs">
            <BreadcrumbsTab items={crumbs} onSelect={focusScreen} />
          </div>
        )}
      </div>

      {/* Overlays sit above the chrome and outside its scaler, so they're always
          legible at their designed size regardless of --ui-scale. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        screens={snapshot?.screens ?? []}
        flows={snapshot?.flows ?? []}
        projects={projects}
        activeProjectId={projectId}
        commands={paletteCommands}
        onSelectScreen={openOnMap}
        onSelectFlow={(flowId, toId) => {
          switchMode('map')
          focusScreen(toId)
          selectFlow(flowId)
        }}
        onSelectProject={(id) => actions.selectProject(id)}
      />
      {/* Full stat set for the connector under the pointer. Suppressed while a panel
          swap is mid-flight or a board is being dragged, so it can't stack up on top of
          another transition. */}
      <AnimatePresence>
      {mode === 'map' && hoveredFlow && !cascading && (() => {
        const f = snapshot?.flows.find((x) => x.id === hoveredFlow.id)
        const from = f && snapshot?.screens.find((sc) => sc.id === f.from)
        const to = f && snapshot?.screens.find((sc) => sc.id === f.to)
        if (!f || !from || !to) return null
        return (
          <EdgeCard
            key={f.id}
            x={hoveredFlow.x}
            y={hoveredFlow.y}
            fromLabel={from.label}
            toLabel={to.label}
            action={f.action}
            metrics={flowMetricById.get(f.id) ?? null}
          />
        )
      })()}
      </AnimatePresence>

      <ShortcutSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />



      <LoadingOverlay
        progress={boot.progress}
        steps={boot.steps}
        activeLabel={boot.activeLabel}
        finished={boot.finished}
      />
    </div>
  )
}
