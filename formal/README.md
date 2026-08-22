# Formal verification

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

The same pinned Quint operations are also run in GitHub Actions. `verify` is
declared exhaustive only because this state space is finite and the manifest
selects TLC; simulation is supporting evidence, not the proof claim.
