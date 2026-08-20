/**
 * The single injection point for data access.
 *
 * Nothing else in the app imports an adapter class — components and hooks talk to
 * `atlasRepo` / `metricsRepo` only. That's what makes swapping in an HTTP backend a
 * new file plus one env var rather than a search-and-replace across the tree.
 */

import type { AtlasRepository } from './AtlasRepository'
import type { MetricsRepository } from './MetricsRepository'
import { LocalAtlasRepository } from './local/LocalAtlasRepository'
import { MockMetricsRepository } from './mock/MockMetricsRepository'

type Backend = 'local' | 'supabase' | 'http'

const backend = (import.meta.env.VITE_ATLAS_BACKEND as Backend | undefined) ?? 'local'

/**
 * The Supabase adapter (and the ~330KB of @supabase/supabase-js under it) loads
 * via dynamic import behind a top-level await: the split chunk is FETCHED only
 * when the backend is actually configured. Statically imported, it sat in the
 * main bundle for every visitor of the default local build — 719KB → 395KB min
 * by moving it. Top-level await means importers still see a plain synchronous
 * `atlasRepo`; the module graph just resolves the extra chunk first when (and
 * only when) it's needed.
 */
async function createAtlasRepo(): Promise<AtlasRepository> {
  switch (backend) {
    case 'supabase': {
      // Throws at construction if the URL/key env vars are missing — a hard
      // failure rather than a silent fallback to local, because "why aren't my
      // changes shared?" is a much worse afternoon than "the env var is unset".
      // Setup: supabase/SETUP.md.
      const { SupabaseAtlasRepository } = await import('./supabase/SupabaseAtlasRepository')
      return new SupabaseAtlasRepository()
    }
    case 'http':
      throw new Error(
        'VITE_ATLAS_BACKEND=http is not implemented — use `supabase`, or `local` (default)',
      )
    case 'local':
    default:
      return new LocalAtlasRepository()
  }
}

export const atlasRepo: AtlasRepository = await createAtlasRepo()

export const metricsRepo: MetricsRepository = new MockMetricsRepository()

/** True when persistence is device-local, so the UI can say so out loud. */
export const isLocalOnly = backend === 'local'
