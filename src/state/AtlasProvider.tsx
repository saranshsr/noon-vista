import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'

import type {
  AtlasSnapshot,
  Flow,
  FlowGraph,
  FlowId,
  ProjectId,
  Screen,
  ScreenId,
  Vec,
} from '../domain'
import { buildFlowGraph } from '../domain'
import { alignPositions, distributePositions } from '../canvas/boardGeometry'
import type { AlignEdge, DistributeAxis } from '../canvas/boardGeometry'
import type { RepoError } from '../data/AtlasRepository'
import { RepoError as RepoErrorClass, RevConflictError } from '../data/AtlasRepository'
import { atlasRepo } from '../data/repositories'
import { AbortError } from '../data/latency'
import { atlasReducer, initialAtlasState } from './atlasReducer'
import type { AtlasState, AtlasStatus } from './atlasReducer'

/** How long after the last drag movement to auto-commit, if no pointerup arrives. */
const DRAG_COMMIT_FALLBACK_MS = 400

export interface AtlasContextValue {
  projectId: ProjectId | null
  status: AtlasStatus
  snapshot: AtlasSnapshot | null
  /** Adjacency indexes, rebuilt only when the snapshot identity changes. */
  graph: FlowGraph | null
  error: RepoError | null
  pending: ReadonlySet<ScreenId>
  layoutRev: number
  history: AtlasHistory
}

/**
 * One reversible edit.
 *
 * This was `{ moves: [...] }` only, which was fine while dragging was the sole edit. It
 * isn't a shape that generalises: shipping delete on a move-only history would mean ⌘Z
 * silently doing nothing after you destroyed six boards and eleven flows, which is worse
 * than a disabled button.
 *
 * A group move stays a *single* entry, not one per board — undoing a ten-board drag with
 * ten ⌘Z presses would be indistinguishable from a bug.
 *
 * `screenDelete` carries the whole `Screen` and every incident `Flow`, not just ids,
 * because undo has to reconstruct them. See `restoreScreen` for why the inverse can't be
 * `createScreen`.
 */
type AtlasEdit =
  | { kind: 'move'; moves: { screenId: ScreenId; before: Vec; after: Vec }[] }
  | { kind: 'rename'; screenId: ScreenId; before: string; after: string }
  | { kind: 'flowCreate'; flow: Flow }
  | { kind: 'flowDelete'; flow: Flow }
  | { kind: 'flowAction'; flowId: FlowId; before?: string; after?: string }
  | {
      kind: 'flowReconnect'
      flowId: FlowId
      before: { from: ScreenId; to: ScreenId }
      after: { from: ScreenId; to: ScreenId }
    }
  | { kind: 'screenDelete'; screen: Screen; flows: Flow[] }

export interface AtlasActions {
  selectProject: (projectId: ProjectId) => void
  reload: () => void
  /** Capture the pre-drag position so a failed write can be rolled back. */
  beginScreenDrag: (id: ScreenId) => void
  /** Live drag. Local state only — deliberately does NOT touch the repository. */
  dragScreen: (id: ScreenId, position: Vec) => void
  /**
   * Drag finished: persist once.
   *
   * Takes the final position explicitly rather than reading it back out of state.
   * The gesture handler is the authority on where the board ended up, and state
   * may not have been committed yet — `pointerup` can arrive in the same task as
   * the last `pointermove` (coalesced pointer events do exactly this), in which
   * case re-deriving the position here yields the *pre-drag* value and the write
   * silently no-ops.
   */
  commitScreenPosition: (id: ScreenId, position: Vec) => void
  /** Rename a screen. No-op on an unchanged or blank label. */
  renameScreen: (id: ScreenId, label: string) => void
  /**
   * Delete screens and every flow touching them. One undoable edit per screen, each
   * tombstoning the screen and its incident flows so undo can rebuild them.
   */
  deleteScreens: (ids: ScreenId[]) => void
  /**
   * Draw a new flow. Ignores self-links and duplicates of an existing edge. `onCreated`
   * receives the persisted flow (with its repo-assigned id) so the caller can open it.
   */
  createFlow: (from: ScreenId, to: ScreenId, onCreated?: (flow: Flow) => void) => void
  /** Set (or clear, with '') a flow's affordance label. Undoable. */
  setFlowAction: (id: FlowId, action: string) => void
  /** Re-point one end of a flow to a different screen (drag a connector handle). Undoable. */
  reconnectFlow: (id: FlowId, patch: { from?: ScreenId; to?: ScreenId }) => void
  deleteFlow: (id: FlowId) => void
  resetLayout: () => void
  /** Move every listed screen by one delta. Local only — no I/O per frame. */
  dragGroup: (ids: ScreenId[], delta: Vec) => void
  /** Persist a whole group move in ONE batched write, as a single undo entry. */
  commitGroup: (ids: ScreenId[]) => void
  /** Keyboard nudge. Coalesces a rapid run into one undo entry via a trailing debounce. */
  nudgeSelection: (ids: ScreenId[], delta: Vec) => void
  /** Align the selection to a shared frame edge/centre, as one undoable move. */
  alignSelection: (ids: ScreenId[], edge: AlignEdge) => void
  /** Even out the gaps between the selection along one axis, as one undoable move. */
  distributeSelection: (ids: ScreenId[], axis: DistributeAxis) => void
  undo: () => void
  redo: () => void
  dismissError: () => void
}

export interface AtlasHistory {
  canUndo: boolean
  canRedo: boolean
}

/**
 * Split into two contexts so that components which only dispatch (the canvas) do
 * not re-render every time the snapshot changes.
 */
const AtlasStateContext = createContext<AtlasContextValue | null>(null)
const AtlasActionsContext = createContext<AtlasActions | null>(null)

function toRepoError(err: unknown): RepoError {
  if (err instanceof RepoErrorClass) return err
  return new RepoErrorClass(err instanceof Error ? err.message : 'Unexpected error', err)
}

export function AtlasProvider({
  initialProjectId,
  children,
}: {
  /**
   * The project to open on mount. Named `initial` on purpose: after mount the
   * active project is owned by this provider's state, so `selectProject` sticks
   * rather than being reverted the next time the parent re-renders.
   */
  initialProjectId: ProjectId
  children: ReactNode
}) {
  const [state, dispatch] = useReducer(atlasReducer, initialAtlasState)
  /**
   * Undo stack. Capped: the only recovery from a stray drag used to be resetting the
   * entire layout, which is a sledgehammer. 100 is far more than anyone will reach for
   * and keeps this from growing without bound in a long session.
   */
  const past = useRef<AtlasEdit[]>([])
  const future = useRef<AtlasEdit[]>([])
  const [historyRev, setHistoryRev] = useState(0)

  // Latest state, so the action callbacks can stay referentially stable.
  const stateRef = useRef<AtlasState>(state)
  stateRef.current = state

  const abortRef = useRef<AbortController | null>(null)

  /** Pre-drag positions, for rollback. Captured at drag start, not at dispatch. */
  const dragOrigin = useRef(new Map<ScreenId, Vec>())
  /** Most recent dragged position per screen, for the fallback commit timer. */
  const latestDrag = useRef(new Map<ScreenId, Vec>())
  /** Fallback commit timers, in case a drag ends without a pointerup. */
  const commitTimers = useRef(new Map<ScreenId, number>())
  /** Trailing debounce that collapses a run of nudges into one committed edit. */
  const nudgeTimer = useRef<number | null>(null)

  /**
   * Start a load, superseding any that's still running.
   *
   * Deduplication is the AbortController's job, not a separate in-flight map. An
   * earlier version kept both, and they deadlocked: StrictMode's simulated unmount
   * aborted the first load, then the effect re-ran, found the promise still
   * registered in the map, and returned early without starting a new one — so the
   * aborted promise resolved into the "ignore" branch and `status` stayed
   * `'loading'` forever. Invisible at zero latency, reproducible at 300ms.
   */
  const load = useCallback((id: ProjectId) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    dispatch({ type: 'load/start', projectId: id })

    atlasRepo
      .getAtlas(id, { signal: controller.signal })
      .then((snapshot) => {
        if (controller.signal.aborted) return
        dispatch({ type: 'load/ok', projectId: id, snapshot })
      })
      .catch((err) => {
        // An aborted load was superseded on purpose; it isn't an error state.
        if (err instanceof AbortError || controller.signal.aborted) return
        dispatch({ type: 'load/fail', projectId: id, error: toRepoError(err) })
      })
  }, [])

  useEffect(() => {
    load(initialProjectId)
    return () => abortRef.current?.abort()
  }, [initialProjectId, load])

  /**
   * What a failed write means.
   *
   * A revision conflict is *recoverable* — the stored document simply moved on (another
   * tab, or storage cleared underneath us), and the fix is to re-read it. It was
   * previously lumped in with real failures and dispatched `load/fail`, which replaced
   * the entire view with a fatal error screen because one board couldn't be saved.
   * `RevConflictError` was introduced specifically so the UI could tell "reload" from
   * "retry", and then that distinction went unused.
   */
  const handleWriteError = useCallback(
    (err: unknown, id: ScreenId, rollbackTo?: Vec) => {
      const activeProject = stateRef.current.projectId
      if (err instanceof RevConflictError) {
        if (rollbackTo) dispatch({ type: 'screen/moved', id, position: rollbackTo })
        dispatch({ type: 'write/ok', id, rev: err.currentRev })
        if (activeProject) load(activeProject)
        return
      }
      if (rollbackTo) {
        dispatch({ type: 'write/rollback', id, position: rollbackTo, error: toRepoError(err) })
      } else if (activeProject) {
        dispatch({ type: 'load/fail', projectId: activeProject, error: toRepoError(err) })
      }
    },
    [load],
  )

  const persistPosition = useCallback((id: ScreenId, position: Vec) => {
    const { snapshot, projectId: activeProject } = stateRef.current
    if (!snapshot || !activeProject) return
    if (!snapshot.screens.some((s) => s.id === id)) return

    const rollbackTo = dragOrigin.current.get(id)
    dragOrigin.current.delete(id)
    latestDrag.current.delete(id)
    // Nothing actually moved — don't burn a revision on a no-op tap.
    if (rollbackTo && rollbackTo.x === position.x && rollbackTo.y === position.y) return

    // Record for undo before the write, using the position captured at drag start.
    if (rollbackTo) {
      past.current.push({ kind: 'move', moves: [{ screenId: id, before: rollbackTo, after: position }] })
      if (past.current.length > 100) past.current.shift()
      // A new edit invalidates any redo branch — standard linear history.
      future.current = []
      setHistoryRev((n: number) => n + 1)
    }

    dispatch({ type: 'write/start', id })
    atlasRepo
      .updateScreen(activeProject, id, { position }, { expectedRev: snapshot.rev })
      .then(({ rev }) => dispatch({ type: 'write/ok', id, rev }))
      .catch((err) => handleWriteError(err, id, rollbackTo))
  }, [handleWriteError])

  /**
   * Move and persist any number of boards without recording history (undo/redo).
   * Uses the batched `updateScreens` so a ten-board undo is one write, not ten.
   */
  const applyPositions = useCallback(
    (moves: { id: ScreenId; position: Vec }[]) => {
      const { snapshot, projectId: activeProject } = stateRef.current
      if (!snapshot || !activeProject || moves.length === 0) return
      for (const m of moves) {
        dispatch({ type: 'screen/moved', id: m.id, position: m.position })
        dispatch({ type: 'write/start', id: m.id })
      }
      atlasRepo
        .updateScreens(
          activeProject,
          moves.map((m) => ({ id: m.id, patch: { position: m.position } })),
          { expectedRev: snapshot.rev },
        )
        .then(({ rev }) => {
          for (const m of moves) dispatch({ type: 'write/ok', id: m.id, rev })
        })
        .catch((err) => handleWriteError(err, moves[0].id))
    },
    [handleWriteError],
  )

  /** Push one edit and invalidate the redo branch — standard linear history. */
  const record = useCallback((edit: AtlasEdit) => {
    past.current.push(edit)
    if (past.current.length > 100) past.current.shift()
    future.current = []
    setHistoryRev((n: number) => n + 1)
  }, [])

  /**
   * Move a group locally by a delta, capturing each board's pre-move position once.
   *
   * The origin capture is what lets a *run* of these — a held-down nudge, or a live group
   * drag — collapse into a single undo entry at `commitGroup`: `before` is where the run
   * started, `after` is where it ended, regardless of how many frames were in between.
   */
  const moveGroupBy = useCallback((ids: ScreenId[], delta: Vec) => {
    const snap = stateRef.current.snapshot
    if (!snap) return
    for (const id of ids) {
      const sc = snap.screens.find((s) => s.id === id)
      if (!sc) continue
      if (!dragOrigin.current.has(id)) dragOrigin.current.set(id, { ...sc.position })
      const next = { x: sc.position.x + delta.x, y: sc.position.y + delta.y }
      dispatch({ type: 'screen/moved', id, position: next })
      latestDrag.current.set(id, next)
    }
  }, [])

  /** Flush a group move (drag or nudge run) as ONE edit and one batched write. */
  const commitGroup = useCallback((ids: ScreenId[]) => {
    const snap = stateRef.current.snapshot
    const activeProject = stateRef.current.projectId
    if (!snap || !activeProject) return
    const moves: { screenId: ScreenId; before: Vec; after: Vec }[] = []
    const patches: { id: ScreenId; patch: { position: Vec } }[] = []
    for (const id of ids) {
      const before = dragOrigin.current.get(id)
      const sc = snap.screens.find((s) => s.id === id)
      if (!before || !sc) continue
      if (before.x === sc.position.x && before.y === sc.position.y) continue
      moves.push({ screenId: id, before, after: { ...sc.position } })
      patches.push({ id, patch: { position: { ...sc.position } } })
      dragOrigin.current.delete(id)
      latestDrag.current.delete(id)
    }
    if (patches.length === 0) return
    record({ kind: 'move', moves })
    for (const p of patches) dispatch({ type: 'write/start', id: p.id })
    atlasRepo
      .updateScreens(activeProject, patches, { expectedRev: snap.rev })
      .then(({ rev }) => {
        for (const p of patches) dispatch({ type: 'write/ok', id: p.id, rev })
      })
      .catch((err) => handleWriteError(err, patches[0].id))
  }, [record, handleWriteError])

  /**
   * Set absolute target positions (align / distribute) as ONE edit and one batched write.
   * `before` is read from current state, so only boards that actually move are recorded.
   */
  const commitLayout = useCallback((targets: { id: ScreenId; position: Vec }[]) => {
    const snap = stateRef.current.snapshot
    const activeProject = stateRef.current.projectId
    if (!snap || !activeProject) return
    const moves: { screenId: ScreenId; before: Vec; after: Vec }[] = []
    for (const t of targets) {
      const sc = snap.screens.find((s) => s.id === t.id)
      if (!sc) continue
      if (sc.position.x === t.position.x && sc.position.y === t.position.y) continue
      moves.push({ screenId: t.id, before: { ...sc.position }, after: { ...t.position } })
    }
    if (moves.length === 0) return
    record({ kind: 'move', moves })
    for (const m of moves) {
      dispatch({ type: 'screen/moved', id: m.screenId, position: m.after })
      dispatch({ type: 'write/start', id: m.screenId })
    }
    atlasRepo
      .updateScreens(
        activeProject,
        moves.map((m) => ({ id: m.screenId, patch: { position: m.after } })),
        { expectedRev: snap.rev },
      )
      .then(({ rev }) => {
        for (const m of moves) dispatch({ type: 'write/ok', id: m.screenId, rev })
      })
      .catch((err) => handleWriteError(err, moves[0].screenId))
  }, [record, handleWriteError])

  /**
   * Graph writes (rename / create flow / delete flow / delete screen / restore).
   *
   * Every one is optimistic-then-reconcile like the drag path: dispatch the local edit,
   * write, and on failure re-read rather than trying to invert by hand. Inverting a failed
   * graph write locally is how you end up with a snapshot the store disagrees with; a
   * re-read is one round trip and always correct.
   */
  const runGraphWrite = useCallback(
    (write: (projectId: ProjectId, rev: number) => Promise<{ rev: number }>) => {
      const { snapshot, projectId: activeProject } = stateRef.current
      if (!snapshot || !activeProject) return
      write(activeProject, snapshot.rev)
        .then(({ rev }) => dispatch({ type: 'rev/bump', rev }))
        .catch((err) => {
          if (err instanceof RevConflictError) {
            load(activeProject)
            return
          }
          dispatch({
            type: 'load/fail',
            projectId: activeProject,
            error: toRepoError(err),
          })
        })
    },
    [load],
  )

  /**
   * Replay one edit in either direction, without recording new history.
   *
   * `forward` re-applies (redo), `backward` inverts (undo). Both reuse the same write paths
   * as the deliberate actions, and neither calls `record` — replaying an edit must not push
   * another entry or ⌘Z would fight itself.
   */
  const applyEdit = useCallback(
    (edit: AtlasEdit, direction: 'forward' | 'backward') => {
      const back = direction === 'backward'
      switch (edit.kind) {
        case 'move':
          applyPositions(
            edit.moves.map((m) => ({ id: m.screenId, position: back ? m.before : m.after })),
          )
          return
        case 'rename': {
          const label = back ? edit.before : edit.after
          dispatch({ type: 'screen/renamed', id: edit.screenId, label })
          runGraphWrite((pid, rev) =>
            atlasRepo.updateScreen(pid, edit.screenId, { label }, { expectedRev: rev }),
          )
          return
        }
        case 'flowCreate':
          // Undoing a creation is a deletion, and vice versa.
          if (back) {
            dispatch({ type: 'flow/removed', id: edit.flow.id })
            runGraphWrite((pid, rev) =>
              atlasRepo.deleteFlow(pid, edit.flow.id, { expectedRev: rev }),
            )
          } else {
            dispatch({ type: 'flow/added', flow: edit.flow })
            runGraphWrite((pid, rev) => atlasRepo.restoreFlow(pid, edit.flow, { expectedRev: rev }))
          }
          return
        case 'flowDelete':
          if (back) {
            dispatch({ type: 'flow/added', flow: edit.flow })
            runGraphWrite((pid, rev) => atlasRepo.restoreFlow(pid, edit.flow, { expectedRev: rev }))
          } else {
            dispatch({ type: 'flow/removed', id: edit.flow.id })
            runGraphWrite((pid, rev) =>
              atlasRepo.deleteFlow(pid, edit.flow.id, { expectedRev: rev }),
            )
          }
          return
        case 'flowAction': {
          const value = back ? edit.before : edit.after
          dispatch({ type: 'flow/actionSet', id: edit.flowId, action: value })
          runGraphWrite((pid, rev) =>
            atlasRepo.updateFlow(pid, edit.flowId, { action: value }, { expectedRev: rev }),
          )
          return
        }
        case 'flowReconnect': {
          const ends = back ? edit.before : edit.after
          dispatch({ type: 'flow/reconnected', id: edit.flowId, from: ends.from, to: ends.to })
          runGraphWrite((pid, rev) =>
            atlasRepo.updateFlow(pid, edit.flowId, ends, { expectedRev: rev }),
          )
          return
        }
        case 'screenDelete':
          if (back) {
            dispatch({ type: 'screen/restored', screen: edit.screen, flows: edit.flows })
            runGraphWrite((pid, rev) =>
              atlasRepo.restoreScreen(pid, edit.screen, edit.flows, { expectedRev: rev }),
            )
          } else {
            dispatch({ type: 'screen/removed', id: edit.screen.id })
            runGraphWrite((pid, rev) =>
              atlasRepo.deleteScreen(pid, edit.screen.id, { expectedRev: rev }),
            )
          }
          return
      }
    },
    [applyPositions, runGraphWrite],
  )

  const clearCommitTimer = useCallback((id: ScreenId) => {
    const timer = commitTimers.current.get(id)
    if (timer != null) {
      clearTimeout(timer)
      commitTimers.current.delete(id)
    }
  }, [])

  const actions = useMemo<AtlasActions>(
    () => ({
      selectProject: (id) => {
        if (id === stateRef.current.projectId) return
        // Reflect the switch in the URL immediately — useUrlSync will settle the
        // rest of the query string (mode, screen) once the new snapshot lands, but
        // waiting for that would leave a beat where a reload forgets the switch.
        // The stale `screen` param from the old project is dropped here for the
        // same reason: it must not survive into a copied link for this project.
        const url = new URL(window.location.href)
        url.searchParams.set('project', id)
        url.searchParams.delete('screen')
        window.history.replaceState(null, '', url)
        load(id)
      },
      reload: () => {
        const id = stateRef.current.projectId
        if (id) load(id)
      },

      beginScreenDrag: (id) => {
        const screen = stateRef.current.snapshot?.screens.find((s) => s.id === id)
        if (screen && !dragOrigin.current.has(id)) {
          dragOrigin.current.set(id, { ...screen.position })
        }
      },

      dragScreen: (id, position) => {
        dispatch({ type: 'screen/moved', id, position })
        latestDrag.current.set(id, position)
        // Safety net only: a normal drag commits on pointerup. This catches the
        // case where the pointer stream dies without an up or cancel event.
        clearCommitTimer(id)
        commitTimers.current.set(
          id,
          window.setTimeout(() => {
            commitTimers.current.delete(id)
            const last = latestDrag.current.get(id)
            if (last) persistPosition(id, last)
          }, DRAG_COMMIT_FALLBACK_MS),
        )
      },

      commitScreenPosition: (id, position) => {
        clearCommitTimer(id)
        persistPosition(id, position)
      },

      dragGroup: moveGroupBy,
      commitGroup,

      /**
       * Nudge the selection by a delta, coalescing a rapid run into ONE undo entry.
       *
       * Reuses the drag machinery: each key press moves locally (origin captured on the
       * first), and a trailing debounce commits the whole run through `commitGroup`. Without
       * the coalescing, holding ⌥→ for a second would push ~40 identical single-step edits
       * and ⌘Z would crawl back one pixel at a time.
       */
      nudgeSelection: (ids, delta) => {
        if (ids.length === 0) return
        moveGroupBy(ids, delta)
        if (nudgeTimer.current != null) clearTimeout(nudgeTimer.current)
        nudgeTimer.current = window.setTimeout(() => {
          nudgeTimer.current = null
          commitGroup(ids)
        }, 600)
      },

      alignSelection: (ids, edge) => {
        const snap = stateRef.current.snapshot
        if (!snap) return
        const items = ids
          .map((id) => snap.screens.find((s) => s.id === id))
          .filter((s): s is Screen => !!s)
          .map((s) => ({ id: s.id, position: s.position }))
        commitLayout(alignPositions(items, edge))
      },

      distributeSelection: (ids, axis) => {
        const snap = stateRef.current.snapshot
        if (!snap) return
        const items = ids
          .map((id) => snap.screens.find((s) => s.id === id))
          .filter((s): s is Screen => !!s)
          .map((s) => ({ id: s.id, position: s.position }))
        commitLayout(distributePositions(items, axis))
      },

      renameScreen: (id, label) => {
        const snap = stateRef.current.snapshot
        const screen = snap?.screens.find((s) => s.id === id)
        const next = label.trim()
        if (!screen || !next || next === screen.label) return
        record({ kind: 'rename', screenId: id, before: screen.label, after: next })
        dispatch({ type: 'screen/renamed', id, label: next })
        runGraphWrite((pid, rev) =>
          atlasRepo.updateScreen(pid, id, { label: next }, { expectedRev: rev }),
        )
      },

      /**
       * Delete screens and every flow touching them, as ONE undoable edit per screen.
       *
       * Incident flows are read out of the snapshot *before* the write, because after it
       * they're gone and undo would have nothing to restore. The repository computes the
       * same cascade independently — this isn't trusting the caller, it's capturing the
       * tombstone.
       */
      deleteScreens: (ids) => {
        const snap = stateRef.current.snapshot
        if (!snap || ids.length === 0) return
        for (const id of ids) {
          const screen = snap.screens.find((s) => s.id === id)
          if (!screen) continue
          const flows = snap.flows.filter((f) => f.from === id || f.to === id)
          record({ kind: 'screenDelete', screen, flows })
          dispatch({ type: 'screen/removed', id })
          runGraphWrite((pid, rev) => atlasRepo.deleteScreen(pid, id, { expectedRev: rev }))
        }
      },

      createFlow: (from, to, onCreated) => {
        const snap = stateRef.current.snapshot
        if (!snap) return
        if (from === to) return
        // A duplicate parallel edge is legal in the model but never what a drag meant.
        if (snap.flows.some((f) => f.from === from && f.to === to)) return
        const fromLabel = snap.screens.find((s) => s.id === from)?.label
        const toLabel = snap.screens.find((s) => s.id === to)?.label
        if (!fromLabel || !toLabel) return
        runGraphWrite((pid, rev) =>
          atlasRepo
            // `label` stays "<From> to <To>" for the inspector heading; the *action* (what
            // you tap) is authored afterward via `setFlowAction`, which is the one thing a
            // drawn edge can't derive. The id is assigned by the repo, so the caller learns
            // it via `onCreated` rather than guessing `flow-from-to` (which collisions break).
            .createFlow(pid, { from, to, label: `${fromLabel} to ${toLabel}` }, { expectedRev: rev })
            .then((res) => {
              dispatch({ type: 'flow/added', flow: res.data })
              record({ kind: 'flowCreate', flow: res.data })
              onCreated?.(res.data)
              return res
            }),
        )
      },

      setFlowAction: (id, action) => {
        const flow = stateRef.current.snapshot?.flows.find((f) => f.id === id)
        if (!flow) return
        const next = action.trim() || undefined
        if (next === flow.action) return
        record({ kind: 'flowAction', flowId: id, before: flow.action, after: next })
        dispatch({ type: 'flow/actionSet', id, action: next })
        runGraphWrite((pid, rev) => atlasRepo.updateFlow(pid, id, { action: next }, { expectedRev: rev }))
      },

      reconnectFlow: (id, patch) => {
        const snap = stateRef.current.snapshot
        const flow = snap?.flows.find((f) => f.id === id)
        if (!snap || !flow) return
        const from = patch.from ?? flow.from
        const to = patch.to ?? flow.to
        if (from === to) return
        if (from === flow.from && to === flow.to) return
        // Dropping onto a board already linked this way would duplicate an edge. The repo
        // rejects it, but catch it here so a stray drop is a silent no-op rather than an
        // error state — you just don't get a second identical connector.
        if (snap.flows.some((f) => f.id !== id && f.from === from && f.to === to)) return
        record({
          kind: 'flowReconnect',
          flowId: id,
          before: { from: flow.from, to: flow.to },
          after: { from, to },
        })
        dispatch({ type: 'flow/reconnected', id, from, to })
        runGraphWrite((pid, rev) => atlasRepo.updateFlow(pid, id, { from, to }, { expectedRev: rev }))
      },

      deleteFlow: (id) => {
        const snap = stateRef.current.snapshot
        const flow = snap?.flows.find((f) => f.id === id)
        if (!flow) return
        record({ kind: 'flowDelete', flow })
        dispatch({ type: 'flow/removed', id })
        runGraphWrite((pid, rev) => atlasRepo.deleteFlow(pid, id, { expectedRev: rev }))
      },

      resetLayout: () => {
        const id = stateRef.current.projectId
        if (!id) return
        past.current = []
        future.current = []
        setHistoryRev((n: number) => n + 1)
        atlasRepo
          .resetLayout(id)
          .then((snapshot) => dispatch({ type: 'snapshot/replace', snapshot, reframe: true }))
          .catch((err) => dispatch({ type: 'load/fail', projectId: id, error: toRepoError(err) }))
      },

      /**
       * Undo / redo, per edit kind.
       *
       * Every branch goes through the *same* repository write path as the original action,
       * so an undone edit persists exactly like a deliberate one. An undo that only
       * repaired local state would look right and then silently un-apply itself on the
       * next reload — the same class as the original drag-never-persisted bug.
       */
      undo: () => {
        const edit = past.current.pop()
        if (!edit) return
        future.current.push(edit)
        setHistoryRev((n: number) => n + 1)
        applyEdit(edit, 'backward')
      },
      redo: () => {
        const edit = future.current.pop()
        if (!edit) return
        past.current.push(edit)
        setHistoryRev((n: number) => n + 1)
        applyEdit(edit, 'forward')
      },

      dismissError: () => dispatch({ type: 'error/dismiss' }),
    }),
    [
      load,
      persistPosition,
      clearCommitTimer,
      applyEdit,
      record,
      runGraphWrite,
      handleWriteError,
      moveGroupBy,
      commitGroup,
      commitLayout,
    ],
  )

  /**
   * Flush any debounced commit before the page goes away. Best-effort: the write
   * is async, so this narrows the loss window rather than closing it. The normal
   * path (pointerup → immediate commit) doesn't depend on this.
   */
  useEffect(() => {
    const flush = () => {
      for (const id of [...commitTimers.current.keys()]) {
        clearCommitTimer(id)
        const last = latestDrag.current.get(id)
        if (last) persistPosition(id, last)
      }
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [clearCommitTimer, persistPosition])

  const graph = useMemo(
    () => (state.snapshot ? buildFlowGraph(state.snapshot) : null),
    [state.snapshot],
  )

  const value = useMemo<AtlasContextValue>(
    () => ({
      projectId: state.projectId,
      status: state.status,
      snapshot: state.snapshot,
      graph,
      error: state.error,
      pending: state.pending,
      layoutRev: state.layoutRev,
      history: { canUndo: past.current.length > 0, canRedo: future.current.length > 0 },
    }),
    [
      state.projectId,
      state.status,
      state.snapshot,
      graph,
      state.error,
      state.pending,
      state.layoutRev,
      historyRev,
    ],
  )

  return (
    <AtlasActionsContext.Provider value={actions}>
      <AtlasStateContext.Provider value={value}>{children}</AtlasStateContext.Provider>
    </AtlasActionsContext.Provider>
  )
}

export function useAtlas(): AtlasContextValue {
  const ctx = useContext(AtlasStateContext)
  if (!ctx) throw new Error('useAtlas must be used inside <AtlasProvider>')
  return ctx
}

export function useAtlasActions(): AtlasActions {
  const ctx = useContext(AtlasActionsContext)
  if (!ctx) throw new Error('useAtlasActions must be used inside <AtlasProvider>')
  return ctx
}

/**
 * The snapshot, once it's known to exist. Use inside components that only render
 * under `status === 'ready'`, so they don't each repeat a null check.
 */
export function useAtlasSnapshot(): { snapshot: AtlasSnapshot; graph: FlowGraph } {
  const { snapshot, graph } = useAtlas()
  if (!snapshot || !graph) throw new Error('useAtlasSnapshot used before the atlas was ready')
  return { snapshot, graph }
}
