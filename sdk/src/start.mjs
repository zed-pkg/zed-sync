// startSync — bring up one reconcile client fed by BOTH Supabase realtime and
// the backend WS, re-hydrating (catch-up) on every (re)connect. Either transport
// alone is sufficient; together they are resilient (docs/protocol.md).

import { SyncClient } from "./client.mjs";
import { IndexedDbStore, MemoryStore } from "./store.mjs";
import { SyncLease, flusherLeaseKey } from "./lease.mjs";
import {
  AppLifecycleMachine,
  AppPhase,
  LifecycleEvent,
  TransitionOutcome,
} from "./lifecycle.mjs";
import { ErrorPolicy } from "./policy.mjs";
import { makeBackendSender, startBackendStream } from "./transports/backend.mjs";
import { startSupabase } from "./transports/supabase.mjs";

/**
 * @param {object} opts
 * @param {string} opts.actor
 * @param {string[]} opts.tables
 * @param {string} [opts.dbName]
 * @param {object} [opts.store]                 explicit store (defaults to IndexedDbStore, MemoryStore off-DOM)
 * @param {object} [opts.telemetry]
 * @param {string} [opts.writeMode]
 * @param {string} [opts.errorPolicy]
 * @param {string} [opts.conflictResolution]
 * @param {{ baseUrl: string, wsPath?: string, getToken?: () => string|Promise<string>, onStatus?: (status: string) => void }} [opts.backend]
 * @param {{ client: object, filter?: string, schema?: string, onStatus?: (status: string) => void }} [opts.supabase]
 * @param {(table: string) => Promise<object[]>} [opts.hydrateFetch]
 * @param {{
 *   client: object,
 *   key?: string,
 *   ttlMs?: number,
 *   renewIntervalMs?: number,
 *   holder?: string,
 *   maxWaitMs?: number,
 *   flushOnAcquire?: boolean,
 *   onLost?: (err: Error) => void,
 * }} [opts.lease]  single-flusher lease (docs/leases.md): startSync blocks until
 *   this instance holds `zed-sync/flusher/{dbName}/{actor}` before starting
 *   transports/hydration, stamps every backend send with the grant's fencing
 *   token, flushes the inherited queue on promotion, and stops the transports
 *   if the lease is lost. `client` is a FiduciaLockClient-shaped object (see
 *   lease.mjs); leave `holder` unset unless it is unique per process.
 * @returns {Promise<{ client: SyncClient, lease: SyncLease|null, lifecycle: object, stop(): Promise<void> }>}
 */
export async function startSync(opts) {
  const lifecycle = new AppLifecycleMachine();
  if (lifecycle.dispatch(LifecycleEvent.startRequested()) !== TransitionOutcome.APPLIED) {
    throw new Error("zed-sync lifecycle: could not allocate startup operation");
  }
  const sessionToken = lifecycle.snapshot.activeToken;

  /** @type {SyncLease|null} assigned during startup; visible to cleanup */
  let lease = null;
  /** @type {Array<{ stop(): void }>} */
  const stoppers = [];
  const stopTransports = () => {
    for (const s of stoppers.splice(0)) s.stop();
  };

  try {
    const store =
      opts.store ??
      (globalThis.indexedDB
        ? await IndexedDbStore.open(opts.dbName ?? "zed-sync")
        : new MemoryStore());

    const onlineTransports = new Set();
    const reportTransport = (name, online) => {
      if (online) onlineTransports.add(name);
      else onlineTransports.delete(name);
      lifecycle.dispatch(
        LifecycleEvent.connectivityChanged(sessionToken, onlineTransports.size > 0),
      );
    };

    const send = opts.backend
      ? makeBackendSender({
          baseUrl: opts.backend.baseUrl,
          getToken: opts.backend.getToken,
          getFence: opts.lease
            ? () => (lease?.held ? { key: lease.key, token: lease.fencingToken } : null)
            : undefined,
        })
      : undefined;

    const client = new SyncClient({
      store,
      actor: opts.actor,
      send,
      telemetry: opts.telemetry,
      writeMode: opts.writeMode,
      errorPolicy: opts.errorPolicy,
      conflictResolution: opts.conflictResolution,
      tables: opts.tables,
      lifecycle,
    });
    lifecycle.subscribe((snapshot, event) => {
      client.telemetry.event("sync.lifecycle.transition", {
        event: event.type,
        phase: snapshot.phase,
        generation: snapshot.generation,
      });
    });

    const hydrateAll = async () => {
      if (!opts.hydrateFetch) return;
      for (const table of opts.tables) {
        try {
          await client.hydrate(await opts.hydrateFetch(table));
        } catch {
          // catch-up will retry on the next reconnect
        }
      }
    };

  // Single-flusher lease: block until this instance is the elected flusher
  // BEFORE any transport, hydration, or flush touches the shared store. On
  // loss of authority the transports stop — local writes keep queueing and a
  // promoted instance (possibly this one, re-elected by the app) drains them.
    if (opts.lease) {
      lease = new SyncLease({
        client: opts.lease.client,
        key: opts.lease.key ?? flusherLeaseKey(opts.dbName ?? "zed-sync", opts.actor),
        ttlMs: opts.lease.ttlMs,
        renewIntervalMs: opts.lease.renewIntervalMs,
        holder: opts.lease.holder,
        onLost: (err) => {
          // Revoke effects before publishing Failed. Failed capabilities are
          // closed until stop() performs explicit reconciliation.
          stopTransports();
          lifecycle.dispatch(LifecycleEvent.runtimeFailed(sessionToken));
          client.telemetry.event("sync.lease.lost", { key: lease.key, error: err });
          opts.lease.onLost?.(err);
        },
      });
      await lease.acquire({ maxWaitMs: opts.lease.maxWaitMs });
      client.telemetry.event("sync.lease.acquired", {
        key: lease.key,
        fencing_token: lease.fencingToken,
      });
    }

    if (opts.backend) {
      stoppers.push(
        startBackendStream({
          baseUrl: opts.backend.baseUrl,
          wsPath: opts.backend.wsPath,
          getToken: opts.backend.getToken,
          sync: client,
          onReconnect: hydrateAll,
          onStatus: (status) => {
            reportTransport("backend", status === "open");
            opts.backend.onStatus?.(status);
          },
        }),
      );
    }
    if (opts.supabase) {
      stoppers.push(
        startSupabase({
          client: /** @type {any} */ (opts.supabase.client),
          sync: client,
          tables: opts.tables,
          schema: opts.supabase.schema,
          filter: opts.supabase.filter,
          onStatus: (status) => {
            if (status === "SUBSCRIBED") reportTransport("supabase", true);
            if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
              reportTransport("supabase", false);
            }
            opts.supabase.onStatus?.(status);
          },
        }),
      );
    }
    await hydrateAll();
    lifecycle.dispatch(LifecycleEvent.startSucceeded(sessionToken));

  // A freshly promoted flusher inherits whatever the previous holder left
  // queued in the shared store; drain it now rather than waiting for the next
  // reconnect. EMIT_ONLY: a flush failure must not fail startup — the queue
  // is retried on reconnect as usual.
    if (lease && (opts.lease.flushOnAcquire ?? true) && opts.backend) {
      try {
        await client.flushQueue(ErrorPolicy.EMIT_ONLY);
      } catch {
        // EMIT_ONLY never throws; belt-and-suspenders for custom policies
      }
    }

    const lifecycleView = Object.freeze({
      get snapshot() {
        return lifecycle.snapshot;
      },
      get capabilities() {
        return lifecycle.capabilities;
      },
      subscribe(listener) {
        return lifecycle.subscribe(listener);
      },
    });

    let stopPromise = null;
    const stop = () => {
      if (stopPromise) return stopPromise;
      const event =
        lifecycle.snapshot.phase === AppPhase.FAILED
          ? LifecycleEvent.reconcileRequested()
          : LifecycleEvent.stopRequested();
      const outcome = lifecycle.dispatch(event);
      if (outcome === TransitionOutcome.STUTTERED && lifecycle.snapshot.phase === AppPhase.STOPPED) {
        return Promise.resolve();
      }
      if (outcome !== TransitionOutcome.APPLIED) {
        return Promise.reject(
          new Error(`zed-sync lifecycle: stop rejected while ${lifecycle.snapshot.phase}`),
        );
      }
      const stopToken = lifecycle.snapshot.activeToken;
      stopPromise = (async () => {
        try {
          stopTransports();
          if (lease) await lease.release();
          lifecycle.dispatch(LifecycleEvent.stopSucceeded(stopToken));
        } catch (err) {
          lifecycle.dispatch(LifecycleEvent.stopFailed(stopToken));
          throw err;
        }
      })();
      return stopPromise;
    };

    return { client, lease, lifecycle: lifecycleView, stop };
  } catch (err) {
    stopTransports();
    if (lease) await lease.release();
    lifecycle.dispatch(LifecycleEvent.startFailed(sessionToken));
    throw err;
  }
}
