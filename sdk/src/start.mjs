// startSync — bring up one reconcile client fed by BOTH Supabase realtime and
// the backend WS, re-hydrating (catch-up) on every (re)connect. Either transport
// alone is sufficient; together they are resilient (docs/protocol.md).

import { SyncClient } from "./client.mjs";
import { IndexedDbStore, MemoryStore } from "./store.mjs";
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
 * @param {{ baseUrl: string, wsPath?: string, getToken?: () => string|Promise<string> }} [opts.backend]
 * @param {{ client: object, filter?: string, schema?: string }} [opts.supabase]
 * @param {(table: string) => Promise<object[]>} [opts.hydrateFetch]
 * @returns {Promise<{ client: SyncClient, stop(): void }>}
 */
export async function startSync(opts) {
  const store =
    opts.store ??
    (globalThis.indexedDB
      ? await IndexedDbStore.open(opts.dbName ?? "zed-sync")
      : new MemoryStore());

  const send = opts.backend
    ? makeBackendSender({ baseUrl: opts.backend.baseUrl, getToken: opts.backend.getToken })
    : undefined;

  const client = new SyncClient({
    store,
    actor: opts.actor,
    send,
    telemetry: opts.telemetry,
    writeMode: opts.writeMode,
    errorPolicy: opts.errorPolicy,
    conflictResolution: opts.conflictResolution,
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

  /** @type {Array<{ stop(): void }>} */
  const stoppers = [];
  if (opts.backend) {
    stoppers.push(
      startBackendStream({
        baseUrl: opts.backend.baseUrl,
        wsPath: opts.backend.wsPath,
        getToken: opts.backend.getToken,
        sync: client,
        onReconnect: hydrateAll,
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
      }),
    );
  }
  await hydrateAll();

  return {
    client,
    stop() {
      for (const s of stoppers) s.stop();
    },
  };
}
