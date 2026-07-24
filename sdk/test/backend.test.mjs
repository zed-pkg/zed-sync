// The backend WS read stream: optional bearer-token auth on the handshake URL
// (browsers cannot set WS headers, so the token rides as ?access_token=), plus
// no-auth parity. Frame decoding is covered separately in decode.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { startBackendStream, makeBackendSender } from "../src/transports/backend.mjs";

/** A minimal fake WebSocket that records the URL it was opened with. */
function fakeWs(urls) {
  return class FakeWebSocket {
    constructor(url) {
      urls.push(url);
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
    }
    close() {}
  };
}

const sync = { applyChange: async () => {} };
// connect() resolves the token before opening the socket; let a macrotask flush
// the pending microtasks so the URL has been recorded.
const flush = () => new Promise((r) => setTimeout(r, 0));

test("opens ws:// with no query when no token is given", async () => {
  const urls = [];
  const stream = startBackendStream({
    baseUrl: "https://api.example.com/",
    sync,
    WebSocketImpl: fakeWs(urls),
  });
  await flush();
  stream.stop();
  assert.deepEqual(urls, ["wss://api.example.com/ws"]);
});

test("appends a static token as ?access_token (url-encoded)", async () => {
  const urls = [];
  const stream = startBackendStream({
    baseUrl: "https://api.example.com",
    sync,
    token: "secret/123",
    WebSocketImpl: fakeWs(urls),
  });
  await flush();
  stream.stop();
  assert.deepEqual(urls, ["wss://api.example.com/ws?access_token=secret%2F123"]);
});

test("resolves an async getToken per connect", async () => {
  const urls = [];
  const stream = startBackendStream({
    baseUrl: "https://api.example.com",
    sync,
    getToken: async () => "tok-async",
    WebSocketImpl: fakeWs(urls),
  });
  await flush();
  stream.stop();
  assert.deepEqual(urls, ["wss://api.example.com/ws?access_token=tok-async"]);
});

test("makeBackendSender url-encodes the table name in the write path", async () => {
  const calls = [];
  const send = makeBackendSender({
    baseUrl: "https://api.example.com/",
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ committed_version: {} }) };
    },
  });
  await send({ table: "weird/table name", id: "1", write_key: "k1", version: {} });
  assert.equal(calls[0], "https://api.example.com/api/sync/weird%2Ftable%20name");
});
