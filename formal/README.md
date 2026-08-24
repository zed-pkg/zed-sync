# Formal verification

zed-sync has two finite Quint transition systems. They are deliberately small
enough for exhaustive TLC exploration and are connected to production code by
schema-constrained traces replayed in Rust, JavaScript, and Dart. `fm.toml`
registers the optimistic-write model and `app-lifecycle.fm.toml` independently
registers the managed application/session model, so fleet tooling can reject an
executable Quint specification that is present on disk but absent from the
formal-methods inventory.

## Application/session lifecycle

`app_lifecycle.qnt` owns the operational state used by mobile, desktop, and
browser apps: `stopped`, `starting`, `online`, `offline`, `stopping`, and
`failed`. Its safety invariant requires phase, operation, intent, connectivity,
failure, and the active monotonic operation token to agree.

The lifecycle is fail-closed:

- UI/runtime capabilities are derived from the phase, never duplicated as
  mutable booleans;
- invalid current-generation events are rejected without mutation;
- stale async completions stutter and cannot resurrect a stopped session;
- startup/runtime/stop failures close write and receive capabilities; and
- `failed` cannot restart directly—platform cleanup must explicitly reconcile
  it through `stopping` to `stopped`.

`protocol/formal-app-lifecycle.json` is replayed by the three production
reducers. The browser/desktop `startSync()` path is lifecycle-managed and gates
its retained `SyncClient`; Flutter apps use `SyncSession`, whose `activate` and
idempotent `deactivate` effects are serialized through the same reducer. Native
desktop consumers use `AppLifecycleMachine` from the Rust core.

The TLC model bounds generation to four and exhaustively explores the resulting
finite state space. Runtime reducers use monotonic counters up to their safe
integer bound. The proof covers the declared transition relation; it does not
prove that an operating system, network, database, lock provider, or cleanup
callback cannot fail. Those are explicit inputs: a terminal failure revokes
logical capabilities immediately, and adapters clean platform effects before
explicit reconciliation permits another start.

## Optimistic-write lifecycle

`write_lifecycle.qnt` is a finite model of the correctness-critical lifecycle
for one optimistic write queue slot. The JavaScript stores coalesce repeated
writes to the same `(table, id)` onto one storage sequence. The immutable write
key, not that reused sequence, therefore decides whether an acknowledgement may
retire the current slot.

The model checks these invariants exhaustively with TLC:

- a queued write remains dirty and retryable;
- an in-flight request always refers to an allocated generation;
- disconnect and send failure preserve the durable queue for retry;
- an acknowledgement retires a slot only when its write key exactly matches;
- duplicate acknowledgements are idempotent; and
- server-wins conflict retirement is an explicit transition, distinct from ack
  settlement.

The reachability witnesses force the checker to demonstrate the interesting
paths: a late first acknowledgement after a coalesced second write, retry after
disconnect, server-wins conflict resolution, and duplicate acknowledgement.

The model is intentionally finite: it represents two writes to one logical row
and abstracts HLC values to monotonically increasing generations. The refinement
boundary is executable rather than aspirational:
`protocol/formal-write-lifecycle.json` contains concrete HLC/write-key traces,
validated by `protocol/formal-write-lifecycle.schema.json`, that the Rust,
JavaScript/TypeScript, and Dart test suites replay against their real ack logic.
JavaScript additionally exercises the concurrent client/store race, including
atomic conditional retirement in both memory and IndexedDB stores.

Run with the schema-v1 `fmctl` manifest:

```bash
fmctl validate
fmctl check
fmctl simulate
fmctl verify
```

Run the application lifecycle directly with the same pinned commands as CI:

```bash
npx --yes --package=@informalsystems/quint@0.32.0 quint typecheck formal/app_lifecycle.qnt
npx --yes --package=@informalsystems/quint@0.32.0 quint run formal/app_lifecycle.qnt \
  --main=app_lifecycle --init=init --step=step --backend=typescript \
  --max-samples=10000 --max-steps=24 --invariants app_lifecycle_safety \
  --witnesses online_reached offline_reached failed_reached \
    stale_completion_reached rejected_transition_reached failure_reconciliation_reached
npx --yes --package=@informalsystems/quint@0.32.0 quint verify formal/app_lifecycle.qnt \
  --main=app_lifecycle --init=init --step=step --backend=tlc \
  --invariants app_lifecycle_safety
```

`nix develop --no-update-lock-file -c agent-check formal` runs both models with
the pinned Node, Quint, and Java 17 toolchains. The same operations run in
GitHub Actions. A `verify` result is called exhaustive only for each declared
finite model; simulation supplies reachability evidence, not the proof claim.
