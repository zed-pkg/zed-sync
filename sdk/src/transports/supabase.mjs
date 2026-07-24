// Supabase realtime transport. @supabase/supabase-js is NOT a dependency: the
// caller passes any object satisfying this minimal structural interface, so the
// SDK stays dependency-free. Realtime + the backend catch-up path can deliver
// the same change in any order; reconcile converges (docs/protocol.md).

import { decodeSupabaseChange } from "./decode.mjs";

/**
 * @typedef {{
 *   channel(name: string): {
 *     on(type: string, filter: object, cb: (payload: any) => void): any,
 *     subscribe(cb?: (status: string) => void): any,
 *   },
 *   removeChannel(ch: any): void,
 * }} SupabaseLike
 */

/**
 * Subscribe a client's applyChange to Supabase realtime for the given tables.
 * @param {object} opts
 * @param {SupabaseLike} opts.client
 * @param {import("../client.mjs").SyncClient} opts.sync
 * @param {string[]} opts.tables
 * @param {string} [opts.schema]
 * @param {string} [opts.filter]   e.g. "tenant_id=eq.123" (complements RLS)
 * @param {(status: string) => void} [opts.onStatus]
 * @returns {{ stop(): void }}
 */
export function startSupabase({ client, sync, tables, schema = "public", filter, onStatus }) {
  const channel = client.channel(`zed-sync-${tables.join("-")}`);
  for (const table of tables) {
    channel.on(
      "postgres_changes",
      { event: "*", schema, table, ...(filter ? { filter } : {}) },
      (payload) => {
        const change = decodeSupabaseChange(payload);
        if (change) void sync.applyChange(change);
      },
    );
  }
  channel.subscribe((status) => onStatus?.(status));
  return {
    stop() {
      client.removeChannel(channel);
    },
  };
}
