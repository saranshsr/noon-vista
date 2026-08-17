# Supabase backend — setup

The app runs on localStorage by default. To point it at a shared Supabase
backend instead:

1. **Create a Supabase project** at supabase.com (free tier is fine — the data
   is a few hundred KB of JSON).

2. **Run the schema**: open the SQL editor, paste `schema.sql`, run it.
   The default policies let the anon key read/write — fine for a team pilot,
   see the PRODUCTION note in the file before sharing widely.

3. **Set the env vars** (locally in `.env.local`, on Vercel in Project →
   Settings → Environment Variables):

   ```
   VITE_ATLAS_BACKEND=supabase
   VITE_SUPABASE_URL=https://<your-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon public key>
   ```

4. Redeploy (or restart `npm run dev`). The boot loader's "Connecting to atlas"
   step is now literal.

## What is and isn't stored

Stored: projects, and one JSON document per project (screens, flows, positions,
seed tombstones — the same `StoredAtlas` the local adapter keeps). The seed is
compiled into the app and merged on read, so seed updates ship to everyone.

**Never stored: metrics.** Numbers come from `MetricsRepository` (mock today,
noon's analytics via a serverless proxy next) and stay out of this database by
design — see the roadmap decision: structure in Supabase, metrics proxied.

## Semantics

Identical to localStorage by construction — both adapters extend
`DocumentAtlasRepository`, which owns all merge/tombstone/undo semantics. The
only behavioural difference is that rev conflicts are real: two people editing
the same project concurrently will see "the atlas has changed" instead of
silently overwriting each other.

## Migrating your local edits

There is no importer yet. The seed is identical everywhere, so a fresh backend
starts at the same 18 screens; local-only edits (moved boards, added flows)
stay in the browser that made them until an exporter exists.
