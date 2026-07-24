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

test("telemetry fires the write lifecycle events", async () => {
  const telemetry = recordingTelemetry();
  const { client } = makeClient({ telemetry });
  await client.write("p", "1", { id: "1" });
  const names = telemetry.events.map((e) => e.name);
  assert.ok(names.includes("sync.write.start"));
  assert.ok(names.includes("sync.write.local"));
  assert.ok(names.includes("sync.write.acked"));
});
