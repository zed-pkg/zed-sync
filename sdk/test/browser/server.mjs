// A tiny static file server used only by the browser tests. It serves the repo
// root over HTTP so a real browser can `import` the build-free ESM SDK by URL
// (`/sdk/src/client.mjs` and its relative imports resolve same-origin), which
// `file://` and `data:` cannot do. `/` returns a blank same-origin document so
// the page has an origin (IndexedDB requires one). No dependencies.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = normalize(join(fileURLToPath(new URL(".", import.meta.url)), "../../.."));

const MIME = {
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

/** Start the server. @returns {Promise<{ origin: string, close: () => Promise<void> }>} */
export function startStaticServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><meta charset=utf-8><title>zed-sync browser test</title>");
        return;
      }
      // Resolve under REPO_ROOT and refuse anything that escapes it.
      const path = normalize(join(REPO_ROOT, decodeURIComponent(url.pathname)));
      if (!path.startsWith(REPO_ROOT)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile(path);
      res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
  });
}
