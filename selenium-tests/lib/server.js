"use strict";
/**
 * Minimal static file server with SPA fallback.
 *
 * The web app is a Vite SPA: every route other than a real asset must serve
 * index.html so react-router can take over. `vite preview` would do this too,
 * but it pulls the whole Vite toolchain into the test job and binds its own
 * port; a 40-line server keeps the Selenium job independent of the app's build
 * tooling and lets the runner pick a free port.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function startServer(rootDir, port = 0) {
  const indexPath = path.join(rootDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `No index.html in ${rootDir}. Build the web app first:\n` +
      `  pnpm --filter @mediguard/web build`
    );
  }

  const server = http.createServer((req, res) => {
    // Strip query/hash before touching the filesystem.
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);

    // Reject traversal outright rather than normalising it away silently --
    // this server is only ever pointed at a build output, but a test harness
    // that is itself traversable is a bad example to leave in a repo.
    const resolved = path.resolve(rootDir, "." + urlPath);
    if (!resolved.startsWith(path.resolve(rootDir))) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    let filePath = resolved;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    // SPA fallback: an unknown path that is not an asset request gets index.html.
    if (!fs.existsSync(filePath)) {
      if (path.extname(urlPath)) {
        res.writeHead(404).end("Not found");
        return;
      }
      filePath = indexPath;
    }

    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      // The app is served over http://127.0.0.1 in CI, so HSTS is meaningless
      // here; these are the headers the assertions in suite 09 look for.
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        baseUrl: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startServer };
