#!/usr/bin/env node
// Yara local runner: lets Yara's agents read, build, edit and deploy a project folder on
// this machine. Every command and file write is printed here as it happens.
//
//   npx yara-runner --server http://localhost:3001 --token yr_… [--dir .] [--name laptop] [--read-only]
//
// Get the token from Yara → Settings → Local runner.
import os from "node:os";
import path from "node:path";
import * as fsops from "./fsops.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const server = String(args.server || process.env.YARA_SERVER || "http://localhost:3001").replace(/\/$/, "");
const token = args.token || process.env.YARA_RUNNER_TOKEN;
const root = path.resolve(String(args.dir || "."));
const name = String(args.name || os.hostname());
const readOnly = !!args["read-only"];

if (!token) {
  console.error("Missing --token. Create one in Yara → Settings → Local runner.");
  process.exit(1);
}

const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const log = (tag, msg) => console.log(`${dim(new Date().toLocaleTimeString())} ${tag} ${msg}`);

const handlers = {
  list: ({ dir, depth }) => fsops.list(root, dir, depth),
  read: ({ file, from, to }) => fsops.read(root, file, from, to),
  readRaw: ({ file }) => fsops.readRaw(root, file),
  search: ({ query, glob }) => fsops.search(root, query, glob),
  detect: () => fsops.detectProject(root),
  gitInfo: () => fsops.gitInfo(root),
  changes: () => fsops.gitChanges(root),
  write: ({ file, content }) => {
    if (readOnly) throw new Error("Runner is read-only (--read-only).");
    log("\x1b[33mwrite\x1b[0m", file);
    return fsops.write(root, file, content);
  },
  exec: ({ command, timeoutMs }) => {
    if (readOnly) throw new Error("Runner is read-only (--read-only).");
    log("\x1b[36mexec \x1b[0m", command);
    return fsops.exec(root, command, timeoutMs, (chunk) => process.stdout.write(dim(chunk)));
  },
  archive: async ({ platform }) => {
    log("\x1b[35mpack \x1b[0m", `deploy archive (${platform ?? "auto"})`);
    const a = await fsops.archive(root, platform);
    return { base64: a.buffer.toString("base64"), files: a.files, size: a.size };
  },
};

let backoff = 1000;
function connect() {
  const url = `${server.replace(/^http/, "ws")}/ws/runner?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => {
    backoff = 1000;
    ws.send(JSON.stringify({ hello: { name, root, platform: process.platform, readOnly } }));
    log("\x1b[32mready\x1b[0m", `connected to ${server} · sharing ${root}${readOnly ? " (read-only)" : ""}`);
  });
  ws.addEventListener("message", async (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const fn = handlers[msg.method];
    try {
      if (!fn) throw new Error(`Unknown method ${msg.method}`);
      ws.send(JSON.stringify({ id: msg.id, result: await fn(msg.params ?? {}) }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, error: e instanceof Error ? e.message : String(e) }));
    }
  });
  ws.addEventListener("close", (ev) => {
    if (ev.code === 4401) {
      console.error("Yara rejected the token. Create a new one in Settings → Local runner.");
      process.exit(1);
    }
    log("\x1b[31mclosed\x1b[0m", `reconnecting in ${Math.round(backoff / 1000)}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
  ws.addEventListener("error", () => {});
}

connect();
