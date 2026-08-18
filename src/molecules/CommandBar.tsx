import { CornerBrackets } from '../components/CornerBrackets'
import { Tip } from '../components/Tip'

/**
 * The zoom bar — bottom-right, and only zoom.
 *
 * This used to be a bottom-centre command bar carrying the tool chip, undo/redo and
 * zoom. It shrank on purpose, one decision per control:
 *
 *  · **The tool chip went** because the dial is the tool switcher and two touchpoints
 *    for the same tools meant neither read as canonical. Right-click summons the dial
 *    at the cursor; the shortcut sheet (?) documents it. The cost — no persistent
 *    active-tool indicator — was accepted deliberately.
 *  · **Undo/redo went keyboard-only** (⌘Z / ⇧⌘Z). The risky cases keep a visible
 *    affordance regardless: destructive edits raise a toast that carries its own Undo
 *    button. What was lost is only the buttons, not the capability.
 *  · **Zoom stayed** because `−  78%  +` is a stateful numeric readout with a stepper,
 *    and burying zoom was already tried once — the plan records the HUD being disabled
 *    and having to be brought back, because it left the product with no zoom control
 *    anywhere. The readout doubles as reset-to-100%, fit-all frames everything.
 *
 * `TOOLS` still lives in this module because it is the single source of truth for the
 * glyphs, labels, hints and disabled reasons that the dial renders.
 *
 * Tools that aren't wired yet stay `disabled` with an explanatory tooltip rather than
 * omitted or — worse — present and inert. A visible, honestly-disabled control tells you
 * the capability is planned; a control that silently does nothing is the exact failure
 * this whole project started out fixing.
 */

export type ToolId =
  | 'select'
  | 'pan'
  | 'addScreen'
  | 'drawFlow'
  | 'delete'
  | 'isolate'
  | 'filter'
  | 'minimap'
  | 'snap'
  | 'undo'
  | 'redo'

export type Tool = {
  id: ToolId
  label: string
  /**
   * One-word form for the dial's 64px tiles.
   *
   * The full labels are written for a tooltip, where "Isolate neighbourhood" is the right
   * amount of detail. On a tile they ellipsise to "ISOLATE NEIGH…", which is worse than
   * either the long or the short version. Absent means `label` already fits.
   */
  short?: string
  /** Keyboard hint shown in the tooltip. */
  hint?: string
  glyph: React.ReactNode
  /** Not yet implemented — rendered disabled, with `why` in the tooltip. */
  why?: string
}

/**
 * Glyphs.
 *
 * Sourced from Lucide via the `better-icons` CLI (Iconify), which is why every path here is
 * on a 24×24 grid rather than the 14×14 the hand-drawn marks used. Three normalisations were
 * applied to the fetched output:
 *
 *  · `stroke-width` dropped from Lucide's default 2 to 1.5 — 2 reads heavy against this
 *    app's hairline borders and 1px plus-grid.
 *  · Inner `fill="currentColor"` attributes stripped. Iconify emits them on grouped shapes
 *    (the git-branch circles, the square-plus and grid rects), and left in place they fill
 *    those shapes solid, turning a line icon into a blob.
 *  · No intrinsic `width`/`height`, so size is driven by CSS — the dial renders them at 20px
 *    and the bar's mode chip at 14px from the same source.
 */
const S = {
  stroke: 'currentColor',
  strokeWidth: 1.5,
  fill: 'none',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** Every glyph shares one box, so they optically match at any rendered size. */
function Ico({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden>
      <g {...S}>{children}</g>
    </svg>
  )
}

/** Exported so the dial can reuse `close` for its exit without a second copy. */
export const Glyphs = {
  // lucide:mouse-pointer-2
  select: (
    <Ico>
      <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
    </Ico>
  ),
  // lucide:move
  pan: (
    <Ico>
      <path d="M12 2v20m3-3l-3 3l-3-3M19 9l3 3l-3 3M2 12h20M5 9l-3 3l3 3M9 5l3-3l3 3" />
    </Ico>
  ),
  // lucide:square-plus
  addScreen: (
    <Ico>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M8 12h8m-4-4v8" />
    </Ico>
  ),
  // lucide:git-branch
  drawFlow: (
    <Ico>
      <path d="M15 6a9 9 0 0 0-9 9V3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </Ico>
  ),
  // lucide:trash-2
  delete: (
    <Ico>
      <path d="M10 11v6m4-6v6m5-11v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Ico>
  ),
  // lucide:scan
  isolate: (
    <Ico>
      <path d="M3 7V5a2 2 0 0 1 2-2h2m10 0h2a2 2 0 0 1 2 2v2m0 10v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
    </Ico>
  ),
  // lucide:filter
  filter: (
    <Ico>
      <path d="M22 3H2l8 9.46V19l4 2v-8.54z" />
    </Ico>
  ),
  // lucide:map
  minimap: (
    <Ico>
      <path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0zm.894.211v15M9 3.236v15" />
    </Ico>
  ),
  // lucide:grid-3x3
  snap: (
    <Ico>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18m6-18v18" />
    </Ico>
  ),
  // lucide:undo-2
  undo: (
    <Ico>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    </Ico>
  ),
  // lucide:redo-2
  redo: (
    <Ico>
      <path d="m15 14l5-5l-5-5" />
      <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />
    </Ico>
  ),
  // lucide:maximize
  fit: (
    <Ico>
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3" />
    </Ico>
  ),
  // lucide:x — the dial's exit
  close: (
    <Ico>
      <path d="M18 6L6 18M6 6l12 12" />
    </Ico>
  ),
}

export const TOOLS: Tool[] = [
  { id: 'select', label: 'Select', hint: 'V', glyph: Glyphs.select },
  { id: 'pan', label: 'Pan', hint: 'Space / drag', glyph: Glyphs.pan },
  { id: 'isolate', label: 'Isolate neighbourhood', short: 'Isolate', hint: 'I', glyph: Glyphs.isolate },
  { id: 'minimap', label: 'Minimap', hint: 'O', glyph: Glyphs.minimap },
  { id: 'snap', label: 'Snap to grid', short: 'Snap', hint: 'G', glyph: Glyphs.snap },
  {
    id: 'filter',
    label: 'Filter by metric',
    short: 'Filter',
    glyph: Glyphs.filter,
    why: 'Metric filtering isn’t built yet',
  },
  {
    id: 'addScreen',
    label: 'Add screen',
    short: 'Add',
    glyph: Glyphs.addScreen,
    why: 'Needs artboard upload, which needs a backend',
  },
  // Live. Drag from one board to another to draw an edge; the Trigger is authored in the
  // edge inspector afterward. `createFlow` shipped in the repo in Phase 0.
  { id: 'drawFlow', label: 'Draw flow', short: 'Flow', hint: 'drag board → board', glyph: Glyphs.drawFlow },
  // Live. `deleteScreen` (with its flow cascade) has been implemented in the repository
  // since Phase 0 — the blocker was never a backend, it was that undo covered only position
  // moves, so a delete would have been unrecoverable. See `AtlasEdit` in AtlasProvider.
  { id: 'delete', label: 'Delete selection', short: 'Delete', hint: '⌫', glyph: Glyphs.delete },
]

export function ZoomBar({
  scale,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFit,
}: {
  scale: number
  onZoomIn: () => void
  onZoomOut: () => void
  onResetZoom: () => void
  onFit?: () => void
}) {
  return (
    <div className="zoombar" onPointerDown={(e) => e.stopPropagation()}>
      <Tip label="Zoom out  −">
        <button
          type="button"
          className="zoombar__tool has-brackets"
          onClick={onZoomOut}
          aria-label="Zoom out"
        >
          <CornerBrackets />
          <span className="zoombar__glyph">−</span>
        </button>
      </Tip>
      <Tip label="Reset zoom  0">
        <button
          type="button"
          className="zoombar__readout"
          onClick={onResetZoom}
          aria-label="Reset zoom to 100%"
        >
          {Math.round(scale * 100)}%
        </button>
      </Tip>
      <Tip label="Zoom in  +">
        <button
          type="button"
          className="zoombar__tool has-brackets"
          onClick={onZoomIn}
          aria-label="Zoom in"
        >
          <CornerBrackets />
          <span className="zoombar__glyph">+</span>
        </button>
      </Tip>
      {onFit && (
        <button
          type="button"
          className="zoombar__tool has-brackets"
          onClick={onFit}
          aria-label="Fit all screens"
          title="Fit all screens  1"
        >
          <CornerBrackets />
          {Glyphs.fit}
        </button>
      )}
    </div>
  )
}
