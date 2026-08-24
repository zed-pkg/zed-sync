import test from "node:test";
import assert from "node:assert/strict";
import {
  AppPhase,
  LifecycleOperationError,
  MemoryStore,
  startSync,
} from "../src/index.mjs";

test("startSync owns lifecycle and retained clients fail closed after stop", async () => {
  const transitions = [];
  const session = await startSync({
    actor: "desktop-1",
    tables: ["notes"],
    store: new MemoryStore(),
  });
  const unsubscribe = session.lifecycle.subscribe((snapshot) => transitions.push(snapshot.phase));

  assert.equal(session.lifecycle.snapshot.phase, AppPhase.OFFLINE);
  assert.equal(session.lifecycle.capabilities.canWrite, true);
  const queued = await session.client.write("notes", "n1", { id: "n1" });
  assert.equal(queued.status, "queued");

  await session.stop();
  assert.equal(session.lifecycle.snapshot.phase, AppPhase.STOPPED);
  assert.equal(session.lifecycle.capabilities.canWrite, false);
  await assert.rejects(
    () => session.client.write("notes", "n2", { id: "n2" }),
    LifecycleOperationError,
  );
  await assert.rejects(
    () =>
      session.client.applyChange({
        table: "notes",
        op: "upsert",
        id: "remote",
        version: { wall_ms: 1, counter: 0, actor: "server" },
        row: { id: "remote" },
        at_ms: 1,
      }),
    LifecycleOperationError,
  );
  assert.deepEqual(transitions, [AppPhase.STOPPING, AppPhase.STOPPED]);
  unsubscribe();
});

test("transport status is folded into the session phase", async () => {
  let statusCallback;
  const channel = {
    on() {
      return this;
    },
    subscribe(callback) {
      statusCallback = callback;
      callback("SUBSCRIBED");
      return this;
    },
  };
  const supabase = {
    channel: () => channel,
    removeChannel() {},
  };

  const session = await startSync({
    actor: "desktop-2",
    tables: ["notes"],
    store: new MemoryStore(),
    supabase: { client: supabase },
  });
  assert.equal(session.lifecycle.snapshot.phase, AppPhase.ONLINE);

  statusCallback("CHANNEL_ERROR");
  assert.equal(session.lifecycle.snapshot.phase, AppPhase.OFFLINE);
  statusCallback("SUBSCRIBED");
  assert.equal(session.lifecycle.snapshot.phase, AppPhase.ONLINE);
  await session.stop();
});
