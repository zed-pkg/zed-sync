// deepMerge — the JSONB-aware partial-write fold. Locks in the deliberate
// semantics documented in merge.mjs: objects recurse, arrays/scalars/class
// instances replace, `undefined` skips, `null` replaces (not RFC 7386 delete).
// The pollution + stack-overflow hardening cases live in policy.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { deepMerge } from "../src/merge.mjs";

test("nested objects recurse; siblings survive at every level", () => {
  const base = { top: "t", a: { keep: true, b: { c: 1, keep: "k" } } };
  const out = deepMerge(base, { a: { b: { c: 2 } } });
  assert.deepEqual(out, { top: "t", a: { keep: true, b: { c: 2, keep: "k" } } });
});

test("arrays replace wholesale, never merge element-wise", () => {
  assert.deepEqual(deepMerge({ xs: [1, 2, 3] }, { xs: [9] }), { xs: [9] });
  assert.deepEqual(deepMerge({ xs: [{ a: 1 }] }, { xs: [{ b: 2 }] }), { xs: [{ b: 2 }] });
  assert.deepEqual(deepMerge({ xs: [1] }, { xs: [] }), { xs: [] }, "empty array clears the list");
});

test("undefined patch values never erase", () => {
  assert.deepEqual(deepMerge({ a: 1, b: 2 }, { a: undefined, b: 3 }), { a: 1, b: 3 });
});

test("null replaces at any level — it clears the field, it does not delete the key", () => {
  const out = deepMerge({ a: { deep: 1 }, b: 2 }, { a: null });
  assert.deepEqual(out, { a: null, b: 2 });
  assert.ok("a" in out);
});

test("top-level non-object sides degrade to replace (or keep base when patch is undefined)", () => {
  const base = { a: 1 };
  assert.equal(deepMerge(base, undefined), base);
  assert.equal(deepMerge(base, 5), 5, "scalar patch replaces an object base");
  assert.deepEqual(deepMerge(5, { a: 1 }), { a: 1 }, "object patch replaces a scalar base");
  assert.equal(deepMerge(undefined, null), null, "explicit null wins over a missing base");
});

test("mismatched container types replace", () => {
  assert.deepEqual(deepMerge({ v: { a: 1 } }, { v: [1] }), { v: [1] }, "object -> array");
  assert.deepEqual(deepMerge({ v: [1] }, { v: { a: 1 } }), { v: { a: 1 } }, "array -> object");
  assert.deepEqual(deepMerge({ v: "s" }, { v: { a: 1 } }), { v: { a: 1 } }, "scalar -> object");
});

test("class instances replace wholesale in either position, never spread", () => {
  const when = new Date(0);
  assert.equal(deepMerge({ v: { a: 1 } }, { v: when }).v, when, "instance patch replaces");
  assert.deepEqual(deepMerge({ v: when }, { v: { a: 1 } }).v, { a: 1 }, "instance base is replaced");
  assert.equal(deepMerge({ v: new Map() }, { v: { a: 1 } }).v.a, 1);
});

test("null-prototype objects (JSON-ish data) still recurse", () => {
  const base = Object.assign(Object.create(null), { keep: 1, nested: Object.assign(Object.create(null), { x: 1 }) });
  const patch = Object.assign(Object.create(null), { nested: Object.assign(Object.create(null), { y: 2 }) });
  assert.deepEqual(deepMerge(base, patch), { keep: 1, nested: { x: 1, y: 2 } });
});

test("empty patch returns an equal copy, not the base reference", () => {
  const base = { a: 1, nested: { b: 2 } };
  const out = deepMerge(base, {});
  assert.deepEqual(out, base);
  assert.notEqual(out, base);
});

test("neither input is mutated, at any depth", () => {
  const base = { a: { b: 1 }, list: [1] };
  const patch = { a: { c: 2 }, list: [2], extra: { d: 3 } };
  const baseSnap = structuredClone(base);
  const patchSnap = structuredClone(patch);
  deepMerge(base, patch);
  assert.deepEqual(base, baseSnap);
  assert.deepEqual(patch, patchSnap);
});

test("polluting keys are skipped at any depth, not just the top level", () => {
  const hostile = JSON.parse('{"meta": {"__proto__": {"polluted": 1}, "ok": 2}}');
  const out = deepMerge({ meta: { keep: 1 } }, hostile);
  assert.deepEqual(out, { meta: { keep: 1, ok: 2 } });
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
});

test("past the depth cap the patch subtree replaces wholesale (siblings dropped)", () => {
  const LEVELS = 80; // > MAX_DEPTH (64)
  let base = { keep: true };
  let patch = { hit: true };
  for (let i = 0; i < LEVELS; i++) {
    base = { n: base, keep: true };
    patch = { n: patch };
  }
  const merged = /** @type {any} */ (deepMerge(base, patch));
  let cur = merged;
  for (let depth = 1; depth < 64; depth++) {
    cur = cur.n;
    assert.equal(cur.keep, true, `merged at depth ${depth}`);
  }
  assert.equal(cur.n.keep, undefined, "replaced wholesale past the cap");
  let leaf = cur.n;
  while (leaf.n) leaf = leaf.n;
  assert.equal(leaf.hit, true, "the deep patch payload survives intact");
});
