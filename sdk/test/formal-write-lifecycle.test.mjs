// Refinement replay for formal/write_lifecycle.qnt. Rust and Dart consume this
// same concrete HLC/write-key corpus, so the three production cores refine the
// same queue-settlement transition rather than merely implementing similar
// prose independently.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { settleQueuedAck } from "../src/core.mjs";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../protocol/formal-write-lifecycle.json", import.meta.url)),
    "utf8",
  ),
);

test("JavaScript replays every formal write-lifecycle case", () => {
  assert.equal(fixture.schema_version, 1);
  assert.equal(fixture.model, "optimistic-write-lifecycle-v1");
  assert.ok(fixture.cases.length >= 4);

  const covered = new Set();
  for (const c of fixture.cases) {
    for (const action of c.actions) covered.add(action);
    const got = settleQueuedAck(
      c.current.local,
      c.current.queued,
      c.settling.write_key,
      c.settling.base_version,
      c.settling.ack,
    );
    const finalVersion = got.adopt ?? c.current.local.version;
    const finalDirty = got.adopt ? false : c.current.local.dirty;
    const finalQueuedKey = got.retire_current_slot ? null : c.current.queued.key;

    assert.equal(got.adopt ? "Adopt" : "Preserve", c.expected.settlement, c.name);
    assert.equal(got.retire_current_slot, c.expected.retire_current_slot, c.name);
    assert.equal(finalDirty, c.expected.final_dirty, c.name);
    assert.equal(finalQueuedKey, c.expected.final_queued_key, c.name);
    assert.deepEqual(finalVersion, c.expected.final_version, c.name);
  }

  for (const action of [
    "local_write",
    "send",
    "disconnect",
    "reconnect",
    "acknowledge",
    "duplicate_ack",
  ]) {
    assert.ok(covered.has(action), `formal refinement corpus covers ${action}`);
  }
});
