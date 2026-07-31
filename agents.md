# Agent instructions

## Scope and hierarchy

- These instructions apply to the whole `zed-pkg/zed-sync` repository unless a deeper lowercase `agents.md` adds narrower rules.
- Before editing, resolve the current working directory and load every readable ancestor `agents.md` from the filesystem root to the working directory. Do not search siblings. Resolve symlinks, deduplicate resolved files, and report unreadable or cyclic instruction files.
- `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, and `.openai/AGENTS.md` are pointers only. Never duplicate instructions in tool-specific files.

## Repository role

This repository implements Zed's offline-first synchronization engine and convergence contracts across local state, network transports, registry metadata, and generated clients.

## Working rules

- Preserve deterministic convergence, idempotency, monotonic progress, replay safety, and bounded retry behavior.
- Treat persisted state, wire messages, version vectors, conflict records, and migration formats as compatibility-sensitive contracts.
- Never resolve conflicts by silently discarding acknowledged data; make precedence and tombstone behavior explicit and tested.
- Separate transport availability from correctness. Tests must cover disconnects, duplication, reordering, partial writes, retries, and restart recovery.
- Keep clocks, randomness, storage, and network I/O injectable where deterministic tests require control.
- Reuse `zed-interfaces` models and coordinate contract-first changes across services and clients.
- Redact authentication material and user data from logs; never commit tokens, database files containing real data, or production environment files.
- Run focused unit, property/state-machine, persistence, transport, restart, formatting, compilation, Clippy, and interoperability checks relevant to the change.

## Validation

The pinned `agents policy` workflow validates this hierarchy and the three tool pointers. Follow `README.md` and existing CI for synchronization-specific validation before requesting review.
