# Yara · یارا

Yara is an AI DevOps assistant for apps hosted on [Liara](https://liara.ir). You ask in Persian or English. A team of agents (coordinator, deploy, debug, ops) reads your live Liara account and your code. They reproduce failures, fix the bug in your source, verify the build and redeploy. **Nothing changes until you approve it.**

Yara is an independent tool. It is not affiliated with or endorsed by Liara.

## Features

- **Accounts.** Email and password sign-up and login, with sessions in httpOnly cookies and scrypt password hashes.
- **Onboarding.** Users connect their own Liara API token. Yara verifies it against Liara before storing it, and stores it encrypted (AES-256-GCM).
- **Saved conversations.** History is stored per user on the server, with rename and delete.
- **Approvals.** Every infrastructure change is an approval card. Ctrl/⌘+Enter approves and Esc moves focus to Deny. High-risk actions need the resource name typed. The server re-validates every action before it calls Liara.
- **Command palette.** Ctrl/⌘+K opens new chat, jump to a chat, check an app, deploy code, settings and theme.
- **Deploy from the browser.** Upload a `.tar.gz`; Yara prepares the release and waits for approval.
- **Docs grounding.** Answers search and read docs.liara.ir live.
- **Persian-first.** The interface is RTL, uses YekanBakh and Jalali dates, and has dark and light themes.

## What it can do

| Area | Read (automatic) | Change (needs approval) |
|---|---|---|
| Apps | list, config, env (secrets masked), one-shot health check | create, delete, restart, power, plan, env vars, features |
| Deploys | releases, build state, git info | deploy uploaded source |
| Observability | logs, events, CPU/memory/network, URL probe (HTTP status + latency), ranked diagnosis | – |
| Monitoring | monitors, health history, incidents, routines | turn monitoring on, schedule backups/restarts; auto-restart only under policy |
| Domains | domains, SSL, DNS target, re-check | add domain, issue SSL |
| Disks | list | create, back up |
| Databases | list, details, backups, metrics | create, back up, power |
| DNS | zones, records | create / delete records |
| Object storage | buckets, objects, object info, download links | create bucket/folder, public/private, delete |
| Virtual machines | VMs, details (credentials never returned), operations, disks, network traffic, plans and OS images | create, delete, start/reboot/shutdown/stop, resize, add/extend/delete disk, reset network, reset root password, unfreeze |

## How it works

Yara is a team of agents built on LangGraph.js:

| Agent | Job |
|---|---|
| Coordinator | Talks to you, plans, and hands each task to the right specialist. It has no file or infrastructure tools of its own. |
| Deploy | Packs a workspace the way `liara deploy` does, uploads it, creates the release and follows the build. On a code failure it hands off to Debug, then redeploys the fix. |
| Debug | Reproduces a build or runtime failure, finds the root cause in your code, edits it as a reviewable diff, and proves the fix with a build or test run. |
| Ops | Logs, metrics, restarts, env vars, plans, domains, databases, DNS and buckets. |

```
Browser ──SSE──► /api/agent ──► LangGraph StateGraph (checkpointed in data/checkpoints.db)
                   coordinator ─handoff─► deploy ⇄ debug ⇄ ops
                        │ read tools run immediately
                        └ write tools ──interrupt()──► approval card ──resume──► run once
```

- `lib/agent/graph.ts` holds the graph: agent nodes, a tools node (reads and safe commands) and an approval node that pauses with `interrupt()` before any write. Each agent can only run its own tools.
- `lib/agent/tools.ts` holds the code, deploy and Liara tools. The UI renders some results as generative cards: plan, command output, deploy pipeline and diff.
- `lib/server/deploy.ts` is a port of the CLI deploy flow: `POST v2/projects/{app}/sources`, `POST v2/projects/{app}/releases`, and polling `GET v2/releases/{id}/build-logs`. These endpoints are not in Liara's public docs. They were read from the source of `@liara/cli`.
- `runner/` is the local runner. It also holds the shared file operations, which keep every path inside the workspace root.

### Governance

The server enforces every rule in this section. A prompt, a log line or a file the agent reads can't loosen any of them.

- **Policy engine** (`lib/agent/policy.ts`). Each proposed change gets one of three verdicts before anything runs:
  - **auto**: safe builds/tests, plus low-risk changes if the user allows them
  - **ask**: an approval card
  - **blocked**
  Users set the policy in Settings → Governance: read-only mode, auto-run safe commands, auto-run low-risk changes, ban deletions, and three rate limits.
- **High-risk changes** (deletes, plan changes, password resets) always need approval and the resource name typed. The server checks the typed text. A wrong confirmation is refused even if the approval button was pressed.
- **Guardrails.**
  - Caps on changes per conversation per hour, per account per hour, and per app per hour for deploys. These stop deploy → fail → redeploy loops.
  - The same change can't be retried after it failed twice.
  - Each agent can only run its own tools.
- **Audit log** (`lib/server/audit.ts`, page `/app/audit`). Every change is recorded, whether it was auto-run, approved, denied or blocked. Each record has the agent, the decision and its reason, inputs with secret values redacted, the result, and the self-verification outcome. It can be exported as CSV or JSON.
- **Rollback points** (`lib/agent/rollback.ts`). Before env vars, plans, power state, app features or code files change, the previous state is saved, encrypted. `rollbackChange(auditId)` restores it, as a new approved change.
- **Secrets stay out of the model.**
  - `.env` files, keys and credential files are read with every value masked.
  - Commands that touch them always need approval, and their output is masked the same way.
  - Secret-looking values in any output are masked.
  - VM root passwords are never sent to the model or stored in the conversation.
- **Prompt injection.** The agents are told that tool output (logs, files, pages) is data, not instructions. Because approvals and limits are enforced on the server, an injected instruction still can't skip them.
- **API limits** (`lib/limits.ts`). This is a list of what Liara's API can't do, with the workaround for each. The agents read it through `getPlatformLimits`, and Settings shows it.

### Monitoring loop

Liara has no alerting or uptime API, so Yara runs its own monitor (`lib/server/monitor.ts`, page `/app/monitoring`).

```
server.mjs ─every 60 s─► POST /api/monitor/tick (in-process HMAC key)
  for each due monitor:  gatherEvidence ─► diagnose ─► record check ─► incident state machine ─► maybe auto-heal ─► verify
  for each due routine:  policy check ─► run action ─► audit (─► verify for restarts)
```

- **Evidence** (`lib/monitor/evidence.ts`). For each app it collects:
  - a probe of the public URL, the way a visitor sees it, retried once before it counts as a failure
  - CPU and RAM over 30 minutes, compared with the plan's limits from `/v1/me`
  - error-like log lines
  - the latest release and platform events
- **Diagnosis** (`lib/monitor/diagnose.ts`). Deterministic rules turn the evidence into a status (`healthy`, `degraded`, `down` or `off`) and causes ranked by confidence. Each cause comes with evidence and a fix. The rules cover:
  - OOM or memory pressure
  - CPU saturation
  - the wrong port or nothing listening
  - missing modules or code errors
  - missing env vars
  - an unreachable database or other dependency
  - a regression from the last deploy
  - a failed deploy
  - slowness measured against the app's learned latency baseline
  - an unresponsive process

  The agents' `diagnoseApp` uses the same engine.
- **Incidents.** One bad check is treated as noise: an incident opens after 2 failed checks in a row (`down`) or 3 (`degraded`), and resolves on the next healthy check. Each incident keeps a timeline. Alerts go to an optional webhook, which is stored encrypted and must be https with no private addresses.
- **Auto-heal** (off by default, Settings → Governance):
  - It runs only when the top cause is one a restart fixes (a stuck process or an OOM kill), never for code errors.
  - It is capped per app per hour. Once the cap is reached, the incident is escalated as "needs you".
  - Every restart is audited as agent `monitor` and verified (two healthy probes in a row) before the incident is closed.
  - Read-only mode and the account change limit also apply.
- **Verification after every agent change.** `restartApp`, env, plan, power, feature and deploy changes made in chat re-probe the app before the result reaches the model. The approval card shows "result checked" with the HTTP status and latency, or "result not confirmed".
- **Routines.** Database backups, disk backups and app restarts can run daily or weekly at a set hour, Tehran time. Creating one is a standing authorisation. Each run is still checked against the policy (it can be paused globally) and recorded in the audit log.

### Network tools and VM SSH

- **Network tab** (bottom panel) and the agents' `netCheck` tool share one command line: `dig`, `http`, `tls`, `port`, `whois`. Yara's own runs appear there too, marked as Yara's.
  - It is not a shell: each verb is implemented with Node's dns/net/tls/http modules, so there is nothing to inject into and nothing else can run.
  - Targets must resolve to public addresses only. The connection is pinned to the checked address, so private, loopback, link-local and cloud-metadata ranges cannot be reached (no SSRF or DNS rebinding).
  - Hard timeouts, size caps, no redirect following, 30 checks per minute per user, and every run is written to the audit log.
- **Domain guide** (`domainGuide`): a checklist card for connecting a domain. It shows who does each step, what Liara reports, what public DNS answers right now, the exact NS or CNAME records with IRNIC how-to for `.ir`, and a re-check button. The registrar step has no API, and the card says so.
- **SSH to VMs** (VM page). The browser opens a WebSocket to `server.mjs`, which uses ssh2 to reach the VM.
  - The single-use ticket is minted only after Liara confirms the VM is the user's, and it fixes the VM's public IP.
  - By default the server reads the VM's root password from Liara at connect time, so it never reaches the browser, the database or the agents. Manual password or key login is the fallback.
  - Host keys are trusted on first use and pinned; a changed key is refused before any credential is sent.
  - Sessions end after 15 minutes idle or 2 hours, and connect and disconnect are audited.

### Virtual machines

VMs use a separate service, `iaas-api.liara.ir` (spec: `spec/Iaas.yaml` in liara-cloud/openapi). Some behavior isn't in the spec. It comes from the CLI and from calls to the real API:

- Power actions are `start`, `reboot`, `shutdown` (graceful) and `stop` (forced).
- Every VM change adds an entry to `/vm/operation/{id}`. Yara snapshots that history before the change and waits for the new entry to reach `SUCCEEDED` or `FAILED`. The approval card then shows the verified result and the VM's final power state.
- `traffic-volume` and `traffic-graph` require `startTimeUnix`, return `{ result: [...] }` in 5-minute buckets, and reject long windows (24 h returns 400).
- VM details include the root password in plain text. Yara drops it on the server. A reset password goes to the browser once, as a UI event. It is never sent to the model and never stored in the conversation.

**What the VM API can't do:** CPU and RAM usage, system or app logs, and running commands inside the VM. The agents say this when a question needs that data. They offer the exact commands to run over SSH, or the Yara runner on the VM.

### Code access

- **Local folder.** In Settings, create a runner token and run `node runner/yara-runner.mjs --server <url> --token <token> --dir .` in your project. The agents can then read, search, build and (after you approve) edit files there. Commands get a minimal environment, so your shell's secrets are not passed through.
- **GitHub.** Add a token and a repository in Settings. Yara clones it on the server. Fixes can be pushed to a new branch and opened as a pull request, each after your approval.

Reading, searching, building and testing run without asking. Code edits, deploys, git pushes and infrastructure changes always wait for your approval.

## Run locally

```bash
npm install
cp .env.example .env.local   # set the AI gateway URL, key and model
npm run dev                  # http://localhost:3000
```

Sign up, connect a Liara API token (console.liara.ir → API), and start a conversation.

## Deploy to Liara

1. Create a **Next.js** app (`yara`, or change `app` in `liara.json`) and a disk named `data`. `liara.json` mounts it at `data/`, where the SQLite database lives.
2. Set the env vars from `.env.example`, with a long random `APP_SECRET`.
3. Run `npm i -g @liara/cli && liara login && liara deploy`.

## Notes and limits

- There is no email delivery, so there's no email verification or password reset yet.
- Rate limits and login throttling are in-memory, so they assume a single instance. The monitoring loop also assumes one instance: two instances would both run checks.
- Monitoring only works while Yara's server is up, and probes only reach public URLs. Apps without a subdomain or domain fall back to status, metrics and logs.
- Endpoint coverage comes from Liara's [OpenAPI specs](https://github.com/liara-cloud/openapi). Some `{id}` paths are called with the app name, and the storage listing tries a few key encodings. Verify both against a real account.
- **GitHub workspaces run commands on the Yara server without a sandbox.** Builds and tests in a cloned repo can read whatever the server process can. Before offering this to people you don't trust, run it in a container or VM per user. The local runner doesn't have this problem, because it runs on the user's own machine.
- Agent quality depends on the model. Small models sometimes stop instead of handing off. The tool results tell the agent what to do next, which helps.
- The operator pays for model usage. `CHAT_REQUESTS_PER_HOUR` caps each user.
