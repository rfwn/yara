---
version: 1
slug: "app-app"
primary_target: "app/app"
related_targets: ["app/page.tsx","app/login","app/onboarding"]
---

# Surface: Yara workbench (overview, app dashboards, console, logs, Yara panel) + auth/onboarding/landing

Mode: Operate (workbench, auth, onboarding); Persuade for the landing page, in the same world.
Audience: Persian-speaking developers who run apps on Liara and want an ops console with an AI engineer built in, not a chat wrapper.
Task: see every app's health, open an app, read logs, open a shell, and have Yara investigate and propose fixes that run only on approval.

## Direction contract
THESIS: The VS Code workbench, the layout developers live in, as a Liara ops console. Resources lead and Yara works inside them; it refuses the centered-chatbot layout.
OWN-WORLD: Dark editor graphite (#1E1F22 editor, #181A1F side bars, #2B2D31 seams), light theme mirrored, one blue accent #4F8BFF, green/red status, YekanBakh UI with a monospace face for shell, logs and numbers. Activity bar, explorer tree, editor tabs, resizable bottom panel, status bar.
STORY: Land on Overview (every app's status, CPU, memory, last deploy), open an app tab, then use Console, Logs or Yara in the bottom panel; Yara's fixes arrive as approval cards and a status-bar badge.
FIRST VIEWPORT: Activity bar far right (RTL), explorer of apps/databases/buckets/chats, editor showing the Overview table, bottom panel open on Yara, status bar with account, connection and pending approvals.
FORM: Workbench (VS Code-style), rank 1 of 7, seed 4dc1d187 (pick).
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Signature interaction
A real shell in the Console tab (Liara exec over a server-side WebSocket proxy, so the token never reaches the browser). Ctrl+J toggles the panel and Ctrl+K opens the command palette.
