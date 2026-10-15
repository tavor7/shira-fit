// Latency-modelling HTTPS proxy in front of the ISOLATED local perf stack (docs/performance/README.md).
//
// Production (2026-10-14/15, measured): users in Israel, Supabase in ap-south-1; edge→origin p50 ≈ 180-215 ms per request while
// PostgREST itself answers in ~5 ms. Locally every request returns in a few ms, which hides exactly the cost we need to measure.
// This proxy adds a fixed delay per request and serves HTTP/2 (like production, so the browser is not capped at 6 parallel
// HTTP/1.1 connections), gzips JSON (production compresses responses), and passes WebSockets (Realtime) through untouched.
//
// Usage: PERF_TARGET=http://127.0.0.1:57421 PERF_PROXY_PORT=57499 PERF_LATENCY_MS=190 \
//        PERF_TLS_KEY=key.pem PERF_TLS_CERT=cert.pem node latency-proxy.mjs
// Refuses non-localhost targets.

import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import fs from "node:fs";
import zlib from "node:zlib";

const target = new URL(process.env.PERF_TARGET ?? "http://127.0.0.1:57421");
const port = Number(process.env.PERF_PROXY_PORT ?? 57499);
const latencyMs = Number(process.env.PERF_LATENCY_MS ?? 190);
/** Production answers CORS preflights at the Cloudflare edge (origin time ≈ 0); only the client→edge leg remains. */
const preflightMs = Number(process.env.PERF_PREFLIGHT_MS ?? 20);

if (!["127.0.0.1", "localhost"].includes(target.hostname)) {
  console.error(`Refusing to proxy to non-local target ${target.href}`);
  process.exit(2);
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"]);
let count = 0;

const server = http2.createSecureServer({
  key: fs.readFileSync(process.env.PERF_TLS_KEY ?? "key.pem"),
  cert: fs.readFileSync(process.env.PERF_TLS_CERT ?? "cert.pem"),
  allowHTTP1: true,
});

// One aborted request (a browser closing a page mid-request) must never take the proxy down.
process.on("uncaughtException", (e) => console.error("proxy error (continuing):", e?.code ?? e?.message ?? e));
process.on("unhandledRejection", (e) => console.error("proxy rejection (continuing):", e?.code ?? e?.message ?? e));

server.on("request", (req, res) => {
  handle(req, res).catch(() => {
    try {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    } catch {
      /* client already gone */
    }
  });
});

async function handle(req, res) {
  count += 1;
  req.on("error", () => {});
  res.on("error", () => {});
  const chunks = [];
  for await (const c of req) chunks.push(c);
  await sleep(req.method === "OPTIONS" ? preflightMs : latencyMs);
  if (res.destroyed || res.closed) return;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(":") && !HOP.has(k)) headers[k] = v;
  headers["accept-encoding"] = "identity";
  headers.host = target.host;

  const up = http.request(
    { host: target.hostname, port: target.port, method: req.method, path: req.url, headers, agent },
    (upRes) => {
      const out = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k) && k !== "content-length") out[k] = v;
      const type = String(upRes.headers["content-type"] ?? "");
      const gzip = /gzip/.test(String(req.headers["accept-encoding"] ?? "")) && /json|text/.test(type);
      if (gzip) out["content-encoding"] = "gzip";
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.on("error", () => res.destroy());
      (gzip ? upRes.pipe(zlib.createGzip()) : upRes).pipe(res);
    }
  );
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(String(e.message));
  });
  up.end(Buffer.concat(chunks));
}

// WebSocket (Realtime): raw TCP pass-through after one latency delay, like the connection setup to production.
server.on("upgrade", async (req, socket, head) => {
  await sleep(latencyMs);
  const upstream = net.connect(Number(target.port), target.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      lines.push(`${k}: ${k.toLowerCase() === "host" ? target.host : req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(port, "127.0.0.1", () => {
  console.log(`latency proxy https://127.0.0.1:${port} -> ${target.href} (+${latencyMs} ms per request, ${preflightMs} ms per preflight)`);
});
process.on("SIGTERM", () => {
  console.log(`requests proxied: ${count}`);
  process.exit(0);
});
