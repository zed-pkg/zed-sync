// E2E: the server-side timestamp/version contract the whole protocol rests on
// (postgres/zed_sync.sql, docs/timestamps.md). created_at is immutable,
// updated_at is strictly monotonic per row even under same-millisecond bursts,
// sync_version (HLC) strictly increases, a delete tombstone is exactly one tick
// newer, and the outbox sequence is a plane-wide monotonic catch-up cursor. The
// client's synced_at_ms is asserted from the SDK side.

import test from "node:test";
import assert from "node:assert/strict";
import { SimServer, Hub, connectReplica } from "./e2e_harness.mjs";
import { compareHlc } from "../src/hlc.mjs";
import { WriteMode } from "../src/policy.mjs";

const TABLES = ["events"];

test("created_at is immutable and updated_at is strictly monotonic across a same-ms burst", () => {
  const server = new SimServer();
  const versions = [];
  const updatedAts = [];
  let createdAt;
  for (let i = 0; i < 50; i++) {
    const { committed_version } = server.commit({ table: "events", op: "upsert", id: "e1", row: { id: "e1", n: i } });
    const row = server.currentRow("events", "e1");
    if (i === 0) createdAt = row.created_at;
    assert.equal(row.created_at, createdAt, `created_at immutable at write ${i}`);
    versions.push(committed_version);
    updatedAts.push(Date.parse(row.updated_at));
  }
  // updated_at never regresses or repeats, even when many writes share a wall ms.
  for (let i = 1; i < updatedAts.length; i++) {
    assert.equal(updatedAts[i] > updatedAts[i - 1], true, `updated_at strictly increases at ${i}`);
  }
  // sync_version (HLC) is strictly increasing under the total order.
  for (let i = 1; i < versions.length; i++) {
    assert.equal(compareHlc(versions[i], versions[i - 1]) > 0, true, `HLC strictly increases at ${i}`);
  }
});

test("a delete tombstone's HLC is exactly one logical tick past the last upsert", () => {
  const server = new SimServer();
  const up = server.commit({ table: "events", op: "upsert", id: "e1", row: { id: "e1" } });
  const del = server.commit({ table: "events", op: "delete", id: "e1" });
  assert.equal(compareHlc(del.committed_version, up.committed_version) > 0, true, "tombstone is newer");
  assert.equal(del.committed_version.wall_ms, up.committed_version.wall_ms);
  assert.equal(del.committed_version.counter, up.committed_version.counter + 1, "exactly one tick");
});

test("outbox sequence is a plane-wide monotonic cursor across tables and ops", () => {
  const server = new SimServer();
  server.commit({ table: "events", op: "upsert", id: "e1", row: { id: "e1" } });
  server.commit({ table: "audit", op: "upsert", id: "a1", row: { id: "a1" } });
  server.commit({ table: "events", op: "delete", id: "e1" });
  const seqs = server.outbox.map((e) => e.sequence);
  assert.deepEqual(seqs, [1, 2, 3], "sequence is gap-free and commit-ordered");
  // changesSince behaves like the catch-up cursor.
  assert.equal(server.changesSince(1).length, 2, "everything after sequence 1");
  assert.equal(server.changesSince(3).length, 0, "nothing after the tip");
});

test("the client stamps synced_at_ms only when a row is reconciled clean, and preserves it across a dirty edit", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES });
  await hub.settle();

  await a.client.write("events", "e1", { id: "e1", n: 1 });
  await hub.settle();
  const synced = await a.store.getRow("events", "e1");
  assert.equal(synced.meta.dirty, false);
  assert.equal(typeof synced.meta.synced_at_ms, "number", "synced rows carry a synced_at stamp");
  const firstSyncedAt = synced.meta.synced_at_ms;

  // A local (unsynced) edit stays dirty but PRESERVES the prior synced stamp —
  // editing synced state does not pretend the row was just synced.
  await a.client.write("events", "e1", { id: "e1", n: 2 }, { mode: WriteMode.LOCAL_ONLY });
  const dirty = await a.store.getRow("events", "e1");
  assert.equal(dirty.meta.dirty, true);
  assert.equal(dirty.meta.synced_at_ms, firstSyncedAt, "synced_at preserved on a dirty edit");
  a.stop();
});

test("a client HLC never adopts an over-drift (far-future) server wall clock", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: TABLES });
  await hub.settle();

  const farFuture = Date.now() + 3_600_000; // 1h ahead, well past MAX_DRIFT_MS
  await a.client.applyChange({
    table: "events",
    op: "upsert",
    id: "e1",
    version: { wall_ms: farFuture, counter: 0, actor: "attacker" },
    row: { id: "e1" },
    at_ms: farFuture,
  });
  // The change still applies (it is a valid newer version for that row)...
  assert.notEqual(await a.store.getRow("events", "e1"), null);
  // ...but the local clock refused to fold in the poisoned wall: a fresh tick
  // stays near real time, not an hour in the future.
  const stamp = a.client.clock.tick();
  assert.equal(stamp.wall_ms < farFuture, true, "clock clamped the over-drift remote wall");
  a.stop();
});
