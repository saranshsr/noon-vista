import { useEffect, useMemo, useRef, useState } from 'react'

import type { Flow, Project, Screen, ScreenId } from '../domain/types'
import { AnimatePresence, motion } from 'motion/react'

export type PaletteAction =
  | { kind: 'screen'; id: ScreenId; label: string; hint?: string }
  | { kind: 'flow'; id: string; label: string; hint?: string; toId: ScreenId }
  | { kind: 'project'; id: string; label: string; hint?: string }
  | { kind: 'command'; id: string; label: string; hint?: string; run: () => void }

type CommandPaletteProps = {
  open: boolean
  onClose: () => void
  screens: Screen[]
  flows: Flow[]
  projects: Project[]
  activeProjectId?: string | null
  commands?: Array<{ id: string; label: string; hint?: string; run: () => void }>
  onSelectScreen: (id: ScreenId) => void
  onSelectFlow: (flowId: string, toId: ScreenId) => void
  onSelectProject: (id: string) => void
}

/**
 * ⌘K over everything addressable.
 *
 * At 17 screens this is a convenience; the design already assumes it won't stay
 * that way (`TopNav`'s own placeholder counts are 48 screens / 121 paths), and at
 * that size hunting the canvas by eye stops working. Flows are searchable too, since
 * "where does checkout leak?" is a question about an edge, not a screen.
 */
export function CommandPalette({
  open,
  onClose,
  screens,
  flows,
  projects,
  activeProjectId,
  commands = [],
  onSelectScreen,
  onSelectFlow,
  onSelectProject,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset and focus each time it opens, so it never reopens mid-search.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    // rAF so focus lands after the element is actually in the layout.
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  const screenById = useMemo(() => new Map(screens.map((s) => [s.id, s])), [screens])

  const results = useMemo<PaletteAction[]>(() => {
    const all: PaletteAction[] = [
      ...commands.map((c) => ({ kind: 'command' as const, ...c })),
      ...screens.map((s) => ({
        kind: 'screen' as const,
        id: s.id,
        label: s.label,
        hint: 'Screen',
      })),
      ...flows.flatMap((f) => {
        const from = screenById.get(f.from)
        const to = screenById.get(f.to)
        if (!from || !to) return []
        return [
          {
            kind: 'flow' as const,
            id: f.id,
            label: `${from.label} → ${to.label}`,
            hint: 'Flow',
            toId: to.id,
          },
        ]
      }),
      ...projects
        .filter((p) => p.id !== activeProjectId)
        .map((p) => ({
          kind: 'project' as const,
          id: p.id,
          label: p.name,
          hint: p.seeded ? (p.kind === 'pod' ? 'Pod' : 'Project') : 'Empty',
        })),
    ]

    const q = query.trim().toLowerCase()
    if (!q) return all.slice(0, 40)
    return all
      .map((a) => ({ a, score: score(a.label.toLowerCase(), q) }))
      .filter((r) => r.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, 40)
      .map((r) => r.a)
  }, [commands, screens, flows, projects, activeProjectId, query, screenById])

  // Clamp the cursor when the result set shrinks under it.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)))
  }, [results.length])

  // Keep the highlighted row in view when navigating by keyboard.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])


  const commit = (action: PaletteAction | undefined) => {
    if (!action) return
    switch (action.kind) {
      case 'screen':
        onSelectScreen(action.id)
        break
      case 'flow':
        onSelectFlow(action.id, action.toId)
        break
      case 'project':
        onSelectProject(action.id)
        break
      case 'command':
        action.run()
        break
    }
    onClose()
  }

  return (
    <AnimatePresence>
    {open && (
    <motion.div
      className="palette__scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* Rises on `top`, not transform — glass surface, standing constraint. */}
      <motion.div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{ position: 'relative' }}
        initial={{ top: 10, opacity: 0 }}
        animate={{ top: 0, opacity: 1 }}
        exit={{ top: 6, opacity: 0 }}
        transition={{ type: 'spring', visualDuration: 0.26, bounce: 0.1 }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => (a + 1) % Math.max(1, results.length))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => (a - 1 + results.length) % Math.max(1, results.length))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            commit(results[active])
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <input
          ref={inputRef}
          className="pixel palette__input"
          placeholder="Search screens, flows, projects…"
          aria-label="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="palette__list" ref={listRef} role="listbox">
          {results.length === 0 ? (
            <div className="palette__empty pixel-line">No matches for “{query}”</div>
          ) : (
            results.map((r, i) => (
              <div
                key={`${r.kind}-${r.id}`}
                role="option"
                aria-selected={i === active}
                data-active={i === active}
                className="palette__row"
                onPointerEnter={() => setActive(i)}
                onPointerDown={(e) => {
                  e.preventDefault()
                  commit(r)
                }}
              >
                <span className="pixel palette__row-label">{r.label}</span>
                {r.hint && <span className="pixel-line palette__row-hint">{r.hint}</span>}
              </div>
            ))
          )}
        </div>

        <footer className="palette__footer pixel-line">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> dismiss
          </span>
        </footer>
      </motion.div>
    </motion.div>
    )}
    </AnimatePresence>
  )
}

/**
 * Subsequence match, scored so that earlier and tighter matches rank higher.
 * Enough for a few hundred items; deliberately not a fuzzy-search dependency.
 */
function score(haystack: string, needle: string): number {
  if (haystack.includes(needle)) {
    // Prefix beats mid-word, which beats a scattered subsequence.
    return haystack.startsWith(needle) ? 1000 : 500 - haystack.indexOf(needle)
  }
  let hi = 0
  let matched = 0
  let gaps = 0
  for (const ch of needle) {
    const found = haystack.indexOf(ch, hi)
    if (found === -1) return 0
    if (found > hi) gaps += found - hi
    hi = found + 1
    matched += 1
  }
  return matched === needle.length ? Math.max(1, 200 - gaps) : 0
}
