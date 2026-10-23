import "server-only";
import fs from "node:fs";
import path from "node:path";
import * as fsops from "../../runner/fsops.mjs";
import type { Entry, ExecResult, GitChanges, GitInfo, ProjectInfo, ReadResult } from "../../runner/fsops.mjs";
import { newId } from "./crypto";
import { dataDir, db } from "./db";

// A workspace is a project folder the agents can read, build, edit and deploy.
// Two kinds: GitHub repos cloned on this server, and folders on the user's own
// machine reached through the local runner (runner/yara-runner.mjs).

/** The shell commands run in, so the agent writes matching syntax. */
export const shellFor = (platform: string) => (platform === "win32" ? "cmd.exe (Windows): no bash heredocs/pipes-to-python; use type instead of cat" : "/bin/sh (POSIX)");

export type WorkspaceInfo = { id: string; kind: "github" | "local"; label: string; shell?: string; path?: string; repo?: string; branch?: string | null; online: boolean };

export interface Workspace {
  info: WorkspaceInfo;
  list(dir?: string, depth?: number): Promise<Entry[]>;
  read(file: string, from?: number, to?: number): Promise<ReadResult>;
  readRaw(file: string): Promise<string | null>;
  write(file: string, content: string): Promise<{ path: string; bytes: number }>;
  search(query: string, glob?: string): Promise<{ query: string; matches: { path: string; line: number; text: string }[]; truncated: boolean }>;
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
  archive(platform?: string | null): Promise<{ buffer: Buffer; files: number; size: number }>;
  detect(): Promise<ProjectInfo>;
  gitInfo(): Promise<GitInfo>;
  changes(): Promise<GitChanges>;
}

// ---------- GitHub workspaces (server-side clones) ----------

type Row = { id: string; user_id: string; kind: string; repo: string; branch: string | null; app: string | null; created_at: number };

const wsRoot = (id: string) => path.join(dataDir(), "workspaces", id);
const authHeader = (token: string) => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` });

function githubWorkspace(row: Row): Workspace {
  const root = wsRoot(row.id);
  return {
    info: { id: row.id, kind: "github", label: row.repo, repo: row.repo, branch: row.branch, shell: shellFor(process.platform), online: fs.existsSync(root) },
    list: async (dir, depth) => fsops.list(root, dir, depth),
    read: async (file, from, to) => fsops.read(root, file, from, to),
    readRaw: async (file) => fsops.readRaw(root, file),
    write: async (file, content) => fsops.write(root, file, content),
    search: async (q, glob) => fsops.search(root, q, glob),
    exec: (cmd, t) => fsops.exec(root, cmd, t),
    archive: (p) => fsops.archive(root, p),
    detect: async () => fsops.detectProject(root),
    gitInfo: () => fsops.gitInfo(root),
    changes: () => fsops.gitChanges(root),
  };
}

export async function cloneRepo(userId: string, repo: string, token: string, branch?: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Repository must look like owner/name.");
  const id = newId();
  const root = wsRoot(id);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const args = ["clone", "--depth", "50", ...(branch ? ["--branch", branch] : []), `https://github.com/${repo}.git`, root];
  const ok = await fsops.git(path.dirname(root), args, authHeader(token));
  if (ok === null) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`Could not clone ${repo}. Check the repository name and that your GitHub token can read it.`);
  }
  const actualBranch = await fsops.git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  db()
    .prepare("INSERT INTO workspaces (id, user_id, kind, repo, branch, created_at) VALUES (?, ?, 'github', ?, ?, ?)")
    .run(id, userId, repo, actualBranch, Date.now());
  return id;
}

export function removeWorkspace(userId: string, id: string) {
  const row = db().prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  if (!row) return false;
  fs.rmSync(wsRoot(id), { recursive: true, force: true });
  db().prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  return true;
}

/** Commits all changes to `branch` and pushes it with the user's GitHub token. */
export async function commitAndPush(userId: string, id: string, token: string, branch: string, message: string) {
  const row = db().prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  if (!row) throw new Error("Workspace not found.");
  const root = wsRoot(id);
  const run = (args: string[], env?: Record<string, string>) => fsops.git(root, args, env);
  if ((await run(["checkout", "-B", branch])) === null) throw new Error(`Could not switch to branch ${branch}.`);
  await run(["add", "-A"]);
  const commit = await run(["-c", "user.name=Yara", "-c", "user.email=yara@users.noreply.github.com", "commit", "-m", message]);
  if (commit === null) throw new Error("Nothing to commit, or the commit failed.");
  const pushed = await run(["push", "-u", "origin", branch, "--force-with-lease"], authHeader(token));
  if (pushed === null) throw new Error(`Push to ${branch} failed. The token needs Contents: write on ${row.repo}.`);
  const sha = await run(["rev-parse", "HEAD"]);
  return { repo: row.repo, branch, commit: sha };
}

export async function openPullRequest(userId: string, id: string, token: string, head: string, title: string, body: string) {
  const row = db().prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  if (!row) throw new Error("Workspace not found.");
  const res = await fetch(`https://api.github.com/repos/${row.repo}/pulls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "yara" },
    body: JSON.stringify({ title, head, base: row.branch ?? "main", body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GitHub: ${data.message ?? res.status}`);
  return { url: data.html_url as string, number: data.number as number };
}

// ---------- local runners (connected over /ws/runner, see server.mjs) ----------

type RunnerConn = { id: string; userId: string; name: string; root: string; platform?: string; call: (method: string, params: unknown, timeoutMs?: number) => Promise<any> };
const registry = () => {
  const g = globalThis as unknown as { __yaraRunners?: Map<string, RunnerConn> };
  return (g.__yaraRunners ??= new Map());
};

function runnerWorkspace(r: RunnerConn): Workspace {
  const call = r.call;
  return {
    info: { id: `local:${r.id}`, kind: "local", label: `${r.name}: ${r.root.split(/[\\/]/).filter(Boolean).pop() ?? r.root}`, path: r.root, shell: shellFor(r.platform ?? ""), online: true },
    list: (dir, depth) => call("list", { dir, depth }),
    read: (file, from, to) => call("read", { file, from, to }),
    readRaw: (file) => call("readRaw", { file }),
    write: (file, content) => call("write", { file, content }),
    search: (query, glob) => call("search", { query, glob }),
    exec: (command, timeoutMs = 300_000) => call("exec", { command, timeoutMs }, timeoutMs + 15_000),
    archive: async (platform) => {
      const r2 = await call("archive", { platform }, 600_000);
      return { buffer: Buffer.from(r2.base64, "base64"), files: r2.files, size: r2.size };
    },
    detect: () => call("detect", {}),
    gitInfo: () => call("gitInfo", {}),
    changes: () => call("changes", {}),
  };
}

export function listWorkspaces(userId: string): WorkspaceInfo[] {
  const rows = db().prepare("SELECT * FROM workspaces WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Row[];
  const locals = [...registry().values()].filter((r) => r.userId === userId).map((r) => runnerWorkspace(r).info);
  return [...locals, ...rows.map((r) => githubWorkspace(r).info)];
}

export function getWorkspace(userId: string, id: string): Workspace | null {
  if (id.startsWith("local:")) {
    const r = registry().get(id.slice(6));
    return r && r.userId === userId ? runnerWorkspace(r) : null;
  }
  const row = db().prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined;
  return row ? githubWorkspace(row) : null;
}
