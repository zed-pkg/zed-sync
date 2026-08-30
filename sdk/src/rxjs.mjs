// Optional RxJS boundary for application/session lifecycle observation.
//
// The formal AppLifecycleMachine remains the sole state authority. These
// adapters only lift its immutable snapshots into shared, replaying streams;
// no Subject, operator, or observer can dispatch a transition.

import { Observable, distinctUntilChanged, map, shareReplay } from "rxjs";

import { appCapabilities, assertAppLifecycleInvariant } from "./lifecycle.mjs";

const SNAPSHOT_KEYS = Object.freeze([
  "phase",
  "operation",
  "generation",
  "activeToken",
  "desiredRunning",
  "online",
  "failure",
]);

const CAPABILITY_KEYS = Object.freeze([
  "canStart",
  "canStop",
  "canWrite",
  "canReceiveChanges",
  "canFlush",
  "canReconcile",
  "busy",
  "running",
]);

const equalFields = (keys) => (left, right) => keys.every((key) => left[key] === right[key]);
const equalSnapshots = equalFields(SNAPSHOT_KEYS);
const equalCapabilities = equalFields(CAPABILITY_KEYS);

const assertLifecycleView = (lifecycle) => {
  if (!lifecycle || typeof lifecycle.subscribe !== "function" || !("snapshot" in lifecycle)) {
    throw new TypeError("zed-sync rxjs: lifecycle must expose snapshot and subscribe(listener)");
  }
  return lifecycle;
};

/**
 * Observe validated lifecycle snapshots.
 *
 * The stream emits the current snapshot immediately, shares one underlying
 * machine subscription across observers, replays the latest snapshot to late
 * observers, and releases the machine listener when the final observer leaves.
 * A malformed foreign lifecycle view fails closed through the Observable error
 * channel before it can expose operational state.
 */
export function observeLifecycle(lifecycle) {
  return new Observable((subscriber) => {
    const view = assertLifecycleView(lifecycle);
    const publish = (snapshot) => {
      try {
        subscriber.next(assertAppLifecycleInvariant(snapshot));
      } catch (error) {
        subscriber.error(error);
      }
    };

    publish(view.snapshot);
    if (subscriber.closed) return undefined;
    return view.subscribe((snapshot) => {
      if (!subscriber.closed) publish(snapshot);
    });
  }).pipe(
    distinctUntilChanged(equalSnapshots),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
}

/** Derive a replaying capability stream from validated lifecycle snapshots. */
export function observeCapabilities(lifecycle) {
  return observeLifecycle(lifecycle).pipe(
    map(appCapabilities),
    distinctUntilChanged(equalCapabilities),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
}
