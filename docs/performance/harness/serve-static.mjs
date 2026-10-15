// Serves a local `expo export --platform web` build with the same SPA rewrite as production (render.yaml: /* -> /index.html)
// and the production cache headers observed on 2026-10-15 (`cache-control: public, max-age=0, s-maxage=300`).
// Usage: node serve-static.mjs <dist-dir> [port=8199]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 8199);
const TYPES = { ".js": "application/javascript", ".html": "text/html; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".ttf": "font/ttf", ".css": "text/css", ".ico": "image/x-icon", ".svg": "image/svg+xml" };

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = path.join(root, urlPath);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    const body = fs.readFileSync(file);
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    const headers = { "content-type": type, "cache-control": "public, max-age=0, s-maxage=300" };
    if (/javascript|html|json|css/.test(type) && /gzip/.test(String(req.headers["accept-encoding"] ?? ""))) {
      res.writeHead(200, { ...headers, "content-encoding": "gzip" });
      res.end(zlib.gzipSync(body));
    } else {
      res.writeHead(200, headers);
      res.end(body);
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
