# Yara · یارا

Yara is an AI DevOps assistant for apps hosted on [Liara](https://liara.ir). You ask in Persian or English. Yara reads live account data (apps, logs, releases, metrics, domains, databases, DNS, object storage) and the official docs, finds the cause of a problem with evidence, and proposes fixes. **Nothing changes until you approve it.**

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
| Observability | logs, events, CPU/memory/network | – |
| Domains | domains, SSL, DNS target, re-check | add domain, issue SSL |
| Disks | list | create, back up |
| Databases | list, details, backups, metrics | create, back up, power |
| DNS | zones, records | create / delete records |
| Object storage | buckets, objects, object info, download links | create bucket/folder, public/private, delete |

## How it works

```
Browser ──► /api/chat (session) ──► AI gateway (OpenAI-compatible, tool calling)
   │              └─ read tools ──► api.liara.ir · dns-service · storage-service · docs.liara.ir
   └─ approval ──► /api/actions (session, zod-validated) ──► Liara API
```

- `lib/tools.ts` holds the read tools, which run inside the agent loop.
- `lib/actions.ts` holds the write actions. They are exposed to the model without `execute`, so the stream stops for approval.
- `lib/server/*` covers SQLite storage, auth, encryption, conversation persistence and per-user rate limits.
- `lib/prompt.ts` is the system prompt with Liara operating knowledge.

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
- Rate limits and login throttling are in-memory, so they assume a single instance.
- Endpoint coverage comes from Liara's [OpenAPI specs](https://github.com/liara-cloud/openapi). Some `{id}` paths are called with the app name, and the storage listing tries a few key encodings. Verify both against a real account.
- The operator pays for model usage. `CHAT_REQUESTS_PER_HOUR` caps each user.
