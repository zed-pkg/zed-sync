import test from "node:test";
import assert from "node:assert/strict";

import {
  SyncLease,
  withSyncLease,
  flusherLeaseKey,
  LeaseLostError,
  LeaseTimeoutError,
} from "../src/lease.mjs";
import { startSync } from "../src/start.mjs";
import { MemoryStore } from "../src/store.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeHandle(overrides = {}) {
  const handle = {
    fencingToken: overrides.fencingToken ?? 7,
    leaseExpiresMs: overrides.leaseExpiresMs,
    renewCalls: 0,
    releaseCalls: 0,
    async renew(ttlMs) {
      handle.renewCalls += 1;
      if (overrides.renew) return overrides.renew(handle, ttlMs);
    },
    async release() {
      handle.releaseCalls += 1;
    },
  };
  return handle;
}

function makeClient({ lock, tryLock } = {}) {
  const client = {
    lockCalls: [],
    tryCalls: [],
    async lock(key, opts) {
      client.lockCalls.push({ key, opts });
      return lock ? lock(key, opts, client.lockCalls.length) : makeHandle();
    },
    async tryLock(key, opts) {
      client.tryCalls.push({ key, opts });
      return tryLock ? tryLock(key, opts, client.tryCalls.length) : makeHandle();
    },
  };
  return client;
}

const lockTimeout = () => {
  const err = new Error("timed out waiting for lock");
  err.name = "LockTimeoutError";
  return err;
};

test("flusherLeaseKey builds the canonical key and rejects blanks", () => {
  assert.equal(flusherLeaseKey("appdb", "device-1"), "zed-sync/flusher/appdb/device-1");
  assert.throws(() => flusherLeaseKey("", "a"), TypeError);
  assert.throws(() => flusherLeaseKey("db", ""), TypeError);
});

test("constructor validates client shape, key, and interval ordering", () => {
  const client = makeClient();
  assert.throws(() => new SyncLease({ client: {}, key: "k" }), TypeError);
  assert.throws(() => new SyncLease({ client, key: "" }), TypeError);
  assert.throws(() => new SyncLease({ client, key: "k", ttlMs: 100, renewIntervalMs: 100 }), RangeError);
  assert.throws(() => new SyncLease({ client, key: "k", ttlMs: -5 }), RangeError);
});

test("tryAcquire: false when held elsewhere, true (with fencing token) when free", async () => {
  let free = false;
  const client = makeClient({ tryLock: () => (free ? makeHandle({ fencingToken: 42 }) : null) });
  const lease = new SyncLease({ client, key: "k" });

  assert.equal(await lease.tryAcquire(), false);
  assert.equal(lease.held, false);
  assert.equal(lease.fencingToken, null);

  free = true;
  assert.equal(await lease.tryAcquire(), true);
  assert.equal(lease.held, true);
  assert.equal(lease.fencingToken, 42);
  await lease.release();
});

test("acquire passes ttl/holder/wait budget through to the lock client", async () => {
  const client = makeClient();
  const lease = new SyncLease({ client, key: "k", ttlMs: 5_000, renewIntervalMs: 1_000, holder: "h-1" });
  await lease.acquire({ maxWaitMs: 10_000 });
  const { key, opts } = client.lockCalls[0];
  assert.equal(key, "k");
  assert.equal(opts.ttl, 5_000);
  assert.equal(opts.holder, "h-1");
  assert.ok(opts.maxWaitTime <= 10_000);
  await lease.release();
});

test("heartbeat renews on cadence and release stops it", async () => {
  const handle = makeHandle();
  const client = makeClient({ lock: () => handle });
  const lease = new SyncLease({ client, key: "k", ttlMs: 60, renewIntervalMs: 15 });
  await lease.acquire();
  await sleep(55);
  assert.ok(handle.renewCalls >= 2, `expected >=2 renews, saw ${handle.renewCalls}`);

  await lease.release();
  assert.equal(handle.releaseCalls, 1);
  const after = handle.renewCalls;
  await sleep(40);
  assert.equal(handle.renewCalls, after, "renewals must stop after release");
});

test("renew failure proving lost authority fires onLost immediately", async () => {
  const handle = makeHandle({
    renew: () => {
      throw new Error("fiducia: lock renewal lost fenced authority");
    },
  });
  const client = makeClient({ lock: () => handle });
  const lost = [];
  const lease = new SyncLease({
    client,
    key: "k",
    ttlMs: 60,
    renewIntervalMs: 15,
    onLost: (err) => lost.push(err),
  });
  await lease.acquire();
  await sleep(40);
  assert.equal(lost.length, 1);
  assert.ok(lost[0] instanceof LeaseLostError);
  assert.equal(lease.held, false);
  assert.equal(handle.renewCalls, 1, "no further renew attempts after authority loss");
});

test("transient renew failures are retried; the limit marks the lease lost", async () => {
  let failures = 0;
  const handle = makeHandle({
    renew: () => {
      failures += 1;
      throw new Error("fetch failed: connection refused");
    },
  });
  const client = makeClient({ lock: () => handle });
  const lost = [];
  const renewErrors = [];
  const lease = new SyncLease({
    client,
    key: "k",
    ttlMs: 2_000,
    renewIntervalMs: 20,
    renewFailureLimit: 3,
    onLost: (err) => lost.push(err),
    onRenewError: (_err, n) => renewErrors.push(n),
  });
  await lease.acquire();
  await sleep(700);
  assert.equal(lost.length, 1);
  assert.equal(failures, 3, "exactly renewFailureLimit attempts before giving up");
  assert.deepEqual(renewErrors, [1, 2, 3]);
  assert.equal(lease.held, false);
});

test("acquire keeps waiting through per-attempt lock timeouts", async () => {
  const client = makeClient({
    lock: (_key, _opts, n) => {
      if (n < 3) throw lockTimeout();
      return makeHandle({ fencingToken: 3 });
    },
  });
  const lease = new SyncLease({ client, key: "k" });
  await lease.acquire();
  assert.equal(lease.fencingToken, 3);
  assert.equal(client.lockCalls.length, 3);
  await lease.release();
});

test("acquire enforces a finite maxWaitMs with LeaseTimeoutError", async () => {
  const client = makeClient({
    lock: async (_key, opts) => {
      await sleep(Math.min(opts.maxWaitTime, 20));
      throw lockTimeout();
    },
  });
  const lease = new SyncLease({ client, key: "k" });
  await assert.rejects(() => lease.acquire({ maxWaitMs: 60 }), LeaseTimeoutError);
  assert.equal(lease.held, false);
});

test("non-timeout acquisition errors propagate unchanged", async () => {
  const client = makeClient({
    lock: () => {
      throw new Error("fiducia: lock cancellation did not establish safety (cancellation_capacity)");
    },
  });
  const lease = new SyncLease({ client, key: "k" });
  await assert.rejects(() => lease.acquire(), /cancellation_capacity/);
});

test("withSyncLease releases even when fn throws", async () => {
  const handle = makeHandle();
  const client = makeClient({ lock: () => handle });
  await assert.rejects(
    () =>
      withSyncLease({ client, key: "k" }, () => {
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(handle.releaseCalls, 1);
});

test("release before a failed release response still drops the grant; errors swallowed", async () => {
  const handle = makeHandle();
  handle.release = async () => {
    handle.releaseCalls += 1;
    throw new Error("network down");
  };
  const client = makeClient({ lock: () => handle });
  const lease = new SyncLease({ client, key: "k" });
  await lease.acquire();
  await lease.release();
  assert.equal(lease.held, false);
  assert.equal(handle.releaseCalls, 1);
});

// --- startSync integration (fake lock client, stubbed transports) -----------

test("startSync gates hydration behind the lease and releases on stop", async () => {
  const order = [];
  const handle = makeHandle();
  const client = makeClient({
    lock: async () => {
      order.push("lock");
      await sleep(10);
      return handle;
    },
  });
  const { client: sync, lease, stop } = await startSync({
    actor: "device-1",
    tables: ["notes"],
    store: new MemoryStore(),
    hydrateFetch: async () => {
      order.push("hydrate");
      return [];
    },
    lease: { client, ttlMs: 5_000, renewIntervalMs: 1_000 },
  });

  assert.deepEqual(order, ["lock", "hydrate"], "hydration must wait for the lease");
  assert.equal(client.lockCalls[0].key, "zed-sync/flusher/zed-sync/device-1");
  assert.equal(lease.held, true);
  assert.ok(sync);

  stop();
  await sleep(5);
  assert.equal(handle.releaseCalls, 1);
  assert.equal(lease.held, false);
});

test("startSync drains the inherited queue after winning the lease", async (t) => {
  const store = new MemoryStore();
  // A write the previous (crashed) holder left behind in the shared store.
  await store.enqueue({
    table: "notes",
    id: "n1",
    op: "upsert",
    payload: { title: "left behind" },
    base_version: { wall_ms: 1, counter: 0, actor: "device-1" },
    key: "device-1-prev-0",
  });

  const fetchCalls = [];
  const realFetch = globalThis.fetch;
  const RealWebSocket = globalThis.WebSocket;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ committed_version: { wall_ms: 2, counter: 0, actor: "server" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  // Inert WebSocket: never connects, never schedules timers.
  globalThis.WebSocket = class {
    close() {}
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = RealWebSocket;
  });

  const client = makeClient();
  const { stop } = await startSync({
    actor: "device-1",
    tables: ["notes"],
    store,
    backend: { baseUrl: "http://backend.test" },
    lease: { client, ttlMs: 5_000, renewIntervalMs: 1_000 },
  });

  assert.equal(fetchCalls.length, 1, "queued write flushed once on promotion");
  assert.match(fetchCalls[0].url, /\/api\/sync\/notes$/);
  assert.equal(fetchCalls[0].init.headers["idempotency-key"], "device-1-prev-0");
  assert.equal((await store.pending()).length, 0, "queue drained");
  stop();
});

test("startSync onLost stops transports and forwards the error", async (t) => {
  let renewShouldFail = false;
  const handle = makeHandle({
    renew: () => {
      if (renewShouldFail) throw new Error("fiducia: lock renewal lost fenced authority");
    },
  });
  const client = makeClient({ lock: () => handle });

  let wsInstances = 0;
  let wsClosed = 0;
  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() {
      wsInstances += 1;
    }
    close() {
      wsClosed += 1;
    }
  };
  t.after(() => {
    globalThis.WebSocket = RealWebSocket;
  });

  const lostErrors = [];
  const { lease, stop } = await startSync({
    actor: "device-1",
    tables: ["notes"],
    store: new MemoryStore(),
    backend: { baseUrl: "http://backend.test" },
    lease: {
      client,
      ttlMs: 100,
      renewIntervalMs: 20,
      flushOnAcquire: false,
      onLost: (err) => lostErrors.push(err),
    },
  });
  await sleep(5); // let the async WS connect land so stop() has something to close
  assert.equal(wsInstances, 1);

  renewShouldFail = true;
  await sleep(60);
  assert.equal(lostErrors.length, 1);
  assert.ok(lostErrors[0] instanceof LeaseLostError);
  assert.equal(lease.held, false);
  assert.ok(wsClosed >= 1, "transport stopped when the lease was lost");
  stop();
});
