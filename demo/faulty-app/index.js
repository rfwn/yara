// A tiny shop for recording Yara's demo. It behaves normally until a fault is switched on:
//   POST /__fault?token=$FAULT_TOKEN&mode=leak|error|slow|ok
// leak:  holds memory until close to LEAK_MB, then answers 503 and logs heap-out-of-memory lines.
//        A restart clears it (the leak lives in memory), so Yara's restart + verification works.
// error: every page fails with 500 and a missing-module stack trace. A restart does NOT fix it,
//        so Yara refuses to auto-restart and routes it to the debug agent instead.
// slow:  every page burns ~2.5 s of CPU before answering.
const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.FAULT_TOKEN || "";
const LEAK_MB = Number(process.env.LEAK_MB || 400);
let mode = "ok";
const leak = [];
let leakTimer = null;

function startLeak() {
  if (leakTimer) return;
  leakTimer = setInterval(() => {
    const usedMb = process.memoryUsage().rss / 1024 / 1024;
    if (usedMb < LEAK_MB) leak.push(Buffer.alloc(16 * 1024 * 1024, 1));
    else console.error(`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory (rss ${Math.round(usedMb)} MB)`);
  }, 300);
}

function burn(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) Math.sqrt(Math.random());
}

const page = (title) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;padding:40px"><h1>${title}</h1><p>Yara demo shop.</p></body>`;

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__fault" && req.method === "POST") {
      if (!TOKEN || url.searchParams.get("token") !== TOKEN) return res.writeHead(403).end("forbidden");
      mode = url.searchParams.get("mode") || "ok";
      console.log(`[demo] fault mode → ${mode}`);
      if (mode === "leak") startLeak();
      return res.writeHead(200).end(`mode=${mode}`);
    }
    if (mode === "error") {
      console.error("Error: Cannot find module './config/database'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)\n    at require (node:internal/modules/helpers:177:18)\n    at Object.<anonymous> (/app/routes/products.js:3:12)");
      return res.writeHead(500, { "Content-Type": "text/plain" }).end("Internal Server Error");
    }
    if (mode === "leak" && process.memoryUsage().rss / 1024 / 1024 >= LEAK_MB * 0.95) {
      return res.writeHead(503, { "Content-Type": "text/plain" }).end("Service Unavailable");
    }
    if (mode === "slow") burn(2500);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Demo Shop"));
  })
  .listen(PORT, "0.0.0.0", () => console.log(`[demo] listening on 0.0.0.0:${PORT}`));
