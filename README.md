# zed-sync

Cross-language, offline-first sync for the zed-pkg fleet. **One protocol, three
runtimes:** a zero-IO Rust core, the build-free `@zed-pkg/sync` browser SDK
(IndexedDB), and the `zed_sync` Dart/Flutter package (iOS, Android) all execute
the *same* reconciliation contract. Supabase realtime and a backend WS/HTTP
catch-up path can deliver the same change in any order and every replica
converges.

## Shape: one protocol, three runtimes

The correctness-critical logic lives in **`zed-sync-core`** (this crate) —
HLC version reconciliation, conflict policy, and optimistic write-queue
echo/ack rules, with **zero IO**. It builds:

- **native** (`cargo test`) — verified here, and reusable server-side so the
  Rust services and the browser agree on one protocol; and
- **wasm** (`--features wasm`) — the browser core.

```
zed-sync
├── protocol/                     language-neutral JSON Schema + conformance cases
│   ├── change-event.schema.json  the wire envelope
│   ├── write-policy.schema.json  WriteMode / ErrorPolicy / ConflictResolution enums
│   ├── conformance.json          golden cases — Rust, JS, AND Dart all run these
│   ├── formal-write-lifecycle.*  exact-key queue refinement traces
│   └── formal-app-lifecycle.*    cross-runtime session-state refinement traces
├── formal/                       Quint write + application lifecycle machines
├── src/ (zed-sync-core, Rust)    pure reconcile / on_ack / echo + HLC (src/hlc.rs)
│   └── wasm.rs                    wasm-bindgen JSON ABI (--features wasm)
├── postgres/zed_sync.sql         server: HLC trigger, monotonic timestamps, outbox, sync_sequence
├── sdk/ (@zed-pkg/sync)          build-free ESM + strict .d.ts
│   └── src/
│       ├── policy.mjs            WriteMode / ErrorPolicy / ConflictResolution (enums, not booleans)
│       ├── telemetry.mjs         noop / console / combine / OpenTelemetry sink
│       ├── hlc.mjs · core.mjs    HLC + reconcile (JS mirror; or load the wasm core)
│       ├── merge.mjs             JSONB-aware deepMerge (prototype-pollution + depth hardened)
│       ├── store.mjs             MemoryStore + IndexedDbStore (durable rows + write-queue)
│       ├── client.mjs            applyChange / write / delete / flushQueue / hydrate
│       ├── rxjs.mjs              optional read-only lifecycle Observables
│       ├── transports/           supabase.mjs · backend.mjs (WS + HTTP) · decode.mjs (pure)
│       └── start.mjs             startSync() — wire BOTH transports into one client
└── dart/zed_sync/                Flutter/mobile: same HLC + reconcile + write policies
```

## Three goals, addressed

1. **Optimistic writes with graded control.** Every write names its optimism
   level and error surface with **enums, not booleans** — `WriteMode`
   (`local_only`, `optimistic_queue`, `optimistic_await_ack`, `server_first`,
   `server_only`) and `ErrorPolicy` (`throw_only`, `emit_only`, `throw_and_emit`,
   `silent`). Writes land in IndexedDB/local storage first on the modes that
   allow it and sync in the background. Lifecycle events flow through an
   injectable telemetry sink with an **OpenTelemetry** adapter (dependency-free).
   Works on the browser and on mobile (iOS/Android via the Dart package).

2. **Supabase ⇄ Postgres that really converges.** `created_at` / `updated_at`
   are server-set by trigger with CockroachDB-flavored **monotonic** rules;
   `synced_at` is a CouchDB-style per-replica client fact. Ordering uses a
   **Hybrid Logical Clock** (`version`) — never a wall clock — plus a plane-wide
   `sync_sequence` catch-up cursor. See [docs/timestamps.md](docs/timestamps.md)
   and [docs/postgres.md](docs/postgres.md).

3. **Same schema validation everywhere.** The protocol is defined once as
   **JSON Schema** (`protocol/`), and `protocol/conformance.json` is executed by
   the Rust, JS, and Dart cores so all three provably agree. `zed-interfaces`
   re-exports the enums/envelope for TypeScript, Rust, and Dart consumers, and
   `zed-clients` consumes them — so an app's generated I/O and ORM types line up
   with what zed-sync moves over the wire.

4. **Executable formal safety for critical state.** The finite Quint models in
   `formal/` exhaustively check both exact-key write retirement and the whole
   application/session lifecycle: start, online/offline operation, stop,
   failure, explicit reconciliation, stale allocated completions, and rejected
   zero/future authority. JSON
   Schema-constrained traces are replayed by Rust, JavaScript/TypeScript, and
   Dart reducers. See [formal/README.md](formal/README.md) for the precise proof
   and environment boundary.

## Quickstart (browser)

```js
import { startSync, WriteMode } from "@zed-pkg/sync";
import { createClient } from "@supabase/supabase-js"; // YOUR dep, not ours

const session = await startSync({
  actor: crypto.randomUUID(),
  tables: ["products", "orders"],
  backend: { baseUrl: location.origin, getToken },
  supabase: { client: createClient(URL, KEY), filter: `tenant_id=eq.${tenantId}` },
  hydrateFetch: (t) => fetch(`/api/sync/${t}`).then((r) => r.json()),
});

// optimistic write: local first, synced in the background
await session.client.write("products", "p1", { id: "p1", name: "Ball" });
// or fully server-authoritative:
await session.client.write("orders", "o1", { id: "o1" }, { mode: WriteMode.SERVER_FIRST });

// `stop()` revokes transports/lease authority before publishing `stopped`.
// A retained client is capability-gated and rejects writes after this resolves.
await session.stop();
```

Apps that already use RxJS can observe the formally checked lifecycle without
creating a second state store:

```js
import { observeCapabilities, observeLifecycle } from "@zed-pkg/sync/rxjs";

const lifecycleSubscription = observeLifecycle(session.lifecycle).subscribe(renderStatus);
const capabilitySubscription = observeCapabilities(session.lifecycle).subscribe(renderActions);

// Each stream replays the current value, shares one machine listener, and
// releases it when the final observer unsubscribes.
lifecycleSubscription.unsubscribe();
capabilitySubscription.unsubscribe();
```

The RxJS bridge is deliberately read-only: the Quint-refined reducer remains
the sole transition authority. Install `rxjs@^7.8.2` only when importing the
optional `@zed-pkg/sync/rxjs` subpath; the base SDK keeps no runtime dependency.

## Build & test

```sh
cargo test                                   # Rust core + shared conformance
npm --prefix sdk install && npm --prefix sdk test    # JS SDK + shared conformance
npm --prefix sdk run typecheck               # validate the shipped .d.ts
cd dart/zed_sync && dart test                # Dart core + shared conformance
nix develop --no-update-lock-file -c agent-check formal
```

The pinned contributor environment runs every runtime, formatter, WASM rebuild,
and parity check through one non-interactive entrypoint:

```sh
nix develop --no-update-lock-file -c agent-check
```

`agent-check` treats canonical formatting as part of the cross-runtime contract:
`cargo fmt`, `shfmt`, and `dart format` must produce a clean checkout before the
Rust, TypeScript, Dart, WASM, and shared-conformance suites are accepted. This
keeps generated or platform-specific formatting drift from hiding semantic
parity failures.

zed-sync is standalone — it shares patterns with, but has **no dependency on**,
`ORESoftware/k8s-libs-and-shared-defs`.

## License

MIT
