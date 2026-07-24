# The zed-sync protocol

How browser and Flutter clients, the backend, Supabase realtime, and Postgres
stay convergent. This is the contract the Rust core (`src/lib.rs`), JS SDK
(`sdk/src/`), and Dart package (`dart/zed_sync/`) execute; all three run
`protocol/conformance.json`.

## Two values, two jobs

Every synced row carries:

- **`version`** — a Hybrid Logical Clock `{wall_ms, counter, actor}`, the ONLY
  reconciliation / compare-and-swap key. It totally orders changes across
  leaderless replicas (CockroachDB's HLC scheme), so no central sequencer is
  needed for correctness.
- **`sync_sequence`** — a plane-wide, commit-ordered integer, the HTTP catch-up
  cursor ONLY. An offline client asks "everything after sequence N"; deletes
  survive as tombstones. `sync_sequence` NEVER feeds reconciliation.

Because reconcile is a pure function of `(local.version, local.dirty,
incoming.version, incoming.op)`, both transports can deliver the same change,
in any order, any number of times — the outcome converges.

## The change envelope

```json
{ "table": "products", "op": "upsert" | "delete", "id": "<row id>",
  "version": { "wall_ms": 1752710400000, "counter": 0, "actor": "pg" },
  "row": { ... }, "at_ms": 1752710400000,
  "write_key": "<echoed client token, optional>",
  "sync_sequence": 41 }
```

`protocol/change-event.schema.json` is the language-neutral validation shape.
Integer fields stay within `0..9007199254740991` (exact in Rust, JS, and Dart).

## Reconcile table

| Local | Incoming | Decision |
|---|---|---|
| none | upsert | Apply |
| none | delete | Ignore (AlreadyApplied) |
| incoming.version < local | any | Ignore (Stale) |
| incoming.version == local | any | Ignore (AlreadyApplied)\* |
| incoming.version > local, clean | any | Apply |
| incoming.version > local, dirty | any | Conflict → resolve |

HLC comparison is `wall_ms`, then `counter`, then `actor`. \* a clean,
equal-version event refreshes the stored payload so a server-normalized echo
cannot be hidden by a racing ack.

Conflicts resolve by `ConflictResolution`: `server_wins` (default — adopt the
server row, drop the queued write) or `last_write_wins` (keep the higher HLC,
deterministic across replicas).

## Optimistic writes, echoes, acks

1. `write` stamps a new HLC, stores the row dirty, appends a durable queue
   record `{table, id, op, payload, base_version, key}`, and (per WriteMode)
   POSTs it with `Idempotency-Key: <key>`.
2. The backend commits, allocates the committed HLC, replies
   `{committed_version}`, and broadcasts the change with `write_key: <key>`.
3. The realtime **echo** is matched by exact `write_key` (+ table/id/op) — a
   third party at the same version cannot impersonate our write.
4. The HTTP **ack** adopts `committed_version` unless local already advanced
   past it (then `Superseded`).
5. On reconnect, `flushQueue` re-sends everything still queued under the
   original keys, and `hydrate` replays the catch-up snapshot through the same
   reconcile path.

## Write modes and error policies

Canonical values in `protocol/write-policy.schema.json`.

| WriteMode | local apply | queued | sent | on send failure |
|---|---|---|---|---|
| `local_only` | yes (dirty) | yes | no | n/a (flushed later) |
| `optimistic_queue` (default) | yes (dirty) | yes | yes | stays queued, result `queued` |
| `optimistic_await_ack` | yes (dirty) | yes | yes | stays queued, surfaced per error policy |
| `server_first` | after ack only | no | yes | nothing queued, surfaced per error policy |
| `server_only` | never (change feed) | no | yes | nothing queued, surfaced per error policy |

`ErrorPolicy`: `throw_only`, `emit_only` (default for writes), `throw_and_emit`,
`silent`. Telemetry always records lifecycle events regardless
(`sync.write.*`, `sync.flush.*`, `sync.change`, `sync.hydrate`, `sync.status`)
through the injectable sink (`sdk/src/telemetry.mjs`) with an OpenTelemetry
adapter.
