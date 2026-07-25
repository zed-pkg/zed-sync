// End-to-end harness: an in-memory simulation of the canonical Postgres sync
// server (postgres/zed_sync.sql) wired to the REAL SDK transports. Nothing here
// is a test double of the SDK — the client code under test is the production
// client.mjs / store.mjs / core.mjs / hlc.mjs and the production transports
// (makeBackendSender, startBackendStream, startSupabase). Only the *server* and
// the *network* (fetch / WebSocket / Supabase realtime) are simulated, exactly
// mirroring the server-side obligations the SQL trigger guarantees:
//
//   * sync_version is a server-authored HLC {wall_ms, counter, actor:"pg"},
//     computed by zed_sync.next_hlc — never trusted from the client.
//   * updated_at (hence wall_ms) is strictly monotonic per row.
//   * a DELETE tombstone is one logical tick past the row's last HLC.
//   * every mutation lands in the outbox under a plane-wide monotonic sequence,
//     in commit order (the advisory xact-lock => single writer here).
//   * the client's Idempotency-Key (write_key) makes a retried POST a no-op that
//     returns the already-committed version.
//   * zed_sync.assert_fence rejects a stale fencing token (SQLSTATE ZSF01 -> 412).
//
// The same committed change is delivered over BOTH the backend WS and Supabase
// realtime, and the harness can reorder, duplicate, drop, or delay either path
// so tests can prove reconcile converges regardless (docs/protocol.md).

import { SyncClient } from "../src/client.mjs";
import { MemoryStore } from "../src/store.mjs";
import { makeBackendSender, startBackendStream } from "../src/transports/backend.mjs";
import { startSupabase } from "../src/transports/supabase.mjs";

const SERVER_ACTOR = "pg";
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** Error a fenced-off write raises; the fake fetch maps it to HTTP 412. */
export class FenceRejected extends Error {}

/**
 * In-memory mirror of the Postgres sync server. One instance == one logical
 * database plane (one outbox sequence, one fence registry).
 */
export class SimServer {
  constructor() {
    /** @type {Map<string, {row: object, version: object, updated_at_ms: number, created_at_ms: number}>} table/id -> current */
    this.rows = new Map();
    /** @type {object[]} append-only outbox, index+1 == sync_sequence */
    this.outbox = [];
    /** @type {Map<string, {committed_version: object, sequence: number}>} write_key idempotency */
    this.byWriteKey = new Map();
    /** @type {Map<string, number>} lease_key -> highest fencing token seen */
    this.fence = new Map();
    /** monotonic server wall clock (ms); never regresses. */
    this._wall = 0;
    /** live subscribers fed on every commit: (entry) => void */
    this._subs = new Set();
  }

  _key(table, id) {
    return `${table} ${id}`;
  }

  /** The current committed row payload for (table, id), or null if absent. */
  currentRow(table, id) {
    return this.rows.get(this._key(table, id))?.row ?? null;
  }

  /** clock_timestamp() with the trigger's per-plane monotonic guarantee. */
  _now() {
    const t = Date.now();
    this._wall = t > this._wall ? t : this._wall + 1;
    return this._wall;
  }

  /** zed_sync.assert_fence: same-or-higher token accepted, lower rejected. */
  assertFence(leaseKey, token) {
    if (leaseKey == null || token == null) return;
    const seen = this.fence.get(leaseKey);
    if (seen != null && token < seen) {
      throw new FenceRejected(`stale fencing token ${token} for ${leaseKey} (current ${seen})`);
    }
    this.fence.set(leaseKey, Math.max(seen ?? 0, token));
  }

  /**
   * Apply one client write transactionally and return the committed version.
   * Mirrors the BEFORE stamp + AFTER record triggers.
   * @param {{table:string, op:"upsert"|"delete", id:string, row?:object|null, write_key?:string}} change
   * @param {{leaseKey?:string, token?:number}} [fence]
   * @returns {{committed_version: object, sequence: number}}
   */
  commit(change, fence = {}) {
    if (fence.leaseKey != null) this.assertFence(fence.leaseKey, fence.token);

    // Idempotency-Key: a retried write returns the first commit's result and
    // does NOT append a second outbox row (the server saw this write already).
    if (change.write_key && this.byWriteKey.has(change.write_key)) {
      return this.byWriteKey.get(change.write_key);
    }

    const k = this._key(change.table, change.id);
    const prev = this.rows.get(k) ?? null;
    const updated = Math.max(this._now(), (prev?.updated_at_ms ?? 0) + 1);
    const wall = prev ? Math.max(updated, prev.version.wall_ms) : updated;
    // created_at is immutable after insert (the trigger corrects a rewrite back).
    const created = prev?.created_at_ms ?? updated;

    let version;
    let payload;
    if (change.op === "delete") {
      // Tombstone HLC = one logical tick past the deleted row's version.
      const base = prev?.version ?? { wall_ms: wall, counter: 0, actor: SERVER_ACTOR };
      version = { wall_ms: base.wall_ms, counter: base.counter + 1, actor: SERVER_ACTOR };
      payload = null;
      this.rows.delete(k);
    } else {
      const counter = prev && prev.version.wall_ms === wall ? prev.version.counter + 1 : 0;
      version = { wall_ms: wall, counter, actor: SERVER_ACTOR };
      // row_data == to_jsonb(NEW): the domain columns PLUS the server-managed
      // sync columns. Every replica converges on THIS canonical row, so the
      // writer's initially-clean optimistic row is reconciled to it after echo.
      payload = {
        ...clone(change.row),
        id: change.id,
        created_at: new Date(created).toISOString(),
        updated_at: new Date(updated).toISOString(),
        sync_version: version,
      };
      this.rows.set(k, { row: payload, version, updated_at_ms: updated, created_at_ms: created });
    }

    const entry = {
      sequence: this.outbox.length + 1,
      table: change.table,
      op: change.op,
      id: change.id,
      version,
      row: payload,
      at_ms: updated,
      write_key: change.write_key ?? null,
      updated_at_iso: new Date(updated).toISOString(),
    };
    this.outbox.push(entry);
    const result = { committed_version: version, sequence: entry.sequence };
    if (change.write_key) this.byWriteKey.set(change.write_key, result);
    for (const sub of this._subs) sub(entry);
    return result;
  }

  /** Catch-up projection (zed_sync.changes), optionally since a sequence. */
  changesSince(sequence = 0, table) {
    return this.outbox
      .filter((e) => e.sequence > sequence && (!table || e.table === table))
      .map((e) => this.toChangeEvent(e));
  }

  /** Outbox entry -> the wire ChangeEvent the backend transport carries. */
  toChangeEvent(entry) {
    return {
      table: entry.table,
      op: entry.op,
      id: entry.id,
      version: clone(entry.version),
      row: clone(entry.row),
      at_ms: entry.at_ms,
      write_key: entry.write_key ?? undefined,
      sync_sequence: entry.sequence,
    };
  }

  /** Outbox entry -> a Supabase postgres_changes payload. The `record` is the
   * committed row exactly as `to_jsonb(NEW)` produced it (sync_version and the
   * timestamps are real columns), so realtime and the backend WS carry byte-
   * identical row content. write_key is NOT a table column, so a realtime-fed
   * change has no write_key (only the backend envelope does). */
  toSupabasePayload(entry) {
    if (entry.op === "delete") {
      return {
        table: entry.table,
        eventType: "DELETE",
        old: { id: entry.id, sync_version: clone(entry.version), updated_at: entry.updated_at_iso },
      };
    }
    return { table: entry.table, eventType: "INSERT", new: clone(entry.row) };
  }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
}

/**
 * The network. Owns the fake fetch (HTTP write path + hydrate), a fake
 * WebSocket class (backend realtime), and a fake Supabase client, all driven by
 * one SimServer. Per-path delivery can be toggled/reordered/duplicated so a test
 * can subject reconcile to any interleaving.
 */
export class Hub {
  /** @param {SimServer} server */
  constructor(server) {
    this.server = server;
    this.baseUrl = "https://sync.test";
    /** delivery switches (flip to simulate a partitioned transport) */
    this.backendLive = true;
    this.supabaseLive = true;
    /** when false, the HTTP write path rejects like a dropped network (the
     * client keeps the write queued); flip back to true and flushQueue drains it. */
    this.online = true;
    /** count of HTTP writes that actually reached the server (retries included) */
    this.httpWrites = 0;
    /** @type {Set<FakeSocket>} */
    this._sockets = new Set();
    /** @type {Set<{tables:Set<string>, cb:(p:object)=>void}>} */
    this._supaSubs = new Set();

    server.subscribe((entry) => {
      if (this.backendLive) this._pushBackend(entry);
      if (this.supabaseLive) this._pushSupabase(entry);
    });

    const hub = this;
    this.WebSocket = class extends FakeSocket {
      constructor(url) {
        super(url, hub);
      }
    };
    this.fetchImpl = this._makeFetch();
    this.supabase = this._makeSupabase();
  }

  _pushBackend(entry) {
    const frame = JSON.stringify({ event: "zed:sync", changes: [this.server.toChangeEvent(entry)] });
    for (const s of this._sockets) s._recv(frame);
  }

  _pushSupabase(entry) {
    const payload = this.server.toSupabasePayload(entry);
    for (const sub of this._supaSubs) {
      if (sub.tables.has(entry.table)) sub.cb(payload);
    }
  }

  _makeFetch() {
    const server = this.server;
    const hub = this;
    return async (url, init = {}) => {
      if (!hub.online) throw new TypeError("fetch failed: network is offline");
      const u = new URL(url);
      const m = u.pathname.match(/^\/api\/sync\/(.+)$/);
      if (!m || (init.method || "GET").toUpperCase() !== "POST") {
        return jsonResponse(404, { error: "not found" });
      }
      const table = decodeURIComponent(m[1]);
      const body = JSON.parse(init.body);
      const headers = normalizeHeaders(init.headers);
      const leaseKey = headers["x-zed-sync-lease-key"];
      const token = headers["x-zed-sync-fencing-token"];
      hub.httpWrites += 1;
      try {
        const { committed_version } = server.commit(
          {
            table,
            op: body.op,
            id: body.id,
            row: body.row,
            write_key: body.write_key ?? headers["idempotency-key"],
          },
          leaseKey != null ? { leaseKey, token: Number(token) } : {},
        );
        return jsonResponse(200, { committed_version });
      } catch (err) {
        if (err instanceof FenceRejected) return jsonResponse(412, { error: String(err.message) });
        return jsonResponse(500, { error: String(err) });
      }
    };
  }

  _makeSupabase() {
    const hub = this;
    return {
      channel(_name) {
        /** @type {Array<{table:string, cb:(p:object)=>void}>} */
        const bindings = [];
        const sub = { tables: new Set(), cb: (p) => bindings.forEach((b) => b.table === p.table && b.cb(p)) };
        return {
          on(_type, filter, cb) {
            bindings.push({ table: filter.table, cb });
            sub.tables.add(filter.table);
            return this;
          },
          subscribe(statusCb) {
            hub._supaSubs.add(sub);
            statusCb?.("SUBSCRIBED");
            this._sub = sub;
            return this;
          },
        };
      },
      removeChannel(ch) {
        if (ch?._sub) hub._supaSubs.delete(ch._sub);
      },
    };
  }

  /** hydrateFetch for a full catch-up replay of the outbox. */
  hydrateFetch() {
    const server = this.server;
    return async (table) => server.changesSince(0, table);
  }

  /** Wait until every in-flight applyChange settles (bounded loop). */
  async settle(rounds = 12) {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
  }
}

/** Minimal WebSocket stand-in matching what startBackendStream uses. */
class FakeSocket {
  constructor(url, hub) {
    this.url = url;
    this._hub = hub;
    this.readyState = 0;
    hub._sockets.add(this);
    // onopen fires after the caller has attached handlers (next microtask).
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }
  _recv(data) {
    if (this.readyState === 1) this.onmessage?.({ data });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._hub._sockets.delete(this);
    this.onclose?.({});
  }
}

function normalizeHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

/**
 * Connect one replica (a device) to the hub with the production wiring: a
 * SyncClient whose `send` is the real backend HTTP sender, plus the real
 * backend WS stream and the real Supabase realtime subscription. Returns the
 * client, its store, and a stop().
 * @param {Hub} hub
 * @param {object} opts
 * @param {string} opts.actor
 * @param {string[]} opts.tables
 * @param {object} [opts.telemetry]
 * @param {string} [opts.writeMode]
 * @param {string} [opts.errorPolicy]
 * @param {string} [opts.conflictResolution]
 * @param {() => ({key:string, token:number}|null)} [opts.getFence]
 * @param {boolean} [opts.backend=true]
 * @param {boolean} [opts.supabase=true]
 * @param {boolean} [opts.hydrateOnReconnect=true]
 */
export function connectReplica(hub, opts) {
  const store = opts.store ?? new MemoryStore();
  const send = makeBackendSender({
    baseUrl: hub.baseUrl,
    fetchImpl: hub.fetchImpl,
    getFence: opts.getFence,
  });
  const client = new SyncClient({
    store,
    actor: opts.actor,
    send,
    telemetry: opts.telemetry,
    writeMode: opts.writeMode,
    errorPolicy: opts.errorPolicy,
    conflictResolution: opts.conflictResolution,
    tables: opts.tables,
    onError: opts.onError,
  });

  const hydrate = async () => {
    for (const table of opts.tables) {
      await client.hydrate(await hub.hydrateFetch()(table));
    }
  };

  const stoppers = [];
  if (opts.backend !== false) {
    stoppers.push(
      startBackendStream({
        baseUrl: hub.baseUrl,
        sync: client,
        WebSocketImpl: hub.WebSocket,
        onReconnect: opts.hydrateOnReconnect === false ? undefined : hydrate,
      }),
    );
  }
  if (opts.supabase !== false) {
    stoppers.push(startSupabase({ client: hub.supabase, sync: client, tables: opts.tables }));
  }

  return {
    client,
    store,
    hydrate,
    stop() {
      for (const s of stoppers) s.stop();
    },
  };
}

/** Convenience: the visible row payload (or null) for an assertion. */
export async function rowOf(store, table, id) {
  const r = await store.getRow(table, id);
  return r ? r.row : undefined;
}

/** Server-managed columns every canonical row carries; stripped for domain
 * comparisons so a test asserts on business fields, not timestamps/HLC. */
export const SERVER_COLUMNS = ["created_at", "updated_at", "sync_version"];

/** The domain projection of a stored row (server columns removed), or the
 * sentinel: undefined (absent) / null (tombstone). */
export async function domainRow(store, table, id) {
  const r = await store.getRow(table, id);
  if (!r) return undefined;
  if (r.row == null) return null;
  const out = {};
  for (const [k, v] of Object.entries(r.row)) if (!SERVER_COLUMNS.includes(k)) out[k] = v;
  return out;
}

/** Convenience: the reconciled HLC version a replica holds for a row. */
export async function versionOf(store, table, id) {
  const r = await store.getRow(table, id);
  return r ? r.meta.version : undefined;
}
