import test from "node:test";
import assert from "node:assert/strict";
import { decodeBackendFrame, decodeSupabaseChange } from "../src/transports/decode.mjs";
import { makeOtelTelemetry, combineTelemetry } from "../src/telemetry.mjs";

test("backend frame decodes zed:sync changes and ignores others", () => {
  const frame = {
    event: "zed:sync",
    changes: [
      { table: "products", op: "upsert", id: "p1", version: { wall_ms: 1, counter: 0, actor: "srv" }, row: {}, at_ms: 1 },
      { table: "x", op: "upsert", id: "y", at_ms: 1 }, // no version -> dropped
    ],
  };
  assert.equal(decodeBackendFrame(frame).length, 1);
  assert.deepEqual(decodeBackendFrame({ event: "other" }), []);
  assert.deepEqual(decodeBackendFrame(null), []);
});

test("supabase delete without a usable version is dropped, not fabricated", () => {
  const insert = decodeSupabaseChange({
    table: "products", eventType: "INSERT",
    new: { id: "p1", sync_version: { wall_ms: 10, counter: 0, actor: "pg" }, updated_at: "2026-07-24T00:00:00Z" },
  });
  assert.equal(insert.op, "upsert");
  assert.equal(insert.version.wall_ms, 10);

  const badDelete = decodeSupabaseChange({ table: "products", eventType: "DELETE", old: { id: "p1" } });
  assert.equal(badDelete, null, "no version -> null, never version 0");
});

test("otel telemetry adapter records counters and spans without importing otel", () => {
  const spans = [];
  const counts = [];
  const tracer = { startSpan: (name, o) => ({ setStatus() {}, recordException() {}, end: () => spans.push({ name, o }) }) };
  const meter = { createCounter: (name) => ({ add: (n, attrs) => counts.push({ name, n, attrs }) }) };
  const otel = makeOtelTelemetry({ tracer, meter });
  const sink = combineTelemetry(otel);
  sink.event("sync.write.start", { table: "p", id: "1" });
  sink.event("sync.write.failed", { table: "p", id: "1", error: new Error("x") });
  assert.equal(spans.length, 2);
  assert.ok(counts.some((c) => c.name === "zed_sync_events_total"));
  assert.ok(counts.some((c) => c.name === "zed_sync_errors_total"));
});
