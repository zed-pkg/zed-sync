// E2E: conflict reconciliation across replicas. A dirty local edit meets a
// newer server-authored change; the configured ConflictResolution decides, the
// queue is reconciled, and every replica still converges. Also covers the
// JSONB-aware merge write path (reconciling nested blob columns locally).

import test from "node:test";
import assert from "node:assert/strict";
import { SimServer, Hub, connectReplica, domainRow, versionOf } from "./e2e_harness.mjs";
import { WriteMode, ConflictResolution } from "../src/policy.mjs";
import { compareHlc } from "../src/hlc.mjs";

const TABLES = ["docs"];

test("server_wins: a newer server change overrides a dirty local edit and drops its queued write", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES });
  const b = connectReplica(hub, {
    actor: "dev-B",
    tables: TABLES,
    conflictResolution: ConflictResolution.SERVER_WINS,
  });
  await hub.settle();

  // Both replicas start clean at the same committed version.
  await a.client.write("docs", "d1", { id: "d1", title: "original", body: "x" });
  await hub.settle();
  const base = await versionOf(b.store, "docs", "d1");

  // B edits locally but stays offline for that write (local_only => dirty, queued).
  await b.client.write("docs", "d1", { id: "d1", title: "B's draft", body: "x" }, { mode: WriteMode.LOCAL_ONLY });
  assert.equal((await b.store.pending()).length, 1, "B has a queued dirty edit");

  // A commits a newer change to the same row; it reaches B over the live feed.
  await a.client.write("docs", "d1", { id: "d1", title: "A wins", body: "y" });
  await hub.settle();

  const incoming = await versionOf(b.store, "docs", "d1");
  assert.equal(compareHlc(incoming, base) > 0, true, "server change is strictly newer than B's baseline");
  assert.deepEqual(await domainRow(b.store, "docs", "d1"), { id: "d1", title: "A wins", body: "y" }, "server_wins adopted");
  assert.equal((await b.store.pending()).length, 0, "B's conflicting queued write was dropped");

  // And the two replicas converged on the same version.
  assert.deepEqual(await versionOf(a.store, "docs", "d1"), await versionOf(b.store, "docs", "d1"));
  a.stop();
  b.stop();
});

test("a newer local dirty edit is preserved against a STALE server echo (stale-ignore, not clobber)", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES });
  await hub.settle();

  await a.client.write("docs", "d1", { id: "d1", v: 1 });
  await hub.settle();
  const staleEntry = hub.server.outbox[hub.server.outbox.length - 1];

  // A edits locally (newer HLC), offline, leaving it dirty + queued.
  await a.client.write("docs", "d1", { id: "d1", v: 2 }, { mode: WriteMode.LOCAL_ONLY });
  const dirtyVersion = await versionOf(a.store, "docs", "d1");

  // A re-delivery of the OLD committed change must not overwrite the newer edit.
  await a.client.applyChange(hub.server.toChangeEvent(staleEntry));

  assert.deepEqual(await domainRow(a.store, "docs", "d1"), { id: "d1", v: 2 }, "newer local edit survives a stale echo");
  assert.deepEqual(await versionOf(a.store, "docs", "d1"), dirtyVersion);
  assert.equal((await a.store.pending()).length, 1, "the edit is still queued to send");
  a.stop();
});

test("last_write_wins converges identically to server_wins for server-authored changes", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES });
  const b = connectReplica(hub, {
    actor: "dev-B",
    tables: TABLES,
    conflictResolution: ConflictResolution.LAST_WRITE_WINS,
  });
  await hub.settle();

  await a.client.write("docs", "d1", { id: "d1", n: 0 });
  await hub.settle();
  await b.client.write("docs", "d1", { id: "d1", n: 1 }, { mode: WriteMode.LOCAL_ONLY }); // dirty
  await a.client.write("docs", "d1", { id: "d1", n: 2 }); // newer server change
  await hub.settle();

  // The strictly-newer server change wins; queue dropped; replicas converge.
  assert.deepEqual(await domainRow(b.store, "docs", "d1"), { id: "d1", n: 2 });
  assert.equal((await b.store.pending()).length, 0);
  assert.deepEqual(await versionOf(a.store, "docs", "d1"), await versionOf(b.store, "docs", "d1"));
  a.stop();
  b.stop();
});

test("JSONB merge write folds a partial update into the stored blob and converges", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES });
  const b = connectReplica(hub, { actor: "dev-B", tables: TABLES });
  await hub.settle();

  await a.client.write("docs", "d1", { id: "d1", settings: { theme: "dark", density: "cozy" }, tags: ["a"] });
  await hub.settle();

  // Partial update: only settings.density changes; theme + tags must survive.
  await a.client.write("docs", "d1", { settings: { density: "compact" } }, { merge: true });
  await hub.settle();

  const expected = { id: "d1", settings: { theme: "dark", density: "compact" }, tags: ["a"] };
  assert.deepEqual(await domainRow(a.store, "docs", "d1"), expected, "A folded the partial update");
  assert.deepEqual(await domainRow(b.store, "docs", "d1"), expected, "B converged on the merged blob");
  a.stop();
  b.stop();
});

test("delete/upsert race: the delete tombstone (one tick newer) wins on every replica", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES });
  const b = connectReplica(hub, { actor: "dev-B", tables: TABLES });
  await hub.settle();

  await a.client.write("docs", "d1", { id: "d1", live: true });
  await hub.settle();
  await a.client.delete("docs", "d1");
  await hub.settle();

  // Replay the pre-delete upsert late on B — the tombstone must still win.
  const upsertEntry = hub.server.outbox.find((e) => e.op === "upsert");
  await b.client.applyChange(hub.server.toChangeEvent(upsertEntry));
  await hub.settle();

  assert.equal(await domainRow(a.store, "docs", "d1"), null, "A: deleted");
  assert.equal(await domainRow(b.store, "docs", "d1"), null, "B: tombstone survives a late upsert replay");
  a.stop();
  b.stop();
});
