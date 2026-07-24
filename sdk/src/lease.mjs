// SyncLease — a distributed single-flusher lease over an injected lock client.
//
// Problem (docs/leases.md): N instances of the same logical actor (tabs,
// workers, processes) share one IndexedDB queue. Each runs its own HLC clock
// and its own flush loop, so the same actor can mint colliding versions and
// double-send queued writes. The fix is a single-writer lease: exactly one
// instance holds `zed-sync/flusher/{dbName}/{actor}` and runs transports,
// hydration, and flushing; the rest wait in the lock service's FIFO queue and
// take over (with the shared queue) when the holder releases, crashes, or
// lets the lease TTL lapse.
//
// The SDK stays zero-dependency: the lock client is INJECTED. The expected
// shape is `FiduciaLockClient` from @fiducia/client (locking.ts):
//
//   * lock(key, { ttl, holder, maxWaitTime, signal }) -> Promise<handle>
//   * tryLock(key, opts) -> Promise<handle|null>
//   * handle: { fencingToken, leaseExpiresMs?, renew(ttlMs), release() }
//   * a timed-out blocking wait throws an error named "LockTimeoutError"
//
// Any client honoring that contract works.
//
// IMPORTANT — holder identity: fiducia treats a same-holder acquire as the
// SAME owner reacquiring its grant, so two instances sharing a holder id
// would both be granted the lease and the mutual exclusion evaporates. Leave
// `holder` unset (the lock client generates a unique id per acquisition)
// unless you are certain the id is unique per PROCESS, not per actor.
//
// Fencing: `lease.fencingToken` is the monotonic token for the current grant.
// Pass it to downstream systems that support it; the queued-write
// `Idempotency-Key` remains the server-side backstop against a paused old
// holder double-sending.

/** Default lease TTL: long enough to ride out a GC pause or slow renew. */
export const DEFAULT_LEASE_TTL_MS = 30_000;
/** Cap on a single blocking acquire attempt while looping toward a deadline. */
const ATTEMPT_WAIT_MS = 30_000;
/** Floor for the fast-retry delay after a transient renew failure. */
const RETRY_FLOOR_MS = 250;

/** Build the canonical flusher-lease key for a (dbName, actor) pair. */
export function flusherLeaseKey(dbName, actor) {
  if (!dbName || !actor) throw new TypeError("flusherLeaseKey requires dbName and actor");
  return `zed-sync/flusher/${dbName}/${actor}`;
}

/** The lease could not be acquired within the caller's wait budget. */
export class LeaseTimeoutError extends Error {
  constructor(key, waitedMs) {
    super(`zed-sync: timed out after ${waitedMs}ms waiting for lease ${key}`);
    this.name = "LeaseTimeoutError";
    this.key = key;
    this.waitedMs = waitedMs;
  }
}

/** A held lease lost its authority (renewal failed past the safe deadline). */
export class LeaseLostError extends Error {
  constructor(key, options) {
    super(`zed-sync: lease ${key} lost its authority`, options);
    this.name = "LeaseLostError";
    this.key = key;
  }
}

/** Renew errors that prove another owner exists — lose authority immediately. */
const AUTHORITY_LOST_RE = /lost fenced authority|not_holder|not_found/i;

export class SyncLease {
  /**
   * @param {object} opts
   * @param {object} opts.client            injected lock client (FiduciaLockClient shape)
   * @param {string} opts.key               lease key (see flusherLeaseKey)
   * @param {number} [opts.ttlMs]           lease TTL (default 30s); the crash-recovery bound
   * @param {number} [opts.renewIntervalMs] heartbeat cadence (default ttlMs/3)
   * @param {string} [opts.holder]          UNIQUE-PER-INSTANCE id; omit to auto-generate
   * @param {number} [opts.renewFailureLimit] consecutive transient failures before loss (default 3)
   * @param {(err: LeaseLostError) => void} [opts.onLost]
   * @param {(err: unknown, consecutiveFailures: number) => void} [opts.onRenewError]
   */
  constructor({ client, key, ttlMs, renewIntervalMs, holder, renewFailureLimit, onLost, onRenewError }) {
    if (typeof client?.lock !== "function" || typeof client?.tryLock !== "function") {
      throw new TypeError("SyncLease requires a lock client with lock() and tryLock()");
    }
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("SyncLease requires a nonempty key");
    }
    this.client = client;
    this.key = key;
    this.ttlMs = ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.renewIntervalMs = renewIntervalMs ?? Math.floor(this.ttlMs / 3);
    if (!(this.ttlMs > 0) || !(this.renewIntervalMs > 0) || this.renewIntervalMs >= this.ttlMs) {
      throw new RangeError("SyncLease requires 0 < renewIntervalMs < ttlMs");
    }
    this.holder = holder;
    this.renewFailureLimit = renewFailureLimit ?? 3;
    this.onLost = onLost;
    this.onRenewError = onRenewError;
    /** @type {object|null} */
    this._handle = null;
    this._timer = null;
    this._failures = 0;
    this._acquiring = false;
  }

  /** True while this instance holds an unrevoked grant. */
  get held() {
    return this._handle !== null;
  }

  /** Monotonic fencing token of the current grant, or null when not held. */
  get fencingToken() {
    return this._handle?.fencingToken ?? null;
  }

  /** Server-reported lease expiry (ms epoch) if known, else null. */
  get leaseExpiresMs() {
    return this._handle?.leaseExpiresMs ?? null;
  }

  /**
   * Block until the lease is held. Loops through the lock client's per-attempt
   * wait budget until `maxWaitMs` elapses (default: wait forever), so a
   * follower can sit in the FIFO queue indefinitely awaiting promotion.
   * @param {{ maxWaitMs?: number, signal?: AbortSignal }} [opts]
   * @returns {Promise<this>}
   */
  async acquire({ maxWaitMs = Infinity, signal } = {}) {
    if (this._handle) return this;
    if (this._acquiring) throw new Error("zed-sync: lease acquisition already in progress");
    this._acquiring = true;
    const started = Date.now();
    const deadline = Number.isFinite(maxWaitMs) ? started + maxWaitMs : null;
    try {
      for (;;) {
        const budget = deadline === null ? ATTEMPT_WAIT_MS : deadline - Date.now();
        if (budget <= 0) throw new LeaseTimeoutError(this.key, Date.now() - started);
        let handle;
        try {
          handle = await this.client.lock(this.key, {
            ttl: this.ttlMs,
            holder: this.holder,
            maxWaitTime: Math.min(budget, ATTEMPT_WAIT_MS),
            signal,
          });
        } catch (err) {
          // A per-attempt timeout just means "still queued" — keep waiting
          // unless the caller's overall budget or signal says stop.
          if (err?.name === "LockTimeoutError" && !signal?.aborted) continue;
          throw err;
        }
        this._adopt(handle);
        return this;
      }
    } finally {
      this._acquiring = false;
    }
  }

  /** Take the lease only if it is free right now; false when it is held. */
  async tryAcquire() {
    if (this._handle) return true;
    if (this._acquiring) throw new Error("zed-sync: lease acquisition already in progress");
    this._acquiring = true;
    try {
      const handle = await this.client.tryLock(this.key, {
        ttl: this.ttlMs,
        holder: this.holder,
      });
      if (!handle) return false;
      this._adopt(handle);
      return true;
    } finally {
      this._acquiring = false;
    }
  }

  /**
   * Release the grant. Safe to call when not held. A failed release is
   * swallowed: the lease TTL is the backstop and the next holder is promoted
   * when it lapses.
   */
  async release() {
    const handle = this._handle;
    this._handle = null;
    this._stopHeartbeat();
    if (!handle) return;
    try {
      await handle.release();
    } catch {
      /* TTL backstop */
    }
  }

  _adopt(handle) {
    this._handle = handle;
    this._failures = 0;
    this._schedule(this.renewIntervalMs);
  }

  _schedule(ms) {
    this._stopHeartbeat();
    this._timer = setTimeout(() => void this._beat(), ms);
    // Never keep a Node process alive just to heartbeat.
    this._timer.unref?.();
  }

  _stopHeartbeat() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async _beat() {
    const handle = this._handle;
    if (!handle) return;
    try {
      await handle.renew(this.ttlMs);
      this._failures = 0;
      this._schedule(this.renewIntervalMs);
    } catch (err) {
      this._failures += 1;
      this.onRenewError?.(err, this._failures);
      const authorityLost = AUTHORITY_LOST_RE.test(String(err?.message ?? err));
      const expired = this.leaseExpiresMs !== null && Date.now() >= this.leaseExpiresMs;
      if (authorityLost || expired || this._failures >= this.renewFailureLimit) {
        this._markLost(err);
      } else {
        // Transient (network) failure: retry faster than the normal cadence,
        // but never tighter than the floor.
        this._schedule(Math.max(RETRY_FLOOR_MS, Math.floor(this.renewIntervalMs / 2)));
      }
    }
  }

  _markLost(cause) {
    if (!this._handle) return;
    this._handle = null;
    this._stopHeartbeat();
    this.onLost?.(new LeaseLostError(this.key, { cause }));
  }
}

/**
 * Acquire the lease, run `fn`, and always release — even if `fn` throws.
 * @template T
 * @param {ConstructorParameters<typeof SyncLease>[0] & { maxWaitMs?: number, signal?: AbortSignal }} opts
 * @param {(lease: SyncLease) => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export async function withSyncLease(opts, fn) {
  const { maxWaitMs, signal, ...leaseOpts } = opts;
  const lease = new SyncLease(leaseOpts);
  await lease.acquire({ maxWaitMs, signal });
  try {
    return await fn(lease);
  } finally {
    await lease.release();
  }
}
