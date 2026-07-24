// resolveConflict — the one core decision not covered by the shared
// conformance fixture (the Dart port has no resolveConflict yet). reconcile /
// onAck / isOwnEcho are pinned cross-language in conformance.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveConflict } from "../src/core.mjs";
import { ConflictResolution } from "../src/policy.mjs";

const at = (wall) => ({ version: { wall_ms: wall, counter: 0, actor: "dev" }, dirty: true });
const change = (wall) => ({
  table: "t", op: "upsert", id: "1",
  version: { wall_ms: wall, counter: 0, actor: "srv" }, row: { id: "1" }, at_ms: wall,
});

test("server_wins always adopts the incoming change, even an older one", () => {
  assert.equal(resolveConflict(ConflictResolution.SERVER_WINS, at(100), change(200)), true);
  assert.equal(resolveConflict(ConflictResolution.SERVER_WINS, at(200), change(100)), true);
});

test("last_write_wins adopts only a strictly higher HLC", () => {
  assert.equal(resolveConflict(ConflictResolution.LAST_WRITE_WINS, at(100), change(200)), true);
  assert.equal(resolveConflict(ConflictResolution.LAST_WRITE_WINS, at(200), change(100)), false);
});

test("last_write_wins keeps the local write on an equal version (no self-clobber)", () => {
  const local = { version: { wall_ms: 100, counter: 0, actor: "srv" }, dirty: true };
  assert.equal(resolveConflict(ConflictResolution.LAST_WRITE_WINS, local, change(100)), false);
});
