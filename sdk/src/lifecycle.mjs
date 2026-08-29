// Total, deterministic application/session lifecycle for desktop/browser apps.
//
// The machine is the sole owner of operational intent. Every asynchronous
// completion carries the token allocated by its request; an old token stutters
// as STALE and can never resurrect a stopped/reconciled session.

export const AppPhase = Object.freeze({
  STOPPED: "stopped",
  STARTING: "starting",
  ONLINE: "online",
  OFFLINE: "offline",
  STOPPING: "stopping",
  FAILED: "failed",
});

export const LifecycleOperation = Object.freeze({
  NONE: "none",
  START: "start",
  STOP: "stop",
  RECONCILE: "reconcile",
});

export const LifecycleFailure = Object.freeze({
  START: "start",
  RUNTIME: "runtime",
  STOP: "stop",
});

export const TransitionOutcome = Object.freeze({
  APPLIED: "applied",
  STUTTERED: "stuttered",
  STALE: "stale",
  REJECTED: "rejected",
});

const TokenRelation = Object.freeze({
  CURRENT: "current",
  STALE: "stale",
  INVALID: "invalid",
});

export const LifecycleEvent = Object.freeze({
  startRequested: () => Object.freeze({ type: "start_requested" }),
  startSucceeded: (token) => Object.freeze({ type: "start_succeeded", token }),
  startFailed: (token) => Object.freeze({ type: "start_failed", token }),
  connectivityChanged: (token, online) =>
    Object.freeze({ type: "connectivity_changed", token, online }),
  runtimeFailed: (token) => Object.freeze({ type: "runtime_failed", token }),
  stopRequested: () => Object.freeze({ type: "stop_requested" }),
  stopSucceeded: (token) => Object.freeze({ type: "stop_succeeded", token }),
  stopFailed: (token) => Object.freeze({ type: "stop_failed", token }),
  reconcileRequested: () => Object.freeze({ type: "reconcile_requested" }),
});

/** An app operation was attempted while its derived capability was closed. */
export class LifecycleOperationError extends Error {
  constructor(operation, phase) {
    super(`zed-sync lifecycle: cannot ${operation} while ${phase}`);
    this.name = "LifecycleOperationError";
    this.operation = operation;
    this.phase = phase;
  }
}

const initialSnapshot = (generation = 0) =>
  Object.freeze({
    phase: AppPhase.STOPPED,
    operation: LifecycleOperation.NONE,
    generation,
    activeToken: null,
    desiredRunning: false,
    online: false,
    failure: null,
  });

const CLOSED_CAPABILITIES = Object.freeze({
  canStart: false,
  canStop: false,
  canWrite: false,
  canReceiveChanges: false,
  canFlush: false,
  canReconcile: false,
  busy: false,
  running: false,
});

/** Validate first, then derive capabilities from phase; malformed input closes all authority. */
export function appCapabilities(snapshot) {
  try {
    assertAppLifecycleInvariant(snapshot);
  } catch {
    return CLOSED_CAPABILITIES;
  }
  const active = [AppPhase.STARTING, AppPhase.ONLINE, AppPhase.OFFLINE].includes(snapshot.phase);
  return Object.freeze({
    canStart: snapshot.phase === AppPhase.STOPPED,
    canStop: active,
    canWrite: [AppPhase.ONLINE, AppPhase.OFFLINE].includes(snapshot.phase),
    canReceiveChanges: active,
    canFlush: snapshot.phase === AppPhase.ONLINE,
    canReconcile: snapshot.phase === AppPhase.FAILED,
    busy: [AppPhase.STARTING, AppPhase.STOPPING].includes(snapshot.phase),
    running: [AppPhase.ONLINE, AppPhase.OFFLINE].includes(snapshot.phase),
  });
}

/** Throw if a persisted/foreign snapshot violates the formally checked shape. */
export function assertAppLifecycleInvariant(snapshot) {
  const tokenValid =
    snapshot.activeToken === null ||
    (Number.isSafeInteger(snapshot.activeToken) &&
      snapshot.activeToken > 0 &&
      snapshot.activeToken <= snapshot.generation);
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0 || !tokenValid) {
    throw new TypeError("zed-sync lifecycle: invalid generation or active token");
  }

  const coherent = {
    [AppPhase.STOPPED]:
      snapshot.operation === LifecycleOperation.NONE &&
      snapshot.activeToken === null &&
      !snapshot.desiredRunning &&
      !snapshot.online &&
      snapshot.failure === null,
    [AppPhase.STARTING]:
      snapshot.operation === LifecycleOperation.START &&
      snapshot.activeToken === snapshot.generation &&
      snapshot.desiredRunning &&
      snapshot.failure === null,
    [AppPhase.ONLINE]:
      snapshot.operation === LifecycleOperation.NONE &&
      snapshot.activeToken === snapshot.generation &&
      snapshot.desiredRunning &&
      snapshot.online &&
      snapshot.failure === null,
    [AppPhase.OFFLINE]:
      snapshot.operation === LifecycleOperation.NONE &&
      snapshot.activeToken === snapshot.generation &&
      snapshot.desiredRunning &&
      !snapshot.online &&
      snapshot.failure === null,
    [AppPhase.STOPPING]:
      [LifecycleOperation.STOP, LifecycleOperation.RECONCILE].includes(snapshot.operation) &&
      snapshot.activeToken === snapshot.generation &&
      !snapshot.desiredRunning &&
      !snapshot.online &&
      snapshot.failure === null,
    [AppPhase.FAILED]:
      snapshot.operation === LifecycleOperation.NONE &&
      snapshot.activeToken === null &&
      !snapshot.desiredRunning &&
      !snapshot.online &&
      Object.values(LifecycleFailure).includes(snapshot.failure),
  }[snapshot.phase];

  if (!coherent) {
    throw new TypeError(
      "zed-sync lifecycle: phase, operation, token, intent, connectivity, and failure disagree",
    );
  }
  return snapshot;
}

export class AppLifecycleMachine {
  #snapshot = initialSnapshot();
  #listeners = new Set();

  get snapshot() {
    return this.#snapshot;
  }

  get capabilities() {
    return appCapabilities(this.#snapshot);
  }

  /** Subscribe to applied state changes; returns an idempotent unsubscribe. */
  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("lifecycle listener must be a function");
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  }

  /** @returns {"applied"|"stuttered"|"stale"|"rejected"} */
  dispatch(event) {
    const before = this.#snapshot;
    let next = before;
    let outcome = TransitionOutcome.REJECTED;

    switch (event?.type) {
      case "start_requested": {
        if (before.phase !== AppPhase.STOPPED) break;
        if (before.generation >= Number.MAX_SAFE_INTEGER) break;
        const token = before.generation + 1;
        next = {
          phase: AppPhase.STARTING,
          operation: LifecycleOperation.START,
          generation: token,
          activeToken: token,
          desiredRunning: true,
          online: false,
          failure: null,
        };
        outcome = TransitionOutcome.APPLIED;
        break;
      }
      case "start_succeeded": {
        const relation = this.#tokenRelation(event.token);
        if (relation === TokenRelation.STALE) return TransitionOutcome.STALE;
        if (relation === TokenRelation.INVALID) break;
        if (before.phase !== AppPhase.STARTING) break;
        next = {
          ...before,
          phase: before.online ? AppPhase.ONLINE : AppPhase.OFFLINE,
          operation: LifecycleOperation.NONE,
        };
        outcome = TransitionOutcome.APPLIED;
        break;
      }
      case "start_failed": {
        const relation = this.#tokenRelation(event.token);
        if (relation === TokenRelation.STALE) return TransitionOutcome.STALE;
        if (relation === TokenRelation.INVALID) break;
        if (before.phase !== AppPhase.STARTING) break;
        next = this.#failed(LifecycleFailure.START);
        outcome = TransitionOutcome.APPLIED;
        break;
      }
      case "connectivity_changed": {
        const relation = this.#tokenRelation(event.token);
        if (relation === TokenRelation.STALE) return TransitionOutcome.STALE;
        if (relation === TokenRelation.INVALID) break;
        if (![AppPhase.STARTING, AppPhase.ONLINE, AppPhase.OFFLINE].includes(before.phase)) break;
        if (typeof event.online !== "boolean") break;
        const phase =
          before.phase === AppPhase.STARTING
            ? AppPhase.STARTING
            : event.online
              ? AppPhase.ONLINE
              : AppPhase.OFFLINE;
        if (before.online === event.online && before.phase === phase) {
          outcome = TransitionOutcome.STUTTERED;
          break;
        }
        next = { ...before, phase, online: event.online };
        outcome = TransitionOutcome.APPLIED;
        break;
      }
      case "runtime_failed": {
        const relation = this.#tokenRelation(event.token);
        if (relation === TokenRelation.STALE) return TransitionOutcome.STALE;
        if (relation === TokenRelation.INVALID) break;
        if (![AppPhase.STARTING, AppPhase.ONLINE, AppPhase.OFFLINE].includes(before.phase)) break;
        next = this.#failed(LifecycleFailure.RUNTIME);
        outcome = TransitionOutcome.APPLIED;
        break;
      }
      case "stop_requested": {
        if ([AppPhase.STOPPED, AppPhase.STOPPING].includes(before.phase)) {
          outcome = TransitionOutcome.STUTTERED;
          break;
        }
        if (![AppPhase.STARTING, AppPhase.ONLINE, AppPhase.OFFLINE].includes(before.phase)) break;
        ({ next, outcome } = this.#beginStop(LifecycleOperation.STOP));
        break;
      }
      case "stop_succeeded": {
        const relation = this.#tokenRelation(event.token);
        if (relation === TokenRelation.STALE) return TransitionOutcome.STALE;
        if (relation === TokenRelation.INVALID) break;
        if (before.phase !== AppPhase.STOPPING) break;
        next = initialSnapshot(before.generation);
        outcome = TransitionOutcome.APPLIED;
        break;
      }
      case "stop_failed": {
        const relation = this.#tokenRelation(event.token);
        if (relation === TokenRelation.STALE) return TransitionOutcome.STALE;
        if (relation === TokenRelation.INVALID) break;
        if (before.phase !== AppPhase.STOPPING) break;
        next = this.#failed(LifecycleFailure.STOP);
        outcome = TransitionOutcome.APPLIED;
        break;
      }
      case "reconcile_requested": {
        if (before.phase !== AppPhase.FAILED) break;
        ({ next, outcome } = this.#beginStop(LifecycleOperation.RECONCILE));
        break;
      }
      default:
        break;
    }

    if (outcome === TransitionOutcome.APPLIED) this.#commit(next, event);
    return outcome;
  }

  #tokenRelation(token) {
    if (!Number.isSafeInteger(token) || token <= 0) return TokenRelation.INVALID;
    if (this.#snapshot.activeToken === token) return TokenRelation.CURRENT;
    if (token <= this.#snapshot.generation) return TokenRelation.STALE;
    return TokenRelation.INVALID;
  }

  #beginStop(operation) {
    if (this.#snapshot.generation >= Number.MAX_SAFE_INTEGER) {
      return { next: this.#snapshot, outcome: TransitionOutcome.REJECTED };
    }
    const token = this.#snapshot.generation + 1;
    return {
      next: {
        phase: AppPhase.STOPPING,
        operation,
        generation: token,
        activeToken: token,
        desiredRunning: false,
        online: false,
        failure: null,
      },
      outcome: TransitionOutcome.APPLIED,
    };
  }

  #failed(failure) {
    return {
      phase: AppPhase.FAILED,
      operation: LifecycleOperation.NONE,
      generation: this.#snapshot.generation,
      activeToken: null,
      desiredRunning: false,
      online: false,
      failure,
    };
  }

  #commit(next, event) {
    const frozen = Object.freeze(next);
    assertAppLifecycleInvariant(frozen);
    this.#snapshot = frozen;
    for (const listener of [...this.#listeners]) {
      try {
        listener(frozen, event);
      } catch {
        // Observation must never control the lifecycle transition.
      }
    }
  }
}
