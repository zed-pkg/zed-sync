// Backend transport: a WebSocket read stream (with auto-reconnect) that decodes
// { event: "zed:sync", changes: [...] } frames, plus an idempotent HTTP write
// path used as the SyncClient's `send`. Dependency-free (global fetch/WebSocket).

import { decodeBackendFrame } from "./decode.mjs";

/**
 * HTTP write sender for SyncClient.send. POSTs to /api/sync/<table> with an
 * Idempotency-Key so retries are safe; expects { committed_version }.
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {() => (string|Promise<string>)} [opts.getToken]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {(change: object) => Promise<{ committed_version: object }>}
 */
export function makeBackendSender({ baseUrl, getToken, fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/+$/, "");
  return async (change) => {
    /** @type {Record<string,string>} */
    const headers = { "content-type": "application/json", "idempotency-key": change.write_key };
    if (getToken) headers.authorization = `Bearer ${await getToken()}`;
    const res = await fetchImpl(`${base}/api/sync/${change.table}`, {
      method: "POST",
      headers,
      body: JSON.stringify(change),
    });
    if (!res.ok) throw new Error(`backend write failed: ${res.status}`);
    return res.json();
  };
}

/**
 * Open the backend sync WS and feed frames into the client. Reconnects with
 * backoff and re-hydrates on every (re)connect.
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {import("../client.mjs").SyncClient} opts.sync
 * @param {string} [opts.wsPath]
 * @param {() => Promise<void>} [opts.onReconnect]  e.g. re-hydrate
 * @param {(status: string) => void} [opts.onStatus]
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 * @returns {{ stop(): void }}
 */
export function startBackendStream({
  baseUrl,
  sync,
  wsPath = "/ws",
  onReconnect,
  onStatus,
  WebSocketImpl = globalThis.WebSocket,
}) {
  const url = baseUrl.replace(/^http/, "ws").replace(/\/+$/, "") + wsPath;
  let stopped = false;
  let attempt = 0;
  /** @type {WebSocket|undefined} */
  let ws;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocketImpl(url);
    ws.onopen = () => {
      attempt = 0;
      onStatus?.("open");
      void onReconnect?.();
    };
    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      for (const change of decodeBackendFrame(frame)) void sync.applyChange(change);
    };
    ws.onclose = () => {
      onStatus?.("closed");
      if (stopped) return;
      const delay = Math.min(30_000, 500 * 2 ** attempt++);
      setTimeout(connect, delay);
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return {
    stop() {
      stopped = true;
      ws?.close();
    },
  };
}
