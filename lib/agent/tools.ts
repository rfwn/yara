import "server-only";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { ACTION_META } from "../action-meta";
import { actions } from "../actions";
import { createLiaraClient, enc, type Project } from "../liara";
import { appUrl } from "../monitor/evidence";
import { probeUrl } from "../monitor/probe";
import { domainGuide } from "../server/domains";
import { checkApp, createRoutine, INTERVALS, listIncidents, listMonitors, listRoutines, upsertMonitor, uptime } from "../server/monitor";
import { getPolicy } from "./policy";
import { buildLogs, deployWorkspace } from "../server/deploy";
import { commitAndPush, getWorkspace, listWorkspaces, openPullRequest, type Workspace } from "../server/workspaces";
import { PLATFORM_LIMITS } from "../limits";
import { appPlanOptions, recommendAppPlan } from "../plans";
import { isSecretFile, maskSecrets, touchesSecretFile } from "../mask";
import { readTools } from "../tools";
import { rollbackChange } from "./rollback";
import { workspaceFor } from "./workspace";
import { defineTool, type AgentCtx, type AgentTool } from "./types";

// ---------- helpers ----------

const wsArg = z.string().optional().describe("Workspace id from listWorkspaces; defaults to the one the user has open");
/** Shown on the approval card as «چرا»: lets the user judge a change against the finding it fixes. */
const why = z.string().max(300).optional().describe("One short Persian sentence for the approval card: which finding this change fixes and why it should work");
const withWhy = (s: z.ZodTypeAny) => (s instanceof z.ZodObject ? s.extend({ why }) : s);
const clip = (s: string, n = 20_000) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);

/** Applies an exact-snippet edit, tolerating LF vs CRLF differences between the model and the file. */
function applyEdit(before: string, oldString: string, newString: string, replaceAll: boolean) {
  const toCrlf = (x: string) => x.replace(/\r?\n/g, "\r\n");
  const toLf = (x: string) => x.replace(/\r\n/g, "\n");
  const norm = before.includes("\r\n") ? toCrlf : toLf;
  const variants = [
    [oldString, newString],
    [norm(oldString), norm(newString)],
  ];
  for (const [o, n] of variants) {
    const count = before.split(o).length - 1;
    if (count === 0) continue;
    if (count > 1 && !replaceAll) return { error: `oldString appears ${count} times; add surrounding lines to make it unique or set replaceAll.` };
    return { after: replaceAll ? before.split(o).join(n) : before.replace(o, () => n) };
  }
  return { error: "oldString was not found. Read the file again and copy the exact text." };
}

function unifiedDiff(file: string, before: string | null, after: string) {
  return createTwoFilesPatch(`a/${file}`, `b/${file}`, before ?? "", after, before === null ? "(new file)" : "", "", { context: 3 });
}

/** Commands that run without approval in a local runner: builds, tests, linters, read-only git, no shell chaining. */
const SAFE_COMMAND =
  /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|lint|typecheck|check|ci|install|i)\b[\w\s:=.@/-]*|npx\s+(?:tsc|eslint|vitest|jest|next\s+build)\b[\w\s:=.@/-]*|(?:node|python3?|go|php|dotnet|java)\s+(?:-v|--version)|python3?\s+-m\s+(?:pytest|compileall)\b[\w\s.=/-]*|pytest\b[\w\s.=/-]*|go\s+(?:build|test|vet)\b[\w\s./-]*|ls(?:\s+[\w./-]+)*|cat\s+[\w./-]+|git\s+(?:status|diff|log)\b[\w\s.=/-]*)$/;

// ---------- workspace + code tools ----------

const workspaceTools: AgentTool[] = [
  defineTool({
    name: "listWorkspaces",
    description: "Connected code workspaces: GitHub repos cloned on the server and folders shared by the user's local runner.",
    schema: z.object({}),
    kind: "read",
    run: async (_a, ctx) => listWorkspaces(ctx.userId),
  }),
  defineTool({
    name: "listFiles",
    description: "List files and folders in a workspace (dependency/build folders are shown but not expanded).",
    schema: z.object({ workspace: wsArg, dir: z.string().default("."), depth: z.number().int().min(1).max(5).default(2) }),
    kind: "read",
    run: async (a, ctx) => workspaceFor(ctx, a.workspace).list(a.dir, a.depth),
  }),
  defineTool({
    name: "readFile",
    description: "Read a text file with line numbers. Use from/to (1-based) for big files.",
    schema: z.object({ workspace: wsArg, path: z.string(), from: z.number().int().optional(), to: z.number().int().optional() }),
    kind: "read",
    // Secret files come back with keys only; secret-looking values are masked everywhere.
    run: async (a, ctx) => {
      const r = await workspaceFor(ctx, a.workspace).read(a.path, a.from, a.to);
      if (!("content" in r)) return r;
      const secret = isSecretFile(a.path);
      return { ...r, content: maskSecrets(r.content, { secretFile: secret }), ...(secret ? { note: "Secret file: values are hidden from you by policy. Refer to keys by name." } : {}) };
    },
  }),
  defineTool({
    name: "searchCode",
    description: "Search the workspace for a regex or text (case-insensitive). Optional glob like *.ts or src/*.",
    schema: z.object({ workspace: wsArg, query: z.string().min(1), glob: z.string().optional() }),
    kind: "read",
    run: async (a, ctx) => {
      const r = await workspaceFor(ctx, a.workspace).search(a.query, a.glob);
      return { ...r, matches: r.matches.map((m) => ({ ...m, text: maskSecrets(m.text, { secretFile: isSecretFile(m.path) }) })) };
    },
  }),
  defineTool({
    name: "detectProject",
    description: "Detect the Liara platform, port, app name and liara.json of a workspace, plus package scripts/engines.",
    schema: z.object({ workspace: wsArg }),
    kind: "read",
    run: async (a, ctx) => {
      const ws = workspaceFor(ctx, a.workspace);
      return { ...(await ws.detect()), shell: ws.info.shell };
    },
  }),
  defineTool({
    name: "gitChanges",
    description: "Uncommitted changes in the workspace: changed files and the diff.",
    schema: z.object({ workspace: wsArg }),
    kind: "read",
    run: async (a, ctx) => workspaceFor(ctx, a.workspace).changes(),
  }),
  defineTool({
    name: "runCommand",
    description:
      "Run a shell command in the workspace (build, test, lint, install). Returns exit code and output. Use it to reproduce build failures and to verify fixes before deploying. Write commands for the workspace's shell (see listWorkspaces/detectProject). To inspect code use readFile and searchCode, not ad-hoc scripts.",
    schema: z.object({ workspace: wsArg, command: z.string().min(1).max(500), timeoutSec: z.number().int().min(5).max(900).default(300) }),
    kind: "write",
    // Server-side GitHub clones are disposable; a local runner touches the user's machine, so only safe commands skip approval.
    autoApprove: (a, ctx) => {
      const ws = workspaceFor(ctx, a.workspace);
      // Anything touching secret files, or dumping the environment, always asks.
      if (touchesSecretFile(a.command) || /^(env|printenv|set)\b/.test(a.command.trim())) return false;
      return SAFE_COMMAND.test(a.command.trim()) || (ws.info.kind === "github" && !/[;&|`$<>]/.test(a.command));
    },
    approval: (a, ctx) => {
      const ws = workspaceFor(ctx, a.workspace);
      return {
        kind: "command",
        title: "اجرای دستور",
        summary: ws.info.kind === "local" ? "این دستور روی رایانه‌ی شما و در پوشه‌ی پروژه اجرا می‌شود." : "این دستور در نسخه‌ی پروژه روی سرور یارا اجرا می‌شود.",
        risk: "medium",
        target: ws.info.label,
        command: a.command,
      };
    },
    run: async (a, ctx, ui) => {
      ui("command", { command: a.command, status: "running" });
      const r = await workspaceFor(ctx, a.workspace).exec(a.command, a.timeoutSec * 1000);
      ui("command", { command: a.command, status: "done", exitCode: r.exitCode, output: r.output.slice(-4000), durationMs: r.durationMs });
      return { ...r, output: clip(maskSecrets(r.output, { secretFile: touchesSecretFile(a.command) }), 12_000) };
    },
  }),
  defineTool({
    name: "editFile",
    description: "Replace an exact, unique snippet in a file (include enough surrounding lines to be unique). Shows the user a diff for approval.",
    schema: z.object({ workspace: wsArg, path: z.string(), oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean().default(false) }),
    kind: "write",
    approval: async (a, ctx) => {
      const ws = workspaceFor(ctx, a.workspace);
      const before = await ws.readRaw(a.path);
      if (before === null) throw new Error(`${a.path} does not exist; use writeFile to create it.`);
      const r = applyEdit(before, a.oldString, a.newString, a.replaceAll);
      if (r.error) throw new Error(`${a.path}: ${r.error}`);
      const after = r.after!;
      return { kind: "edit", title: "ویرایش کد", summary: `تغییر در \`${a.path}\``, risk: "medium", target: `${ws.info.label} · ${a.path}`, diff: unifiedDiff(a.path, before, after) };
    },
    run: async (a, ctx) => {
      const ws = workspaceFor(ctx, a.workspace);
      const before = await ws.readRaw(a.path);
      const r = before === null ? { error: "missing" } : applyEdit(before, a.oldString, a.newString, a.replaceAll);
      if (r.error) throw new Error(`The file changed since the edit was proposed; re-read ${a.path}.`);
      const after = r.after!;
      await ws.write(a.path, after);
      return { path: a.path, applied: true, diff: unifiedDiff(a.path, before, after) };
    },
  }),
  defineTool({
    name: "writeFile",
    description: "Create a file or overwrite it entirely (e.g. liara.json, a Dockerfile, a workflow). Shows a diff for approval.",
    schema: z.object({ workspace: wsArg, path: z.string(), content: z.string() }),
    kind: "write",
    approval: async (a, ctx) => {
      const ws = workspaceFor(ctx, a.workspace);
      const before = await ws.readRaw(a.path);
      return {
        kind: "edit",
        title: before === null ? "ساخت فایل تازه" : "بازنویسی فایل",
        summary: `\`${a.path}\``,
        risk: before === null ? "low" : "medium",
        target: `${ws.info.label} · ${a.path}`,
        diff: unifiedDiff(a.path, before, a.content),
      };
    },
    run: async (a, ctx) => {
      const ws = workspaceFor(ctx, a.workspace);
      const before = await ws.readRaw(a.path);
      await ws.write(a.path, a.content);
      return { path: a.path, created: before === null, diff: unifiedDiff(a.path, before, a.content) };
    },
  }),
  defineTool({
    name: "commitAndPush",
    description: "Commit all workspace changes to a branch and push it to GitHub (GitHub workspaces only). Prefer a new branch like yara/fix-port.",
    schema: z.object({ workspace: wsArg, branch: z.string().regex(/^[\w./-]+$/), message: z.string().min(3) }),
    kind: "write",
    approval: async (a, ctx) => {
      const ws = workspaceFor(ctx, a.workspace);
      if (ws.info.kind !== "github") throw new Error("Local workspaces are committed by the user; suggest the git commands instead.");
      const ch = await ws.changes();
      return { kind: "git", title: "کامیت و پوش", summary: `ثبت تغییرات در شاخه‌ی \`${a.branch}\` و ارسال به گیت‌هاب: ${a.message}`, risk: "medium", target: `${ws.info.label} → ${a.branch}`, diff: ch.isRepo ? (ch.diff ?? "") : "" };
    },
    run: async (a, ctx) => {
      if (!ctx.github) throw new Error("GitHub is not connected. Ask the user to add a token in Settings.");
      const ws = workspaceFor(ctx, a.workspace);
      return commitAndPush(ctx.userId, ws.info.id, ctx.github, a.branch, a.message);
    },
  }),
  defineTool({
    name: "openPullRequest",
    description: "Open a GitHub pull request from a pushed branch into the workspace's base branch.",
    schema: z.object({ workspace: wsArg, branch: z.string(), title: z.string(), body: z.string().default("") }),
    kind: "write",
    approval: (a, ctx) => ({ kind: "git", title: "ساخت Pull Request", summary: `**${a.title}**\n\n${a.body}`, risk: "low", target: `${workspaceFor(ctx, a.workspace).info.label} ← ${a.branch}` }),
    run: async (a, ctx) => {
      if (!ctx.github) throw new Error("GitHub is not connected.");
      return openPullRequest(ctx.userId, workspaceFor(ctx, a.workspace).info.id, ctx.github, a.branch, a.title, a.body + "\n\n_Opened by Yara._");
    },
  }),
];

// ---------- deploy tools ----------

const deployTools: AgentTool[] = [
  defineTool({
    name: "deployWorkspace",
    description:
      "Package the workspace like `liara deploy` (honoring .liaraignore/.gitignore), upload it, create a release and follow the build until READY or FAILED. Returns the final state and the build log tail.",
    schema: z.object({
      workspace: wsArg,
      app: z.string().min(1).describe("Liara app name"),
      platform: z.string().optional().describe("Override the detected platform"),
      port: z.number().int().optional().describe("Override the detected port"),
      message: z.string().optional(),
      why,
    }),
    kind: "write",
    approval: async (a, ctx) => {
      try {
        await ctx.liara.get(`/v1/projects/${enc(a.app)}`);
      } catch (e) {
        if ((e as { status?: number }).status === 404)
          throw new Error(
            `App "${a.app}" does not exist on Liara yet. Create it yourself: call recommendAppPlan for the platform, then createApp (the user approves the plan and price on the card), then call deployWorkspace again. Never send the user to the Liara console for this.`,
          );
        throw e;
      }
      const ws = workspaceFor(ctx, a.workspace);
      const p = await ws.detect();
      const platform = a.platform ?? p.platform ?? "?";
      const port = a.port ?? p.port;
      return {
        kind: "deploy",
        title: "استقرار نسخه‌ی تازه",
        summary: `کد **${ws.info.label}** بسته‌بندی و روی برنامه‌ی **${a.app}** مستقر می‌شود.${p.liaraJson?.envs ? "\n\n⚠️ liara.json فیلد envs دارد و همه‌ی متغیرهای فعلی برنامه را جایگزین می‌کند." : ""}`,
        risk: "medium",
        target: a.app,
        details: { platform, port: port ?? "پیش‌فرض", workspace: ws.info.label, message: a.message ?? "" },
      };
    },
    run: async (a, ctx, ui) => {
      const ws = workspaceFor(ctx, a.workspace);
      const p = await ws.detect();
      const platform = a.platform ?? p.platform;
      if (!platform) throw new Error("Could not detect the platform; pass platform explicitly.");
      const r = await deployWorkspace(ctx.liara, ws, { app: a.app, platform, port: a.port ?? p.port, message: a.message, liaraJson: p.liaraJson as Record<string, any> | null }, (prog) =>
        ui("deploy", { app: a.app, ...prog }),
      );
      if (r.state === "READY") return r;
      // Steer the next step from the result itself; models follow tool output more reliably than the system prompt.
      return {
        ...r,
        next:
          "The release did not go live. Do not stop here and do not ask the user to fix it. If the log shows an error in the user's code (exception, compile/type error, failing build script), call transfer_to_debug now with the error lines, the release id and the workspace id, asking it to fix, verify and hand back to deploy. If it is configuration (port, platform, liara.json, env, build location), fix it and redeploy.",
      };
    },
  }),
  defineTool({
    name: "getBuildLogs",
    description: "Full build log of a release (from getAppReleases) with its state and fail reason.",
    schema: z.object({ releaseId: z.string() }),
    kind: "read",
    run: async (a, ctx) => buildLogs(ctx.liara, a.releaseId),
  }),
  defineTool({
    name: "cancelRelease",
    description: "Cancel a release that is still building.",
    schema: z.object({ releaseId: z.string() }),
    kind: "write",
    approval: (a) => ({ kind: "liara", title: "لغو استقرار", summary: `ساخت نسخه‌ی \`${a.releaseId}\` لغو می‌شود.`, risk: "low", target: a.releaseId }),
    run: async (a, ctx) => ctx.liara.post(`/v2/releases/${enc(a.releaseId)}/cancel`),
  }),
];

// ---------- Liara tools from the original assistant ----------

const dummy = readTools(createLiaraClient({ token: "" }));
const liaraReadTools: Record<string, AgentTool> = Object.fromEntries(
  Object.entries(dummy).map(([name, t]) => [
    name,
    defineTool({
      name,
      description: t.description ?? name,
      schema: t.inputSchema as unknown as z.ZodTypeAny,
      kind: "read",
      run: async (args, ctx) => {
        const live = readTools(ctx.liara)[name as keyof typeof dummy];
        return (live.execute as (a: unknown, o: unknown) => Promise<unknown>)(args, { toolCallId: "agent", messages: [] });
      },
    }),
  ]),
);

const liaraActionTools: Record<string, AgentTool> = Object.fromEntries(
  Object.entries(actions).map(([name, def]) => [
    name,
    defineTool({
      name,
      description: def.description,
      schema: withWhy(def.input as unknown as z.ZodTypeAny),
      kind: "write",
      approval: async (args, ctx) => {
        const m = ACTION_META[name];
        const input = args as Record<string, any>;
        let price: Record<string, unknown> | undefined;
        if (name === "createApp") {
          const { appPlans, bundles } = await appPlanOptions(ctx.liara);
          const plan = appPlans.find((p) => p.id === input.planID);
          if (!plan) throw new Error(`Plan "${input.planID}" is not available. Valid plans: ${appPlans.map((p) => p.id).join(", ")}. Use recommendAppPlan.`);
          const bundle = bundles(plan.id).find((b) => b.id === input.bundlePlanID) ?? bundles(plan.id)[0];
          price = { "پلن": `${plan.id}: ${plan.cpu} CPU، ${plan.ramGB} GB RAM، ${plan.diskGB} GB دیسک`, "بسته‌ی امکانات": bundle?.id ?? "-", "هزینه‌ی ماهانه (تومان)": (plan.monthlyToman + (bundle?.monthlyToman ?? 0)).toLocaleString("en") };
        }
        return {
          ...(price ? { details: price } : {}),
          kind: name === "runShellCommand" ? "command" : "liara",
          title: m?.label ?? name,
          summary: m ? m.summary(input) : name,
          risk: m?.risk ?? "medium",
          target: m ? String(m.target(input) ?? "") : undefined,
          confirmText: m?.confirmText?.(input),
          command: name === "runShellCommand" ? String(input.command) : undefined,
        };
      },
      run: async (args, ctx, ui) => {
        const r = await (def.run as (c: unknown, i: unknown) => Promise<unknown>)(ctx.liara, (def.input as z.ZodTypeAny).parse(args));
        // Secrets (e.g. a new root password) go to the browser once as a UI event and never into the model's context or the checkpoint.
        if (r && typeof r === "object" && "secret" in r) {
          const { secret, ...rest } = r as { secret?: { label: string; value: string } };
          if (secret) ui("secret", secret);
          return { ...rest, secret: secret ? "shown to the user only; you cannot see it and must not ask for it" : undefined };
        }
        return r;
      },
    }),
  ]),
);

const pick = (src: Record<string, AgentTool>, names: string[]) => names.filter((n) => src[n]).map((n) => src[n]);

// ---------- supervisor helpers ----------

const updatePlan = defineTool({
  name: "updatePlan",
  description: "Show or update the user-facing plan as a checklist. Call it at the start of multi-step work and when a step finishes.",
  schema: z.object({ steps: z.array(z.object({ title: z.string(), status: z.enum(["todo", "doing", "done", "skipped"]) })).min(1).max(10) }),
  kind: "read",
  run: async (a, _ctx, ui) => {
    ui("plan", { steps: a.steps });
    return { ok: true };
  },
});

const recommendAppPlanTool = defineTool({
  name: "recommendAppPlan",
  description:
    "Recommend a Liara app plan and feature bundle for a platform, with monthly prices in Toman, plus every available plan. Use before createApp, and when the user asks which plan they need. Pass minRamGB if the code clearly needs more (ML models, headless browsers, big workers).",
  schema: z.object({ platform: z.string().describe("e.g. node, next, python, django, docker, static"), minRamGB: z.number().min(0.5).max(64).optional() }),
  kind: "read",
  run: async (a, ctx) => recommendAppPlan(ctx.liara, a.platform, a.minRamGB),
});

const getPlatformLimits = defineTool({
  name: "getPlatformLimits",
  description: "Known limits of Liara's APIs (what Yara cannot see or do, e.g. VM CPU/RAM, domain registrar steps, payments) and the workaround for each. Check it before telling the user something is impossible, and quote it when you hit one.",
  schema: z.object({}),
  kind: "read",
  run: async () => PLATFORM_LIMITS.map(({ id, title, detail, workaround }) => ({ id, title, detail, workaround })),
});

// ---------- monitoring ----------

const probeApp = defineTool({
  name: "probeApp",
  description:
    "Request the app's public URL like a visitor would and report HTTP status and latency (several samples). Use it to confirm an outage (e.g. a 500), to measure slowness, and ALWAYS after a fix to prove the site serves again. Only the app's own URLs can be probed.",
  schema: z.object({ app: z.string().min(1), path: z.string().optional().describe("e.g. /health or /api/status; default /"), samples: z.number().int().min(1).max(5).default(3) }),
  kind: "read",
  run: async (a, ctx) => {
    const { project } = await ctx.liara.get<{ project: Project }>(`/v1/projects/${enc(a.app)}`);
    if (project.scale === 0) return { app: a.app, on: false, note: "The app is turned off, so it cannot answer requests." };
    const url = await appUrl(ctx.liara, project, a.path);
    if (!url) return { app: a.app, url: null, note: "The app has no public URL (default subdomain off and no domain), so it cannot be probed from outside. Use logs and status instead.", limit: "probe-no-url" };
    const results = [];
    for (let i = 0; i < a.samples; i++) {
      results.push(await probeUrl(url));
      if (i < a.samples - 1) await new Promise((r) => setTimeout(r, 1000));
    }
    const ok = results.filter((r) => r.ok);
    const ms = ok.map((r) => r.ms).sort((x, y) => x - y);
    return {
      app: a.app,
      url,
      healthy: ok.length === results.length,
      okSamples: `${ok.length}/${results.length}`,
      medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null,
      samples: results.map(({ status, ms, error }) => ({ status, ms, error })),
    };
  },
});

const getMonitoring = defineTool({
  name: "getMonitoring",
  description:
    "Yara's own monitoring state: which apps are watched (interval, last health status, learned latency baseline), open and recent incidents with ranked causes and their timeline (including automatic restarts and whether recovery was verified), scheduled routines, and whether auto-heal is allowed. Use when the user asks how their apps are doing, what happened overnight, or about alerts.",
  schema: z.object({ app: z.string().optional() }),
  kind: "read",
  run: async (a, ctx) => {
    const p = getPolicy(ctx.userId);
    return {
      monitors: listMonitors(ctx.userId)
        .filter((m) => !a.app || m.app === a.app)
        .map((m) => ({ ...m, uptime24hPct: uptime(ctx.userId, m.app) })),
      incidents: listIncidents(ctx.userId, { app: a.app, limit: 10 }).map((i) => ({ ...i, causes: i.causes.slice(0, 3), timeline: i.timeline.slice(-8) })),
      routines: listRoutines(ctx.userId),
      policy: { autoHeal: p.autoHeal, maxAutoHealsPerAppHour: p.maxAutoHealsPerAppHour, allowRoutines: p.allowRoutines },
      note: "Monitoring runs on Yara's server every minute; Liara itself offers no alerting API. The user changes auto-heal in Settings → Governance.",
    };
  },
});

const setMonitor = defineTool({
  name: "setMonitor",
  description:
    "Turn Yara's continuous monitoring on or off for an app: a health check every intervalMin minutes (URL probe, CPU/RAM vs plan, error logs), incidents with ranked causes, optional alerts, and (if the user's policy allows) automatic restart with verified recovery. Offer it after a first deploy or after fixing an outage.",
  schema: z.object({
    app: z.string().min(1),
    enabled: z.boolean().default(true),
    intervalMin: z.number().int().refine((n) => INTERVALS.includes(n), `one of ${INTERVALS.join(", ")}`).default(5),
    path: z.string().optional().describe("Health path to probe, e.g. /health"),
    autoHeal: z.boolean().optional().describe("Allow automatic restarts for this app (only effective if auto-heal is on in the policy)"),
  }),
  kind: "write",
  approval: (a) => ({
    kind: "liara",
    title: a.enabled ? "روشن کردن پایش مداوم" : "خاموش کردن پایش",
    summary: a.enabled
      ? `برنامه‌ی **${a.app}** هر ${a.intervalMin.toLocaleString("fa-IR")} دقیقه بررسی می‌شود (پاسخ سایت، CPU و RAM، لاگ خطا). اگر مشکلی پیدا شود حادثه ثبت و به شما خبر داده می‌شود.${a.autoHeal ? " ری‌استارت خودکار هم برای این برنامه مجاز می‌شود (اگر در سیاست حساب روشن باشد)." : ""}`
      : `پایش برنامه‌ی **${a.app}** متوقف می‌شود.`,
    risk: a.autoHeal ? "medium" : "low",
    target: a.app,
    details: { "بازه": `${a.intervalMin} min`, "مسیر": a.path ?? "/" },
  }),
  run: async (a, ctx) => {
    const monitor = upsertMonitor(ctx.userId, a.app, { enabled: a.enabled, intervalMin: a.intervalMin, path: a.path, autoHeal: a.autoHeal });
    if (!a.enabled) return { monitor };
    const first = await checkApp(ctx.userId, ctx.liara, a.app);
    return { monitor, firstCheck: { status: first.diagnosis.status, summary: first.diagnosis.summary, topCauses: first.diagnosis.causes.slice(0, 2) } };
  },
});

const scheduleRoutine = defineTool({
  name: "scheduleRoutine",
  description:
    "Schedule a repetitive operation that Yara then runs on its own: a database backup (dbBackup: databaseId), an app disk backup (diskBackup: app + disk), or an app restart (restartApp: app). Daily at `hour` (Tehran time), or weekly if weekday is set (0 = Sunday … 6 = Saturday). Each run is checked against the policy and recorded in the audit log.",
  schema: z.object({
    kind: z.enum(["dbBackup", "diskBackup", "restartApp"]),
    app: z.string().optional(),
    disk: z.string().optional(),
    databaseId: z.string().optional(),
    databaseName: z.string().optional(),
    hour: z.number().int().min(0).max(23),
    weekday: z.number().int().min(0).max(6).optional(),
  }),
  kind: "write",
  approval: (a) => {
    const days = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
    const when = `${a.weekday !== undefined ? `هر ${days[a.weekday]}` : "هر روز"} ساعت ${String(a.hour).padStart(2, "0")}:۰۰ به وقت تهران`;
    const what = a.kind === "dbBackup" ? `پشتیبان‌گیری از دیتابیس **${a.databaseName ?? a.databaseId}**` : a.kind === "diskBackup" ? `پشتیبان‌گیری از دیسک **${a.disk}** برنامه‌ی **${a.app}**` : `ری‌استارت برنامه‌ی **${a.app}**`;
    return {
      kind: "liara",
      title: "زمان‌بندی کار تکراری",
      summary: `${what}، ${when}، بدون پرسیدن دوباره اجرا می‌شود. هر اجرا در سوابق تغییرات ثبت می‌شود و از صفحه‌ی پایش قابل توقف یا حذف است.`,
      risk: "medium",
      target: a.app ?? a.databaseName ?? a.databaseId,
    };
  },
  run: async (a, ctx) => ({
    routine: createRoutine(ctx.userId, {
      kind: a.kind,
      target: a.kind === "dbBackup" ? { databaseId: a.databaseId ?? "", name: a.databaseName ?? a.databaseId ?? "" } : a.kind === "diskBackup" ? { app: a.app ?? "", disk: a.disk ?? "" } : { app: a.app ?? "" },
      hour: a.hour,
      weekday: a.weekday ?? null,
    }),
  }),
});

const domainGuideTool = defineTool({
  name: "domainGuide",
  description:
    "Guided custom-domain setup, step by step: whether the domain is attached in Liara, what public DNS answers right now (live lookup), the exact records the user must enter at the registrar (IRNIC for .ir, with how-to), Liara verification and SSL. Shown to the user as a checklist card with a re-check button. Call it first for any domain request, after each step you take (addDomain, enableDomainSsl), and with recheck: true when the user says they changed DNS.",
  schema: z.object({ domain: z.string().min(3), app: z.string().optional(), recheck: z.boolean().optional() }),
  kind: "read",
  run: (a, ctx) => domainGuide(ctx.liara, a.domain, { app: a.app ?? ctx.app, recheck: a.recheck }),
});

// ---------- per-agent tool sets ----------

const ws = (names: string[]) => workspaceTools.filter((t) => names.includes(t.name));

export const AGENT_TOOLS = {
  supervisor: [updatePlan, getPlatformLimits, recommendAppPlanTool, getMonitoring, ...ws(["listWorkspaces"]), ...pick(liaraReadTools, ["listApps", "listVMs", "getAccountOverview"])],
  deploy: [
    probeApp,
    domainGuideTool,
    setMonitor,
    ...ws(["listWorkspaces", "listFiles", "readFile", "searchCode", "detectProject", "runCommand", "writeFile", "editFile", "gitChanges"]),
    ...deployTools,
    ...pick(liaraReadTools, ["listApps", "getApp", "getAppReleases", "getAppLogs", "getAppEvents", "diagnoseApp", "searchLiaraDocs", "readLiaraDocsPage"]),
    ...pick(liaraActionTools, ["setEnvVars", "createApp", "createDisk", "setAppFeature", "restartApp"]),
    recommendAppPlanTool,
    rollbackChange,
    getPlatformLimits,
    updatePlan,
  ],
  debug: [
    probeApp,
    ...workspaceTools,
    ...deployTools.filter((t) => t.name === "getBuildLogs"),
    ...pick(liaraReadTools, ["getApp", "getAppLogs", "getAppReleases", "getAppEvents", "diagnoseApp", "searchLiaraDocs", "readLiaraDocsPage"]),
    ...pick(liaraActionTools, ["runShellCommand"]),
    rollbackChange,
    getPlatformLimits,
    updatePlan,
  ],
  ops: [
    ...Object.values(liaraReadTools),
    ...Object.values(liaraActionTools).filter((t) => t.name !== "deployRelease"),
    probeApp,
    domainGuideTool,
    getMonitoring,
    setMonitor,
    scheduleRoutine,
    recommendAppPlanTool,
    rollbackChange,
    getPlatformLimits,
    updatePlan,
  ],
} satisfies Record<string, AgentTool[]>;

export const ALL_TOOLS: Record<string, AgentTool> = Object.fromEntries(Object.values(AGENT_TOOLS).flat().map((t) => [t.name, t]));
