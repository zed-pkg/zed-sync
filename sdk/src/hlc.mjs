// Hybrid Logical Clock — the JS mirror of src/hlc.rs (and dart/lib/src/hlc.dart).
// Same total order (wall_ms, counter, actor) and same sortable encoding, so a
// stamp made on the browser, server (Rust), or mobile (Dart) compares identically.

/** @typedef {{ wall_ms: number, counter: number, actor: string }} Hlc */

/** Reject a remote stamp whose wall clock runs more than this far ahead of ours
 * (5 minutes). Without the bound one attacker-controlled far-future `wall_ms`
 * would permanently poison the clock and win every LAST_WRITE_WINS conflict. */
export const MAX_DRIFT_MS = 300_000;

/** Total order: wall_ms, then counter, then actor. @param {Hlc} a @param {Hlc} b */
export function compareHlc(a, b) {
  if (a.wall_ms !== b.wall_ms) return a.wall_ms < b.wall_ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.actor === b.actor) return 0;
  return a.actor < b.actor ? -1 : 1;
}

/** Sortable canonical string, e.g. "0197f3b2c4d1-0003". Uses modulo rather than
 * bitwise `&` because JS bitwise operators truncate to 32 bits, which would
 * corrupt the 48-bit millisecond value. @param {Hlc} h */
export function encodeHlc(h) {
  const wall = Math.floor(h.wall_ms % 0x1000000000000)
    .toString(16)
    .padStart(12, "0");
  const ctr = (h.counter % 0x10000).toString(16).padStart(4, "0");
  return `${wall}-${ctr}`;
}

/**
 * A device-local clock producing strictly monotonic stamps even when the wall
 * clock jumps backwards.
 */
export class Clock {
  /** @param {string} actor  stable per-device id */
  constructor(actor) {
    this.actor = actor;
    this.wall_ms = 0;
    this.counter = 0;
  }

  /** @param {number} [nowMs] @returns {Hlc} */
  tick(nowMs = Date.now()) {
    if (nowMs > this.wall_ms) {
      this.wall_ms = nowMs;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return { wall_ms: this.wall_ms, counter: this.counter, actor: this.actor };
  }

  /** Fold in an observed remote stamp. @param {Hlc} remote @param {number} [nowMs] */
  observe(remote, nowMs = Date.now()) {
    // Clock-drift clamp: an over-drift remote wall is IGNORED (not folded in), so
    // the local clock never advances past nowMs + MAX_DRIFT_MS. In range, behavior
    // is identical to the classic HLC update.
    const remoteOk = remote.wall_ms <= nowMs + MAX_DRIFT_MS;
    const maxWall = remoteOk
      ? Math.max(nowMs, this.wall_ms, remote.wall_ms)
      : Math.max(nowMs, this.wall_ms);
    if (remoteOk && maxWall === this.wall_ms && maxWall === remote.wall_ms) {
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else if (maxWall === this.wall_ms) {
      this.counter += 1;
    } else if (remoteOk && maxWall === remote.wall_ms) {
      this.counter = remote.counter + 1;
    } else {
      this.counter = 0;
    }
    this.wall_ms = maxWall;
    return { wall_ms: this.wall_ms, counter: this.counter, actor: this.actor };
  }
}
