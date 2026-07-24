// The reconciliation core, in JS. This is a faithful mirror of the Rust core
// (src/lib.rs) and is validated against the SAME protocol/conformance.json, so
// the two agree. In production you can swap this for the wasm build of the Rust
// crate (loadWasmCore below) for a single source of truth; the pure-JS core
// keeps the SDK dependency-free and instantly runnable in any JS runtime.

import { compareHlc } from "./hlc.mjs";

/** @typedef {import("./hlc.mjs").Hlc} Hlc */
/** @typedef {{ table: string, op: "upsert"|"delete", id: string, version: Hlc, row?: object|null, at_ms: number, write_key?: string, sync_sequence?: number }} ChangeEvent */
/** @typedef {{ version: Hlc, dirty?: boolean }} LocalRow */
/** @typedef {"Apply" | { Ignore: "Stale"|"AlreadyApplied" } | "Conflict"} Reconcile */

/**
 * Pure reconciliation — depends only on (local.version, local.dirty,
 * incoming.version, incoming.op). Idempotent and order-independent.
 * @param {LocalRow|null|undefined} local
 * @param {ChangeEvent} incoming
 * @returns {Reconcile}
 */
export function reconcile(local, incoming) {
  if (local == null) {
    return incoming.op === "upsert" ? "Apply" : { Ignore: "AlreadyApplied" };
  }
  const cmp = compareHlc(incoming.version, local.version);
  if (cmp < 0) return { Ignore: "Stale" };
  if (cmp === 0) return { Ignore: "AlreadyApplied" };
  return local.dirty ? "Conflict" : "Apply";
}

/**
 * Settle an HTTP ack: adopt the committed version unless local advanced past it.
 * @param {LocalRow} local
 * @param {{ id: string, committed_version: Hlc }} ack
 * @returns {{ Adopt: Hlc } | "Superseded"}
 */
export function onAck(local, ack) {
  return compareHlc(local.version, ack.committed_version) > 0
    ? "Superseded"
    : { Adopt: ack.committed_version };
}

/**
 * True when `incoming` is the realtime echo of THIS queued write. Matched by
 * exact write_key (+ table/id/op); a missing/different key is never ours.
 * @param {{ table: string, id: string, op: string, key: string }} queued
 * @param {ChangeEvent} incoming
 */
export function isOwnEcho(queued, incoming) {
  return (
    incoming.table === queued.table &&
    incoming.id === queued.id &&
    incoming.op === queued.op &&
    incoming.write_key === queued.key
  );
}

/**
 * Resolve a "Conflict" deterministically.
 * @param {"server_wins"|"last_write_wins"} resolution
 * @param {LocalRow} local
 * @param {ChangeEvent} incoming
 * @returns {boolean} true to adopt the incoming change
 */
export function resolveConflict(resolution, local, incoming) {
  if (resolution === "server_wins") return true;
  return compareHlc(incoming.version, local.version) > 0;
}

/**
 * Optionally load the wasm build of the Rust core (single source of truth) and
 * expose the same object API. Requires `wasm-pack build --target web
 * --out-dir sdk/pkg -- --features wasm`.
 */
export async function loadWasmCore() {
  const wasm = await import("../pkg/zed_sync_core.js");
  if (wasm.default) await wasm.default();
  return {
    /** @param {LocalRow|null} local @param {ChangeEvent} incoming */
    reconcile: (local, incoming) =>
      JSON.parse(wasm.reconcile(local == null ? undefined : JSON.stringify(local), JSON.stringify(incoming))),
    /** @param {LocalRow} local @param {object} ack */
    onAck: (local, ack) => JSON.parse(wasm.on_ack(JSON.stringify(local), JSON.stringify(ack))),
    /** @param {object} queued @param {ChangeEvent} incoming */
    isOwnEcho: (queued, incoming) => wasm.is_own_echo(JSON.stringify(queued), JSON.stringify(incoming)),
  };
}
