# Distributed single-flusher leases (fiducia)

## Problem

`startSync` instances of the same logical **actor** — browser tabs, worker
processes, replicas — share one durable store (IndexedDB is origin-scoped).
Each instance runs its own HLC `Clock(actor)` and its own flush/hydrate loops,
so without coordination the same actor can:

- **double-send** the same queued writes from two flushers at once (server-side
  `Idempotency-Key` dedups commits, but the sends, acks, and `retire()` races
  still happen), and
- **mint colliding HLC versions**: two clocks ticking at the same `wall_ms`
  under one `actor` can produce identical `{wall_ms, counter, actor}` stamps
  for different writes, which reconcile assumes is impossible per actor.

## Design

One instance holds a **lease** — a TTL'd exclusive lock — and is the only
transport-running, hydrating, flushing instance for the actor. Everyone else
queues writes locally and waits (FIFO) for promotion. Crash safety comes from
the TTL: a dead holder is superseded when its lease lapses, and the successor
inherits the shared queue and drains it (`flushOnAcquire`).

The lock service is **fiducia** (`fiducia.cloud`), consumed through
`@fiducia/client`'s `FiduciaLockClient` (`locking.ts`). The SDK stays
zero-dependency: `src/lease.mjs` accepts any **injected** client with the
`lock` / `tryLock` / handle `{fencingToken, renew, release}` shape.

```js
import { FiduciaLockClient } from "@fiducia/client/locking.ts";
import { startSync } from "@zed-pkg/sync";

const lockClient = new FiduciaLockClient(FIDUCIA_URL, {
  // No bearer option by design — auth rides on an injected fetch wrapper.
  fetch: (input, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  },
});

const { client, lease, stop } = await startSync({
  actor,
  tables: ["notes"],
  backend: { baseUrl },
  lease: {
    client: lockClient,
    ttlMs: 30_000,        // crash-recovery bound; renewed every ttl/3
    onLost: (err) => {    // transports already stopped; decide what's next
      scheduleReelection();
    },
  },
});
```

Key: `zed-sync/flusher/{dbName}/{actor}` (`flusherLeaseKey`). Override with
`lease.key` when scoping differs.

**Holder identity matters:** fiducia treats a same-`holder` acquire as the
*same owner reacquiring*, so two instances sharing a holder id would BOTH be
granted the lease. Leave `holder` unset — the client generates a unique id per
acquisition — unless you can guarantee per-process uniqueness.

For browser-only, same-origin tab election, the platform's Web Locks API
(`navigator.locks`) is a zero-infra alternative; the fiducia lease is for
actors that span processes, devices, or replicas — and it is the only option
that yields a **fencing token**.

## Fencing (why there is a Postgres table)

A lease alone cannot stop a **paused** ex-holder (GC pause, laptop lid,
network partition) from waking up and writing after its lease lapsed. Fiducia
issues a monotonically increasing **fencing token** per grant; the protected
resource must remember the highest token it has seen and reject anything
lower (Kleppmann fencing). Tokens that are never checked protect nothing.

The write path is fenced end to end:

1. `SyncLease` exposes `lease.fencingToken` for the current grant (renewals
   preserve it; a new grant advances it).
2. `makeBackendSender` stamps every send with
   `x-zed-sync-lease-key` and `x-zed-sync-fencing-token` while the lease is
   held — and stops stamping the moment it is lost.
3. The service calls, **inside the same transaction** as the sync writes:

   ```sql
   SELECT zed_sync.assert_fence($lease_key, $fencing_token, $holder);
   ```

   `zed_sync.fence` (see `postgres/zed_sync.sql`) keeps one row per lease key
   with the highest token seen. Same-or-higher tokens pass and advance the
   row; a lower token raises SQLSTATE **`ZSF01`** and aborts the transaction —
   map it to **HTTP 412** so the stale flusher stops rather than retries.
   Rolled-back transactions do not burn the fence.

The queued-write `Idempotency-Key` remains the second line of defense against
duplicate *commits*; the fence is what stops a superseded holder from
committing *at all*.

## Failure behavior

| Event | Behavior |
|---|---|
| Holder releases / `stop()` | Next-in-FIFO promoted immediately; token advances. |
| Holder crashes silently | Successor promoted when the TTL lapses; token advances; inherited queue drained on promotion. |
| Renewal proves authority lost (`lost fenced authority`, `not_holder`, `not_found`) | `onLost` fires immediately; transports stop; fencing headers stop. |
| Transient renew failures (network) | Retried at `renewIntervalMs/2` (≥250 ms floor); lease declared lost after `renewFailureLimit` (default 3) consecutive failures or server-reported expiry. |
| Paused ex-holder writes again | Postgres `assert_fence` rejects with `ZSF01` → service returns 412. |

## Testing

- **Unit** (`sdk/test/lease.test.mjs`): fake lock client; runs in `npm test`.
- **Integration** (`sdk/test/lease.integration.test.mjs`): real
  `FiduciaLockClient` against a real `fiducia-node`; self-skips unless
  configured:

  ```sh
  # boot a node (fiducia-clients/conformance/run-node.sh, or the binary directly)
  FIDUCIA_URL=http://localhost:18095 \
  FIDUCIA_LOCKING_TS=$FIDUCIA_CLOUD/fiducia-clients/clients/ts/locking.ts \
  FIDUCIA_INTERNAL_SECRET=... \
    node --test --experimental-strip-types test/lease.integration.test.mjs
  ```

  Covers mutual exclusion, token monotonicity, heartbeat outliving the TTL,
  crashed-holder takeover, and `withSyncLease` release. NOTE: pick a port not
  shadowed by local kind clusters/docker port-maps on 127.0.0.1 (8090–8105
  are commonly taken on dev machines running the fiducia kind fleet).
- **Fence SQL**: apply `postgres/zed_sync.sql` and exercise
  `zed_sync.assert_fence` (equal token ok, lower token → `ZSF01`, rollback
  does not advance).

## Sizing guidance

- `ttlMs` (default 30 s) bounds crash-takeover latency AND must comfortably
  exceed worst-case renew jitter (host load, GC). Don't go below ~5 s in
  production; the heartbeat runs at `ttl/3`.
- `maxWaitMs` defaults to forever (followers wait for promotion). Set it
  finite for jobs that should give up (`LeaseTimeoutError`).
- Semaphores: for N-way concurrency (not single-flusher), use the same
  client's `trySemaphore`/`acquireSemaphore` with the same fencing rules.
