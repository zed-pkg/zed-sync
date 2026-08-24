// Exact refinement replay for formal/app_lifecycle.qnt. Rust and Dart consume
// this same trace corpus so platform lifecycle reducers cannot drift.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AppLifecycleMachine,
  AppPhase,
  LifecycleEvent,
  assertAppLifecycleInvariant,
} from "../src/lifecycle.mjs";
import { validate } from "./schema_validate.mjs";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../protocol/formal-app-lifecycle.json", import.meta.url)),
    "utf8",
  ),
);
const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../protocol/formal-app-lifecycle.schema.json", import.meta.url)),
    "utf8",
  ),
);

const wireSnapshot = (snapshot) => ({
  phase: snapshot.phase,
  operation: snapshot.operation,
  generation: snapshot.generation,
  active_token: snapshot.activeToken,
  desired_running: snapshot.desiredRunning,
  online: snapshot.online,
  failure: snapshot.failure,
});

test("formal app-lifecycle fixture is schema-valid", () => {
  assert.deepEqual(validate(schema, fixture), []);
});

test("JavaScript replays every formal app-lifecycle trace", () => {
  assert.equal(fixture.schema_version, 1);
  assert.equal(fixture.model, "app-lifecycle-v1");
  assert.ok(fixture.cases.length >= 6);
  const covered = new Set();
  const outcomes = new Set();

  for (const c of fixture.cases) {
    const machine = new AppLifecycleMachine();
    for (const step of c.steps) {
      covered.add(step.event.type);
      const outcome = machine.dispatch(Object.freeze(step.event));
      outcomes.add(outcome);
      assert.equal(outcome, step.outcome, c.name);
      assert.deepEqual(wireSnapshot(machine.snapshot), step.state, c.name);
      assert.doesNotThrow(() => assertAppLifecycleInvariant(machine.snapshot), c.name);
    }
  }

  for (const event of [
    "start_requested",
    "start_succeeded",
    "start_failed",
    "connectivity_changed",
    "runtime_failed",
    "stop_requested",
    "stop_succeeded",
    "stop_failed",
    "reconcile_requested",
  ]) {
    assert.ok(covered.has(event), `fixture covers ${event}`);
  }
  for (const outcome of ["applied", "stuttered", "stale", "rejected"]) {
    assert.ok(outcomes.has(outcome), `fixture covers ${outcome}`);
  }
});

test("stale completion is a stutter and failed capabilities are closed", () => {
  const machine = new AppLifecycleMachine();
  machine.dispatch(LifecycleEvent.startRequested());
  const startToken = machine.snapshot.activeToken;
  machine.dispatch(LifecycleEvent.stopRequested());
  const stopping = machine.snapshot;
  assert.equal(machine.dispatch(LifecycleEvent.startSucceeded(startToken)), "stale");
  assert.equal(machine.snapshot, stopping, "stale completion preserves object identity and state");

  const stopToken = machine.snapshot.activeToken;
  machine.dispatch(LifecycleEvent.stopFailed(stopToken));
  assert.equal(machine.snapshot.phase, AppPhase.FAILED);
  assert.deepEqual(machine.capabilities, {
    canStart: false,
    canStop: false,
    canWrite: false,
    canReceiveChanges: false,
    canFlush: false,
    canReconcile: true,
    busy: false,
    running: false,
  });
});
