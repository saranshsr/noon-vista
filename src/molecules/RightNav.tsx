import { useEffect, useRef, useState } from 'react'
import { DeviceSize } from '../components/DeviceSize'
import { RollingNumber } from '../components/RollingNumber'
import { MaskIcon } from '../components/MaskIcon'
import { CornerBrackets } from '../components/CornerBrackets'
import { MasterImage } from './MasterImage'
import type { HoveredSection } from './MasterImage'
import { SegmentedControl } from './SegmentedControl'
import type { Device, ScreenId, Section } from '../domain/types'
import { AnimatePresence, motion } from 'motion/react'

/**
 * The single column width (Device Size + tabs are 299/300 in Figma).
 *
 * The panel used to be two columns — a 240px preview beside a 299px stat column — with the
 * preview height pinned to the viewport. Now that it's one vertical column the preview takes
 * the full content width and its height comes from the artboard's own aspect, so the old
 * `PREVIEW_W`/`PREVIEW_H` pair is gone; see `naturalH` and `windowH` in the component.
 */
const CONTENT_W = 299

const PINK = '#F7306F'

type Stat = { label: string; value: string }

/** A neighbouring screen reachable across one flow, with that flow's numbers. */
export type NeighbourRow = {
  screenId: ScreenId
  label: string
  /** Artboard image, shown as a phone-aspect crop so the list reads as screens. */
  imageUrl?: string
  /** Headline flow metric, pre-formatted (e.g. users/day). */
  value?: string
  /** Secondary flow metric (e.g. share of source). */
  sub?: string
}

const GROUP_A: Stat[] = [
  { label: 'Users per day', value: '583097' },
  { label: 'Impressions', value: '100.0%' },
]

const GROUP_B: Stat[] = [
  { label: 'GP of page', value: '0.67' },
  { label: 'Overall ATC', value: '0.89%' },
  { label: 'atc_gmv_per_user', value: '375.53 ' },
  { label: 'atc_gmv_per_day', value: '1,948,837' },
  { label: 'Monetisation_per_day', value: '380,000' },
]

/**
 * The two headline numbers, as blocks.
 *
 * Previously every stat — headline and detail alike — was an identical `Row` with a
 * rolling reel, so seven values competed at one weight and none of them led. The
 * primaries now get size and their own surface; the details drop to quiet rows. This
 * is deliberately the same grammar as `EdgeInspector`, so the panel reads consistently
 * whether you have a screen or a flow selected.
 */
function PrimaryStats({ stats }: { stats: Stat[] }) {
  if (stats.length === 0) return null
  return (
    <div className="inspector__pair" style={{ width: CONTENT_W }}>
      {stats.map((s) => (
        <div key={s.label} className="inspector__stat">
          <span className="pixel inspector__stat-value">
            <RollingNumber value={s.value} />
          </span>
          <span className="pixel-line inspector__stat-label">{s.label}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Detail rows. No reels: seven simultaneously-animating values is noise, and these
 * are read rather than watched.
 */
function SecondaryStats({ stats }: { stats: Stat[] }) {
  if (stats.length === 0) return null
  return (
    <div className="inspector__rows" style={{ width: CONTENT_W }}>
      {stats.map((s, i) => (
        /* Rows land in reading order, 25ms apart — enough to give the list a
           direction, not enough to make anyone wait. Transforms are fine HERE:
           these are children inside the glass, not ancestors of it. */
        <motion.div
          key={s.label}
          className="inspector__row"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: 'easeOut', delay: i * 0.025 }}
        >
          <span className="pixel-line inspector__row-label">{s.label}</span>
          <span className="pixel inspector__row-value">{s.value}</span>
        </motion.div>
      ))}
    </div>
  )
}

/**
 * The list behind the "Navigate to" / "Reached from" tabs.
 *
 * These two tabs existed in the design and rendered as inert `<div>`s — the data
 * to fill them (the directed flow graph) was already in the file, just never
 * queried. Each row is the neighbouring screen plus that connector's own traffic,
 * and tapping one focuses it on the canvas.
 */
function NeighbourList({
  rows,
  emptyLabel,
  onSelect,
}: {
  rows: NeighbourRow[]
  emptyLabel: string
  onSelect?: (id: ScreenId) => void
}) {
  if (rows.length === 0) {
    return (
      <div style={{ width: CONTENT_W, padding: '4px 2px' }}>
        <span
          className="pixel-line"
          style={{ fontSize: 13, lineHeight: '20px', color: 'rgba(255, 255, 255, 0.4)' }}
        >
          {emptyLabel}
        </span>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: CONTENT_W }}>
      {rows.map((r) => (
        <div
          key={r.screenId}
          className={`neighbour-row${onSelect ? ' is-interactive has-brackets' : ''}`}
          role={onSelect ? 'button' : undefined}
          tabIndex={onSelect ? 0 : undefined}
          onClick={onSelect ? () => onSelect(r.screenId) : undefined}
          onKeyDown={
            onSelect
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(r.screenId)
                  }
                }
              : undefined
          }
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '8px 6px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
            cursor: onSelect ? 'pointer' : 'default',
          }}
        >
          {onSelect && <CornerBrackets />}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            {r.imageUrl && (
              <span className="neighbour-row__thumb">
                <img src={r.imageUrl} alt="" loading="lazy" decoding="async" draggable={false} />
              </span>
            )}
            <span
              className="pixel"
              style={{
                fontSize: 13,
                lineHeight: '20px',
                color: '#FFFFFF',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
              }}
            >
              {r.label}
            </span>
          </span>
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}
          >
            {r.value && (
              <span
                className="pixel"
                style={{
                  fontSize: 13,
                  lineHeight: '20px',
                  color: 'rgba(255, 255, 255, 0.8)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {r.value}
              </span>
            )}
            {r.sub && (
              <span
                className="pixel"
                style={{
                  fontSize: 11,
                  lineHeight: '20px',
                  color: PINK,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {r.sub}
              </span>
            )}
            <MaskIcon src="/icons/chevron-right.svg" width={14} height={14} color="rgba(255,255,255,0.4)" />
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * The screen's name, editable in place.
 *
 * Edited here in 1:1 chrome rather than on the board itself. A world-space `<input>` sits
 * under the canvas's `transform: scale()`, where the caret renders blurry at non-integer
 * scales and selection/IME behave badly — and the label is ~3px tall at fit-all zoom
 * anyway. Editing in the panel is both better-looking and free.
 *
 * `blur` commits and `Escape` reverts, which is what people expect from a rename: clicking
 * away is an accept, not a cancel.
 */
function ScreenTitle({
  title,
  onRename,
  editing,
  onEditingChange,
}: {
  title: string
  onRename?: (label: string) => void
  editing: boolean
  onEditingChange?: (editing: boolean) => void
}) {
  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Re-seed when the editor opens or the focused screen changes under it, so the draft can
  // never show a stale name from a previously-edited screen.
  useEffect(() => {
    if (editing) setDraft(title)
  }, [editing, title])

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const commit = () => {
    const next = draft.trim()
    if (next && next !== title) onRename?.(next)
    onEditingChange?.(false)
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="rightnav__title"
        onClick={onRename ? () => onEditingChange?.(true) : undefined}
        disabled={!onRename}
        title={onRename ? 'Rename \u2014 or double-click the board' : undefined}
      >
        <span className="pixel-square">{title}</span>
      </button>
    )
  }

  return (
    <input
      ref={inputRef}
      className="pixel-square rightnav__title-input"
      value={draft}
      aria-label="Screen name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        // Kept off the global hotkeys: Escape would otherwise also close the panel behind
        // the editor, and Enter belongs to the field.
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setDraft(title)
          onEditingChange?.(false)
        }
      }}
    />
  )
}

type InspectorTab = 'stats' | 'navigateTo' | 'reachedFrom'

/**
 * Figma: Right Nav (node 27:32356).
 * Glass inspector panel: white/4% fill, 1px white/8% border, backdrop blur(4px),
 * radius 16, column padding 20 / gap 20. Header (title + close) · Device Size ·
 * screen preview · tab strip · stat groups.
 *
 * Height is variable: the panel fills whatever height its parent gives it
 * (viewport minus the top bar, on the dashboard). The header is pinned; the body
 * below flexes to fill the space left and scrolls when the content overflows.
 * When the parent is unbounded (e.g. the gallery) the panel hugs its content.
 */
type RightNavProps = {
  /** forwarded to the preview — hover a section block (null on leave) */
  onHoverSection?: (info: HoveredSection | null) => void
  /** title + preview image of the artboard currently in focus on the canvas */
  title?: string
  /** Commit a new label. Absent → the title is read-only. */
  onRename?: (label: string) => void
  /** Controlled, so a double-click on the board can open the editor from outside. */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  src?: string
  /** hover targets for the previewed screen; empty for screens without sections */
  sections?: Section[]
  /**
   * The previewed screen's device. Comes from the snapshot rather than being
   * hardcoded — the previous literal read "iphone 13 Pro / 375 x 812" while the
   * assets are 400×865, so the panel was stating a wrong fact about every screen.
   */
  device?: Device
  /** per-artboard stat groups (roll to fresh values as the focus changes) */
  primary?: Stat[]
  secondary?: Stat[]
  /** outbound / inbound neighbours for the two flow tabs */
  navigateTo?: NeighbourRow[]
  reachedFrom?: NeighbourRow[]
  /** tap a neighbour → focus that screen */
  onSelectScreen?: (id: ScreenId) => void
  /** the screen being inspected — resets the tab when the focus changes */
  screenId?: ScreenId
  /** close icon → slide the panel out */
  onClose?: () => void
}

const FALLBACK_DEVICE: Device = { name: 'Artboard', width: 400, height: 865 }

/**
 * Device viewports the preview can be windowed to.
 *
 * What the selector actually does, and why that's honest: the artboards are *full-page*
 * screenshots — 400×865 here, and 430×7800 for the homepage — not device-sized captures.
 * So a device picker can't legitimately claim "this is how the screen renders on an
 * iPhone 13 Pro". What it can answer, truthfully and usefully, is **how much of the page
 * falls above the fold on that device**: the image is always drawn at its own true aspect
 * and the *window over it* changes. Nothing is ever rescaled or restated as a different
 * resolution.
 *
 * The sizes are logical CSS viewports. Note 13 Pro is 390×844 — the 375×812 often labelled
 * as such is the iPhone X / 11 Pro / 12 mini.
 */
const VIEWPORTS = [
  { name: 'Artboard', width: 400, height: 865, native: true },
  { name: 'iPhone SE', width: 375, height: 667, native: false },
  { name: 'iPhone 13 Pro', width: 390, height: 844, native: false },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932, native: false },
  { name: 'Pixel 7', width: 412, height: 915, native: false },
]

export function RightNav({
  onHoverSection,
  title = 'Homepage',
  onRename,
  editing = false,
  onEditingChange,
  src,
  sections,
  device = FALLBACK_DEVICE,
  primary = GROUP_A,
  secondary = GROUP_B,
  navigateTo = [],
  reachedFrom = [],
  onSelectScreen,
  screenId,
  onClose,
}: RightNavProps) {
  const [tab, setTab] = useState<InspectorTab>('stats')
  /** Which device viewport the preview is windowed to. 0 is the artboard's own size. */
  const [vp, setVp] = useState(0)
  const [vpOpen, setVpOpen] = useState(false)

  /** The pane's content height — the morph target. 'auto' until first measure. */
  const [paneHeight, setPaneHeight] = useState<number | 'auto'>('auto')
  const paneInnerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = paneInnerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setPaneHeight(el.offsetHeight))
    ro.observe(el)
    setPaneHeight(el.offsetHeight)
    return () => ro.disconnect()
  }, [tab])

  // Moving to another screen should land on its stats, not leave you looking at a
  // neighbour list you opened for the previous one.
  useEffect(() => setTab('stats'), [screenId])

  const TABS: InspectorTab[] = ['stats', 'navigateTo', 'reachedFrom']

  /** The artboard at its true aspect — never squashed, only ever windowed. */
  const naturalH = Math.round(CONTENT_W * (device.height / device.width))
  const chosen = VIEWPORTS[vp]
  const windowH = chosen.native
    ? naturalH
    : Math.round(CONTENT_W * (chosen.height / chosen.width))

  useEffect(() => {
    if (!vpOpen) return
    const close = () => setVpOpen(false)
    const t = window.setTimeout(() => window.addEventListener('mousedown', close), 10)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('mousedown', close)
    }
  }, [vpOpen])

  return (
    <div className="tool-surface rightnav">
      {/*
        One vertical column, with a fixed head and a scrolling tail.
        The head is everything that must survive any viewport height — title, device, the
        two headline numbers, and the tabs. The tail is the preview and the long stat list.

        The headline pair sits ABOVE the preview deliberately. A full-aspect phone preview is
        647px tall on its own, and the panel caps at `100vh - 82px` (817px at 900), so with
        the preview first there is no arrangement in which a stat lands in the first fold —
        the chrome and the image alone overrun the panel. Putting the two numbers that matter
        above the image guarantees them at any height, and costs only that the artboard now
        starts a little lower.
      */}
      <div className="rightnav__head">
        <div className="rightnav__header">
          <ScreenTitle
            title={title}
            onRename={onRename}
            editing={editing}
            onEditingChange={onEditingChange}
          />
          <button
            type="button"
            className="rightnav__close"
            onClick={onClose}
            aria-label={onClose ? 'Close panel' : undefined}
            disabled={!onClose}
          >
            <MaskIcon src="/icons/close.svg" width={11} height={11} color="#FFFFFF" />
          </button>
        </div>

        {/* Real selector now — the chevron appears because there is a menu behind it.
            Choosing a device re-windows the preview below; see `VIEWPORTS`. */}
        <div className="rightnav__device">
          <DeviceSize
            device={chosen.native ? device.name : chosen.name}
            dimensions={
              chosen.native ? `${device.width} x ${device.height}` : `${chosen.width} x ${chosen.height}`
            }
            width={CONTENT_W}
            onClick={() => setVpOpen((o) => !o)}
          />
          <AnimatePresence>
          {vpOpen && (
            <motion.div
              className="rightnav__device-menu"
              role="menu"
              onMouseDown={(e) => e.stopPropagation()}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: 'easeOut' }}
            >
              {VIEWPORTS.map((v, i) => (
                <button
                  key={v.name}
                  type="button"
                  role="menuitemradio"
                  aria-checked={i === vp}
                  className={`rightnav__device-item${i === vp ? ' is-on' : ''}`}
                  onClick={() => {
                    setVp(i)
                    setVpOpen(false)
                  }}
                >
                  <span className="pixel-line">{v.name}</span>
                  <span className="pixel rightnav__device-dims">
                    {v.native ? `${device.width} × ${device.height}` : `${v.width} × ${v.height}`}
                  </span>
                </button>
              ))}
              {/* States the compromise rather than hiding it. */}
              <span className="pixel-line rightnav__device-note">
                Windows the page — never rescales it
              </span>
            </motion.div>
          )}
          </AnimatePresence>
        </div>

        {/* The first-fold guarantee. */}
        {tab === 'stats' && <PrimaryStats stats={primary} />}

        {/* Tab strip (Figma 54:80782) — one SegmentedControl, not a hand-rolled dupe. */}
        <SegmentedControl
          width={CONTENT_W}
          height={36}
          tone="accent"
          ariaLabel="Screen details"
          borderColor="rgba(255, 255, 255, 0.12)"
          dividerAfter={[1]}
          dividerColor="rgba(255, 255, 255, 0.12)"
          segments={[
            { label: 'Page Stats', selected: tab === 'stats' },
            { label: 'Navigate to', selected: tab === 'navigateTo' },
            { label: 'Reached from', selected: tab === 'reachedFrom' },
          ]}
          onSelect={(i) => setTab(TABS[i])}
        />
      </div>

      {/* Keyed on the tab so the pane re-mounts and replays its entrance. */}
      {/* The pane's height is animated to its content: switching from a tall stat
          list to a two-row "Navigate to" used to snap the card short. The OUTER div
          persists across tabs and morphs; the INNER keyed div remounts so the
          pane-in entrance still replays per tab. Height, not transform — the card
          is glass. */}
      <motion.div
        className="rightnav__pane"
        style={{ width: CONTENT_W }}
        animate={{ height: paneHeight }}
        initial={false}
        transition={{ type: 'spring', visualDuration: 0.32, bounce: 0.1 }}
      >
        <div className="inspector-pane" key={tab} ref={paneInnerRef}>
        {tab === 'stats' && (
          <>
            {/* The artboard, windowed to the chosen device. The image keeps its own aspect
                and the wrapper clips — so the fold is real and the page is never squashed.
                This is also the only surface where a screen's sections are hoverable. */}
            <div
              className={`rightnav__viewport${chosen.native ? '' : ' is-windowed'}`}
              style={{ height: windowH }}
            >
              <MasterImage
                width={CONTENT_W}
                height={naturalH}
                src={src}
                alt={title}
                sections={sections}
                onHoverSection={onHoverSection}
              />
            </div>
            {!chosen.native && (
              <span className="pixel-line rightnav__fold-note">
                Fold at {chosen.height}px on {chosen.name}
              </span>
            )}
            <SecondaryStats stats={secondary} />
          </>
        )}
        {tab === 'navigateTo' && (
          <NeighbourList
            rows={navigateTo}
            emptyLabel="This screen doesn’t link anywhere yet."
            onSelect={onSelectScreen}
          />
        )}
        {tab === 'reachedFrom' && (
          <NeighbourList
            rows={reachedFrom}
            emptyLabel="No screens link here — this is an entry point."
            onSelect={onSelectScreen}
          />
        )}
        </div>
      </motion.div>
    </div>
  )
}
