// MemoryStore contract tests — the store interface SyncClient depends on
// (rows, tombstones, the durable queue, cursors). IndexedDbStore implements
// the same interface but needs a browser IDB, so it is exercised in headless
// Chromium by test/browser/idb.browser.test.mjs (`npm run test:browser`).
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.mjs";

const v = (wall) => ({ wall_ms: wall, counter: 0, actor: "dev" });
const meta = (wall, extra = {}) => ({ version: v(wall), dirty: false, synced_at_ms: null, ...extra });

test("getRow returns null for a row never written", async () => {
  assert.equal(await new MemoryStore().getRow("t", "missing"), null);
});

test("putRow/getRow roundtrips row and meta; later puts win", async () => {
  const s = new MemoryStore();
  await s.putRow("t", "1", { id: "1", n: 1 }, meta(1));
  await s.putRow("t", "1", { id: "1", n: 2 }, meta(2, { dirty: true }));
  assert.deepEqual(await s.getRow("t", "1"), {
    row: { id: "1", n: 2 },
    meta: { version: v(2), dirty: true, synced_at_ms: null },
  });
});

test("removeRow leaves a tombstone that keeps the delete's meta", async () => {
  const s = new MemoryStore();
  await s.putRow("t", "1", { id: "1" }, meta(1));
  await s.removeRow("t", "1", meta(2));
  const got = await s.getRow("t", "1");
  assert.notEqual(got, null, "tombstone, not a missing row — stale upserts must stay ordered-out");
  assert.equal(got.row, null);
  assert.deepEqual(got.meta.version, v(2));
});

test("rows are keyed per (table, id)", async () => {
  const s = new MemoryStore();
  await s.putRow("products", "1", { of: "products" }, meta(1));
  await s.putRow("orders", "1", { of: "orders" }, meta(1));
  assert.equal((await s.getRow("products", "1")).row.of, "products");
  assert.equal((await s.getRow("orders", "1")).row.of, "orders");
});

test("enqueue assigns increasing seqs and preserves FIFO order in pending()", async () => {
  const s = new MemoryStore();
  const s1 = await s.enqueue({ table: "t", id: "1" });
  const s2 = await s.enqueue({ table: "t", id: "2" });
  assert.ok(s2 > s1);
  assert.deepEqual((await s.pending()).map((w) => w.id), ["1", "2"]);
});

test("retire removes exactly the given seq; unknown seqs are a no-op", async () => {
  const s = new MemoryStore();
  const s1 = await s.enqueue({ table: "t", id: "1" });
  const s2 = await s.enqueue({ table: "t", id: "2" });
  await s.retire(s1);
  assert.deepEqual((await s.pending()).map((w) => w.seq), [s2]);
  await s.retire(999_999);
  assert.equal((await s.pending()).length, 1);
});

test("pending returns a snapshot — mutating it does not affect the queue", async () => {
  const s = new MemoryStore();
  await s.enqueue({ table: "t", id: "1" });
  const snapshot = await s.pending();
  snapshot.length = 0;
  assert.equal((await s.pending()).length, 1);
});

test("enqueue coalesces repeated writes to the same (table,id) into one entry", async () => {
  const s = new MemoryStore();
  const s1 = await s.enqueue({ table: "t", id: "1", payload: { n: 1 } });
  const s2 = await s.enqueue({ table: "t", id: "1", payload: { n: 2 } });
  assert.equal(s2, s1, "same queue slot reused");
  const pending = await s.pending();
  assert.equal(pending.length, 1, "coalesced, not appended");
  assert.deepEqual(pending[0].payload, { n: 2 }, "newer payload wins");
});

test("settleAck atomically preserves a coalesced slot on write-key mismatch", async () => {
  const s = new MemoryStore();
  const first = { wall_ms: 100, counter: 0, actor: "dev" };
  const second = { wall_ms: 100, counter: 1, actor: "dev" };
  await s.putRow("t", "1", { n: 2 }, {
    version: second, dirty: true, synced_at_ms: null,
  });
  const seq = await s.enqueue({
    table: "t", id: "1", key: "write-1", base_version: first, payload: { n: 1 },
  });
  await s.enqueue({
    table: "t", id: "1", key: "write-2", base_version: second, payload: { n: 2 },
  });

  const stale = await s.settleAck({
    table: "t",
    id: "1",
    seq,
    writeKey: "write-1",
    baseVersion: first,
    committedVersion: { wall_ms: 9999, counter: 0, actor: "server" },
    at: 1000,
  });
  assert.deepEqual(stale, { retired: false, adopted: false });
  assert.equal((await s.pending())[0].key, "write-2");
  assert.equal((await s.getRow("t", "1")).meta.dirty, true);

  const wrongGeneration = await s.settleAck({
    table: "t",
    id: "1",
    seq,
    writeKey: "write-2",
    baseVersion: first,
    committedVersion: { wall_ms: 9999, counter: 0, actor: "server" },
    at: 1500,
  });
  assert.deepEqual(wrongGeneration, { retired: false, adopted: false });
  assert.equal((await s.pending())[0].key, "write-2", "base-generation mismatch preserves the slot");
  assert.equal((await s.getRow("t", "1")).meta.dirty, true);

  const current = await s.settleAck({
    table: "t",
    id: "1",
    seq,
    writeKey: "write-2",
    baseVersion: second,
    committedVersion: { wall_ms: 200, counter: 0, actor: "server" },
    at: 2000,
  });
  assert.deepEqual(current, { retired: true, adopted: true });
  assert.equal((await s.pending()).length, 0);
  assert.deepEqual((await s.getRow("t", "1")).meta, {
    version: { wall_ms: 200, counter: 0, actor: "server" },
    dirty: false,
    synced_at_ms: 2000,
  });
});

test("enqueue does not grow the queue past maxQueueLength (drop-oldest)", async () => {
  const dropped = [];
  const s = new MemoryStore({ maxQueueLength: 3 });
  s.onOverflow = (w) => dropped.push(w);
  for (let i = 0; i < 10; i++) await s.enqueue({ table: "t", id: String(i) });
  const pending = await s.pending();
  assert.equal(pending.length, 3, "queue capped at maxQueueLength");
  assert.deepEqual(pending.map((w) => w.id), ["7", "8", "9"], "oldest dropped, newest kept");
  assert.equal(dropped.length, 7, "each overflow surfaced via onOverflow");
  assert.deepEqual(dropped[0].id, "0", "oldest dropped first");
});

test("cursors roundtrip per scope, default to null, and stay independent", async () => {
  const s = new MemoryStore();
  assert.equal(await s.getCursor("feed"), null);
  await s.setCursor("feed", "c-42", 1234);
  assert.deepEqual(await s.getCursor("feed"), { cursor: "c-42", lastSyncedAtMs: 1234 });
  await s.setCursor("other", "c-1", 1);
  assert.equal((await s.getCursor("feed")).cursor, "c-42");
});
