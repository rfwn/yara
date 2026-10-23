// File-system operations on a project folder, shared by Yara's server workspaces
// (GitHub clones) and the local runner. Every path is confined to `root`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { create as createTar } from "tar";

const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".nuxt", "dist", "build", "out", "coverage", "venv", ".venv", "__pycache__", "vendor", ".turbo", ".cache"]);
const MAX_READ = 200_000;
const MAX_OUTPUT = 60_000;

/** Resolves a workspace-relative path and refuses anything outside the root. */
export function resolveIn(root, rel = ".") {
  const abs = path.resolve(root, String(rel).replace(/^[/\\]+/, ""));
  const r = path.resolve(root);
  if (abs !== r && !abs.startsWith(r + path.sep)) throw new Error(`Path is outside the workspace: ${rel}`);
  return abs;
}

const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join("/") || ".";

/** Directory listing, depth-limited, skipping dependency/build folders. */
export function list(root, dir = ".", depth = 2) {
  const out = [];
  const walk = (abs, d) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (out.length >= 800) return;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) {
        out.push({ path: toRel(root, p), type: "dir", skipped: SKIP_DIRS.has(e.name) || undefined });
        if (d > 1 && !SKIP_DIRS.has(e.name)) walk(p, d - 1);
      } else if (e.isFile()) {
        let size;
        try {
          size = fs.statSync(p).size;
        } catch {}
        out.push({ path: toRel(root, p), type: "file", size });
      }
    }
  };
  walk(resolveIn(root, dir), Math.max(1, Math.min(depth, 6)));
  return out;
}

/** Reads a text file, optionally a 1-based inclusive line range; returns numbered lines. */
export function read(root, rel, from, to) {
  const abs = resolveIn(root, rel);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error(`${rel} is a directory`);
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return { path: rel, binary: true, size: stat.size };
  const lines = buf.toString("utf8").split("\n");
  const start = Math.max(1, from || 1);
  const end = Math.min(lines.length, to || lines.length);
  let text = lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}\t${l}`)
    .join("\n");
  const truncated = text.length > MAX_READ;
  if (truncated) text = text.slice(0, MAX_READ);
  return { path: rel, totalLines: lines.length, from: start, to: end, truncated, content: text };
}

/** Raw file content (for diffs and edits). Returns null when the file does not exist. */
export function readRaw(root, rel) {
  const abs = resolveIn(root, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

export function write(root, rel, content) {
  const abs = resolveIn(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return { path: rel, bytes: Buffer.byteLength(content) };
}

/** Grep-like search across text files. `query` is a regex (case-insensitive) or plain text. */
export function search(root, query, glob) {
  let re;
  try {
    re = new RegExp(query, "i");
  } catch {
    re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const globRe = glob ? new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$") : null;
  const results = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= 200) return;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
        continue;
      }
      const rel = toRel(root, p);
      if (globRe && !globRe.test(rel) && !globRe.test(e.name)) continue;
      let buf;
      try {
        if (fs.statSync(p).size > 1_000_000) continue;
        buf = fs.readFileSync(p);
      } catch {
        continue;
      }
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length && results.length < 200; i++) {
        if (re.test(lines[i])) results.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 240) });
      }
    }
  };
  walk(resolveIn(root, "."));
  return { query, matches: results, truncated: results.length >= 200 };
}

/** Environment for child processes: never pass the host's secrets through. */
function childEnv(extra) {
  const keep = ["PATH", "Path", "HOME", "USERPROFILE", "LANG", "TEMP", "TMP", "TMPDIR", "SystemRoot", "SYSTEMROOT", "ComSpec", "APPDATA", "LOCALAPPDATA", "PATHEXT", "WINDIR", "NVM_DIR", "NODE_PATH"];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, CI: "1", TERM: "dumb", FORCE_COLOR: "0", NO_COLOR: "1", ...extra };
}

// Commands run through the platform shell; the agent is told which, so it writes the right syntax.
const SHELL = process.platform === "win32" ? "cmd.exe (Windows): no bash syntax, heredocs, && is fine, use `type` not `cat`" : "/bin/sh (POSIX)";

/** Runs a shell command in the workspace with a timeout; output is combined and tail-capped. */
export function exec(root, command, timeoutMs = 300_000, onOutput) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd: resolveIn(root, "."), shell: true, env: childEnv(), detached: process.platform !== "win32", windowsHide: true });
    let out = "";
    let timedOut = false;
    const push = (d) => {
      const s = d.toString();
      out += s;
      if (out.length > MAX_OUTPUT * 2) out = out.slice(-MAX_OUTPUT);
      onOutput?.(s);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const kill = () => {
      try {
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const clipped = out.length > MAX_OUTPUT ? `…(earlier output trimmed)\n${out.slice(-MAX_OUTPUT)}` : out;
      resolve({ command, exitCode: timedOut ? null : code, timedOut, durationMs: Date.now() - started, output: clipped, shell: SHELL });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ command, exitCode: null, timedOut: false, durationMs: Date.now() - started, output: String(e.message) });
    });
  });
}

/** Runs git with arguments (no shell), returning trimmed stdout or null. */
export function git(root, args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: resolveIn(root, "."), env: childEnv(extraEnv), windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    child.on("error", () => resolve(null));
    void err;
  });
}

export async function gitInfo(root) {
  const [branch, message, commit, committedAt, remote, email, name] = await Promise.all([
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["log", "--format=%B", "-n", "1", "HEAD"]),
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["log", "--format=%ct", "-n", "1", "HEAD"]),
    git(root, ["ls-remote", "--get-url"]),
    git(root, ["log", "--format=%aE", "-n", "1", "HEAD"]),
    git(root, ["log", "--format=%aN", "-n", "1", "HEAD"]),
  ]);
  // Never ship credentials embedded in a remote URL.
  const safeRemote = remote ? remote.replace(/\/\/[^@/]+@/, "//") : null;
  return { branch, message, commit, committedAt, remote: safeRemote, author: { email, name }, tags: [] };
}

export async function gitChanges(root) {
  const status = await git(root, ["status", "--porcelain=v1"]);
  const diff = await git(root, ["diff", "--no-color"]);
  if (status === null) return { isRepo: false };
  return {
    isRepo: true,
    files: status
      .split("\n")
      .filter(Boolean)
      .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })),
    diff: diff && diff.length > MAX_OUTPUT ? diff.slice(0, MAX_OUTPUT) + "\n…(diff trimmed)" : diff,
  };
}

// ---- deploy archive (mirrors the Liara CLI's create-archive) ----

const DEFAULT_IGNORES = [".git", ".idea", ".vscode", ".next", ".dockerignore", "*.*~", "liara.json", "node_modules", "bower_components", ".DS_Store"];
const PY_IGNORES = ["venv", "/venv", ".venv", ".env", "ENV", ".python-version", ".cache", "__pycache__", "lib", "lib64", "*.py[cod]", "*$py.class", "pip-log.txt", "pip-delete-this-directory.txt", "celerybeat-schedule"];
const PLATFORM_IGNORES = {
  django: [...PY_IGNORES, "*.log", "local_settings.py", "staticfiles"],
  flask: [...PY_IGNORES, "instance", ".webassets-cache"],
  python: PY_IGNORES,
  laravel: ["/vendor"],
  php: ["/vendor"],
  dotnet: ["Debug", "debug", "Release", "release", "Releases", "releases", "x64", "x86", "build", "bld", "Bin", "bin", "Obj", "obj"],
};

function loadIgnoreFile(ig, file, root) {
  const dir = path.dirname(file);
  const patterns = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((p) => {
      const neg = p.startsWith("!");
      const raw = neg ? p.slice(1) : p;
      const abs = raw.startsWith("/") ? "/" : "";
      const rel = path.relative(root, path.join(dir, raw)).split(path.sep).join("/");
      return (neg ? "!" : "") + abs + rel;
    });
  ig.add(patterns);
}

/** Builds the gzipped tarball Liara expects, honoring .liaraignore > .dockerignore > .gitignore per folder. */
export async function archive(root, platform) {
  const base = resolveIn(root, ".");
  const ig = ignore({ ignorecase: false });
  ig.add(DEFAULT_IGNORES);
  ig.add(PLATFORM_IGNORES[platform] || []);
  const seen = new Set();
  const addDir = (relDir) => {
    if (seen.has(relDir)) return;
    seen.add(relDir);
    for (const name of [".liaraignore", ".dockerignore", ".gitignore"]) {
      const f = path.join(base, relDir, name);
      if (fs.existsSync(f)) {
        loadIgnoreFile(ig, f, base);
        return;
      }
    }
  };
  const keep = (rel) => {
    const r = rel.split(path.sep).join("/").replace(/^\.\//, "");
    if (!r || r === ".") return true;
    addDir(path.dirname(r));
    return !ig.ignores(r);
  };
  addDir(".");
  const top = fs.readdirSync(base).filter((f) => keep(f));
  if (!top.length) throw new Error("Everything is ignored; nothing to upload. Check .gitignore / .dockerignore / .liaraignore.");
  let files = 0;
  const tmp = path.join(base, "..", `.yara-src-${Date.now()}.tar.gz`);
  await createTar(
    {
      gzip: { level: 9 },
      cwd: base,
      file: tmp,
      filter: (p, stat) => {
        const ok = keep(p);
        if (ok && stat && !stat.isDirectory?.()) files++;
        return ok;
      },
    },
    top,
  );
  const buffer = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return { buffer, files, size: buffer.length };
}

/** Guesses the Liara platform and port the same way the CLI's detect-platform does (simplified). */
export function detectProject(root) {
  const base = resolveIn(root, ".");
  const has = (f) => fs.existsSync(path.join(base, f));
  let liaraJson = null;
  try {
    liaraJson = has("liara.json") ? JSON.parse(fs.readFileSync(path.join(base, "liara.json"), "utf8")) : null;
  } catch (e) {
    liaraJson = { _parseError: String(e.message) };
  }
  let platform = liaraJson?.platform ?? null;
  let pkg = null;
  if (has("package.json")) {
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
    } catch {}
  }
  if (!platform) {
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    if (has("Dockerfile")) platform = "docker";
    else if (has("composer.json")) platform = /laravel/.test(fs.readFileSync(path.join(base, "composer.json"), "utf8")) ? "laravel" : "php";
    else if (has("manage.py")) platform = "django";
    else if (has("requirements.txt") || has("pyproject.toml")) platform = /flask/i.test(has("requirements.txt") ? fs.readFileSync(path.join(base, "requirements.txt"), "utf8") : "") ? "flask" : "python";
    else if (has("go.mod")) platform = "go";
    else if (pkg) platform = deps.next ? "next" : deps.react && !deps.express ? "react" : deps.vue ? "vue" : deps["@angular/core"] ? "angular" : "node";
  }
  const defaults = { node: 3000, next: 3000, react: 80, vue: 80, angular: 80, static: 80, laravel: 80, php: 80, django: 80, flask: 80, python: 80, go: 8080, docker: null, dotnet: 80 };
  return {
    platform,
    port: liaraJson?.port ?? (platform ? defaults[platform] ?? null : null),
    app: liaraJson?.app ?? null,
    liaraJson,
    scripts: pkg?.scripts ?? null,
    engines: pkg?.engines ?? null,
  };
}
