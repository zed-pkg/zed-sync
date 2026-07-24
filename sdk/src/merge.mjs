// deepMerge — the JSONB-aware merge used to fold a PARTIAL optimistic write into
// the row already held locally, so a patch touching one field (or one key of a
// nested jsonb object) never clobbers its siblings. The server's echo remains the
// authoritative whole-row truth on reconcile, so an imperfect merge self-heals.
//
// Semantics (deliberate, for row/JSONB data — not a generic deep-merge):
//   - plain objects RECURSE key-by-key;
//   - arrays REPLACE wholesale (a list is a set, not concatenated);
//   - scalars / class instances / mismatched types REPLACE;
//   - `undefined` in the patch is SKIPPED (a patch never erases by omission);
//   - `null` in the patch REPLACES (the explicit way to clear a field — a
//     deliberate divergence from RFC 7386, which deletes; deletion is a delete
//     write, not a merge).
// Pure: neither argument is mutated.

// Keys that could poison a prototype chain — the class of bug behind
// lodash CVE-2019-10744. Skipped unconditionally.
const POLLUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Legit jsonb is shallow; cap recursion so a hostile deep object can't overflow
// the stack. Beyond the cap the patch replaces wholesale.
const MAX_DEPTH = 64;

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-merge `patch` into `base`, returning a NEW value (inputs untouched).
 * @param {unknown} base
 * @param {unknown} patch
 * @param {number} [depth]
 * @returns {unknown}
 */
export function deepMerge(base, patch, depth = 0) {
  if (!isPlainObject(patch) || !isPlainObject(base) || depth >= MAX_DEPTH) {
    return patch === undefined ? base : patch;
  }
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    if (POLLUTING_KEYS.has(key)) continue;
    const value = /** @type {Record<string, unknown>} */ (patch)[key];
    if (value === undefined) continue; // never erase by omission
    out[key] = deepMerge(out[key], value, depth + 1);
  }
  return out;
}
