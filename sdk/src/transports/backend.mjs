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
 * backoff and re-hydrates on every (re)connect. A browser cannot set handshake
 * headers on a WebSocket, so the bearer token (a static `token` or the same
 * `getToken` the HTTP sender uses) rides as an `access_token` query param,
 * resolved fresh on each (re)connect so a refreshed token is picked up.
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {import("../client.mjs").SyncClient} opts.sync
 * @param {string} [opts.wsPath]
 * @param {string} [opts.token]  static bearer token, appended as ?access_token=
 * @param {() => (string|Promise<string>)} [opts.getToken]  resolved per (re)connect; wins over token
 * @param {() => Promise<void>} [opts.onReconnect]  e.g. re-hydrate
 * @param {(status: string) => void} [opts.onStatus]
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 * @returns {{ stop(): void }}
 */
export function startBackendStream({
  baseUrl,
  sync,
  wsPath = "/ws",
  token,
  getToken,
  onReconnect,
  onStatus,
  WebSocketImpl = globalThis.WebSocket,
}) {
  const url = baseUrl.replace(/^http/, "ws").replace(/\/+$/, "") + wsPath;
  let stopped = false;
  let attempt = 0;
  /** @type {WebSocket|undefined} */
  let ws;

  const authedUrl = async () => {
    const t = getToken ? await getToken() : token;
    if (!t) return url;
    return `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(t)}`;
  };

  const connect = async () => {
    if (stopped) return;
    const target = await authedUrl();
    if (stopped) return;
    ws = new WebSocketImpl(target);
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
  void connect();

  return {
    stop() {
      stopped = true;
      ws?.close();
    },
  };
}
