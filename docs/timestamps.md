# Timestamps: `created_at`, `updated_at`, `synced_at`, and the HLC

Distributed databases learned long ago that wall clocks lie: NTP steps them,
VMs resume them into the past, users edit them. zed-sync borrows three of their
disciplines so the human-facing time columns "really work all the time", while
keeping the HLC `version` and the plane-wide `sync_sequence` as the ONLY
authoritative ordering keys (nothing about reconciliation reads a clock).

## Server side: monotonic `updated_at`, immutable `created_at`

`zed_sync_attach(table)` (in `postgres/zed_sync.sql`) installs a BEFORE
INSERT/UPDATE trigger with CockroachDB-flavored rules:

- **`updated_at` is strictly monotonic per row** —
  `greatest(clock_timestamp(), old.updated_at + interval '1 microsecond')`. A
  stepped-back system clock can never make it regress or repeat, so
  `ORDER BY updated_at` per row is always the true edit order (the microsecond
  bump is the logical part of the hybrid clock).
- **`created_at` is immutable after birth** — an UPDATE that rewrites it is
  corrected back.
- The same trigger derives the row's HLC `sync_version` from the monotonic
  `updated_at` (ms → `wall_ms`) plus a per-row counter, so version and
  timestamps can never drift. The trigger is named `zzz_zed_sync_stamp` so it
  fires LAST and corrects any earlier trigger's raw `now()`.

## Client side: `synced_at` is a replica fact

"When was this row last synced?" is a **per-device** question — CouchDB models
the same idea with per-replica checkpoints — so `synced_at` deliberately does
NOT exist server-side. Each store records it locally as `RowMeta.synced_at_ms`:
the local wall-clock moment THIS device last adopted server-authoritative state
(apply, refresh, echo adoption, ack settlement, server-wins conflict). It is
`null` until then, and a dirty optimistic write **preserves** the previous
stamp — editing on top of synced state does not un-sync it.

## The Hybrid Logical Clock

`src/hlc.rs` (canonical), `sdk/src/hlc.mjs`, and `dart/zed_sync/lib/src/hlc.dart`
implement the same HLC (Kulkarni et al. — the scheme CockroachDB uses):

- `tick()` stamps a local event; stamps are **strictly monotonic per device**
  even when the wall clock jumps backwards.
- `observe(remote)` folds in every incoming change, so local stamps always sort
  after the last one seen.
- Canonical encoding is a fixed-width sortable string (`"0197f3b2c4d1-0003"`:
  12 hex digits of Unix-ms, a dash, 4 hex digits of the counter). Lexicographic
  order equals causal order in every language, and it stays clear of JS's 2^53
  integer limit. `actor` breaks ties deterministically so every replica agrees.
