# Agent Rules

Rules for AI agents (and humans) working in this repository.

## Forbidden — destructive git operations

History is append-only. Never rewrite it: no `git rebase`, `git reset` (any
mode), `git push --force`/`--force-with-lease`, `git filter-repo`/`filter-branch`,
`git clean`, branch/tag deletion, or amending pushed commits. Fix mistakes with
a new commit or `git revert`.

## Source of truth

This repository is the source of truth for the zed-pkg sync contract
(`zed-sync-core` + `@zed-pkg/sync` + `zed_sync`). The Rust services and clients
consume it — do not fork the reconcile/policy logic into them.

`protocol/write-policy.schema.json` and `protocol/change-event.schema.json` are
the canonical shapes; `protocol/conformance.json` is the golden fixture. Any
change to reconcile/echo/ack/HLC/policy behavior MUST update the fixture and
keep the Rust (`cargo test`), JS (`npm --prefix sdk test`), and Dart
(`dart test`) ports all green.

## Independence

zed-sync shares patterns with `ORESoftware/k8s-libs-and-shared-defs` but must
stay **completely independent of it** — no dependency in either direction.

## Build context

- `cargo test` runs the native core + conformance; no wasm toolchain needed.
- The browser core wasm is built with
  `wasm-pack build --target web --out-dir sdk/pkg -- --features wasm`.
- The JS SDK is build-free ESM; `npm --prefix sdk run typecheck` validates the
  shipped `.d.ts`.
