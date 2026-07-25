// The JS core runs the SAME protocol/conformance.json the Rust core does, so
// the two language ports are proven to agree on reconcile/echo/ack.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reconcile, onAck, isOwnEcho } from "../src/core.mjs";
import { Clock, MAX_DRIFT_MS } from "../src/hlc.mjs";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../protocol/conformance.json", import.meta.url)), "utf8"),
);

test("protocol version is 1", () => {
  assert.equal(fixture.protocol_version, 1);
});

test("reconcile matches every shared fixture case", () => {
  for (const c of fixture.reconcile) {
    assert.deepEqual(reconcile(c.local, c.incoming), c.expected, c.name);
  }
});

test("echo detection matches every shared fixture case", () => {
  for (const c of fixture.echoes) {
    assert.equal(isOwnEcho(c.queued, c.incoming), c.expected, c.name);
  }
});

test("ack settlement matches every shared fixture case", () => {
  for (const c of fixture.acks) {
    assert.deepEqual(onAck(c.local, c.ack), c.expected, c.name);
  }
});

test("clock (tick/observe/drift-clamp) matches every shared fixture case", () => {
  assert.equal(fixture.clock.maxDriftMs, MAX_DRIFT_MS, "drift bound agrees with the fixture");
  for (const c of fixture.clock.cases) {
    const clock = new Clock(c.actor);
    for (const op of c.ops) {
      const got = "tick" in op ? clock.tick(op.tick) : clock.observe(op.observe, op.now);
      assert.deepEqual(got, op.expect, `${c.name}: ${JSON.stringify(op)}`);
    }
  }
});
