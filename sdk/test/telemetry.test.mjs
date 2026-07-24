import test from "node:test";
import assert from "node:assert/strict";

import {
  noopTelemetry,
  makeConsoleTelemetry,
  combineTelemetry,
  makeOtelTelemetry,
} from "../src/telemetry.mjs";

test("noopTelemetry swallows events and is frozen", () => {
  assert.doesNotThrow(() => noopTelemetry.event("sync.write.start", { table: "t" }));
  assert.ok(Object.isFrozen(noopTelemetry));
});

test("combineTelemetry fans one event out to every live sink in order", () => {
  const seen = [];
  const a = { event: (n, attrs) => seen.push(["a", n, attrs]) };
  const b = { event: (n) => seen.push(["b", n]) };
  const combined = combineTelemetry(a, null, b, undefined);
  combined.event("sync.change", { outcome: "applied" });
  assert.deepEqual(seen, [
    ["a", "sync.change", { outcome: "applied" }],
    ["b", "sync.change"],
  ]);
});

test("combineTelemetry: one throwing sink never breaks the others or the caller", () => {
  const delivered = [];
  const throwsFirst = {
    event() {
      throw new Error("sink blew up");
    },
  };
  const healthyBefore = { event: (n) => delivered.push(["before", n]) };
  const healthyAfter = { event: (n) => delivered.push(["after", n]) };

  // A throwing sink placed BETWEEN two healthy ones must not stop either.
  const combined = combineTelemetry(healthyBefore, throwsFirst, healthyAfter);
  assert.doesNotThrow(() => combined.event("sync.flush.failed", { error: new Error("x") }));
  assert.deepEqual(delivered, [
    ["before", "sync.flush.failed"],
    ["after", "sync.flush.failed"],
  ]);
});

test("combineTelemetry with no sinks is a safe no-op", () => {
  const combined = combineTelemetry();
  assert.doesNotThrow(() => combined.event("sync.hydrate", { count: 0 }));
});

test("makeConsoleTelemetry routes error events to warn and the rest to debug", () => {
  const calls = [];
  const realWarn = console.warn;
  const realDebug = console.debug;
  console.warn = (...args) => calls.push(["warn", ...args]);
  console.debug = (...args) => calls.push(["debug", ...args]);
  try {
    const tel = makeConsoleTelemetry("[t]");
    tel.event("sync.write.local", { table: "notes" });
    tel.event("sync.write.failed", { error: new Error("boom") });
  } finally {
    console.warn = realWarn;
    console.debug = realDebug;
  }
  assert.equal(calls[0][0], "debug");
  assert.equal(calls[0][1], "[t] sync.write.local");
  assert.equal(calls[1][0], "warn");
  assert.equal(calls[1][1], "[t] sync.write.failed");
});

test("makeOtelTelemetry records spans and counts error events", () => {
  const spans = [];
  const counters = {};
  const tracer = {
    startSpan(name) {
      const span = { name, status: null, exceptions: [], attributes: null, ended: false };
      spans.push(span);
      return {
        setStatus: (s) => (span.status = s),
        recordException: (e) => span.exceptions.push(e),
        setAttributes: (a) => (span.attributes = a),
        end: () => (span.ended = true),
      };
    },
  };
  const meter = {
    createCounter(name) {
      counters[name] = 0;
      return { add: (n) => (counters[name] += n) };
    },
  };
  const tel = makeOtelTelemetry({ tracer, meter });

  tel.event("sync.write.acked", { table: "notes", id: "n1" });
  tel.event("sync.write.failed", { table: "notes", id: "n1", error: new Error("nope") });

  assert.equal(spans.length, 2, "one span per event");
  assert.ok(spans.every((s) => s.ended), "every span is ended");
  // The error event must carry a non-OK status and a recorded exception.
  const errored = spans.find((s) => s.name === "sync.write.failed");
  assert.ok(errored.status && errored.status.code !== undefined);
  assert.equal(errored.exceptions.length, 1);
  // And it must bump an error counter.
  const total = Object.values(counters).reduce((a, b) => a + b, 0);
  assert.ok(total >= 1, "an error counter was incremented");
});

test("makeOtelTelemetry flattens nested and null attribute values without throwing", () => {
  const recorded = [];
  const tracer = {
    startSpan() {
      return {
        setStatus() {},
        recordException() {},
        setAttributes: (a) => recorded.push(a),
        end() {},
      };
    },
  };
  const tel = makeOtelTelemetry({ tracer });
  assert.doesNotThrow(() =>
    tel.event("sync.change", {
      outcome: "applied",
      nested: { a: 1, b: { c: 2 } },
      missing: null,
      list: [1, 2, 3],
    }),
  );
  // Whatever the flattening scheme, attribute values must be OTel-safe
  // primitives (or arrays of them), never a raw nested object or null.
  assert.equal(recorded.length, 1);
  for (const value of Object.values(recorded[0])) {
    const ok =
      value === undefined ||
      ["string", "number", "boolean"].includes(typeof value) ||
      Array.isArray(value);
    assert.ok(ok, `attribute value not OTel-safe: ${JSON.stringify(value)}`);
  }
});
