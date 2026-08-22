// E2E: the shared protocol JSON Schemas are the single source of truth for the
// wire (goal #3). Every ChangeEvent both transports emit during a realistic sync
// session must validate against change-event.schema.json; every shared
// conformance `incoming` must validate; and the JS policy enums must match
// write-policy.schema.json exactly. Malformed envelopes are rejected, proving
// the schema (and the validator) actually constrain the wire.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate, isValid } from "./schema_validate.mjs";
import { SimServer, Hub, connectReplica } from "./e2e_harness.mjs";
import { decodeSupabaseChange, decodeBackendFrame } from "../src/transports/decode.mjs";
import { WriteMode, ErrorPolicy, ConflictResolution } from "../src/policy.mjs";

const protoDir = fileURLToPath(new URL("../../protocol/", import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(protoDir + name, "utf8"));
const CHANGE_EVENT = readJson("change-event.schema.json");
const WRITE_POLICY = readJson("write-policy.schema.json");
const CONFORMANCE = readJson("conformance.json");
const FORMAL_LIFECYCLE_SCHEMA = readJson("formal-write-lifecycle.schema.json");
const FORMAL_LIFECYCLE = readJson("formal-write-lifecycle.json");

/** The JSON wire form (drops undefined props, exactly what a transport sends). */
const wire = (v) => JSON.parse(JSON.stringify(v));

test("every change event from a real session validates against change-event.schema.json (both transports)", async () => {
  const hub = new Hub(new SimServer());
  const a = connectReplica(hub, { actor: "dev-A", tables: ["products"] });
  await hub.settle();

  await a.client.write("products", "p1", { id: "p1", name: "Ball", specs: { size: "L" } });
  await a.client.write("products", "p1", { id: "p1", name: "Ball", specs: { size: "M" } });
  await a.client.delete("products", "p1");
  await hub.settle();

  assert.equal(hub.server.outbox.length, 3);
  for (const entry of hub.server.outbox) {
    // Backend transport form (decoded from the frame it actually puts on the wire).
    const frame = wire({ event: "zed:sync", changes: [hub.server.toChangeEvent(entry)] });
    const [backendChange] = decodeBackendFrame(frame);
    assert.deepEqual(validate(CHANGE_EVENT, wire(backendChange)), [], `backend ${entry.op} valid`);

    // Supabase realtime form (decoded from the postgres_changes payload).
    const supaChange = decodeSupabaseChange(wire(hub.server.toSupabasePayload(entry)));
    if (supaChange) {
      assert.deepEqual(validate(CHANGE_EVENT, wire(supaChange)), [], `supabase ${entry.op} valid`);
    }
  }
  a.stop();
});

test("every shared conformance `incoming` validates against change-event.schema.json", () => {
  const incomings = [
    ...CONFORMANCE.reconcile.map((c) => c.incoming),
    ...(CONFORMANCE.echoes ?? []).map((c) => c.incoming),
  ].filter(Boolean);
  assert.ok(incomings.length >= 8, "found conformance change events to validate");
  for (const inc of incomings) {
    assert.deepEqual(validate(CHANGE_EVENT, wire(inc)), [], `conformance "${JSON.stringify(inc.id)}" valid`);
  }
});

test("JS policy enums are exactly the write-policy.schema.json enums (shared source of truth)", () => {
  assert.deepEqual(Object.values(WriteMode).sort(), [...WRITE_POLICY.$defs.WriteMode.enum].sort());
  assert.deepEqual(Object.values(ErrorPolicy).sort(), [...WRITE_POLICY.$defs.ErrorPolicy.enum].sort());
  assert.deepEqual(
    Object.values(ConflictResolution).sort(),
    [...WRITE_POLICY.$defs.ConflictResolution.enum].sort(),
  );
  // The documented defaults line up with the client's actual defaults.
  assert.equal(WRITE_POLICY.$defs.WriteMode.default, WriteMode.OPTIMISTIC_QUEUE);
  assert.equal(WRITE_POLICY.$defs.ErrorPolicy.default, ErrorPolicy.EMIT_ONLY);
  assert.equal(WRITE_POLICY.$defs.ConflictResolution.default, ConflictResolution.SERVER_WINS);
});

test("malformed change events are REJECTED (the schema genuinely constrains the wire)", () => {
  const good = {
    table: "products",
    op: "upsert",
    id: "p1",
    version: { wall_ms: 1000, counter: 0, actor: "pg" },
    row: { id: "p1" },
    at_ms: 1000,
  };
  assert.ok(isValid(CHANGE_EVENT, good), "baseline is valid");

  const bad = [
    ["unknown op", { ...good, op: "patch" }],
    ["missing version", { table: "products", op: "upsert", id: "p1", at_ms: 1000 }],
    ["bad table pattern (uppercase)", { ...good, table: "Products" }],
    ["extra property", { ...good, injected: true }],
    ["counter over max", { ...good, version: { wall_ms: 1000, counter: 4294967296, actor: "pg" } }],
    ["hlc missing actor", { ...good, version: { wall_ms: 1000, counter: 0 } }],
    ["non-integer at_ms", { ...good, at_ms: 10.5 }],
    ["empty id", { ...good, id: "" }],
  ];
  for (const [label, payload] of bad) {
    assert.equal(isValid(CHANGE_EVENT, payload), false, `rejected: ${label}`);
  }
});

test("the validator itself is sound on the Hlc $ref and type arrays", () => {
  const HLC = CHANGE_EVENT.$defs.Hlc;
  assert.ok(isValid(HLC, { wall_ms: 1, counter: 0, actor: "x" }));
  assert.equal(isValid(HLC, { wall_ms: -1, counter: 0, actor: "x" }), false, "minimum enforced");
  assert.equal(isValid(HLC, { wall_ms: 1, counter: 0, actor: "" }), false, "minLength enforced");
  // row: type ["object","null"] accepts both, rejects a string.
  const rowSchema = CHANGE_EVENT.properties.row;
  assert.ok(isValid(rowSchema, {}) && isValid(rowSchema, null));
  assert.equal(isValid(rowSchema, "nope"), false);
});

test("formal lifecycle traces satisfy their canonical JSON Schema", () => {
  assert.deepEqual(validate(FORMAL_LIFECYCLE_SCHEMA, FORMAL_LIFECYCLE), []);

  const malformedAction = structuredClone(FORMAL_LIFECYCLE);
  malformedAction.cases[0].actions[0] = "guess";
  assert.equal(isValid(FORMAL_LIFECYCLE_SCHEMA, malformedAction), false, "action enum enforced in array items");

  const malformedQueue = structuredClone(FORMAL_LIFECYCLE);
  delete malformedQueue.cases[1].current.queued.key;
  assert.equal(isValid(FORMAL_LIFECYCLE_SCHEMA, malformedQueue), false, "nested required key enforced");
});
