// E2E: multi-replica convergence through the real transports against the
// simulated Postgres server. Proves the core promise (docs/protocol.md): the
// same committed change delivered over Supabase realtime AND the backend WS, in
// any order, with duplicates, converges every replica to identical state.

import test from "node:test";
import assert from "node:assert/strict";
import { SimServer, Hub, connectReplica, domainRow, versionOf } from "./e2e_harness.mjs";
import { WriteMode } from "../src/policy.mjs";

const TABLES = ["products"];

test("two replicas converge: A's optimistic write reaches B over both transports", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES });
  const b = connectReplica(hub, { actor: "dev-B", tables: TABLES });
  await hub.settle();

  const res = await a.client.write("products", "p1", { id: "p1", name: "Ball", price: 10 });
  assert.equal(res.status, "acked");
  await hub.settle();

  // A adopted the server-committed version and dropped its queue.
  const av = await versionOf(a.store, "products", "p1");
  assert.equal(av.actor, "pg", "A adopted the server HLC");
  assert.equal((await a.store.pending()).length, 0, "A's queue drained on ack");

  // B learned the row purely from the change feed and holds the SAME version.
  assert.deepEqual(await domainRow(b.store, "products", "p1"), { id: "p1", name: "Ball", price: 10 });
  assert.deepEqual(await versionOf(b.store, "products", "p1"), av, "B converged to A's committed version");

  a.stop();
  b.stop();
});

test("duplicate delivery (both transports live) is idempotent — no double apply, no spurious conflict", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES });
  const b = connectReplica(hub, { actor: "dev-B", tables: TABLES });
  await hub.settle();

  await a.client.write("products", "p1", { id: "p1", name: "v1" });
  await hub.settle();
  const v1 = await versionOf(b.store, "products", "p1");

  // Re-broadcast the same outbox entry over both paths several more times.
  const entry = hub.server.outbox[hub.server.outbox.length - 1];
  for (let i = 0; i < 5; i++) {
    hub._pushBackend(entry);
    hub._pushSupabase(entry);
  }
  await hub.settle();

  assert.deepEqual(await versionOf(b.store, "products", "p1"), v1, "version unchanged by dupes");
  assert.deepEqual(await domainRow(b.store, "products", "p1"), { id: "p1", name: "v1" });
  a.stop();
  b.stop();
});

test("out-of-order delivery converges: three sequential commits replayed newest-first", async () => {
  const hub = new Hub(new SimServer());
  hub.backendLive = false; // suppress live delivery; we replay manually, reordered
  hub.supabaseLive = false;
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES, backend: false, supabase: false });
  const observer = connectReplica(hub, { actor: "obs", tables: TABLES, backend: false, supabase: false });
  await hub.settle();

  await a.client.write("products", "p1", { id: "p1", n: 1 });
  await a.client.write("products", "p1", { id: "p1", n: 2 });
  await a.client.write("products", "p1", { id: "p1", n: 3 });

  const entries = [...hub.server.outbox];
  assert.equal(entries.length, 3);
  // Deliver to the observer newest -> oldest (worst case for staleness).
  for (const e of [...entries].reverse()) {
    await observer.client.applyChange(hub.server.toChangeEvent(e));
  }

  assert.deepEqual(await domainRow(observer.store, "products", "p1"), { id: "p1", n: 3 }, "newest wins regardless of arrival order");
  const finalVersion = hub.server.outbox[2].version;
  assert.deepEqual(await versionOf(observer.store, "products", "p1"), finalVersion);
  a.stop();
  observer.stop();
});

test("a late-joining replica catches up the whole history via hydrate", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES });
  await hub.settle();

  await a.client.write("products", "p1", { id: "p1", name: "one" });
  await a.client.write("products", "p2", { id: "p2", name: "two" });
  await a.client.delete("products", "p1");
  await hub.settle();

  // B connects only now; its WS onopen triggers hydrate over the full outbox.
  const b = connectReplica(hub, { actor: "dev-B", tables: TABLES });
  await hub.settle();

  assert.equal(await domainRow(b.store, "products", "p1"), null, "deleted row is a tombstone on B");
  assert.deepEqual(await domainRow(b.store, "products", "p2"), { id: "p2", name: "two" });
  a.stop();
  b.stop();
});

test("three replicas, interleaved writes to distinct rows, all converge", async () => {
  const hub = new Hub(new SimServer());
  const reps = ["A", "B", "C"].map((n) => connectReplica(hub, { actor: `dev-${n}`, tables: TABLES }));
  await hub.settle();

  await reps[0].client.write("products", "a", { id: "a", who: "A" });
  await reps[1].client.write("products", "b", { id: "b", who: "B" });
  await reps[2].client.write("products", "c", { id: "c", who: "C" });
  await reps[0].client.write("products", "b", { id: "b", who: "A-edit" }); // cross-edit
  await hub.settle();

  for (const r of reps) {
    assert.deepEqual(await domainRow(r.store, "products", "a"), { id: "a", who: "A" });
    assert.deepEqual(await domainRow(r.store, "products", "c"), { id: "c", who: "C" });
    // 'b' was written by B then edited by A; the later commit wins everywhere.
    assert.deepEqual(await domainRow(r.store, "products", "b"), { id: "b", who: "A-edit" });
  }
  // Every replica agrees on every version (true convergence).
  for (const id of ["a", "b", "c"]) {
    const versions = await Promise.all(reps.map((r) => versionOf(r.store, "products", id)));
    assert.deepEqual(versions[1], versions[0]);
    assert.deepEqual(versions[2], versions[0]);
  }
  reps.forEach((r) => r.stop());
});

test("server_only writer never stores locally until the feed delivers the committed row", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES, writeMode: WriteMode.SERVER_ONLY });
  await hub.settle();

  const res = await a.client.write("products", "p1", { id: "p1", name: "srv" });
  assert.equal(res.status, "acked");
  // Nothing queued, and the local row only exists once realtime echoes it back.
  assert.equal((await a.store.pending()).length, 0);
  await hub.settle();
  assert.deepEqual(await domainRow(a.store, "products", "p1"), { id: "p1", name: "srv" });
  assert.equal((await versionOf(a.store, "products", "p1")).actor, "pg");
  a.stop();
});
