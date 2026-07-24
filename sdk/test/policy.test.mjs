import test from "node:test";
import assert from "node:assert/strict";
import {
  WriteMode,
  ErrorPolicy,
  ConflictResolution,
  assertWriteMode,
  assertErrorPolicy,
} from "../src/policy.mjs";
import { compareHlc, encodeHlc, Clock } from "../src/hlc.mjs";
import { deepMerge } from "../src/merge.mjs";

test("write modes are enum values, not booleans", () => {
  assert.equal(WriteMode.OPTIMISTIC_QUEUE, "optimistic_queue");
  assert.equal(Object.values(WriteMode).length, 5);
  assert.equal(Object.values(ErrorPolicy).length, 4);
  assert.equal(Object.values(ConflictResolution).length, 2);
  assert.throws(() => assertWriteMode("yes"), RangeError);
  assert.throws(() => assertErrorPolicy(true), RangeError);
});

test("HLC total order and monotonic tick", () => {
  assert.equal(compareHlc({ wall_ms: 1, counter: 0, actor: "z" }, { wall_ms: 1, counter: 1, actor: "a" }), -1);
  assert.equal(compareHlc({ wall_ms: 2, counter: 0, actor: "a" }, { wall_ms: 1, counter: 9, actor: "z" }), 1);
  assert.equal(compareHlc({ wall_ms: 5, counter: 5, actor: "aaa" }, { wall_ms: 5, counter: 5, actor: "bbb" }), -1);

  const clock = new Clock("dev");
  const a = clock.tick(1000);
  const b = clock.tick(500); // clock went backwards
  assert.equal(compareHlc(b, a), 1, "tick stays monotonic");
});

test("HLC encoding is sortable and matches the Rust format", () => {
  assert.equal(encodeHlc({ wall_ms: 0x0197f3b2c4d1, counter: 3, actor: "x" }), "0197f3b2c4d1-0003");
  assert.ok(encodeHlc({ wall_ms: 1, counter: 0, actor: "a" }) < encodeHlc({ wall_ms: 2, counter: 0, actor: "a" }));
});

test("deepMerge preserves siblings and clears with null", () => {
  const base = { a: 1, meta: { x: 1, y: 2 }, tags: ["a"] };
  const merged = deepMerge(base, { meta: { y: 9 }, tags: ["b"], a: null });
  assert.deepEqual(merged, { a: null, meta: { x: 1, y: 9 }, tags: ["b"] });
  assert.deepEqual(base, { a: 1, meta: { x: 1, y: 2 }, tags: ["a"] }, "inputs untouched");
});

test("deepMerge resists prototype pollution (CVE-2019-10744 class)", () => {
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"p2": 1}}}');
  const out = deepMerge({}, hostile);
  assert.equal(({}).polluted, undefined, "Object.prototype not polluted");
  assert.equal(/** @type {any} */ (out).polluted, undefined);
});

test("deepMerge caps recursion depth (no stack overflow on hostile input)", () => {
  let deep = {};
  let cur = deep;
  for (let i = 0; i < 5000; i++) {
    cur.n = {};
    cur = cur.n;
  }
  assert.doesNotThrow(() => deepMerge({}, deep));
});
