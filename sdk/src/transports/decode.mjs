// Pure payload -> ChangeEvent decoders. No IO, so they are unit-tested directly.

/** @typedef {import("../hlc.mjs").Hlc} Hlc */

/** Coerce a stored/received value into an HLC, or null if unusable. */
function toHlc(value) {
  if (value && typeof value === "object" && typeof value.wall_ms === "number") {
    return { wall_ms: value.wall_ms, counter: value.counter ?? 0, actor: String(value.actor ?? "srv") };
  }
  return null;
}

/**
 * Backend WS/SSE frame: { event: "zed:sync", changes: [envelope...] }.
 * Returns the change list, or [] for anything else.
 * @param {unknown} frame
 * @returns {object[]}
 */
export function decodeBackendFrame(frame) {
  if (!frame || typeof frame !== "object") return [];
  const f = /** @type {any} */ (frame);
  if (f.event !== "zed:sync" || !Array.isArray(f.changes)) return [];
  return f.changes.filter((c) => c && toHlc(c.version));
}

/**
 * Supabase postgres_changes payload -> ChangeEvent | null. A payload without a
 * usable HLC version (e.g. a DELETE on a table that is not REPLICA IDENTITY
 * FULL) returns null rather than fabricate a stale version — the backend WS /
 * catch-up carries that delete instead.
 * @param {unknown} payload
 * @returns {object|null}
 */
export function decodeSupabaseChange(payload) {
  const p = /** @type {any} */ (payload);
  if (!p || typeof p !== "object" || !p.table) return null;
  const isDelete = p.eventType === "DELETE";
  const record = isDelete ? p.old : p.new;
  if (!record || record.id == null) return null;
  const version = toHlc(record.sync_version);
  if (!version) return null; // never fabricate a version
  return {
    table: p.table,
    op: isDelete ? "delete" : "upsert",
    id: String(record.id),
    version,
    row: isDelete ? null : record,
    at_ms: Date.parse(record.updated_at ?? "") || Date.now(),
    write_key: record.write_key ?? undefined,
  };
}
