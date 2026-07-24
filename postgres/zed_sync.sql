-- zed-sync — canonical Postgres schema for the sync contract.
--
-- Server-side obligations (see docs/postgres.md, docs/timestamps.md,
-- docs/protocol.md) so created_at / updated_at / version can never drift:
--
--   * `sync_version` (an HLC {wall_ms, counter, actor}) is computed by trigger
--     on every INSERT/UPDATE — never trusted from the client. It is the ONLY
--     reconciliation key.
--   * `updated_at` is strictly monotonic per row:
--     greatest(clock_timestamp(), old.updated_at + 1 microsecond). A stepped-
--     back system clock can never make it regress or repeat (the microsecond
--     bump is the logical part of the hybrid clock).
--   * `created_at` is immutable after insert (an UPDATE that rewrites it is
--     corrected back).
--   * every committed mutation lands in `zed_sync_outbox` in COMMIT order
--     (an advisory xact-lock serializes sync writers, so a catch-up cursor
--     that paged past sequence N can never later find N-1 filled in by an
--     older commit).
--   * DELETEs write a tombstone whose HLC is one logical tick past the deleted
--     row's, so reconcile treats the delete as newer than the last upsert.
--   * the client's Idempotency-Key is echoed as `write_key` when the service
--     sets the `zed_sync.write_key` GUC for the transaction.
--
-- Apply:            psql -f postgres/zed_sync.sql
-- Attach a table:   SELECT zed_sync_attach('public.products');
-- Idempotent: safe to re-run.

CREATE SCHEMA IF NOT EXISTS zed_sync;

-- Server actor id for HLCs this database authors (stable per plane).
CREATE OR REPLACE FUNCTION zed_sync.actor() RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'pg'::text $$;

-- Plane-wide, commit-ordered catch-up cursor. Bounded by the shared wire
-- integer range (JS Number.MAX_SAFE_INTEGER = 9007199254740991).
CREATE SEQUENCE IF NOT EXISTS zed_sync.sequence
  AS bigint MINVALUE 1 MAXVALUE 9007199254740991;

CREATE TABLE IF NOT EXISTS zed_sync.outbox (
  sequence     bigint PRIMARY KEY DEFAULT nextval('zed_sync.sequence'),
  table_name   text        NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  operation    text        NOT NULL CHECK (operation IN ('upsert', 'delete')),
  row_id       text        NOT NULL CHECK (length(row_id) BETWEEN 1 AND 512),
  version      jsonb       NOT NULL,   -- HLC {wall_ms, counter, actor}
  row_data     jsonb,                  -- NULL is a delete tombstone
  committed_at timestamptz NOT NULL DEFAULT now(),
  write_key    text        CHECK (write_key IS NULL OR length(write_key) BETWEEN 1 AND 512),
  CHECK ((operation = 'delete') = (row_data IS NULL))
);

CREATE INDEX IF NOT EXISTS zed_sync_outbox_table_row
  ON zed_sync.outbox (table_name, row_id, sequence);

-- The fixed catch-up projection read by the backend's PostgresChangeSource.
CREATE OR REPLACE VIEW zed_sync.changes AS
SELECT
  sequence AS sync_sequence,
  table_name,
  operation AS op,
  row_id AS id,
  version,
  row_data AS row,
  (extract(epoch FROM committed_at) * 1000)::bigint AS at_ms,
  write_key
FROM zed_sync.outbox;

-- Outbox retention. The outbox is an append-only log and grows without bound;
-- this prunes rows committed before now() - retain_interval but ALWAYS keeps
-- the latest row per (table_name, row_id), so every row's current state (or its
-- delete tombstone) survives and reconcile/catch-up still see the newest
-- version. Returns the number of rows pruned. Idempotent and injection-safe
-- (a typed `interval` parameter, no dynamic SQL): a re-run prunes nothing new.
-- Meant to be called periodically by a scheduler — pg_cron or the app, e.g.
--   SELECT cron.schedule('zed-sync-prune-outbox', '17 3 * * *',
--                        $$ SELECT zed_sync.prune_outbox(interval '30 days') $$);
CREATE OR REPLACE FUNCTION zed_sync.prune_outbox(retain_interval interval)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  pruned bigint;
BEGIN
  DELETE FROM zed_sync.outbox o
  WHERE o.committed_at < now() - retain_interval
    AND o.sequence < (
      SELECT max(o2.sequence) FROM zed_sync.outbox o2
      WHERE o2.table_name = o.table_name AND o2.row_id = o.row_id
    );
  GET DIAGNOSTICS pruned = ROW_COUNT;
  RETURN pruned;
END;
$$;

-- Fencing registry for distributed leases (docs/leases.md). Fiducia's lock
-- service hands each lease grant a monotonically increasing fencing token;
-- tokens only protect anything if the resource they guard REJECTS writes
-- carrying a token older than one it has already seen (Kleppmann fencing).
-- This table is that memory: one row per lease key, holding the highest
-- token that has ever written here.
CREATE TABLE IF NOT EXISTS zed_sync.fence (
  lease_key     text PRIMARY KEY CHECK (length(lease_key) BETWEEN 1 AND 512),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  holder        text CHECK (holder IS NULL OR length(holder) BETWEEN 1 AND 512),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Assert the caller still holds fenced authority for lease_key. Call INSIDE
-- the same transaction as the writes the lease protects (e.g. per sync write
-- batch), so the check and the writes commit or abort together:
--
--   SELECT zed_sync.assert_fence('zed-sync/flusher/appdb/actor-1', $token, $holder);
--
-- Same-or-higher tokens are accepted (renewals preserve the token; a newer
-- grant advances it). A LOWER token than the stored one means the caller's
-- lease was superseded while it was paused/partitioned: the function raises
-- SQLSTATE 'ZSF01' and the transaction aborts. Map that to HTTP 412 in the
-- service so the stale flusher stops instead of retrying. The upsert
-- row-locks the fence row, so concurrent writers for one lease serialize.
CREATE OR REPLACE FUNCTION zed_sync.assert_fence(p_lease_key text, p_token bigint, p_holder text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  advanced integer;
  seen bigint;
BEGIN
  IF p_lease_key IS NULL OR length(p_lease_key) = 0 THEN
    RAISE EXCEPTION 'zed_sync.assert_fence: lease_key is required' USING ERRCODE = '22023';
  END IF;
  IF p_token IS NULL OR p_token <= 0 THEN
    RAISE EXCEPTION 'zed_sync.assert_fence: invalid fencing token %', p_token USING ERRCODE = '22023';
  END IF;
  INSERT INTO zed_sync.fence AS f (lease_key, fencing_token, holder)
  VALUES (p_lease_key, p_token, p_holder)
  ON CONFLICT (lease_key) DO UPDATE
    SET fencing_token = EXCLUDED.fencing_token,
        holder        = EXCLUDED.holder,
        updated_at    = now()
    WHERE f.fencing_token <= EXCLUDED.fencing_token;
  GET DIAGNOSTICS advanced = ROW_COUNT;
  IF advanced = 0 THEN
    SELECT fencing_token INTO seen FROM zed_sync.fence WHERE lease_key = p_lease_key;
    RAISE EXCEPTION 'zed_sync: stale fencing token % for lease % (current %)',
      p_token, p_lease_key, seen
      USING ERRCODE = 'ZSF01';
  END IF;
END;
$$;

-- Compute the next HLC given the previous one and the (monotonic) updated_at.
CREATE OR REPLACE FUNCTION zed_sync.next_hlc(prev jsonb, updated timestamptz)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  wall  bigint := floor(extract(epoch FROM updated) * 1000)::bigint;
  ctr   int := 0;
BEGIN
  IF prev IS NOT NULL AND (prev->>'wall_ms')::bigint = wall THEN
    ctr := (prev->>'counter')::int + 1;
  END IF;
  RETURN jsonb_build_object('wall_ms', wall, 'counter', ctr, 'actor', zed_sync.actor());
END;
$$;

-- BEFORE trigger: server-authoritative timestamps + HLC version. Runs LAST
-- (name prefixed zzz) so it corrects any earlier trigger's raw now().
CREATE OR REPLACE FUNCTION zed_sync.stamp()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := COALESCE(NEW.created_at, clock_timestamp());
    NEW.updated_at := GREATEST(clock_timestamp(), NEW.created_at);
    NEW.sync_version := zed_sync.next_hlc(NULL, NEW.updated_at);
  ELSE
    NEW.created_at := OLD.created_at; -- immutable
    NEW.updated_at := GREATEST(clock_timestamp(), OLD.updated_at + interval '1 microsecond');
    NEW.sync_version := zed_sync.next_hlc(OLD.sync_version, NEW.updated_at);
  END IF;
  RETURN NEW;
END;
$$;

-- AFTER trigger: record the committed state in the outbox in commit order.
CREATE OR REPLACE FUNCTION zed_sync.record()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  op text; rid text; ver jsonb; payload jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('zed_sync.outbox'));
  IF TG_OP = 'DELETE' THEN
    op := 'delete';
    rid := OLD.id::text;
    -- One logical tick past the deleted row's HLC, so the tombstone is newer.
    ver := jsonb_set(OLD.sync_version, '{counter}',
                     to_jsonb((OLD.sync_version->>'counter')::int + 1));
    payload := NULL;
  ELSE
    op := 'upsert';
    rid := NEW.id::text;
    ver := NEW.sync_version;
    payload := to_jsonb(NEW);
  END IF;
  INSERT INTO zed_sync.outbox (table_name, operation, row_id, version, row_data, write_key)
  VALUES (TG_TABLE_NAME, op, rid, ver, payload,
          nullif(current_setting('zed_sync.write_key', true), ''));
  RETURN NULL;
END;
$$;

-- Attach the sync contract to a table: add the columns (if missing) and
-- install both triggers. The table must have a text-representable `id`.
CREATE OR REPLACE FUNCTION zed_sync_attach(target regclass)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()', target);
  EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()', target);
  EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS sync_version jsonb', target);
  EXECUTE format('DROP TRIGGER IF EXISTS zzz_zed_sync_stamp ON %s', target);
  EXECUTE format('CREATE TRIGGER zzz_zed_sync_stamp BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION zed_sync.stamp()', target);
  EXECUTE format('DROP TRIGGER IF EXISTS zed_sync_record ON %s', target);
  EXECUTE format('CREATE TRIGGER zed_sync_record AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION zed_sync.record()', target);
END;
$$;
