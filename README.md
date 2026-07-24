# @zed-pkg/sync

Offline-first sync engine: optimistic client writes land in IndexedDB
immediately, and a background outbox ships them to Supabase/Postgres.
**Zero runtime dependencies** — you pass in your own Supabase client (or any
object matching the small structural interface), so `@supabase/supabase-js`
is never a dependency of this package.

```
  UI write
     |
     v
+----------------+     apply() (one IDB txn)     +------------------+
| OptimisticStore| ----------------------------> |  IndexedDB       |
+----------------+                               |  tables + outbox |
     |                                            +------------------+
     | reads are instant (local state)                    |
     v                                                     | SyncEngine.tick()
  UI renders                                               v
                                   flush ---> transport.push ---> sync_changes
                                   pull  <--- transport.pull  <--- (Postgres)
                                          merge last-write-wins
```

## Quickstart

```ts
import { createClient } from "@supabase/supabase-js"; // your dependency, not ours
import { LocalDb, SupabaseTransport, SyncEngine } from "@zed-pkg/sync";

const clientId = localStorage.getItem("zed-client-id") ?? crypto.randomUUID();
localStorage.setItem("zed-client-id", clientId);

const db = await LocalDb.open();
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const engine = new SyncEngine(db, new SupabaseTransport(supabase), clientId, {
  status: (s) => console.log("sync:", s),
  conflict: (local, remote) => console.warn("conflict", local, remote),
});
engine.start(2000); // flush + pull every 2s

// optimistic write: local first, synced in the background
await db.apply("todo", "todo-1", "upsert", { title: "ship zed-pkg", done: false }, clientId);
```

`RestTransport` is the dependency-free alternative for a PostgREST-style
endpoint:

```ts
import { RestTransport } from "@zed-pkg/sync";
const transport = new RestTransport("https://db.example.com", {
  apikey: KEY,
  authorization: `Bearer ${KEY}`,
});
```

## Conflict resolution

Merges are **last-write-wins** by `updated_at`, with ties broken
deterministically by `client_id` so every replica converges on the same
result. An unflushed local write that is newer than an incoming remote change
is preserved (and reported via the `conflict` event). Override behavior by
listening to `conflict` and issuing a corrective `apply()`.

Caveats: LWW can lose concurrent edits to different fields of the same row
(the whole row is the unit). If you need field-level merges or CRDTs, layer
them on top by making each field its own row.

## Server setup

Run [schema.sql](schema.sql) against your Postgres/Supabase database. It
creates the append-only `sync_changes` journal, a trigger that fans changes
out into your real tables (with an LWW guard), plus commented RLS and
Realtime snippets.

## Develop

```sh
npm install
npm run build   # tsc -> dist/
npm test        # node:test, pure logic (no DOM needed)
```

The IndexedDB code in `outbox.ts` is deliberately isolated from the pure
merge/backoff logic in `engine.ts`, so the engine is fully unit-tested in
Node without a browser.

## License

MIT
