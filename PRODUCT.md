# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers and small teams who host apps on Liara (Iranian PaaS) and operate them themselves: they deploy, watch logs, fix crashes, manage env vars, domains, databases, DNS and object storage. Most are Persian-speaking; many write technical terms in English. They come to Yara mid-task, usually when something is broken or about to ship.

## Product Purpose

Yara (یارا) is an AI DevOps assistant for Liara. A user connects their own Liara API token, then asks in Persian or English. Yara reads live account data (apps, logs, releases, metrics, domains, databases, DNS, buckets) and the official docs, then diagnoses and proposes fixes. Success is a problem diagnosed from real evidence and fixed in one conversation, without leaving for the console.

## Positioning

An independent tool that works with Liara. It is not affiliated with or endorsed by Liara, and must never look like an official Liara product or use Liara's logo or marks. Its mechanism: an agent that reads live account state, grounds answers in docs.liara.ir, and changes infrastructure only through an explicit approval step per action. High-risk actions need the resource name typed to confirm.

## Operating Context

- Used in a browser, on desktop most of the time, sometimes on a phone during an incident.
- Sessions are task-shaped: a user reports a symptom ("502 after deploy"), Yara runs read tools, shows evidence (log lines, release states, memory curves), then proposes one change at a time.
- The LLM runs through an OpenAI-compatible gateway configured by the operator (currently GapGPT, model `gapgpt-qwen-3.6`; Liara AI is supported). The operator pays for model usage.

## Capabilities and Constraints

- Read tools run automatically. Write actions pause for approval in the UI and are executed and re-validated server-side.
- Accounts: email + password sign-up and login. Each user stores their own Liara token (encrypted at rest) and team ID. Conversations are saved per user on the server.
- First-run onboarding connects the Liara token and explains what Yara can and cannot do.
- A public landing page explains Yara before sign-up.
- Persian-first, right-to-left UI. Replies follow the language of the user's message.
- Stack: Next.js (App Router), AI SDK v5, SQLite storage; deployable to Liara (Next.js platform, persistent disk for the database).
- No email delivery yet, so there is no email verification and no password-reset email.
- Access keys for object storage are not created through Yara (the secret would pass through the model).

## Brand Commitments

- Name: Yara / یارا. The Persian name leads.
- Typeface: YekanBakh (user-supplied, variable font).
- Must not imitate Liara's branding.
- Visual register (user decision, 2026-10-19): modern, sleek product-tool aesthetics at the craft level of Linear and Raycast. No metaphor-driven worlds (no forms, stamps, transit, kitchens, airports or other off-topic carriers). Keyboard-first.

## Evidence on Hand

- No testimonials, customer logos, usage numbers, or benchmarks exist. Do not invent any.
- Real capabilities are listed in README.md and `lib/tools.ts` / `lib/actions.ts`; landing copy may only claim these.

## Product Principles

1. Evidence before advice: show the log line, release state or metric that justifies a conclusion.
2. Nothing changes without a human yes. Approval is the product's spine, not a modal afterthought.
3. Calm under incident: the interface lowers stress when an app is down.
4. Persian-native, not translated: RTL, Persian numerals where natural, English kept for identifiers.
5. Honest about limits: say what failed and what Yara cannot do.

## Accessibility & Inclusion

- RTL layout must be correct throughout, including mixed Persian/English text, code and logs (always LTR).
- Keyboard-operable approval flow; visible focus; reduced-motion respected; WCAG AA contrast.
