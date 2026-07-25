// E2E: single-flusher fencing (docs/leases.md, zed_sync.assert_fence). A write
// carries the holder's fencing token as request headers; the server rejects a
// token older than the highest it has seen (SQLSTATE ZSF01 -> HTTP 412), so a
// superseded/partitioned flusher can never write behind a newer one.

import test from "node:test";
import assert from "node:assert/strict";
import { SimServer, Hub, connectReplica, FenceRejected } from "./e2e_harness.mjs";
import { WriteMode, ErrorPolicy } from "../src/policy.mjs";

const TABLES = ["ledger"];
const LEASE = "zed-sync/flusher/appdb/dev";

test("a superseded flusher's write is fenced off (412), the newer holder's is accepted", async () => {
  const hub = new Hub(new SimServer());
  // Two grants for the same lease; token 2 supersedes token 1.
  const grant = { token: 1 };
  const old = connectReplica(hub, {
    actor: "flusher-old",
    tables: TABLES,
    writeMode: WriteMode.OPTIMISTIC_AWAIT_ACK,
    errorPolicy: ErrorPolicy.THROW_ONLY,
    getFence: () => ({ key: LEASE, token: grant.token }),
  });
  await hub.settle();

  // Holder with token 1 writes fine; the fence registry advances to 1.
  await old.client.write("ledger", "l1", { id: "l1", n: 1 });
  await hub.settle();
  assert.equal(hub.server.fence.get(LEASE), 1);

  // A newer holder (token 2) writes; the registry advances to 2.
  const fresh = connectReplica(hub, {
    actor: "flusher-new",
    tables: TABLES,
    writeMode: WriteMode.OPTIMISTIC_AWAIT_ACK,
    errorPolicy: ErrorPolicy.THROW_ONLY,
    getFence: () => ({ key: LEASE, token: 2 }),
  });
  await hub.settle();
  await fresh.client.write("ledger", "l1", { id: "l1", n: 2 });
  await hub.settle();
  assert.equal(hub.server.fence.get(LEASE), 2);

  // Now the OLD holder (still token 1) tries to write — it must be rejected.
  const outboxBefore = hub.server.outbox.length;
  await assert.rejects(
    () => old.client.write("ledger", "l1", { id: "l1", n: 99 }),
    /backend write failed: 412/,
  );
  assert.equal(hub.server.outbox.length, outboxBefore, "the fenced write never reached the outbox");
  assert.equal(hub.server.fence.get(LEASE), 2, "fence token did not regress");
  old.stop();
  fresh.stop();
});

test("assert_fence at the server boundary: same-or-higher accepted, lower rejected, token monotonic", () => {
  const server = new SimServer();
  server.assertFence(LEASE, 5); // first grant
  assert.equal(server.fence.get(LEASE), 5);
  server.assertFence(LEASE, 5); // renewal keeps the token
  server.assertFence(LEASE, 7); // newer grant advances it
  assert.equal(server.fence.get(LEASE), 7);
  assert.throws(() => server.assertFence(LEASE, 6), FenceRejected, "a lower token is rejected");
  assert.equal(server.fence.get(LEASE), 7, "rejected token never lowers the registry");
});

test("a fenced-off write stays queued so a re-elected holder can flush it under a fresh token", async () => {
  const hub = new Hub(new SimServer());
  let token = 1;
  const flusher = connectReplica(hub, {
    actor: "flusher",
    tables: TABLES,
    // default optimistic_queue + emit_only: a rejected send leaves it queued.
    getFence: () => ({ key: LEASE, token }),
  });
  await hub.settle();

  // Someone else took token 2 in the meantime.
  hub.server.assertFence(LEASE, 2);

  // This holder (token 1) writes; the send is fenced (412) but the row is queued.
  const res = await flusher.client.write("ledger", "l1", { id: "l1", n: 1 });
  assert.equal(res.status, "queued");
  assert.equal((await flusher.store.pending()).length, 1);
  assert.equal(hub.server.outbox.length, 0);

  // The app re-elects this instance with a fresh, higher token; flush now lands.
  token = 3;
  await flusher.client.flushQueue(ErrorPolicy.EMIT_ONLY);
  await hub.settle();
  assert.equal(hub.server.outbox.length, 1, "flushed under the newer token");
  assert.equal(hub.server.fence.get(LEASE), 3);
  assert.equal((await flusher.store.pending()).length, 0);
  flusher.stop();
});
