// Real-browser tests for IndexedDbStore + SyncClient. The unit suite exercises
// the store contract against MemoryStore (test/store.test.mjs); IndexedDbStore
// needs a real IDB, so it is proven here in headless Chromium (Playwright). This
// is the ONE path that runs the shipped ESM in the environment it targets —
// durable rows + write-queue across a reload, and reconcile over real IDB.
//
// Not part of `npm test` (that globs test/*.test.mjs, not subdirs); run via
// `npm run test:browser`. Self-skips cleanly if Playwright isn't installed, so a
// plain checkout without the browser toolchain still passes.
import test from "node:test";
import assert from "node:assert/strict";
import { startStaticServer } from "./server.mjs";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

// The scenario runs INSIDE the page (real window.indexedDB). It returns a plain
// object of observations; every assertion lives in Node so failures are legible.
async function browserScenario(dbName) {
  const { IndexedDbStore } = await import("/sdk/src/store.mjs");
  const { SyncClient } = await import("/sdk/src/client.mjs");
  const { WriteMode } = await import("/sdk/src/policy.mjs");

  const committing = async (c) => ({
    committed_version: { wall_ms: c.version.wall_ms + 1000, counter: 0, actor: "srv" },
  });
  const offline = async () => {
    throw new Error("offline");
  };
  const out = {};

  // 1) optimistic_queue over real IDB: acked, row stored clean, queue drained.
  {
    const store = await IndexedDbStore.open(dbName);
    const client = new SyncClient({ store, actor: "browser-1", send: committing });
    out.ackStatus = (await client.write("products", "p1", { id: "p1", name: "Ball" })).status;
    const row = await store.getRow("products", "p1");
    out.cleanAfterAck = row.meta.dirty === false && row.row.name === "Ball";
    out.queueDrained = (await store.pending()).length === 0;
  }

  // 2) LOCAL_ONLY offline write is applied dirty and left durably queued.
  {
    const store = await IndexedDbStore.open(dbName);
    const client = new SyncClient({ store, actor: "browser-1", send: offline });
    await client.write("products", "p2", { id: "p2" }, { mode: WriteMode.LOCAL_ONLY });
    out.p2Pending = (await store.pending()).some((w) => w.id === "p2");
  }

  // 3) IDB enqueue coalesces repeated writes to one (table,id) slot.
  {
    const store = await IndexedDbStore.open(dbName);
    const client = new SyncClient({ store, actor: "browser-1", send: offline });
    await client.write("orders", "o1", { n: 1 }, { mode: WriteMode.LOCAL_ONLY });
    await client.write("orders", "o1", { n: 2 }, { mode: WriteMode.LOCAL_ONLY });
    const o1 = (await store.pending()).filter((w) => w.id === "o1");
    out.coalesced = o1.length === 1 && o1[0].payload.n === 2;
  }

  // 4) The IDB transaction binds ack retirement to the immutable key, not the
  //    reused sequence number. Even a server-dominating stale HLC cannot clean
  //    or remove the newer coalesced write.
  {
    const store = await IndexedDbStore.open(dbName);
    const first = { wall_ms: 100, counter: 0, actor: "browser" };
    const second = { wall_ms: 100, counter: 1, actor: "browser" };
    await store.putRow("formal", "race", { n: 2 }, {
      version: second, dirty: true, synced_at_ms: null,
    });
    const seq = await store.enqueue({
      table: "formal", id: "race", key: "write-1", base_version: first, payload: { n: 1 },
    });
    await store.enqueue({
      table: "formal", id: "race", key: "write-2", base_version: second, payload: { n: 2 },
    });
    const stale = await store.settleAck({
      table: "formal",
      id: "race",
      seq,
      writeKey: "write-1",
      baseVersion: first,
      committedVersion: { wall_ms: 9999, counter: 0, actor: "server" },
      at: 1000,
    });
    const queued = (await store.pending()).find((w) => w.table === "formal" && w.id === "race");
    const row = await store.getRow("formal", "race");
    out.staleAckPreserved =
      !stale.retired && !stale.adopted && queued?.key === "write-2" && row.meta.dirty === true;
  }

  // 5) DURABILITY ACROSS RELOAD: a brand-new connection to the SAME db still
  //    sees the committed row and the queued offline writes (survives a reload).
  {
    const store = await IndexedDbStore.open(dbName);
    const row = await store.getRow("products", "p1");
    out.reloadRowSurvives = !!row?.row && row.row.name === "Ball" && row.meta.dirty === false;
    const ids = (await store.pending()).map((w) => w.id);
    out.reloadQueueSurvives = ids.includes("p2") && ids.includes("o1");
  }

  // 6) reconcile over real IDB: a newer server version adopts onto the clean row.
  {
    const store = await IndexedDbStore.open(dbName);
    const client = new SyncClient({ store, actor: "browser-1", send: committing });
    const cur = await store.getRow("products", "p1");
    const newer = { wall_ms: cur.meta.version.wall_ms + 5000, counter: 0, actor: "srv" };
    out.applyOutcome = await client.applyChange({
      table: "products", op: "upsert", id: "p1", version: newer, row: { id: "p1", name: "Ball2" }, at_ms: 1,
    });
    out.adopted = (await store.getRow("products", "p1")).row.name === "Ball2";
  }

  return out;
}

test("IndexedDbStore + SyncClient in real headless Chromium", { skip: chromium ? false : "playwright not installed" }, async () => {
  const srv = await startStaticServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${srv.origin}/`, { waitUntil: "domcontentloaded" });
    const dbName = `zed-sync-browser-test-${Date.now().toString(36)}`;
    const out = await page.evaluate(browserScenario, dbName);

    assert.deepEqual(errors, [], "no uncaught page errors");
    assert.equal(out.ackStatus, "acked", "optimistic_queue acked over IDB");
    assert.equal(out.cleanAfterAck, true, "row stored clean after ack");
    assert.equal(out.queueDrained, true, "queue drained after ack");
    assert.equal(out.p2Pending, true, "LOCAL_ONLY write left durably queued");
    assert.equal(out.coalesced, true, "IDB enqueue coalesced repeated writes, newest payload wins");
    assert.equal(out.staleAckPreserved, true, "IDB settlement preserved the newer coalesced write");
    assert.equal(out.reloadRowSurvives, true, "committed row survives a reload (new IDB connection)");
    assert.equal(out.reloadQueueSurvives, true, "queued offline writes survive a reload");
    assert.equal(out.applyOutcome, "applied", "newer server version applies over IDB");
    assert.equal(out.adopted, true, "reconciled row adopted the newer server payload");
  } finally {
    await browser.close();
    await srv.close();
  }
});
