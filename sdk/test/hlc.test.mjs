// Clock behavior under wall-clock anomalies plus the observe() merge — the
// stateful parts of hlc.mjs the pure-compare conformance fixture cannot cover.
import test from "node:test";
import assert from "node:assert/strict";
import { Clock, compareHlc, encodeHlc } from "../src/hlc.mjs";

test("tick advances with the wall clock and resets the counter", () => {
  const c = new Clock("dev");
  assert.deepEqual(c.tick(1000), { wall_ms: 1000, counter: 0, actor: "dev" });
  assert.deepEqual(c.tick(1000), { wall_ms: 1000, counter: 1, actor: "dev" });
  assert.deepEqual(c.tick(2000), { wall_ms: 2000, counter: 0, actor: "dev" });
});

test("observe: remote ahead adopts the remote wall and bumps past its counter", () => {
  const c = new Clock("dev");
  c.tick(1000);
  const st = c.observe({ wall_ms: 5000, counter: 7, actor: "srv" }, 1001);
  assert.deepEqual(st, { wall_ms: 5000, counter: 8, actor: "dev" });
});

test("observe: local ahead keeps the wall and increments its own counter", () => {
  const c = new Clock("dev");
  c.tick(9000);
  const st = c.observe({ wall_ms: 100, counter: 50, actor: "srv" }, 100);
  assert.deepEqual(st, { wall_ms: 9000, counter: 1, actor: "dev" });
});

test("observe: equal walls take max(counter) + 1", () => {
  const c = new Clock("dev");
  c.tick(3000);
  c.tick(3000); // counter -> 1
  const st = c.observe({ wall_ms: 3000, counter: 9, actor: "srv" }, 3000);
  assert.deepEqual(st, { wall_ms: 3000, counter: 10, actor: "dev" });
});

test("observe: a fresh local wall clock ahead of both resets the counter", () => {
  const c = new Clock("dev");
  c.tick(1000);
  const st = c.observe({ wall_ms: 2000, counter: 5, actor: "srv" }, 8000);
  assert.deepEqual(st, { wall_ms: 8000, counter: 0, actor: "dev" });
});

test("stamps stay strictly monotonic across interleaved tick/observe with a stuck or backwards clock", () => {
  const c = new Clock("dev");
  let prev = c.tick(500);
  const steps = [
    ["tick backwards", () => c.tick(400)],
    ["observe older remote", () => c.observe({ wall_ms: 450, counter: 3, actor: "a" }, 400)],
    ["tick stuck", () => c.tick(500)],
    ["observe equal-wall remote with huge counter", () => c.observe({ wall_ms: 500, counter: 99, actor: "b" }, 500)],
    ["tick still stuck", () => c.tick(500)],
    ["observe remote far ahead", () => c.observe({ wall_ms: 10_000, counter: 0, actor: "c" }, 500)],
    ["tick after remote jump", () => c.tick(500)],
  ];
  for (const [label, step] of steps) {
    const next = step();
    assert.equal(compareHlc(next, prev), 1, `${label}: stamp must sort after the previous one`);
    prev = next;
  }
});

test("a stamp taken after observe sorts after the observed remote stamp", () => {
  const c = new Clock("dev");
  c.tick(100);
  const remote = { wall_ms: 7000, counter: 4, actor: "srv" };
  const st = c.observe(remote, 100);
  assert.equal(compareHlc(st, remote), 1);
});

test("encodeHlc truncates the wall to 48 bits and the counter to 16", () => {
  assert.equal(encodeHlc({ wall_ms: 2 ** 48 + 5, counter: 0x10003, actor: "x" }), "000000000005-0003");
  assert.equal(encodeHlc({ wall_ms: 0, counter: 0, actor: "x" }), "000000000000-0000");
});

test("encoded stamps sort lexicographically in compareHlc order (same actor)", () => {
  const stamps = [
    { wall_ms: 2, counter: 0, actor: "d" },
    { wall_ms: 1, counter: 10, actor: "d" },
    { wall_ms: 1, counter: 2, actor: "d" },
    { wall_ms: 10, counter: 0, actor: "d" },
    { wall_ms: 0x0197f3b2c4d1, counter: 0xffff, actor: "d" },
  ];
  const byCompare = [...stamps].sort(compareHlc).map(encodeHlc);
  const byString = stamps.map(encodeHlc).sort();
  assert.deepEqual(byString, byCompare);
});
