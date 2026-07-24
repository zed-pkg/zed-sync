# Server-side Postgres integration

`postgres/zed_sync.sql` implements the service half of the protocol. Apply it,
then attach each synced table:

```sql
\i postgres/zed_sync.sql
SELECT zed_sync_attach('public.products');
SELECT zed_sync_attach('public.orders');
```

`zed_sync_attach` adds `created_at`, `updated_at`, and `sync_version` (if
missing) and installs two triggers.

## What the triggers guarantee

- **BEFORE `zzz_zed_sync_stamp`** — server-authoritative timestamps + HLC:
  monotonic `updated_at`, immutable `created_at`, and `sync_version` derived
  from them (see [timestamps.md](timestamps.md)). Client-supplied values for
  these columns are always overwritten.
- **AFTER `zed_sync_record`** — appends the committed change to
  `zed_sync.outbox` in COMMIT order. An advisory xact-lock serializes sync
  writers so a catch-up cursor that paged past sequence N can never later find
  N-1 filled in by an older commit. DELETEs write a tombstone whose HLC is one
  tick past the deleted row's, so reconcile treats the delete as newer.

## Reading changes

The `zed_sync.changes` view is the catch-up projection the backend serves at
`/api/sync/<table>` (and via WS/SSE frames `{"event":"zed:sync","changes":[…]}`):

```sql
SELECT * FROM zed_sync.changes WHERE sync_sequence > $1 ORDER BY sync_sequence LIMIT 500;
```

## Idempotent writes

When the service applies a client write it sets the transaction GUC so the
committed change echoes the client's key:

```sql
SET LOCAL zed_sync.write_key = '<Idempotency-Key header>';
```

The `write_key` flows into the outbox and back to the client as the change's
`write_key`, which the SDK matches to settle the optimistic write's echo.

## Supabase realtime

Supabase realtime only includes the full row (with `sync_version`) when the
table is `REPLICA IDENTITY FULL`. Set it on every synced table so DELETE events
carry a usable version; without it `decodeSupabaseChange` drops the delete
(never fabricating a version), and the backend WS / catch-up carries it instead.
Also add the tables to the `supabase_realtime` publication and set RLS tenant
policies.
