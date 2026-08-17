/**
 * All of the atlas's domain logic, over an abstract document store.
 *
 * Every backend stores the same two things: a list of custom projects, and one
 * `StoredAtlas` document per project (user edits + seed tombstones — see
 * `storedAtlas.ts` for the merge rule). What *differs* per backend is only where
 * those bytes live and how a concurrent write is detected. So the id-minting,
 * seed-merging, tombstone bookkeeping and orphan-flow cascades live here exactly
 * once, and an adapter implements five storage hooks:
 *
 *   loadCustomProjects / persistProject / removeProject   — the project list
 *   readStored / writeStored                              — the per-project doc
 *
 * `writeStored` carries the concurrency contract: it receives the rev the caller
 * read (`prevRev`) and MUST refuse — by throwing `RevConflictError` — if the
 * stored document has moved past it. localStorage satisfies this trivially
 * (single browser, effectively single writer); Postgres satisfies it with a
 * conditional `UPDATE … WHERE rev = prevRev`, which makes the check atomic on
 * the server where it belongs.
 *
 * This split exists so that the Local and Supabase repositories cannot drift:
 * a mutation bug fixed here is fixed everywhere, and a new backend is five
 * methods, not four hundred lines of re-derived semantics.
 */

import type {
  AtlasSnapshot,
  Flow,
  FlowId,
  Project,
  ProjectId,
  ProjectKind,
  Screen,
  ScreenId,
} from '../domain/types'
import type {
  AtlasRepository,
  FlowPatch,
  NewFlow,
  NewScreen,
  ReadOpts,
  ScreenPatch,
  WriteOpts,
  WriteResult,
} from './AtlasRepository'
import { NotFoundError, RevConflictError } from './AtlasRepository'
import { SEED_PROJECTS, buildSeedAtlas, findSeedProject, flowId as makeFlowId } from './seed/noonAtlasSeed'
import { mergeSeed, toStored } from './local/storedAtlas'
import type { StoredAtlas } from './local/storedAtlas'

const ARTBOARD_FALLBACK = { name: 'Artboard', width: 400, height: 865 }

export abstract class DocumentAtlasRepository implements AtlasRepository {
  // ── Storage hooks ──────────────────────────────────────────────────────────

  /** Projects the user created — the seed projects are compiled in, not stored. */
  protected abstract loadCustomProjects(signal?: AbortSignal): Promise<Project[]>
  /** Insert-or-replace one custom (or seed-shadowing) project. */
  protected abstract persistProject(project: Project, signal?: AbortSignal): Promise<void>
  /** Remove a custom project and its atlas document. */
  protected abstract removeProject(id: ProjectId, signal?: AbortSignal): Promise<void>

  protected abstract readStored(
    projectId: ProjectId,
    signal?: AbortSignal,
  ): Promise<StoredAtlas | null>
  /**
   * Persist the document, atomically failing with `RevConflictError` if the
   * stored rev is no longer `prevRev`. `stored.rev` is already the NEW rev.
   */
  protected abstract writeStored(
    projectId: ProjectId,
    stored: StoredAtlas,
    prevRev: number,
    signal?: AbortSignal,
  ): Promise<void>

  /** Simulated latency for adapters that would otherwise resolve instantly. */
  protected async latency(_signal?: AbortSignal): Promise<void> {}

  // ── Projects ──────────────────────────────────────────────────────────────

  async listProjects(opts?: ReadOpts & { kind?: ProjectKind }): Promise<Project[]> {
    await this.latency(opts?.signal)
    const custom = await this.loadCustomProjects(opts?.signal)
    // A stored row with a seed id is a *shadow* (an edited seed project) and wins.
    const shadowed = new Map(custom.map((p) => [p.id, p]))
    const all = [
      ...SEED_PROJECTS.map((p) => shadowed.get(p.id) ?? p),
      ...custom.filter((c) => !findSeedProject(c.id)),
    ]
    return opts?.kind ? all.filter((p) => p.kind === opts.kind) : all
  }

  async getProjectBySlug(slug: string, opts?: ReadOpts): Promise<Project | null> {
    const all = await this.listProjects(opts)
    return all.find((p) => p.slug === slug || p.id === slug) ?? null
  }

  async createProject(
    input: { name: string; kind: ProjectKind },
    opts?: ReadOpts,
  ): Promise<Project> {
    await this.latency(opts?.signal)
    const custom = await this.loadCustomProjects(opts?.signal)
    const base = slugify(input.name) || 'project'
    let slug = base
    let n = 2
    const taken = new Set([...SEED_PROJECTS, ...custom].map((p) => p.slug))
    while (taken.has(slug)) slug = `${base}-${n++}`
    const now = new Date().toISOString()
    const project: Project = {
      id: slug,
      slug,
      name: input.name,
      kind: input.kind,
      seeded: false,
      createdAt: now,
      updatedAt: now,
    }
    await this.persistProject(project, opts?.signal)
    return project
  }

  async updateProject(
    id: ProjectId,
    patch: Partial<Pick<Project, 'name'>>,
    opts?: ReadOpts,
  ): Promise<Project> {
    await this.latency(opts?.signal)
    const custom = await this.loadCustomProjects(opts?.signal)
    const existing =
      custom.find((p) => p.id === id) ??
      // Seed projects aren't editable in place; shadow them with a stored copy.
      findSeedProject(id)
    if (!existing) throw new NotFoundError(`project ${id}`)
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() }
    await this.persistProject(updated, opts?.signal)
    return updated
  }

  async deleteProject(id: ProjectId, opts?: ReadOpts): Promise<void> {
    await this.latency(opts?.signal)
    await this.removeProject(id, opts?.signal)
  }

  // ── Aggregate read ────────────────────────────────────────────────────────

  async getAtlas(projectId: ProjectId, opts?: ReadOpts): Promise<AtlasSnapshot> {
    await this.latency(opts?.signal)
    const project = await this.resolveProject(projectId)
    return mergeSeed(buildSeedAtlas(project), await this.readStored(projectId, opts?.signal))
  }

  // ── Screens ───────────────────────────────────────────────────────────────

  async updateScreen(
    projectId: ProjectId,
    id: ScreenId,
    patch: ScreenPatch,
    opts?: WriteOpts,
  ): Promise<WriteResult<Screen>> {
    const result = await this.updateScreens(projectId, [{ id, patch }], opts)
    const screen = result.data.find((s) => s.id === id)
    if (!screen) throw new NotFoundError(`screen ${id}`)
    return { rev: result.rev, data: screen }
  }

  async updateScreens(
    projectId: ProjectId,
    patches: Array<{ id: ScreenId; patch: ScreenPatch }>,
    opts?: WriteOpts,
  ): Promise<WriteResult<Screen[]>> {
    return this.mutate(projectId, opts, (snapshot) => {
      const byId = new Map(patches.map((p) => [p.id, p.patch]))
      const missing = patches.find((p) => !snapshot.screens.some((s) => s.id === p.id))
      if (missing) throw new NotFoundError(`screen ${missing.id}`)
      const screens = snapshot.screens.map((s) => {
        const patch = byId.get(s.id)
        return patch ? { ...s, ...patch } : s
      })
      const touched = screens.filter((s) => byId.has(s.id))
      return { snapshot: { ...snapshot, screens }, data: touched }
    })
  }

  async createScreen(
    projectId: ProjectId,
    input: NewScreen,
    opts?: WriteOpts,
  ): Promise<WriteResult<Screen>> {
    return this.mutate(projectId, opts, (snapshot) => {
      const taken = new Set(snapshot.screens.map((s) => s.id))
      const base = slugify(input.label) || 'screen'
      let id = base
      let n = 2
      while (taken.has(id)) id = `${base}-${n++}`
      const screen: Screen = {
        id,
        projectId,
        label: input.label,
        imageUrl: input.imageUrl,
        previewUrl: input.previewUrl,
        position: input.position,
        homePosition: input.homePosition ?? input.position,
        device: input.device ?? ARTBOARD_FALLBACK,
        order: snapshot.screens.length,
      }
      return {
        snapshot: { ...snapshot, screens: [...snapshot.screens, screen] },
        data: screen,
      }
    })
  }

  async deleteScreen(
    projectId: ProjectId,
    id: ScreenId,
    opts?: WriteOpts,
  ): Promise<WriteResult<{ removedFlowIds: FlowId[] }>> {
    return this.mutate(projectId, opts, (snapshot, stored) => {
      if (!snapshot.screens.some((s) => s.id === id)) throw new NotFoundError(`screen ${id}`)
      const orphaned = snapshot.flows.filter((f) => f.from === id || f.to === id)
      const seed = buildSeedAtlas(snapshot.project)
      const isSeedScreen = seed.screens.some((s) => s.id === id)
      const orphanedSeedFlowIds = orphaned
        .filter((f) => seed.flows.some((sf) => sf.id === f.id))
        .map((f) => f.id)

      return {
        snapshot: {
          ...snapshot,
          screens: snapshot.screens.filter((s) => s.id !== id),
          flows: snapshot.flows.filter((f) => f.from !== id && f.to !== id),
          sections: snapshot.sections.filter((s) => s.screenId !== id),
        },
        data: { removedFlowIds: orphaned.map((f) => f.id) },
        // Record seed deletions so the merge doesn't resurrect them next load.
        removed: {
          removedSeedScreenIds: isSeedScreen
            ? [...(stored?.removedSeedScreenIds ?? []), id]
            : stored?.removedSeedScreenIds,
          removedSeedFlowIds: orphanedSeedFlowIds.length
            ? [...(stored?.removedSeedFlowIds ?? []), ...orphanedSeedFlowIds]
            : stored?.removedSeedFlowIds,
        },
      }
    })
  }

  /**
   * Inverse of `deleteScreen` — see the interface for why this can't be `createScreen`.
   *
   * Re-inserts at the original `order` rather than appending, so an undone delete doesn't
   * silently reshuffle the Screens grid's default "Flow" sort.
   */
  async restoreScreen(
    projectId: ProjectId,
    screen: Screen,
    flows: Flow[],
    opts?: WriteOpts,
  ): Promise<WriteResult<Screen>> {
    return this.mutate(projectId, opts, (snapshot, stored) => {
      const screens = snapshot.screens.some((s) => s.id === screen.id)
        ? snapshot.screens
        : [...snapshot.screens, screen].sort((a, b) => a.order - b.order)

      const have = new Set(snapshot.flows.map((f) => f.id))
      const restored = flows.filter((f) => !have.has(f.id))

      const flowIds = new Set(flows.map((f) => f.id))
      return {
        snapshot: { ...snapshot, screens, flows: [...snapshot.flows, ...restored] },
        data: screen,
        // Lift the tombstones, or the next `mergeSeed` deletes all of this again.
        removed: {
          removedSeedScreenIds: (stored?.removedSeedScreenIds ?? []).filter(
            (id) => id !== screen.id,
          ),
          removedSeedFlowIds: (stored?.removedSeedFlowIds ?? []).filter(
            (id) => !flowIds.has(id),
          ),
        },
      }
    })
  }

  // ── Flows ─────────────────────────────────────────────────────────────────

  async createFlow(
    projectId: ProjectId,
    input: NewFlow,
    opts?: WriteOpts,
  ): Promise<WriteResult<Flow>> {
    return this.mutate(projectId, opts, (snapshot) => {
      const ends = [input.from, input.to]
      for (const end of ends) {
        if (!snapshot.screens.some((s) => s.id === end)) throw new NotFoundError(`screen ${end}`)
      }
      const taken = new Set(snapshot.flows.map((f) => f.id))
      let id = makeFlowId(input.from, input.to)
      let n = 2
      while (taken.has(id)) id = `${makeFlowId(input.from, input.to)}-${n++}`
      const flow: Flow = {
        id,
        projectId,
        from: input.from,
        to: input.to,
        label: input.label,
        action: input.action,
      }
      return { snapshot: { ...snapshot, flows: [...snapshot.flows, flow] }, data: flow }
    })
  }

  async updateFlow(
    projectId: ProjectId,
    id: FlowId,
    patch: FlowPatch,
    opts?: WriteOpts,
  ): Promise<WriteResult<Flow>> {
    return this.mutate(projectId, opts, (snapshot) => {
      const flow = snapshot.flows.find((f) => f.id === id)
      if (!flow) throw new NotFoundError(`flow ${id}`)
      const from = patch.from ?? flow.from
      const to = patch.to ?? flow.to
      // Endpoint edits (reconnect) must still point at real screens and not collapse the
      // edge onto one board or duplicate an existing one.
      if (patch.from != null || patch.to != null) {
        for (const end of [from, to]) {
          if (!snapshot.screens.some((s) => s.id === end)) throw new NotFoundError(`screen ${end}`)
        }
        if (from === to) throw new NotFoundError(`flow ${id}: endpoints coincide`)
        if (snapshot.flows.some((f) => f.id !== id && f.from === from && f.to === to))
          throw new NotFoundError(`flow ${from}→${to} already exists`)
      }
      // Blank clears the action rather than storing "" — an empty string would render as a
      // present-but-empty Trigger row, which reads as broken. `action` unset in the patch
      // means "leave it"; explicit blank means "clear".
      const action = 'action' in patch ? patch.action?.trim() || undefined : flow.action
      const next: Flow = { ...flow, from, to, action }
      return {
        snapshot: { ...snapshot, flows: snapshot.flows.map((f) => (f.id === id ? next : f)) },
        data: next,
      }
    })
  }

  async deleteFlow(
    projectId: ProjectId,
    id: FlowId,
    opts?: WriteOpts,
  ): Promise<WriteResult<void>> {
    return this.mutate(projectId, opts, (snapshot, stored) => {
      if (!snapshot.flows.some((f) => f.id === id)) throw new NotFoundError(`flow ${id}`)
      const seed = buildSeedAtlas(snapshot.project)
      const isSeedFlow = seed.flows.some((f) => f.id === id)
      return {
        snapshot: { ...snapshot, flows: snapshot.flows.filter((f) => f.id !== id) },
        data: undefined as void,
        removed: {
          removedSeedScreenIds: stored?.removedSeedScreenIds,
          removedSeedFlowIds: isSeedFlow
            ? [...(stored?.removedSeedFlowIds ?? []), id]
            : stored?.removedSeedFlowIds,
        },
      }
    })
  }

  /** Inverse of `deleteFlow`: original id preserved, seed tombstone lifted. */
  async restoreFlow(
    projectId: ProjectId,
    flow: Flow,
    opts?: WriteOpts,
  ): Promise<WriteResult<Flow>> {
    return this.mutate(projectId, opts, (snapshot, stored) => {
      for (const end of [flow.from, flow.to]) {
        if (!snapshot.screens.some((s) => s.id === end)) throw new NotFoundError(`screen ${end}`)
      }
      const exists = snapshot.flows.some((f) => f.id === flow.id)
      return {
        snapshot: exists ? snapshot : { ...snapshot, flows: [...snapshot.flows, flow] },
        data: flow,
        removed: {
          removedSeedScreenIds: stored?.removedSeedScreenIds,
          removedSeedFlowIds: (stored?.removedSeedFlowIds ?? []).filter((id) => id !== flow.id),
        },
      }
    })
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  async resetLayout(projectId: ProjectId, opts?: WriteOpts): Promise<AtlasSnapshot> {
    const result = await this.mutate(projectId, opts, (snapshot) => {
      const screens = snapshot.screens.map((s) => ({ ...s, position: { ...s.homePosition } }))
      return { snapshot: { ...snapshot, screens }, data: undefined as void }
    })
    // `mutate` already persisted; re-read so the caller gets the merged truth.
    return this.getAtlas(projectId, opts).then((s) => ({ ...s, rev: result.rev }))
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  protected async resolveProject(projectId: ProjectId): Promise<Project> {
    const project = await this.getProjectBySlug(projectId)
    if (!project) throw new NotFoundError(`project ${projectId}`)
    return project
  }

  /**
   * The single write path: read → check rev → apply → bump rev → persist.
   * Everything funnels through here so the concurrency check and the rev bump
   * can't be forgotten by a new method. The adapter's `writeStored` re-checks the
   * rev at commit time, which is what makes the check meaningful on a backend
   * with more than one writer.
   */
  private async mutate<T>(
    projectId: ProjectId,
    opts: WriteOpts | undefined,
    apply: (
      snapshot: AtlasSnapshot,
      stored: StoredAtlas | null,
    ) => {
      snapshot: AtlasSnapshot
      data: T
      removed?: Pick<StoredAtlas, 'removedSeedScreenIds' | 'removedSeedFlowIds'>
    },
  ): Promise<WriteResult<T>> {
    await this.latency(opts?.signal)
    const project = await this.resolveProject(projectId)
    const stored = await this.readStored(projectId, opts?.signal)
    const current = mergeSeed(buildSeedAtlas(project), stored)

    if (opts?.expectedRev != null && opts.expectedRev !== current.rev) {
      throw new RevConflictError(current.rev)
    }

    const { snapshot, data, removed } = apply(current, stored)
    const rev = current.rev + 1
    await this.writeStored(
      projectId,
      toStored({ ...snapshot, rev }, {
        removedSeedScreenIds: removed?.removedSeedScreenIds ?? stored?.removedSeedScreenIds,
        removedSeedFlowIds: removed?.removedSeedFlowIds ?? stored?.removedSeedFlowIds,
      }),
      current.rev,
      opts?.signal,
    )
    return { rev, data }
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
