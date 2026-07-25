// Proves the wasm build of the Rust core and the pure-JS mirror (core.mjs)
// produce IDENTICAL results across the shared protocol/conformance.json — so
// swapping loadWasmCore() in for the JS mirror can never change behavior, and
// the two implementations can never silently drift.
//
// Skips cleanly when sdk/pkg is not built (e.g. a plain `npm test` on a machine
// without the wasm toolchain). CI builds the wasm first (see build-wasm.sh /
// the `wasm` CI job), so this runs there.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reconcile as jsReconcile, onAck as jsOnAck, isOwnEcho as jsIsOwnEcho } from "../src/core.mjs";

const pkgPath = fileURLToPath(new URL("../pkg/zed_sync_core.js", import.meta.url));
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../protocol/conformance.json", import.meta.url)), "utf8"),
);

test("wasm core matches the JS mirror on every conformance case", { skip: !existsSync(pkgPath) && "sdk/pkg not built (run sdk/build-wasm.sh)" }, async () => {
  const wasm = await import(pkgPath);
  // The --target web build fetches its .wasm by URL, which Node can't do for a
  // file:// path — so hand the bytes to the initializer directly. (Browsers use
  // the default fetch path via loadWasmCore().)
  if (wasm.default) {
    const bytes = readFileSync(fileURLToPath(new URL("../pkg/zed_sync_core_bg.wasm", import.meta.url)));
    try {
      await wasm.default({ module_or_path: bytes });
    } catch {
      await wasm.default(bytes);
    }
  }

  const wReconcile = (local, incoming) =>
    JSON.parse(wasm.reconcile(local == null ? undefined : JSON.stringify(local), JSON.stringify(incoming)));
  const wOnAck = (local, ack) => JSON.parse(wasm.on_ack(JSON.stringify(local), JSON.stringify(ack)));
  const wIsOwnEcho = (queued, incoming) => wasm.is_own_echo(JSON.stringify(queued), JSON.stringify(incoming));

  for (const c of fixture.reconcile) {
    const w = wReconcile(c.local, c.incoming);
    assert.deepEqual(w, jsReconcile(c.local, c.incoming), `reconcile ${c.name}: wasm vs js`);
    assert.deepEqual(w, c.expected, `reconcile ${c.name}: wasm vs fixture`);
  }
  for (const c of fixture.echoes) {
    const w = wIsOwnEcho(c.queued, c.incoming);
    assert.equal(w, jsIsOwnEcho(c.queued, c.incoming), `echo ${c.name}: wasm vs js`);
    assert.equal(w, c.expected, `echo ${c.name}: wasm vs fixture`);
  }
  for (const c of fixture.acks) {
    const w = wOnAck(c.local, c.ack);
    assert.deepEqual(w, jsOnAck(c.local, c.ack), `ack ${c.name}: wasm vs js`);
    assert.deepEqual(w, c.expected, `ack ${c.name}: wasm vs fixture`);
  }
});
