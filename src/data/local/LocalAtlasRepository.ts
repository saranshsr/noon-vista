/**
 * localStorage-backed persistence.
 *
 * Chosen over a real backend because the brief was "persistence only": edits, board
 * positions and projects survive a reload, which this satisfies completely. A
 * shared database also needs identity — without auth, the first person to drag a
 * board would change the exec demo for everyone, which is a regression dressed up
 * as a feature.
 *
 * All of the atlas's actual semantics — id minting, seed merging, tombstones,
 * orphan cascades, the rev check — live in `DocumentAtlasRepository`. This class
 * is only the storage: five hooks over localStorage, plus the configurable fake
 * latency (`VITE_ATLAS_LATENCY`) that keeps call sites honest about async.
 *
 * The cost is stated in the UI: data is per-browser. `SupabaseAtlasRepository` is
 * the same five hooks over Postgres — see `../supabase/`.
 *
 * Concurrency note: `writeStored` re-checks the rev read-to-write, which guards
 * against the one real local race — two tabs editing the same project. It's a
 * check-then-write rather than an atomic compare-and-swap, because localStorage
 * offers nothing stronger; the window is a few microseconds in a same-machine
 * scenario that mostly doesn't happen.
 */

import type { Project, ProjectId } from '../../domain/types'
import { RevConflictError } from '../AtlasRepository'
import { DocumentAtlasRepository } from '../DocumentAtlasRepository'
import { delay } from '../latency'
import { keys, readJson, removeKey, writeJson } from './kv'
import { migrate } from './migrations'
import type { StoredAtlas } from './storedAtlas'

export class LocalAtlasRepository extends DocumentAtlasRepository {
  protected override latency(signal?: AbortSignal): Promise<void> {
    return delay(signal)
  }

  protected async loadCustomProjects(): Promise<Project[]> {
    return readJson<Project[]>(keys.projects(), [])
  }

  protected async persistProject(project: Project): Promise<void> {
    const custom = readJson<Project[]>(keys.projects(), [])
    const idx = custom.findIndex((p) => p.id === project.id)
    if (idx === -1) custom.push(project)
    else custom[idx] = project
    writeJson(keys.projects(), custom)
  }

  protected async removeProject(id: ProjectId): Promise<void> {
    const custom = readJson<Project[]>(keys.projects(), [])
    writeJson(
      keys.projects(),
      custom.filter((p) => p.id !== id),
    )
    removeKey(keys.atlas(id))
  }

  protected async readStored(projectId: ProjectId): Promise<StoredAtlas | null> {
    const raw = readJson<unknown>(keys.atlas(projectId), null)
    return raw ? migrate(raw) : null
  }

  protected async writeStored(
    projectId: ProjectId,
    stored: StoredAtlas,
    prevRev: number,
  ): Promise<void> {
    const raw = readJson<unknown>(keys.atlas(projectId), null)
    const onDisk = raw ? migrate(raw) : null
    // A fresh project has no document; its merged rev is the seed's (1), and
    // there is nothing on disk to conflict with.
    if (onDisk && onDisk.rev !== prevRev) throw new RevConflictError(onDisk.rev)
    writeJson(keys.atlas(projectId), stored)
  }
}
