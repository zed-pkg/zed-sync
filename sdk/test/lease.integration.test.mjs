// Integration tests for SyncLease against a REAL fiducia-node and the REAL
// @fiducia/client FiduciaLockClient. Self-skipping: runs only when both env
// vars are set (see zed-sync/docs/leases.md):
//
//   FIDUCIA_URL         e.g. http://localhost:18095
//   FIDUCIA_LOCKING_TS  absolute path to fiducia-clients/clients/ts/locking.ts
//   FIDUCIA_INTERNAL_SECRET  optional; sent as x-fiducia-internal-auth
//
// Boot a node with fiducia-clients/conformance/run-node.sh (or the prebuilt
// binary) and run:
//   FIDUCIA_URL=... FIDUCIA_LOCKING_TS=... node --test \
//     --experimental-strip-types test/lease.integration.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { SyncLease, withSyncLease } from "../src/lease.mjs";

const FIDUCIA_URL = process.env.FIDUCIA_URL;
const LOCKING_TS = process.env.FIDUCIA_LOCKING_TS;
const SECRET = process.env.FIDUCIA_INTERNAL_SECRET;
const enabled = Boolean(FIDUCIA_URL && LOCKING_TS);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Unique keyspace per run so reruns against a warm node never collide. */
const RUN = `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const key = (name) => `zed-sync-integration/${RUN}/${name}`;

async function makeLockClient() {
  const { FiduciaLockClient } = await import(pathToFileURL(LOCKING_TS).href);
  // Direct-to-node auth is a fetch-wrapper concern by design (no bearer
  // option in the client): attach the internal-auth + org headers here.
  const authedFetch = (input, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (SECRET) headers.set("x-fiducia-internal-auth", SECRET);
    headers.set("x-fiducia-org-id", "zed-sync-integration");
    return fetch(input, { ...init, headers });
  };
  return new FiduciaLockClient(FIDUCIA_URL, { fetch: authedFetch });
}

test("fiducia integration: mutual exclusion and fencing-token monotonicity", { skip: !enabled }, async () => {
  const client = await makeLockClient();
  const K = key("mutex");
  const a = new SyncLease({ client, key: K, ttlMs: 10_000, renewIntervalMs: 3_000 });
  const b = new SyncLease({ client, key: K, ttlMs: 10_000, renewIntervalMs: 3_000 });

  await a.acquire({ maxWaitMs: 10_000 });
  assert.equal(a.held, true);
  const tokenA = a.fencingToken;
  assert.ok(Number.isSafeInteger(tokenA) && tokenA > 0);

  assert.equal(await b.tryAcquire(), false, "second holder must not get the lease");

  await a.release();
  await b.acquire({ maxWaitMs: 15_000 });
  assert.equal(b.held, true);
  assert.ok(b.fencingToken > tokenA, `token must advance: ${tokenA} -> ${b.fencingToken}`);
  await b.release();
});

test("fiducia integration: heartbeat keeps the lease alive past its TTL", { skip: !enabled }, async () => {
  const client = await makeLockClient();
  const lease = new SyncLease({ client, key: key("heartbeat"), ttlMs: 2_000, renewIntervalMs: 600 });
  await lease.acquire({ maxWaitMs: 10_000 });
  const token = lease.fencingToken;

  await sleep(3_500); // > TTL: only renewals keep it
  assert.equal(lease.held, true, "renewals must outlive the original TTL");
  assert.equal(lease.fencingToken, token, "renewal preserves the fencing token");

  const contender = new SyncLease({ client, key: key("heartbeat"), ttlMs: 2_000, renewIntervalMs: 600 });
  assert.equal(await contender.tryAcquire(), false, "held lease must still exclude others");
  await lease.release();
});

test("fiducia integration: crashed holder is superseded after TTL, token advances", { skip: !enabled }, async () => {
  const client = await makeLockClient();
  const K = key("takeover");
  const crasher = new SyncLease({ client, key: K, ttlMs: 2_000, renewIntervalMs: 600 });
  await crasher.acquire({ maxWaitMs: 10_000 });
  const crashedToken = crasher.fencingToken;
  // Simulate a crash: stop heartbeating WITHOUT releasing. The server-side
  // lease TTL is now the only way this lock frees up.
  crasher._stopHeartbeat();

  const successor = new SyncLease({ client, key: K, ttlMs: 5_000, renewIntervalMs: 1_500 });
  const started = Date.now();
  await successor.acquire({ maxWaitMs: 20_000 });
  const waited = Date.now() - started;

  assert.equal(successor.held, true);
  assert.ok(successor.fencingToken > crashedToken,
    `successor token must fence out the crashed holder: ${crashedToken} -> ${successor.fencingToken}`);
  assert.ok(waited >= 500, `takeover should wait for lease expiry, waited ${waited}ms`);
  await successor.release();
});

test("fiducia integration: withSyncLease releases so a follower can proceed", { skip: !enabled }, async () => {
  const client = await makeLockClient();
  const K = key("with");
  let observedToken = null;
  await withSyncLease(
    { client, key: K, ttlMs: 10_000, renewIntervalMs: 3_000, maxWaitMs: 10_000 },
    (lease) => {
      observedToken = lease.fencingToken;
    },
  );
  assert.ok(observedToken > 0);

  const follower = new SyncLease({ client, key: K, ttlMs: 10_000, renewIntervalMs: 3_000 });
  assert.equal(await follower.tryAcquire(), true, "released lease must be immediately free");
  assert.ok(follower.fencingToken > observedToken);
  await follower.release();
});
