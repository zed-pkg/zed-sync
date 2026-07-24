// SyncClient — optimistic writes + reconciliation over a pluggable store.
// The correctness-critical decisions come from core.mjs (mirror of the Rust
// core); this file owns IO orchestration, the WriteMode/ErrorPolicy behavior,
// and telemetry. Every write names its optimism level and error surface with
// ENUMS (never a boolean), and every lifecycle step emits a telemetry event.

import { reconcile, onAck, isOwnEcho, resolveConflict } from "./core.mjs";
import { deepMerge } from "./merge.mjs";
import { Clock } from "./hlc.mjs";
import {
  WriteMode,
  ErrorPolicy,
  ConflictResolution,
  assertWriteMode,
  assertErrorPolicy,
  assertConflictResolution,
  shouldThrow,
  shouldEmit,
} from "./policy.mjs";
import { noopTelemetry } from "./telemetry.mjs";

/** @typedef {import("./store.mjs").MemoryStore} Store */

let seq = 0;
const nextKey = (actor) => `${actor}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export class SyncClient {
  /**
   * @param {object} deps
   * @param {Store} deps.store
   * @param {string} deps.actor                stable per-device id (HLC actor + key prefix)
   * @param {(change: object) => Promise<{ committed_version: object }>} [deps.send]  network write
   * @param {object} [deps.telemetry]          { event(name, attrs) }
   * @param {string} [deps.writeMode]          default WriteMode (enum)
   * @param {string} [deps.errorPolicy]        default ErrorPolicy (enum)
   * @param {string} [deps.conflictResolution] default ConflictResolution (enum)
   * @param {string[]} [deps.tables]           incoming-change table allowlist; omit to allow all
   * @param {(err: unknown, ctx: object) => void} [deps.onError]
   */
  constructor({
    store,
    actor,
    send,
    telemetry = noopTelemetry,
    writeMode = WriteMode.OPTIMISTIC_QUEUE,
    errorPolicy = ErrorPolicy.EMIT_ONLY,
    conflictResolution = ConflictResolution.SERVER_WINS,
    tables,
    onError,
  }) {
    if (!store) throw new TypeError("SyncClient requires a store");
    if (!actor) throw new TypeError("SyncClient requires an actor id");
    this.store = store;
    this.actor = actor;
    this.send = send;
    this.telemetry = telemetry;
    this.writeMode = assertWriteMode(writeMode);
    this.errorPolicy = assertErrorPolicy(errorPolicy);
    this.conflictResolution = assertConflictResolution(conflictResolution);
    /** @type {Set<string>|null} allowlist of tables incoming changes may touch */
    this.tables = tables ? new Set(tables) : null;
    this.onError = onError;
    this.clock = new Clock(actor);
    // Route bounded-queue overflow drops through the configured error policy.
    if (store && "onOverflow" in store) {
      store.onOverflow = (dropped) =>
        this.#surface(
          new Error(`sync write queue overflow: dropped oldest queued write for ${dropped.table}/${dropped.id}`),
          { table: dropped.table, id: dropped.id, op: dropped.op, reason: "queue-overflow" },
          this.errorPolicy,
        );
    }
  }

  /** @param {unknown} err @param {object} ctx @param {string} policy */
  #surface(err, ctx, policy) {
    if (shouldEmit(policy)) {
      this.telemetry.event("sync.write.failed", { ...ctx, error: err });
      this.onError?.(err, ctx);
    }
    if (shouldThrow(policy)) throw err;
  }

  /**
   * Apply an incoming change (from either transport) through reconcile.
   * @param {object} incoming ChangeEvent
   * @returns {Promise<"applied"|"ignored"|"conflict-resolved"|"refreshed">}
   */
  async applyChange(incoming) {
    this.clock.observe(incoming.version);
    const existing = await this.store.getRow(incoming.table, incoming.id);
    const local = existing ? { version: existing.meta.version, dirty: existing.meta.dirty } : null;
    const decision = reconcile(local, incoming);

    if (decision === "Apply") {
      await this.#adopt(incoming);
      this.telemetry.event("sync.change", { table: incoming.table, id: incoming.id, outcome: "applied" });
      return "applied";
    }
    if (decision === "Conflict") {
      const adopt = resolveConflict(this.conflictResolution, /** @type {any} */ (local), incoming);
      if (adopt) {
        await this.#adopt(incoming);
        // Server-wins drops any queued writes for this row.
        await this.#dropQueuedFor(incoming.table, incoming.id);
        this.telemetry.event("sync.change", {
          table: incoming.table, id: incoming.id, outcome: "conflict-resolved",
        });
        return "conflict-resolved";
      }
      this.telemetry.event("sync.change", { table: incoming.table, id: incoming.id, outcome: "ignored" });
      return "ignored";
    }
    // Ignore. Refresh the stored payload for an equal-version clean row so a
    // server-normalized echo cannot be hidden by a racing ack.
    if (existing && !existing.meta.dirty && JSON.stringify(decision) === JSON.stringify({ Ignore: "AlreadyApplied" })) {
      await this.#adopt(incoming);
      this.telemetry.event("sync.change", { table: incoming.table, id: incoming.id, outcome: "refreshed" });
      return "refreshed";
    }
    this.telemetry.event("sync.change", { table: incoming.table, id: incoming.id, outcome: "ignored" });
    return "ignored";
  }

  async #adopt(incoming) {
    const meta = { version: incoming.version, dirty: false, synced_at_ms: Date.now() };
    if (incoming.op === "delete") await this.store.removeRow(incoming.table, incoming.id, meta);
    else await this.store.putRow(incoming.table, incoming.id, incoming.row, meta);
  }

  async #dropQueuedFor(table, id) {
    for (const w of await this.store.pending()) {
      if (w.table === table && w.id === id) await this.store.retire(w.seq);
    }
  }

  /**
   * Optimistically write a row. `options` may be a bare op string or
   * `{ op, merge, mode, errorPolicy }` — `mode`/`errorPolicy` are enum values
   * that override the client defaults for this write.
   * @param {string} table
   * @param {string} id
   * @param {object|null} row
   * @param {"upsert"|"delete"|{op?:string, merge?:boolean, mode?:string, errorPolicy?:string}} [options]
   * @returns {Promise<{ status: string, version: object }>}
   */
  async write(table, id, row, options = {}) {
    const opts = typeof options === "string" ? { op: options } : options;
    const op = opts.op ?? (row === null ? "delete" : "upsert");
    const mode = assertWriteMode(opts.mode ?? this.writeMode);
    const policy = assertErrorPolicy(opts.errorPolicy ?? this.errorPolicy);
    const version = this.clock.tick();
    const wkey = nextKey(this.actor);
    const ctx = { table, id, op, mode };
    this.telemetry.event("sync.write.start", ctx);

    // server_first / server_only: send before (or without) any local mutation.
    if (mode === WriteMode.SERVER_FIRST || mode === WriteMode.SERVER_ONLY) {
      try {
        const ack = await this.#doSend({ table, op, id, row, version, write_key: wkey });
        if (mode === WriteMode.SERVER_FIRST) {
          await this.store.putRow(table, id, row, {
            version: ack?.committed_version ?? version, dirty: false, synced_at_ms: Date.now(),
          });
        }
        this.telemetry.event("sync.write.acked", { ...ctx, via: "server" });
        return { status: "acked", version: ack?.committed_version ?? version };
      } catch (err) {
        this.#surface(err, ctx, policy);
        return { status: "failed", version };
      }
    }

    // local_only / optimistic_*: durably apply locally, then (maybe) send.
    let existing = await this.store.getRow(table, id);
    let stored = row;
    if (op === "upsert" && opts.merge && existing?.row) stored = deepMerge(existing.row, row);
    const meta = {
      version, dirty: true,
      // A dirty write preserves the prior synced stamp — editing on synced state
      // does not un-sync it.
      synced_at_ms: existing?.meta.synced_at_ms ?? null,
    };
    if (op === "delete") await this.store.removeRow(table, id, meta);
    else await this.store.putRow(table, id, stored, meta);
    const qseq = await this.store.enqueue({ table, id, op, payload: stored, base_version: version, key: wkey });
    this.telemetry.event("sync.write.local", ctx);

    if (mode === WriteMode.LOCAL_ONLY) {
      return { status: "local", version };
    }

    // optimistic_queue / optimistic_await_ack: send now.
    try {
      const ack = await this.#doSend({ table, op, id, row: stored, version, write_key: wkey });
      await this.#settleAck(table, id, qseq, ack, version);
      this.telemetry.event("sync.write.acked", ctx);
      return { status: "acked", version: ack?.committed_version ?? version };
    } catch (err) {
      this.telemetry.event("sync.write.queued", { ...ctx, error: err });
      if (mode === WriteMode.OPTIMISTIC_AWAIT_ACK) this.#surface(err, ctx, policy);
      return { status: "queued", version };
    }
  }

  /** Delete convenience. */
  delete(table, id, options = {}) {
    return this.write(table, id, null, { ...(/** @type {object} */ (options)), op: "delete" });
  }

  async #doSend(change) {
    if (!this.send) throw new Error("no send transport configured");
    return this.send(change);
  }

  async #settleAck(table, id, qseq, ack, baseVersion) {
    const current = await this.store.getRow(table, id);
    if (!current) return;
    const outcome = onAck({ version: current.meta.version }, {
      id, committed_version: ack?.committed_version ?? baseVersion,
    });
    if (outcome !== "Superseded") {
      await this.store.putRow(table, id, current.row, {
        version: outcome.Adopt, dirty: false, synced_at_ms: Date.now(),
      });
    }
    await this.store.retire(qseq);
  }

  /**
   * Re-send everything still queued (on reconnect) under the original keys.
   * Defaults to THROW_ONLY for parity with historical flush behavior.
   * @param {string} [errorPolicy]
   */
  async flushQueue(errorPolicy = ErrorPolicy.THROW_ONLY) {
    const policy = assertErrorPolicy(errorPolicy);
    this.telemetry.event("sync.flush.start", {});
    let sent = 0;
    for (const w of await this.store.pending()) {
      try {
        const ack = await this.#doSend({
          table: w.table, op: w.op, id: w.id, row: w.payload, version: w.base_version, write_key: w.key,
        });
        await this.#settleAck(w.table, w.id, w.seq, ack, w.base_version);
        sent += 1;
      } catch (err) {
        this.telemetry.event("sync.flush.failed", { table: w.table, id: w.id, error: err });
        if (shouldEmit(policy)) this.onError?.(err, { table: w.table, id: w.id });
        if (shouldThrow(policy)) throw err;
        break; // stop on first failure; retried next reconnect
      }
    }
    this.telemetry.event("sync.flush.done", { sent });
    return sent;
  }

  /**
   * Replay a catch-up snapshot through the same reconcile path.
   * @param {object[]} changes
   */
  async hydrate(changes) {
    this.telemetry.event("sync.hydrate", { count: changes.length });
    for (const change of changes) await this.applyChange(change);
  }

  /** True if `incoming` echoes any queued write (used by transports). */
  async isEcho(incoming) {
    for (const w of await this.store.pending()) if (isOwnEcho(w, incoming)) return true;
    return false;
  }
}
