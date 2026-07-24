import test from "node:test";
import assert from "node:assert/strict";
import { remoteWins, backoffMs, SyncEngine } from "../dist/index.js";

const at = (iso, client) => ({
  id: `${client}-${iso}`,
  table: "t",
  pk: "1",
  op: "upsert",
  payload: {},
  client_id: client,
  seq: 0,
  updated_at: iso,
});

test("last-write-wins by timestamp", () => {
  const local = at("2026-07-24T00:00:00Z", "a");
  const newer = at("2026-07-24T00:00:01Z", "b");
  assert.equal(remoteWins(local, newer), true);
  assert.equal(remoteWins(newer, local), false);
});

test("last-write-wins ties break deterministically by client_id", () => {
  const local = at("2026-07-24T00:00:00Z", "a");
  const remote = at("2026-07-24T00:00:00Z", "b");
  // Same instant: higher client_id wins, and both replicas agree.
  assert.equal(remoteWins(local, remote), true);
  assert.equal(remoteWins(remote, local), false);
});

test("backoff grows exponentially and caps", () => {
  assert.equal(backoffMs(0), 500);
  assert.equal(backoffMs(1), 1000);
  assert.equal(backoffMs(2), 2000);
  assert.equal(backoffMs(100), 60_000);
});

// Fake LocalDb + transport to exercise the engine's control flow without a DOM.
class FakeDb {
  constructor() {
    this.outbox = [];
    this.remoteApplied = [];
    this.cursor = "";
  }
  async pending() {
    return this.outbox;
  }
  async ack(ids) {
    this.outbox = this.outbox.filter((c) => !ids.includes(c.id));
  }
  async applyRemote(change) {
    this.remoteApplied.push(change);
  }
  async getCursor() {
    return this.cursor;
  }
  async setCursor(c) {
    this.cursor = c;
  }
}

test("flush drains the outbox and acks", async () => {
  const db = new FakeDb();
  db.outbox = [at("2026-07-24T00:00:00Z", "a")];
  const transport = {
    push: async (changes) => ({ acked: changes.map((c) => c.id) }),
    pull: async (cursor) => ({ changes: [], cursor }),
  };
  const engine = new SyncEngine(db, transport, "a");
  const pushed = await engine.flush();
  assert.equal(pushed, 1);
  assert.equal(db.outbox.length, 0);
});

test("pull applies remote changes and advances the cursor", async () => {
  const db = new FakeDb();
  const remote = at("2026-07-24T00:00:05Z", "other");
  const transport = {
    push: async () => ({ acked: [] }),
    pull: async () => ({ changes: [remote], cursor: remote.updated_at }),
  };
  const engine = new SyncEngine(db, transport, "me");
  const count = await engine.pull();
  assert.equal(count, 1);
  assert.equal(db.remoteApplied.length, 1);
  assert.equal(db.cursor, remote.updated_at);
});

test("unflushed newer local write is not clobbered by an older remote", async () => {
  const db = new FakeDb();
  db.outbox = [at("2026-07-24T00:00:10Z", "me")];
  const staleRemote = at("2026-07-24T00:00:01Z", "other");
  const transport = {
    push: async () => ({ acked: [] }),
    pull: async () => ({ changes: [staleRemote], cursor: staleRemote.updated_at }),
  };
  let conflict = false;
  const engine = new SyncEngine(db, transport, "me", { conflict: () => (conflict = true) });
  await engine.pull();
  assert.equal(db.remoteApplied.length, 0, "stale remote must not overwrite newer local");
  assert.equal(conflict, true);
});
