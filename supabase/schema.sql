-- noon Atlas — Supabase schema.
--
-- Two tables, mirroring what the localStorage adapter stores: the list of
-- custom projects, and one StoredAtlas document per project. Structure only —
-- metrics are proxied from noon's analytics at read time and NEVER stored here.
--
-- Run this in the Supabase SQL editor (or `supabase db push`) once per project.

create table if not exists public.atlas_projects (
  id         text primary key,
  slug       text not null unique,
  name       text not null,
  kind       text not null check (kind in ('project', 'pod')),
  seeded     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.atlas_docs (
  project_id text primary key,
  -- Mirrors doc->>'rev'. A column so the optimistic-concurrency guard is one
  -- conditional UPDATE instead of a jsonb expression in every WHERE clause.
  rev        integer not null,
  doc        jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.atlas_projects enable row level security;
alter table public.atlas_docs     enable row level security;

-- ── Policies ────────────────────────────────────────────────────────────────
-- DEV (default below): the anon key may read and write. This is what lets the
-- app run before noon SSO is wired in. Anyone with the URL + anon key can edit —
-- acceptable for a team pilot behind an unlisted URL, not for production.
--
-- PRODUCTION: delete the anon policies and uncomment the authenticated ones,
-- then wire Supabase Auth (noon SSO / Google) in the client.

create policy "dev anon read projects"  on public.atlas_projects for select using (true);
create policy "dev anon write projects" on public.atlas_projects for all using (true) with check (true);
create policy "dev anon read docs"      on public.atlas_docs for select using (true);
create policy "dev anon write docs"     on public.atlas_docs for all using (true) with check (true);

-- create policy "authenticated read projects"  on public.atlas_projects for select to authenticated using (true);
-- create policy "authenticated write projects" on public.atlas_projects for all    to authenticated using (true) with check (true);
-- create policy "authenticated read docs"      on public.atlas_docs     for select to authenticated using (true);
-- create policy "authenticated write docs"     on public.atlas_docs     for all    to authenticated using (true) with check (true);
