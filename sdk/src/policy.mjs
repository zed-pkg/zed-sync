// Write-mode, error-policy, and conflict-resolution enums for the sync client.
//
// These are ENUMS, not booleans, on purpose: each write names its exact
// optimism level and error surface, and new levels can be added without
// breaking call sites. The wire values are canonical for every language port
// (protocol/write-policy.schema.json; the Rust core src/policy.rs and Dart
// lib/src/policy.dart mirror them; zed-interfaces re-exports them).

/** How optimistically a single write is applied. @enum {string} */
export const WriteMode = Object.freeze({
  /** Apply locally + enqueue durably; no network until the next flush. */
  LOCAL_ONLY: "local_only",
  /** Apply locally, enqueue, send; a send failure leaves it queued (default). */
  OPTIMISTIC_QUEUE: "optimistic_queue",
  /** Like OPTIMISTIC_QUEUE, but a send failure is surfaced per the error policy. */
  OPTIMISTIC_AWAIT_ACK: "optimistic_await_ack",
  /** Send first; apply locally only after the ack. */
  SERVER_FIRST: "server_first",
  /** Send only; local updates when the change feed delivers the committed row. */
  SERVER_ONLY: "server_only",
});

/** How write/flush errors are surfaced. @enum {string} */
export const ErrorPolicy = Object.freeze({
  /** Reject the returned promise. */
  THROW_ONLY: "throw_only",
  /** Report through telemetry/onError, resolve normally (default for writes). */
  EMIT_ONLY: "emit_only",
  /** Both. */
  THROW_AND_EMIT: "throw_and_emit",
  /** Neither; the outcome is only visible in the result. */
  SILENT: "silent",
});

/** How a dirty-vs-newer-remote conflict resolves. @enum {string} */
export const ConflictResolution = Object.freeze({
  /** Adopt the server row, drop the queued local write (default). */
  SERVER_WINS: "server_wins",
  /** Keep the higher HLC version — leaderless multi-master converges. */
  LAST_WRITE_WINS: "last_write_wins",
});

const WRITE_MODES = new Set(Object.values(WriteMode));
const ERROR_POLICIES = new Set(Object.values(ErrorPolicy));
const CONFLICTS = new Set(Object.values(ConflictResolution));

/** @param {string} mode */
export function assertWriteMode(mode) {
  if (!WRITE_MODES.has(mode)) {
    throw new RangeError(
      `unknown sync write mode "${mode}" (expected one of ${[...WRITE_MODES].join(", ")})`,
    );
  }
  return mode;
}

/** @param {string} policy */
export function assertErrorPolicy(policy) {
  if (!ERROR_POLICIES.has(policy)) {
    throw new RangeError(
      `unknown sync error policy "${policy}" (expected one of ${[...ERROR_POLICIES].join(", ")})`,
    );
  }
  return policy;
}

/** @param {string} resolution */
export function assertConflictResolution(resolution) {
  if (!CONFLICTS.has(resolution)) {
    throw new RangeError(
      `unknown conflict resolution "${resolution}" (expected one of ${[...CONFLICTS].join(", ")})`,
    );
  }
  return resolution;
}

/** @param {string} policy */
export const shouldThrow = (policy) =>
  policy === ErrorPolicy.THROW_ONLY || policy === ErrorPolicy.THROW_AND_EMIT;
/** @param {string} policy */
export const shouldEmit = (policy) =>
  policy === ErrorPolicy.EMIT_ONLY || policy === ErrorPolicy.THROW_AND_EMIT;
