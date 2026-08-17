/**
 * Postgres-backed persistence via Supabase — the same five storage hooks as the
 * localStorage adapter, over two tables (see `supabase/schema.sql`):
 *
 *   atlas_projects   custom + seed-shadowing projects, one row each
 *   atlas_docs       one StoredAtlas document per project, as jsonb, with the
 *                    rev mirrored into a column for the concurrency guard
 *
 * The document is stored whole rather than normalised into screens/flows rows.
 * That is a deliberate v1: it keeps the semantics byte-identical to the local
 * adapter (both persist the same `StoredAtlas`, both merge against the seed on
 * read), and the collaboration it can't express — two people editing *different*
 * screens of the same project concurrently — is exactly the feature that should
 * force the normalisation, when it's actually wanted. Until then, rows would buy
 * joins and migration risk for no observable difference.
 *
 * Concurrency: `writeStored` is an `UPDATE … WHERE project_id = X AND rev = prev`.
 * Zero rows updated means someone else committed first — surfaced as
 * `RevConflictError`, same as every other adapter. The check runs on the server,
 * inside the statement, so two racing writers cannot both win. First write for a
 * project is an INSERT racing on the primary key instead, which fails closed the
 * same way.
 *
 * Auth note: the client uses the anon key. Until noon SSO lands, the RLS policies
 * in schema.sql decide who can do what — see SETUP.md for the dev-vs-production
 * policy split. Nothing sensitive lives here: structure only, never metrics.
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Project, ProjectId } from '../../domain/types'
import { OfflineError, RepoError, RevConflictError } from '../AtlasRepository'
import { DocumentAtlasRepository } from '../DocumentAtlasRepository'
import type { StoredAtlas } from '../local/storedAtlas'

/** Row shapes, kept local — the domain model must not grow a dependency on them. */
type ProjectRow = {
  id: string
  slug: string
  name: string
  kind: 'project' | 'pod'
  seeded: boolean
  created_at: string
  updated_at: string
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  kind: r.kind,
  seeded: r.seeded,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toRow = (p: Project): ProjectRow => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  kind: p.kind,
  seeded: p.seeded,
  created_at: p.createdAt,
  updated_at: p.updatedAt,
})

export class SupabaseAtlasRepository extends DocumentAtlasRepository {
  private client: SupabaseClient

  constructor(url?: string, anonKey?: string) {
    super()
    const u = url ?? (import.meta.env.VITE_SUPABASE_URL as string | undefined)
    const k = anonKey ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)
    if (!u || !k) {
      // Fail at construction, loudly. Falling back to local here would be the
      // "why aren't my changes shared?" afternoon the backend switch exists to
      // prevent — same reasoning as the hard throw in repositories.ts.
      throw new RepoError(
        'VITE_ATLAS_BACKEND=supabase needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY set',
      )
    }
    this.client = createClient(u, k)
  }

  protected async loadCustomProjects(signal?: AbortSignal): Promise<Project[]> {
    const q = this.client.from('atlas_projects').select('*')
    const { data, error } = await (signal ? q.abortSignal(signal) : q)
    if (error) throw wire(error)
    return (data as ProjectRow[]).map(toProject)
  }

  protected async persistProject(project: Project, signal?: AbortSignal): Promise<void> {
    const q = this.client.from('atlas_projects').upsert(toRow(project))
    const { error } = await (signal ? q.abortSignal(signal) : q)
    if (error) throw wire(error)
  }

  protected async removeProject(id: ProjectId, signal?: AbortSignal): Promise<void> {
    // The doc first: if the second delete fails we're left with an orphan doc,
    // which is invisible; the reverse order leaves a project that opens to a
    // load error, which isn't.
    const docs = this.client.from('atlas_docs').delete().eq('project_id', id)
    const { error: docError } = await (signal ? docs.abortSignal(signal) : docs)
    if (docError) throw wire(docError)
    const projects = this.client.from('atlas_projects').delete().eq('id', id)
    const { error } = await (signal ? projects.abortSignal(signal) : projects)
    if (error) throw wire(error)
  }

  protected async readStored(
    projectId: ProjectId,
    signal?: AbortSignal,
  ): Promise<StoredAtlas | null> {
    const filtered = this.client.from('atlas_docs').select('doc').eq('project_id', projectId)
    const q = (signal ? filtered.abortSignal(signal) : filtered).maybeSingle()
    const { data, error } = await q
    if (error) throw wire(error)
    return data ? (data.doc as StoredAtlas) : null
  }

  protected async writeStored(
    projectId: ProjectId,
    stored: StoredAtlas,
    prevRev: number,
    signal?: AbortSignal,
  ): Promise<void> {
    // The conditional update IS the concurrency check: `rev = prevRev` in the
    // WHERE clause makes it atomic on the server. `select()` returns the rows
    // the statement touched — zero rows means someone else got there first.
    const update = this.client
      .from('atlas_docs')
      .update({ doc: stored, rev: stored.rev, updated_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('rev', prevRev)
      .select('rev')
    const { data, error } = await (signal ? update.abortSignal(signal) : update)
    if (error) throw wire(error)
    if (data && data.length > 0) return

    // No row updated: either the doc doesn't exist yet (first write for this
    // project) or the rev moved. Try the insert; a primary-key conflict means
    // it was the rev after all.
    const insert = this.client
      .from('atlas_docs')
      .insert({ project_id: projectId, doc: stored, rev: stored.rev })
    const { error: insertError } = await (signal ? insert.abortSignal(signal) : insert)
    if (!insertError) return
    if (insertError.code === '23505') {
      // Unique violation → the doc exists at some other rev. Report the truth.
      const { data: row } = await this.client
        .from('atlas_docs')
        .select('rev')
        .eq('project_id', projectId)
        .maybeSingle()
      throw new RevConflictError((row?.rev as number) ?? prevRev + 1)
    }
    throw wire(insertError)
  }
}

/** Map transport failures onto the typed errors the UI already understands. */
function wire(error: { message: string; code?: string }): RepoError {
  if (/fetch|network|Failed to fetch/i.test(error.message)) return new OfflineError(error)
  return new RepoError(error.message, error)
}
