// E2E soak: randomized, seeded delivery chaos. Many writers commit through the
// real client/transports; every committed change is then re-delivered to every
// replica in a RANDOM order, over a randomly chosen transport, with random
// duplicates. Because reconcile is order-independent and idempotent, all
// replicas must converge — byte-for-byte on rows AND HLC versions — to the
// server's canonical state. A fixed seed makes any failure reproducible.

import test from "node:test";
import assert from "node:assert/strict";
import { SimServer, Hub, connectReplica, domainRow, versionOf } from "./e2e_harness.mjs";
import { decodeBackendFrame, decodeSupabaseChange } from "../src/transports/decode.mjs";

/** Deterministic PRNG (mulberry32) — same seed => same run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const shuffle = (r, arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const wire = (v) => JSON.parse(JSON.stringify(v));

/** Deliver one outbox entry to a replica through a randomly chosen transport,
 * decoded by the REAL decoder for that path. Returns the applyChange promise. */
function deliver(r, hub, entry, transport) {
  if (transport === "backend") {
    const [change] = decodeBackendFrame(wire({ event: "zed:sync", changes: [hub.server.toChangeEvent(entry)] }));
    return r.client.applyChange(change);
  }
  const change = decodeSupabaseChange(wire(hub.server.toSupabasePayload(entry)));
  return change ? r.client.applyChange(change) : Promise.resolve();
}

test("upsert/merge chaos converges with NO ordered heal (pure order-independence)", async () => {
  const r = rng(0xc0ffee);
  const hub = new Hub(new SimServer());
  hub.backendLive = false; // we drive every delivery ourselves, chaotically
  hub.supabaseLive = false;
  const TABLES = ["items"];
  const reps = ["A", "B", "C", "D"].map((n) =>
    connectReplica(hub, { actor: `dev-${n}`, tables: TABLES, backend: false, supabase: false }),
  );
  const keys = ["k1", "k2", "k3"];
  await hub.settle();

  // Phase 1: 60 random upsert/merge writes (no deletes here).
  for (let i = 0; i < 60; i++) {
    const w = pick(r, reps);
    const key = pick(r, keys);
    const merge = r() < 0.5;
    const row = merge ? { [`f${i % 3}`]: i } : { id: key, seq: i, tag: `w${i}` };
    await w.client.write("items", key, { id: key, ...row }, { merge });
  }
  await hub.settle();

  // Phase 2: replay every committed change to every replica in a per-replica
  // random order + transport, with ~30% duplicates. No ordered catch-up.
  const outbox = [...hub.server.outbox];
  for (const rep of reps) {
    const plan = shuffle(r, outbox);
    for (const entry of plan) {
      await deliver(rep, hub, entry, pick(r, ["backend", "supabase"]));
      if (r() < 0.3) await deliver(rep, hub, entry, pick(r, ["backend", "supabase"])); // dup
    }
  }
  await hub.settle();

  // Every replica converged to the server's canonical row + version per key.
  for (const key of keys) {
    const canonicalRow = hub.server.currentRow("items", key);
    const domain = canonicalRow
      ? Object.fromEntries(Object.entries(canonicalRow).filter(([k]) => !["created_at", "updated_at", "sync_version"].includes(k)))
      : undefined;
    for (const rep of reps) {
      assert.deepEqual(await domainRow(rep.store, "items", key), domain, `${rep.client.actor} row @${key}`);
      assert.deepEqual(await versionOf(rep.store, "items", key), canonicalRow?.sync_version, `${rep.client.actor} version @${key}`);
    }
  }
  reps.forEach((x) => x.stop());
});

test("mixed ops incl. deletes converge after chaotic delivery + one ordered catch-up", async () => {
  const r = rng(0x1234abcd);
  const hub = new Hub(new SimServer());
  hub.backendLive = false;
  hub.supabaseLive = false;
  const TABLES = ["items"];
  const reps = ["A", "B", "C"].map((n) =>
    connectReplica(hub, { actor: `dev-${n}`, tables: TABLES, backend: false, supabase: false }),
  );
  const keys = ["k1", "k2", "k3", "k4"];
  await hub.settle();

  // Random ops including deletes; keys are always upserted at least once first.
  for (const key of keys) await pick(r, reps).client.write("items", key, { id: key, born: true });
  for (let i = 0; i < 50; i++) {
    const w = pick(r, reps);
    const key = pick(r, keys);
    if (r() < 0.25) await w.client.delete("items", key);
    else await w.client.write("items", key, { id: key, seq: i });
  }
  await hub.settle();

  // Chaotic realtime, THEN an in-order catch-up (what every reconnect does).
  const outbox = [...hub.server.outbox];
  for (const rep of reps) {
    for (const entry of shuffle(r, outbox)) {
      await deliver(rep, hub, entry, pick(r, ["backend", "supabase"]));
    }
  }
  await hub.settle();
  for (const rep of reps) {
    for (const entry of outbox) await deliver(rep, hub, entry, "backend"); // ordered heal
  }
  await hub.settle();

  for (const key of keys) {
    const canonicalRow = hub.server.currentRow("items", key);
    const expected = canonicalRow
      ? Object.fromEntries(Object.entries(canonicalRow).filter(([k]) => !["created_at", "updated_at", "sync_version"].includes(k)))
      : null; // deleted => tombstone (null), never resurrected
    for (const rep of reps) {
      const got = await domainRow(rep.store, "items", key);
      assert.deepEqual(got ?? null, expected, `${rep.client.actor} converged @${key}`);
      if (canonicalRow) {
        assert.deepEqual(await versionOf(rep.store, "items", key), canonicalRow.sync_version, `${rep.client.actor} version @${key}`);
      }
    }
  }
  reps.forEach((x) => x.stop());
});
