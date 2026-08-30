# Agent instructions

Parent policy: <https://github.com/ORESoftware/my-ai/blob/main/AGENTS.md>

## Scope and hierarchy

- These instructions apply to the whole `zed-pkg/zed-sync` repository unless a deeper lowercase `agents.md` adds narrower rules.
- Before editing, resolve the current working directory and load every readable ancestor `agents.md` from the filesystem root to the working directory. Do not search siblings. Resolve symlinks, deduplicate resolved files, and report unreadable or cyclic instruction files.
- `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, and `.openai/AGENTS.md` are pointers only. Never duplicate instructions in tool-specific files.

## Repository role and source of truth

This repository implements Zed's offline-first synchronization engine and is the source of truth for the Zed sync contract: `zed-sync-core`, `@zed-pkg/sync`, and `zed_sync`. Rust services and clients consume this contract; do not fork reconcile or write-policy logic into those consumers.

`protocol/write-policy.schema.json` and `protocol/change-event.schema.json` are canonical shapes. `protocol/conformance.json` is the golden cross-language fixture. Reconcile, echo, acknowledgement, HLC, or policy changes must update the fixture and keep the Rust, JavaScript, and Dart ports aligned.

## Working rules

- Preserve deterministic convergence, idempotency, monotonic progress, replay safety, and bounded retry behavior.
- Treat persisted state, wire messages, version vectors, conflict records, schemas, fixtures, and migration formats as compatibility-sensitive contracts.
- Never resolve conflicts by silently discarding acknowledged data; make precedence and tombstone behavior explicit and tested.
- Separate transport availability from correctness. Tests must cover disconnects, duplication, reordering, partial writes, retries, and restart recovery.
- Keep clocks, randomness, storage, and network I/O injectable where deterministic tests require control.
- Keep reducers and protocol transformations pure, immutable, total, and exhaustively typed. Effects belong at transport/session boundaries.
- RxJS/RxDart adapters must remain read-only projections of the canonical state machines, use shared replay with reference-counted teardown, and fail closed on malformed foreign snapshots. Reactive subjects never become parallel state authorities.
- Keep `zed-sync` completely independent of `ORESoftware/k8s-libs-and-shared-defs`; do not add a dependency in either direction.
- History is append-only. Do not use rebase, reset, force-push, filter-repo/filter-branch, git clean, branch/tag deletion, or amend pushed commits. Correct mistakes with a new commit or `git revert`.
- Redact authentication material and user data from logs; never commit credentials, database files containing real data, or production environment files.

## Validation

- `cargo test` runs the native core and conformance suite; it does not require the wasm toolchain.
- Build the browser core with `wasm-pack build --target web --out-dir sdk/pkg -- --features wasm`.
- Validate the build-free ESM SDK declarations with `npm --prefix sdk run typecheck`.
- Keep `cargo test`, `npm --prefix sdk test`, and `dart test` green for sync-contract changes.
- Run focused property/state-machine, persistence, transport, restart, formatting, compilation, Clippy, and interoperability checks relevant to the change.

The pinned `agents policy` workflow validates this hierarchy and the three tool pointers.
