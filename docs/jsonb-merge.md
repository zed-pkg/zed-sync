# JSONB-aware merge

How the SDK folds a **partial** optimistic write into the row held locally so a
patch touching one field (or one key of a nested `jsonb` object) never clobbers
its siblings.

## Semantics (`sdk/src/merge.mjs`, `deepMerge`)

| Case | Behavior | Rationale |
|---|---|---|
| plain object ⊕ plain object | recurse key-by-key | field-level preservation |
| array | **replace** | matches RFC 7386 (a list is a set, not concatenated) |
| scalar / mismatched types / class instance | **replace** | opaque to a JSON merge |
| `undefined` in patch | **skip** (keep base) | a patch never erases by omission |
| `null` in patch | **set to null** | deliberate divergence from RFC 7386 (which deletes) — over DB rows, "set field to null" is a real operation; deletion is a delete write |
| pure | new value returned; inputs untouched | safe to reuse the stored row |

Only the local optimistic row is merged; the server's whole-row echo remains
authoritative on reconcile, so any imperfect merge self-heals.

## Hardening

- **Prototype pollution** — `__proto__`, `constructor`, `prototype` patch keys
  (which arrive as own enumerable keys from `JSON.parse`) are skipped
  unconditionally. This is the class of bug behind lodash **CVE-2019-10744**.
  Covered by `sdk/test/policy.test.mjs`.
- **Recursion depth / DoS** — capped at depth 64 (legit `jsonb` is shallow;
  beyond the cap the patch replaces), so a pathological/hostile document can't
  overflow the stack.
- **Opaque objects** — Date/Map/class instances replace rather than being
  half-merged into a corrupt shape.
