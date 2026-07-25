# Testing zed-sync

One protocol, three runtimes — so the tests come in two layers: a **shared
conformance fixture** every language port must satisfy identically, and
**per-runtime end-to-end suites** that drive each runtime's full optimistic
write / reconcile / transport stack.

```
protocol/conformance.json ── the shared golden fixture (reconcile · echoes · acks · clock)
   │
   ├── Rust  tests/conformance.rs                 (cargo test)
   ├── JS    sdk/test/conformance.test.mjs         (node --test)
   └── Dart  dart/zed_sync/test/conformance_test.dart (dart test)

end-to-end (per runtime):
   ├── JS    sdk/test/e2e_*.test.mjs   — SimServer + the REAL transports
   └── Dart  dart/zed_sync/test/e2e_test.dart — client lifecycle vs an in-memory server
```

## The shared conformance fixture

`protocol/conformance.json` is the single source of truth for
correctness-critical behavior. All three cores run the **same** cases, so a
divergence in any port fails that port's build. Sections:

| Section | Exercises | Pure function |
|---|---|---|
| `reconcile` | Apply / Ignore(Stale\|AlreadyApplied) / Conflict | `reconcile(local, incoming)` |
| `echoes` | own-write echo detection by `write_key` | `isOwnEcho(queued, incoming)` |
| `acks` | Adopt committed version / Superseded | `onAck(local, ack)` |
| `clock` | HLC `tick` + `observe`, incl. the drift clamp | `Clock.tick` / `Clock.observe` |

### Why `clock` exists

HLC clock behavior *is* part of the protocol — it decides version ordering, and
therefore every reconcile and every `last_write_wins` outcome — but it was long
tested only per-language. That gap let a real bug through: the Dart
`Clock.observe` shipped **without the over-drift clamp** that Rust
(`src/hlc.rs`, `MAX_DRIFT_MS`) and JS (`sdk/src/hlc.mjs`) both enforce. An
attacker-controlled far-future remote `wall_ms` would have permanently poisoned
the mobile clock and won every `last_write_wins` conflict.

The `clock` section closes that gap. Each case starts from a fresh clock
(`wall_ms=0, counter=0`, given `actor`) and applies `ops` in order:

```json
{ "name": "observe CLAMPS a far-future poison remote to now …",
  "actor": "a",
  "ops": [
    { "tick": 1000, "expect": { "wall_ms": 1000, "counter": 0, "actor": "a" } },
    { "observe": { "wall_ms": 9999999999999, "counter": 0, "actor": "attacker" },
      "now": 2000, "expect": { "wall_ms": 2000, "counter": 0, "actor": "a" } }
  ] }
```

- `{ "tick": now, "expect": Hlc }` — advance for a local event at wall-clock `now`.
- `{ "observe": Hlc, "now": now, "expect": Hlc }` — fold in a remote stamp.
- `maxDriftMs` (300000) is asserted equal to each port's constant, so the bound
  can never silently diverge either.

**Adding a case:** append to the relevant array in `conformance.json`. All three
runners pick it up with no code change (the `clock` runner loops `ops`); only add
runner code for a genuinely new *kind* of behavior.

## End-to-end suites

### JS — `sdk/test/e2e_*.test.mjs`

`e2e_harness.mjs` is an in-memory simulation of the canonical Postgres server
(`postgres/zed_sync.sql`) — HLC stamping, per-row monotonic `updated_at`,
outbox sequencing, `write_key` idempotency, fencing — wired to the **real** SDK
transports (`makeBackendSender`, `startBackendStream`, `startSupabase`). Nothing
in the SDK is mocked; only the server and the network (fetch / WebSocket /
Supabase realtime) are simulated, and either transport can be reordered,
duplicated, dropped, or delayed.

| Suite | Proves |
|---|---|
| `e2e_convergence` | multi-replica sync over both transports; out-of-order + duplicate delivery; late-join hydrate; `server_only`/`server_first` |
| `e2e_conflicts` | `server_wins`/`last_write_wins`; stale-echo preservation; JSONB merge writes; delete/upsert tombstone races |
| `e2e_offline` | optimistic queue → reconnect flush; Idempotency-Key dedupe; partition/heal; queue overflow; `optimistic_await_ack` error surface |
| `e2e_fencing` | superseded flusher rejected (412); fencing-token monotonicity |
| `e2e_timestamps` | `created_at` immutable; `updated_at` strictly monotonic; tombstone HLC one tick newer; outbox cursor; `synced_at`; drift clamp |
| `e2e_protocol_schema` | real wire envelopes validate against `change-event`/`write-policy` JSON Schemas (dependency-free validator) |
| `e2e_chaos` | seeded randomized delivery — order-independence at scale |

### Dart — `dart/zed_sync/test/e2e_test.dart`

The mobile client's optimistic-write lifecycle against a small in-memory sync
server: every `WriteMode` + `ErrorPolicy` surface, `server_wins` conflict +
stale-echo preservation, offline queue → `flushQueue`, two-device convergence +
delete tombstones, and `synced_at` stamping. `hlc_test.dart` mirrors the Rust
HLC unit tests (tick, observe, drift clamp, encoding, actor tiebreak).

## Running everything

```sh
# Rust core (unit + conformance)
cargo test

# JS SDK (conformance + all e2e), plus the .d.ts typecheck
npm --prefix sdk test
npm --prefix sdk run typecheck

# Dart package (conformance + hlc + e2e)
cd dart/zed_sync && dart pub get && dart analyze lib && dart test
```

CI (`.github/workflows/ci.yml`) runs all three as separate jobs on every push
and PR.

## Registry-stack e2e (separate repo)

The `zed-pkg/zed-e2e` repo boots the whole registry stack (Postgres +
`zed-api-server.rs` + `zed-web-server.rs` + the `zed` CLI) and drives it with
Playwright / Puppeteer / Selenium. That is where the HTTP/WS backend, Supabase,
and CLI integration are exercised against real services; this repo's suites
cover the sync *protocol and clients* in isolation. See `zed-e2e/README.md`.
