import test from "node:test";
import assert from "node:assert/strict";
import { firstValueFrom, take, toArray } from "rxjs";

import {
  AppLifecycleMachine,
  AppPhase,
  LifecycleEvent,
  TransitionOutcome,
} from "../src/index.mjs";
import { observeCapabilities, observeLifecycle } from "../src/rxjs.mjs";

test("lifecycle observation replays current state and follows applied transitions", async () => {
  const machine = new AppLifecycleMachine();
  const snapshotsPromise = firstValueFrom(observeLifecycle(machine).pipe(take(3), toArray()));

  assert.equal(
    machine.dispatch(LifecycleEvent.startRequested()),
    TransitionOutcome.APPLIED,
  );
  const token = machine.snapshot.activeToken;
  assert.equal(
    machine.dispatch(LifecycleEvent.startSucceeded(token)),
    TransitionOutcome.APPLIED,
  );

  const snapshots = await snapshotsPromise;
  assert.deepEqual(
    snapshots.map(({ phase }) => phase),
    [AppPhase.STOPPED, AppPhase.STARTING, AppPhase.OFFLINE],
  );
});

test("shareReplay owns one listener and releases it after the final unsubscribe", () => {
  let subscriptions = 0;
  let unsubscriptions = 0;
  const lifecycle = {
    snapshot: {
      phase: "stopped",
      operation: "none",
      generation: 0,
      activeToken: null,
      desiredRunning: false,
      online: false,
      failure: null,
    },
    subscribe() {
      subscriptions += 1;
      return () => {
        unsubscriptions += 1;
      };
    },
  };
  const lifecycle$ = observeLifecycle(lifecycle);

  const first = lifecycle$.subscribe();
  const second = lifecycle$.subscribe();
  assert.equal(subscriptions, 1);
  first.unsubscribe();
  assert.equal(unsubscriptions, 0);
  second.unsubscribe();
  assert.equal(unsubscriptions, 1);
});

test("capabilities are pure projections and suppress equivalent emissions", async () => {
  const machine = new AppLifecycleMachine();
  const observed = [];
  const subscription = observeCapabilities(machine).subscribe((capabilities) => {
    observed.push(capabilities);
  });

  machine.dispatch(LifecycleEvent.startRequested());
  const token = machine.snapshot.activeToken;
  machine.dispatch(LifecycleEvent.connectivityChanged(token, true));
  machine.dispatch(LifecycleEvent.startSucceeded(token));

  assert.equal(observed.length, 3);
  assert.equal(observed[0].canStart, true);
  assert.equal(observed[1].busy, true);
  assert.equal(observed[2].canFlush, true);
  subscription.unsubscribe();
});

test("malformed foreign snapshots fail closed through the error channel", async () => {
  const invalid = {
    snapshot: {
      phase: "online",
      operation: "none",
      generation: 0,
      activeToken: null,
      desiredRunning: false,
      online: true,
      failure: null,
    },
    subscribe() {
      return () => {};
    },
  };

  await assert.rejects(firstValueFrom(observeLifecycle(invalid)), TypeError);
});
