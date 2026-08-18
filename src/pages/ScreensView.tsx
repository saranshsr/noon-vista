import { useEffect, useMemo, useRef, useState } from 'react'

import { ScreenPlate } from '../components/ScreenPlate'
import { Button } from '../components/Button'
import { SegmentedControl } from '../molecules'
import { CategoryTree, type TreeSelection } from '../molecules/CategoryTree'
import { MaskIcon } from '../components/MaskIcon'
import { JourneyStrip } from '../molecules/JourneyStrip'
import type { AtlasSnapshot, FlowGraph, MetricScope, MetricSet, ScreenId } from '../domain'
import { buildCategoryTree, findJourney, formatMetric, screensInCategory } from '../domain'
import { useMetrics } from '../state/useMetrics'
import { motion } from 'motion/react'

/**
 * Screens mode — a structured browser over the app, after Mobbin.
 *
 * Three parts: a nested taxonomy rail, a Screens tab showing every artboard whole,
 * and a Flows tab showing one journey as an ordered filmstrip. The rail scopes both.
 *
 * This replaced a flat sortable grid of metric cards. That grid answered "which
 * screens carry the traffic?" and nothing else — there was no way to see what the app
 * *is*, which is the question a designer or a new PM opens the tool with, and the one
 * a 190px cropped thumbnail per card actively prevented. Sorting survives because the
 * analyst's question is still real, but it's no longer the only thing the surface can
 * do.
 *
 * One batched metrics read covers every screen, so sorting and hovering are both
 * instant rather than a fetch per plate.
 */

type SortKey = 'flow' | 'users' | 'atc' | 'gmv' | 'name'

const SORTS: { key: SortKey; label: string; metricKey?: string }[] = [
  // Default is the atlas's own order, not a metric: this is a browser first, and
  // opening on "highest traffic" silently editorialises the app's structure.
  { key: 'flow', label: 'Flow' },
  { key: 'users', label: 'Traffic', metricKey: 'users_per_day' },
  { key: 'atc', label: 'ATC', metricKey: 'overall_atc' },
  { key: 'gmv', label: 'GMV', metricKey: 'atc_gmv_per_day' },
  { key: 'name', label: 'A–Z' },
]

const TABS = ['Screens', 'Flows'] as const
type Tab = (typeof TABS)[number]

function metricValue(set: MetricSet | undefined, key: string): number {
  if (!set) return -Infinity
  return [...set.primary, ...set.secondary].find((m) => m.key === key)?.value ?? -Infinity
}

function metricDisplay(set: MetricSet | undefined, key: string): string | undefined {
  if (!set) return undefined
  const m = [...set.primary, ...set.secondary].find((x) => x.key === key)
  if (!m) return undefined
  // Grouped here rather than in the metric's own format: the inspector's rolling reel
  // is designed around an unbroken run of digits, but on a plate a bare `797400` is
  // just hard to read. Carrying numbers rather than strings is what makes this a
  // per-surface choice at all.
  if (m.format === 'int') return Math.round(m.value).toLocaleString('en-US')
  return formatMetric(m)
}

export function ScreensView({
  snapshot,
  graph,
  focusedId,
  onOpenScreen,
}: {
  snapshot: AtlasSnapshot
  graph: FlowGraph
  focusedId: ScreenId | null
  /** Open a screen on the Map — the browser is a way in, not a dead end. */
  onOpenScreen: (id: ScreenId) => void
}) {
  // Flows on arrival: the browser's headline is the named journeys through the app, and
  // the taxonomy rail is organised around them; landing on the flat screen grid buries
  // that. The Screens tab is one click away for anyone who wants the raw list.
  const [tab, setTab] = useState<Tab>('Flows')
  const [sort, setSort] = useState<SortKey>('flow')
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<TreeSelection>({ kind: 'all' })

  const tree = useMemo(() => buildCategoryTree(snapshot.journeys), [snapshot.journeys])

  // Top level open on arrival: a rail that starts fully collapsed shows six words and
  // hides the entire taxonomy behind six clicks.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(tree.map((n) => n.path)),
  )
  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  /**
   * Re-sorting plays out → swap → in, rather than the order snapping.
   *
   * `appliedSort` lags `sort` by the exit animation, so the plates you're watching
   * leave in the order you were reading; only once they're gone does the list
   * re-order. Without the lag they'd re-order first and it would read as a flicker.
   */
  const [appliedSort, setAppliedSort] = useState<SortKey>('flow')
  const [exiting, setExiting] = useState(false)
  const firstRender = useRef(true)

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (sort === appliedSort) return
    setExiting(true)
    const t = window.setTimeout(() => {
      setAppliedSort(sort)
      setExiting(false)
    }, 180 + 12 * 8)
    return () => window.clearTimeout(t)
  }, [sort, appliedSort])

  // Selecting a journey in the rail is a request to see that journey, so it carries
  // you to the tab that can show one. Leaving the user on the grid after clicking a
  // named flow makes the rail feel broken.
  useEffect(() => {
    if (selection.kind === 'journey') setTab('Flows')
  }, [selection])

  const scopes = useMemo<MetricScope[]>(
    () => snapshot.screens.map((s) => ({ kind: 'screen', screenId: s.id })),
    [snapshot.screens],
  )
  // No `loading` flag needed: a plate with no metrics yet simply renders no stat grid,
  // and the panel is hover-only anyway — a row of em-dashes would be worse than nothing.
  const { data: metrics } = useMetrics(scopes)

  const byScreenId = useMemo(() => {
    const map = new Map<ScreenId, MetricSet>()
    for (const set of metrics ?? []) {
      if (set.scope.kind === 'screen') map.set(set.scope.screenId, set)
    }
    return map
  }, [metrics])

  const selectedJourney =
    selection.kind === 'journey' ? findJourney(snapshot.journeys, selection.id) : undefined

  const plates = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = snapshot.screens

    // The rail scopes the grid. A journey selection narrows it to that journey's
    // screens, which is what makes the two tabs views of one selection rather than
    // two unrelated pages.
    if (selection.kind === 'category') {
      const allowed = screensInCategory(snapshot.journeys, selection.path)
      list = list.filter((s) => allowed.has(s.id))
    } else if (selection.kind === 'journey' && selectedJourney) {
      const allowed = new Set(selectedJourney.screenIds)
      list = list.filter((s) => allowed.has(s.id))
    }

    if (q) list = list.filter((s) => s.label.toLowerCase().includes(q))

    const active = SORTS.find((s) => s.key === appliedSort)!
    return [...list].sort((a, b) => {
      if (appliedSort === 'flow') return a.order - b.order
      if (appliedSort === 'name') return a.label.localeCompare(b.label)
      return (
        metricValue(byScreenId.get(b.id), active.metricKey!) -
        metricValue(byScreenId.get(a.id), active.metricKey!)
      )
    })
  }, [snapshot.screens, snapshot.journeys, selection, selectedJourney, query, appliedSort, byScreenId])

  const journeysShown = useMemo(() => {
    if (selection.kind === 'all') return snapshot.journeys
    if (selection.kind === 'journey') return selectedJourney ? [selectedJourney] : []
    return snapshot.journeys.filter((j) => {
      const key = j.categoryPath.join('/')
      return key === selection.path || key.startsWith(`${selection.path}/`)
    })
  }, [snapshot.journeys, selection, selectedJourney])

  /**
   * Every metric the repository returns for a screen, flattened to one list.
   *
   * The `primary` / `secondary` split is collapsed deliberately. Those groups exist for
   * the inspector, where there's room to lead with something; on a hover panel the
   * split produced a 19px Users-per-day above six figures that read as footnotes, which
   * asserts a ranking the data doesn't support — within one screen all seven are
   * things somebody came here to read.
   */
  const plateStats = (id: ScreenId) => {
    const set = byScreenId.get(id)
    if (!set) return []
    return [...set.primary, ...set.secondary].map((m) => ({
      label: m.label,
      value: metricDisplay(set, m.key) ?? '—',
    }))
  }

  return (
    <div className="browser">
      <aside className="browser__rail">
        {/* A search *section*, not a lone input: a labelled field with a magnifier and an
            inline clear affordance, so it reads as the way to filter the browser rather
            than an anonymous text box at the top of the rail. */}
        <div className="browser__search-field">
          <svg
            className="browser__search-icon"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.4" />
            <line x1="9.4" y1="9.4" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            className="pixel browser__search"
            type="search"
            placeholder={tab === 'Screens' ? 'Search screens…' : 'Search flows…'}
            aria-label="Search the browser"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="browser__search-clear"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              <MaskIcon src="/icons/close.svg" width={9} height={9} color="currentColor" />
            </button>
          )}
        </div>
        <CategoryTree
          tree={tree}
          allCount={tab === 'Screens' ? snapshot.screens.length : snapshot.journeys.length}
          expanded={expanded}
          selection={selection}
          onToggle={toggle}
          onSelect={setSelection}
        />
      </aside>

      <main className="browser__main">
        <header className="browser__head">
          <SegmentedControl
            width={200}
            height={34}
            tone="accent"
            ariaLabel="Browse mode"
            borderColor="rgba(255, 255, 255, 0.12)"
            segments={TABS.map((t) => ({ label: t, selected: t === tab }))}
            onSelect={(i) => setTab(TABS[i])}
          />

          <div className="browser__head-right">
            {tab === 'Screens' && (
              <SegmentedControl
                width={300}
                height={34}
                tone="accent"
                ariaLabel="Sort screens"
                borderColor="rgba(255, 255, 255, 0.12)"
                segments={SORTS.map((s) => ({ label: s.label, selected: s.key === sort }))}
                onSelect={(i) => setSort(SORTS[i].key)}
              />
            )}
            <span className="pixel browser__showing">
              {tab === 'Screens'
                ? `Showing\n${plates.length} of ${snapshot.screens.length} screens`
                : `Showing\n${journeysShown.length} flow${journeysShown.length === 1 ? '' : 's'}`}
            </span>
          </div>
        </header>

        {tab === 'Screens' ? (
          plates.length === 0 ? (
            <div className="browser__empty">
              <span className="pixel-square">
                {query ? `No screens match “${query}”` : 'No screens in this category yet'}
              </span>
              {query && <Button onClick={() => setQuery('')}>Clear search</Button>}
            </div>
          ) : (
            <div className={`browser__grid${exiting ? ' is-exiting' : ''}`}>
              {plates.map((screen, i) => (
                /* `layout` animates re-flow: filtering or re-sorting used to teleport
                   every surviving plate to its new slot. Transforms are fine on
                   plates — they carry no glass. */
                <motion.div
                  key={screen.id}
                  layout
                  transition={{ type: 'spring', visualDuration: 0.3, bounce: 0.12 }}
                >
                <ScreenPlate
                  label={screen.label}
                  imageUrl={screen.imageUrl}
                  selected={screen.id === focusedId}
                  // Staggered by position so the wave crosses the grid, capped so a
                  // large project doesn't end with a plate waiting half a second.
                  delayMs={Math.min(i * 12, 220)}
                  onClick={() => onOpenScreen(screen.id)}
                  stats={plateStats(screen.id)}
                />
                </motion.div>
              ))}
            </div>
          )
        ) : selectedJourney ? (
          <JourneyStrip
            journey={selectedJourney}
            graph={graph}
            metricFor={(id) => byScreenId.get(id)}
            focusedId={focusedId}
            onOpenScreen={onOpenScreen}
          />
        ) : journeysShown.length === 0 ? (
          <div className="browser__empty">
            <span className="pixel-square">No flows documented here yet</span>
          </div>
        ) : (
          /* No single journey picked, so stack them — the overview Mobbin gives you
             before you commit to one flow. */
          <div className="browser__strips">
            {journeysShown.map((j) => (
              <JourneyStrip
                key={j.id}
                journey={j}
                graph={graph}
                metricFor={(id) => byScreenId.get(id)}
                focusedId={focusedId}
                onOpenScreen={onOpenScreen}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
