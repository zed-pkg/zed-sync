// End-to-end SyncClient behavior across the WriteMode enum, echo/ack settling,
// conflict resolution, and telemetry — all against the in-memory store (no DOM).
import test from "node:test";
import assert from "node:assert/strict";
import { SyncClient } from "../src/client.mjs";
import { MemoryStore } from "../src/store.mjs";
import { WriteMode, ErrorPolicy } from "../src/policy.mjs";

function recordingTelemetry() {
  const events = [];
  return { events, event: (name, attrs) => events.push({ name, attrs }) };
}

function makeClient(overrides = {}) {
  const store = new MemoryStore();
  const sent = [];
  const client = new SyncClient({
    store,
    actor: "dev-1",
    send: async (change) => {
      sent.push(change);
      // Server commits at a higher HLC than the client's base.
      return { committed_version: { wall_ms: change.version.wall_ms + 1000, counter: 0, actor: "srv" } };
    },
    ...overrides,
  });
  return { client, store, sent };
}

test("optimistic_queue applies locally, sends, and adopts the ack", async () => {
  const { client, store, sent } = makeClient();
  const res = await client.write("products", "p1", { id: "p1", name: "Ball" });
  assert.equal(res.status, "acked");
  assert.equal(sent.length, 1);
  const row = await store.getRow("products", "p1");
  assert.equal(row.meta.dirty, false, "adopted clean after ack");
  assert.equal(row.meta.actor, undefined);
  assert.equal((await store.pending()).length, 0, "queue drained");
});

test("local_only applies + enqueues but never sends", async () => {
  const { client, store, sent } = makeClient();
  const res = await client.write("products", "p1", { id: "p1" }, { mode: WriteMode.LOCAL_ONLY });
  assert.equal(res.status, "local");
  assert.equal(sent.length, 0);
  assert.equal((await store.pending()).length, 1, "still queued for later flush");
  const row = await store.getRow("products", "p1");
  assert.equal(row.meta.dirty, true);
});

test("optimistic_queue keeps the write queued on send failure", async () => {
  const { client, store } = makeClient({
    send: async () => {
      throw new Error("offline");
    },
  });
  const res = await client.write("products", "p1", { id: "p1" });
  assert.equal(res.status, "queued");
  assert.equal((await store.pending()).length, 1);
});

test("optimistic_await_ack surfaces send errors per the error policy", async () => {
  const telemetry = recordingTelemetry();
  const { client } = makeClient({
    send: async () => {
      throw new Error("boom");
    },
    telemetry,
    errorPolicy: ErrorPolicy.THROW_ONLY,
  });
  await assert.rejects(() => client.write("p", "1", { id: "1" }, { mode: WriteMode.OPTIMISTIC_AWAIT_ACK }));
});

test("server_first does not apply locally until the ack", async () => {
  const { client, store } = makeClient();
  await client.write("orders", "o1", { id: "o1" }, { mode: WriteMode.SERVER_FIRST });
  const row = await store.getRow("orders", "o1");
  assert.equal(row.meta.dirty, false, "clean, applied only after ack");
  assert.equal((await store.pending()).length, 0, "nothing queued");
});

test("flushQueue re-sends everything under the original keys", async () => {
  const store = new MemoryStore();
  let online = false;
  const sent = [];
  const client = new SyncClient({
    store,
    actor: "dev-1",
    send: async (c) => {
      if (!online) throw new Error("offline");
      sent.push(c);
      return { committed_version: { wall_ms: c.version.wall_ms + 1, counter: 0, actor: "srv" } };
    },
  });
  await client.write("p", "1", { id: "1" }); // queued (offline)
  await client.write("p", "2", { id: "2" }); // queued (offline)
  assert.equal((await store.pending()).length, 2);
  online = true;
  const flushed = await client.flushQueue();
  assert.equal(flushed, 2);
  assert.equal((await store.pending()).length, 0);
});

test("incoming change reconciles: newer applies, stale ignored", async () => {
  const { client, store } = makeClient();
  await client.applyChange({
    table: "products", op: "upsert", id: "p1",
    version: { wall_ms: 100, counter: 0, actor: "srv" }, row: { id: "p1", v: 1 }, at_ms: 100,
  });
  await client.applyChange({
    table: "products", op: "upsert", id: "p1",
    version: { wall_ms: 50, counter: 0, actor: "srv" }, row: { id: "p1", v: "stale" }, at_ms: 50,
  });
  const row = await store.getRow("products", "p1");
  assert.equal(row.row.v, 1, "stale change ignored");
});

test("server-wins conflict adopts server row and drops the queued write", async () => {
  const store = new MemoryStore();
  const client = new SyncClient({
    store, actor: "dev-1",
    send: async () => {
      throw new Error("offline");
    },
  });
  // Dirty local write, still queued (offline).
  await client.write("products", "p1", { id: "p1", who: "me" });
  assert.equal((await store.pending()).length, 1);
  // A newer server change arrives -> conflict -> server wins.
  await client.applyChange({
    table: "products", op: "upsert", id: "p1",
    version: { wall_ms: 9_999_999_999_999, counter: 0, actor: "srv" }, row: { id: "p1", who: "server" }, at_ms: 1,
  });
  const row = await store.getRow("products", "p1");
  assert.equal(row.row.who, "server");
  assert.equal(row.meta.dirty, false);
  assert.equal((await store.pending()).length, 0, "queued write dropped on server-wins");
});

test("write-queue overflow surfaces through the client error policy", async () => {
  const store = new MemoryStore({ maxQueueLength: 2 });
  const errors = [];
  const client = new SyncClient({
    store, actor: "dev-1",
    send: async () => {
      throw new Error("offline"); // keep every write queued
    },
    errorPolicy: ErrorPolicy.EMIT_ONLY,
    onError: (err, ctx) => errors.push(ctx),
  });
  for (let i = 0; i < 5; i++) await client.write("t", `row-${i}`, { id: `row-${i}` });
  assert.equal((await store.pending()).length, 2, "queue held at the cap");
  assert.ok(errors.some((c) => c.reason === "queue-overflow"), "overflow surfaced via onError");
});

test("applyChange drops incoming changes for non-allowlisted tables", async () => {
  const telemetry = recordingTelemetry();
  const { client, store } = makeClient({ tables: ["products"], telemetry });
  // Allowed table applies as normal.
  const allowed = await client.applyChange({
    table: "products", op: "upsert", id: "p1",
    version: { wall_ms: 100, counter: 0, actor: "srv" }, row: { id: "p1" }, at_ms: 100,
  });
  assert.equal(allowed, "applied");
  // A change for a table not in the allowlist is dropped, never written.
  const dropped = await client.applyChange({
    table: "secrets", op: "upsert", id: "s1",
    version: { wall_ms: 200, counter: 0, actor: "srv" }, row: { id: "s1", stolen: true }, at_ms: 200,
  });
  assert.equal(dropped, "ignored");
  assert.equal(await store.getRow("secrets", "s1"), null, "non-allowlisted change not stored");
  assert.ok(telemetry.events.some((e) => e.name === "sync.change.rejected"));
});

test("applyChange without an allowlist accepts any table (back-compat)", async () => {
  const { client, store } = makeClient();
  await client.applyChange({
    table: "anything", op: "upsert", id: "x",
    version: { wall_ms: 1, counter: 0, actor: "srv" }, row: { id: "x" }, at_ms: 1,
  });
  assert.notEqual(await store.getRow("anything", "x"), null);
});

test("telemetry fires the write lifecycle events", async () => {
  const telemetry = recordingTelemetry();
  const { client } = makeClient({ telemetry });
  await client.write("p", "1", { id: "1" });
  const names = telemetry.events.map((e) => e.name);
  assert.ok(names.includes("sync.write.start"));
  assert.ok(names.includes("sync.write.local"));
  assert.ok(names.includes("sync.write.acked"));
});

test("merge upsert folds a partial patch into the existing row and sends the merged row", async () => {
  const { client, store, sent } = makeClient();
  await client.write("products", "p1", { id: "p1", name: "Ball", meta: { color: "red", size: "M" } });
  await client.write("products", "p1", { meta: { size: "L" } }, { merge: true });
  const row = await store.getRow("products", "p1");
  assert.deepEqual(row.row, { id: "p1", name: "Ball", meta: { color: "red", size: "L" } });
  assert.deepEqual(sent[1].row, row.row, "the server receives the merged row, not the bare patch");
});

test("merge upsert on a missing row stores the patch as-is", async () => {
  const { client, store } = makeClient();
  await client.write("products", "new", { name: "only-a-patch" }, { merge: true });
  assert.deepEqual((await store.getRow("products", "new")).row, { name: "only-a-patch" });
});

test("delete() writes a tombstone and a late stale upsert stays ordered-out", async () => {
  const { client, store } = makeClient();
  await client.write("products", "p1", { id: "p1" });
  const res = await client.delete("products", "p1");
  assert.equal(res.status, "acked");
  const tomb = await store.getRow("products", "p1");
  assert.equal(tomb.row, null);
  assert.equal(tomb.meta.dirty, false);
  const outcome = await client.applyChange({
    table: "products", op: "upsert", id: "p1",
    version: { wall_ms: 1, counter: 0, actor: "srv" }, row: { id: "p1", zombie: true }, at_ms: 1,
  });
  assert.equal(outcome, "ignored");
  assert.equal((await store.getRow("products", "p1")).row, null, "the delete holds");
});

test("write(table, id, null) infers a delete op", async () => {
  const { client, store, sent } = makeClient();
  await client.write("products", "p1", { id: "p1" });
  await client.write("products", "p1", null);
  assert.equal(sent[1].op, "delete");
  assert.equal((await store.getRow("products", "p1")).row, null);
});

test("server_only never touches the local store or the queue", async () => {
  const { client, store, sent } = makeClient();
  const res = await client.write("orders", "o1", { id: "o1" }, { mode: WriteMode.SERVER_ONLY });
  assert.equal(res.status, "acked");
  assert.equal(sent.length, 1);
  assert.equal(await store.getRow("orders", "o1"), null, "local state waits for the change feed");
  assert.equal((await store.pending()).length, 0);
});

test("server_first failure stores nothing and reports through onError (default EMIT_ONLY)", async () => {
  const failures = [];
  const { client, store } = makeClient({
    send: async () => {
      throw new Error("500");
    },
    onError: (err, ctx) => failures.push(ctx),
  });
  const res = await client.write("orders", "o1", { id: "o1" }, { mode: WriteMode.SERVER_FIRST });
  assert.equal(res.status, "failed");
  assert.equal(await store.getRow("orders", "o1"), null, "no dirty window on server_first failure");
  assert.equal((await store.pending()).length, 0, "nothing queued on failure");
  assert.equal(failures.length, 1);
});

test("SILENT error policy stays quiet: no throw, no onError, no failure event", async () => {
  const telemetry = recordingTelemetry();
  const failures = [];
  const { client } = makeClient({
    send: async () => {
      throw new Error("boom");
    },
    telemetry,
    onError: (e) => failures.push(e),
  });
  const res = await client.write("o", "1", { id: "1" }, {
    mode: WriteMode.OPTIMISTIC_AWAIT_ACK, errorPolicy: ErrorPolicy.SILENT,
  });
  assert.equal(res.status, "queued", "the write itself still queues durably");
  assert.equal(failures.length, 0);
  assert.ok(!telemetry.events.some((e) => e.name === "sync.write.failed"));
});

test("THROW_AND_EMIT both rejects and reports", async () => {
  const failures = [];
  const { client } = makeClient({
    send: async () => {
      throw new Error("boom");
    },
    onError: (e) => failures.push(e),
  });
  await assert.rejects(() =>
    client.write("o", "1", { id: "1" }, { mode: WriteMode.OPTIMISTIC_AWAIT_ACK, errorPolicy: ErrorPolicy.THROW_AND_EMIT }),
  );
  assert.equal(failures.length, 1);
});

test("flushQueue EMIT_ONLY stops at the first failure without throwing; the rest stay queued", async () => {
  const store = new MemoryStore();
  let online = false;
  const failed = [];
  const client = new SyncClient({
    store, actor: "dev-1",
    send: async (c) => {
      if (!online) throw new Error("offline");
      if (c.id === "2") throw new Error("row 2 rejected");
      return { committed_version: { wall_ms: c.version.wall_ms + 1, counter: 0, actor: "srv" } };
    },
    onError: (err, ctx) => failed.push(ctx.id),
  });
  await client.write("p", "1", { id: "1" });
  await client.write("p", "2", { id: "2" });
  await client.write("p", "3", { id: "3" });
  online = true;
  const sent = await client.flushQueue(ErrorPolicy.EMIT_ONLY);
  assert.equal(sent, 1);
  assert.deepEqual((await store.pending()).map((w) => w.id), ["2", "3"], "failed + unsent stay for the next flush");
  assert.deepEqual(failed, ["2"]);
});

test("flushQueue default policy rethrows the first failure and keeps the write queued", async () => {
  const store = new MemoryStore();
  const client = new SyncClient({
    store, actor: "dev-1",
    send: async () => {
      throw new Error("offline");
    },
  });
  await client.write("p", "1", { id: "1" });
  await assert.rejects(() => client.flushQueue(), /offline/);
  assert.equal((await store.pending()).length, 1);
});

test("isEcho matches only the exact queued write_key", async () => {
  const { client, store } = makeClient({
    send: async () => {
      throw new Error("offline");
    },
  });
  await client.write("carts", "c1", { id: "c1" }); // stays queued
  const [queued] = await store.pending();
  const echo = {
    table: "carts", op: "upsert", id: "c1",
    version: { wall_ms: 99, counter: 0, actor: "srv" }, row: { id: "c1" }, at_ms: 99, write_key: queued.key,
  };
  assert.equal(await client.isEcho(echo), true);
  assert.equal(await client.isEcho({ ...echo, write_key: "someone-else" }), false);
});

test("an equal-version change refreshes a clean row's payload (server-normalized row wins)", async () => {
  const { client, store } = makeClient();
  const version = { wall_ms: 100, counter: 0, actor: "srv" };
  await client.applyChange({ table: "p", op: "upsert", id: "1", version, row: { id: "1", name: "raw" }, at_ms: 100 });
  const outcome = await client.applyChange({
    table: "p", op: "upsert", id: "1", version, row: { id: "1", name: "normalized" }, at_ms: 100,
  });
  assert.equal(outcome, "refreshed");
  assert.equal((await store.getRow("p", "1")).row.name, "normalized");
});

test("a dirty write preserves the prior synced_at_ms (editing synced state does not un-sync it)", async () => {
  const store = new MemoryStore();
  let online = true;
  const client = new SyncClient({
    store, actor: "dev-1",
    send: async (c) => {
      if (!online) throw new Error("offline");
      return { committed_version: { wall_ms: c.version.wall_ms + 1, counter: 0, actor: "srv" } };
    },
  });
  await client.write("p", "1", { id: "1" });
  const synced = (await store.getRow("p", "1")).meta.synced_at_ms;
  assert.notEqual(synced, null, "acked write stamps synced_at_ms");
  online = false;
  await client.write("p", "1", { id: "1", v: 2 });
  const after = await store.getRow("p", "1");
  assert.equal(after.meta.dirty, true);
  assert.equal(after.meta.synced_at_ms, synced);
});

test("constructor validates its dependencies and enums up front", () => {
  assert.throws(() => new SyncClient({ actor: "dev" }), TypeError);
  assert.throws(() => new SyncClient({ store: new MemoryStore() }), TypeError);
  assert.throws(() => new SyncClient({ store: new MemoryStore(), actor: "d", writeMode: "eager" }), RangeError);
  assert.throws(() => new SyncClient({ store: new MemoryStore(), actor: "d", errorPolicy: "loud" }), RangeError);
  assert.throws(() => new SyncClient({ store: new MemoryStore(), actor: "d", conflictResolution: "coin_flip" }), RangeError);
});

test("a per-write mode typo rejects before any local mutation", async () => {
  const { client, store } = makeClient();
  await assert.rejects(() => client.write("p", "1", { id: "1" }, { mode: "yolo" }), RangeError);
  assert.equal(await store.getRow("p", "1"), null);
  assert.equal((await store.pending()).length, 0);
});
