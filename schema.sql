-- zed-sync server schema (Postgres / Supabase).
--
-- The `sync_changes` table is an append-only journal that clients push to and
-- pull from. A row-level trigger fans each journaled change out into the real
-- application table (example: `todo`). Clients keep a cursor over
-- `updated_at` and merge last-write-wins locally.

create extension if not exists "pgcrypto";

-- Append-only change journal.
create table if not exists sync_changes (
  id          uuid primary key,
  table_name  text        not null,
  pk          text        not null,
  op          text        not null check (op in ('upsert', 'delete')),
  payload     jsonb,
  client_id   text        not null,
  updated_at  timestamptz not null default now()
);

create index if not exists idx_sync_changes_updated_at on sync_changes (updated_at);

-- Example synced table. Real apps add their own; the trigger below is the
-- pattern to copy per synced table.
create table if not exists todo (
  id         text primary key,
  title      text,
  done       boolean     not null default false,
  updated_at timestamptz not null default now()
);

-- updated_at trigger so server-side edits also advance the cursor.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_todo_updated_at on todo;
create trigger trg_todo_updated_at
  before update on todo
  for each row execute function set_updated_at();

-- Fan a journaled change out into its target table (last-write-wins on
-- updated_at). Extend the case list as you add synced tables.
create or replace function apply_sync_change() returns trigger as $$
begin
  if new.table_name = 'todo' then
    if new.op = 'delete' then
      delete from todo where id = new.pk;
    else
      insert into todo (id, title, done, updated_at)
      values (
        new.pk,
        new.payload->>'title',
        coalesce((new.payload->>'done')::boolean, false),
        new.updated_at
      )
      on conflict (id) do update
        set title = excluded.title,
            done = excluded.done,
            updated_at = excluded.updated_at
        where todo.updated_at <= excluded.updated_at;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_apply_sync_change on sync_changes;
create trigger trg_apply_sync_change
  after insert on sync_changes
  for each row execute function apply_sync_change();

-- Row Level Security example (Supabase). Scope changes to the authenticated
-- user; adapt to your tenancy model.
-- alter table sync_changes enable row level security;
-- create policy "own changes" on sync_changes
--   for all using (auth.uid()::text = client_id) with check (auth.uid()::text = client_id);

-- Realtime (Supabase): publish sync_changes so other devices get live pulls.
-- alter publication supabase_realtime add table sync_changes;
