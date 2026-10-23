export type Entry = { path: string; type: "file" | "dir"; size?: number; skipped?: boolean };
export type ExecResult = { command: string; exitCode: number | null; timedOut: boolean; durationMs: number; output: string; shell?: string };
export type ReadResult =
  | { path: string; binary: true; size: number }
  | { path: string; totalLines: number; from: number; to: number; truncated: boolean; content: string };
export type GitInfo = {
  branch: string | null;
  message: string | null;
  commit: string | null;
  committedAt: string | null;
  remote: string | null;
  author: { email: string | null; name: string | null };
  tags: string[];
};
export type GitChanges = { isRepo: false } | { isRepo: true; files: { status: string; path: string }[]; diff: string | null };
export type ProjectInfo = {
  platform: string | null;
  port: number | null;
  app: string | null;
  liaraJson: Record<string, unknown> | null;
  scripts: Record<string, string> | null;
  engines: Record<string, string> | null;
};

export function resolveIn(root: string, rel?: string): string;
export function list(root: string, dir?: string, depth?: number): Entry[];
export function read(root: string, rel: string, from?: number, to?: number): ReadResult;
export function readRaw(root: string, rel: string): string | null;
export function write(root: string, rel: string, content: string): { path: string; bytes: number };
export function search(root: string, query: string, glob?: string): { query: string; matches: { path: string; line: number; text: string }[]; truncated: boolean };
export function exec(root: string, command: string, timeoutMs?: number, onOutput?: (chunk: string) => void): Promise<ExecResult>;
export function git(root: string, args: string[], extraEnv?: Record<string, string>): Promise<string | null>;
export function gitInfo(root: string): Promise<GitInfo>;
export function gitChanges(root: string): Promise<GitChanges>;
export function archive(root: string, platform?: string | null): Promise<{ buffer: Buffer; files: number; size: number }>;
export function detectProject(root: string): ProjectInfo;
