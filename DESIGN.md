---
name: Yara
description: A Persian-first, keyboard-first ops workbench for apps on Liara, with an AI engineer whose changes run only on approval.
colors:
  accent: "#4f8bff"
  accent-hover: "#6b9dff"
  accent-ink: "#ffffff"
  accent-soft: "rgb(79 139 255 / 0.15)"
  accent-line: "rgb(79 139 255 / 0.5)"
  editor-graphite: "#1e1f22"
  sidebar-graphite: "#181a1f"
  raised-graphite: "#232529"
  seam-graphite: "#2b2d31"
  border-strong: "#3a3d43"
  hover-veil: "rgb(255 255 255 / 0.05)"
  active-veil: "rgb(255 255 255 / 0.085)"
  text: "#dfe1e5"
  text-2: "#a8abb2"
  text-3: "#868a93"
  ok: "#3fbf86"
  ok-soft: "rgb(63 191 134 / 0.14)"
  warn: "#e6a740"
  warn-soft: "rgb(230 167 64 / 0.14)"
  danger: "#f25c63"
  danger-soft: "rgb(242 92 99 / 0.13)"
  terminal-black: "#141518"
  scrim: "rgb(0 0 0 / 0.55)"
  light-accent: "#005fb8"
  light-accent-hover: "#0258a8"
  light-editor: "#ffffff"
  light-sidebar: "#f3f3f3"
  light-raised: "#f8f8f8"
  light-seam: "#e5e5e5"
  light-text: "#1f1f1f"
  light-text-2: "#555a62"
  light-text-3: "#6b7078"
typography:
  display:
    fontFamily: "YekanBakh, Vazirmatn, Tahoma, system-ui, sans-serif"
    fontSize: "clamp(2.6rem, 6.2vw, 5.2rem)"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "YekanBakh, Vazirmatn, Tahoma, system-ui, sans-serif"
    fontSize: "clamp(1.7rem, 3.2vw, 2.6rem)"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "YekanBakh, Vazirmatn, Tahoma, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 750
    lineHeight: 1.3
  body:
    fontFamily: "YekanBakh, Vazirmatn, Tahoma, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
  prose:
    fontFamily: "YekanBakh, Vazirmatn, Tahoma, system-ui, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.85
  label:
    fontFamily: "YekanBakh, Vazirmatn, Tahoma, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 700
    lineHeight: 1.3
  mono:
    fontFamily: "Cascadia Mono, JetBrains Mono, ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "14px"
  pill: "999px"
spacing:
  hair: "2px"
  xs: "6px"
  sm: "8px"
  md: "14px"
  lg: "20px"
  xl: "28px"
  bar: "35px"
  status: "24px"
components:
  button-default:
    backgroundColor: "{colors.raised-graphite}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-default-hover:
    backgroundColor: "{colors.seam-graphite}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.hover-veil}"
    textColor: "{colors.text}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-3}"
    rounded: "{rounded.sm}"
    size: "28px"
  input:
    backgroundColor: "{colors.sidebar-graphite}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: "36px"
  pill-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "22px"
  pill-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "22px"
  editor-tab:
    backgroundColor: "{colors.sidebar-graphite}"
    textColor: "{colors.text-3}"
    padding: "0 6px 0 12px"
    height: "35px"
  editor-tab-active:
    backgroundColor: "{colors.editor-graphite}"
    textColor: "{colors.text}"
  explorer-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    height: "26px"
  explorer-row-active:
    backgroundColor: "{colors.active-veil}"
    textColor: "{colors.text}"
  box:
    backgroundColor: "{colors.editor-graphite}"
    rounded: "{rounded.lg}"
    padding: "14px"
  approval-card:
    backgroundColor: "{colors.sidebar-graphite}"
    rounded: "{rounded.lg}"
    padding: "14px"
  status-cell-attention:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.xs}"
    height: "22px"
---

# Design System: Yara

## Overview

**Creative North Star: "The Editor You Already Live In"**

Yara is an ops console wearing the VS Code workbench: activity bar, explorer tree, editor tabs, a bottom panel for Console and Logs, a status bar, and Yara herself in a full-height, resizable chat sidebar opposite the explorer (the left edge in RTL), with conversation history inside it. Resources lead and the assistant works beside them; there is no centered-chatbot layout anywhere in the app. The register is a Linear/Raycast-grade product tool: dense, quiet, precise, keyboard-first (Ctrl+K palette, Ctrl+J panel, Ctrl/⌘+Enter to approve).

The world is dark editor graphite first, with a mirrored light theme driven by `prefers-color-scheme` and a `data-theme` override. Color does almost no decorative work: depth comes from three graphite steps and one-pixel seams, state comes from soft-tinted pills and dots, and a single blue accent marks focus, the active tab, the active activity item and anything that needs your yes. Terminal surfaces (console, logs) stay terminal-black in both themes.

Everything is Persian-first and right-to-left, set in YekanBakh with a monospace face for shell, logs, identifiers and code, which are always isolated LTR.

**Key Characteristics:**
- Workbench grid: 48px activity bar, explorer (248px default), editor column, Yara sidebar (420px default), 24px status bar.
- Three graphite tones plus 1px seams; no decorative shadows inside the workbench.
- One accent, blue; status via green / amber / red soft tints.
- 35px chrome rows, 26px tree rows, 40px table rows: a compact, editor-dense rhythm.
- Approval is a first-class card with an accent ring, risk pill, and keyboard approval.
- Logical properties throughout (`inset-inline`, `padding-inline`, `border-inline-*`) so RTL is native, not flipped.

## Colors

A graphite neutral ramp carrying one blue accent and three status hues, each status paired with a ~14% soft tint for backgrounds.

### Primary
- **Workbench Blue** (accent; light theme uses Light Workbench Blue): focus rings (2px outline, 2px offset), the 1px top line on the active editor tab, the 2px bar beside the active activity button, primary buttons, link text, sparklines and meter fills, resize handles on hover (as accent-line), the activity and status-bar attention badges, and the approval card's ring. Accent-soft fills selection, input focus halos (3px) and the approval ring; accent-line underlines links and outlines the pending approval card.

### Secondary
- **Running Green** (ok): live/up dots (with a 3px ok-soft halo), success pills, success icon wells.
- **Caution Amber** (warn): warning pills, hot meter fills, the inline destructive-confirm strip (amber border on warn-soft).
- **Incident Red** (danger): down dots, failed pills, critical meters, error text, danger buttons for high-risk approvals, the alert banner (35% danger border over danger-soft).

### Neutral
- **Editor Graphite** (editor-graphite / light-editor): the editor canvas, the active tab, the bottom panel, content boxes.
- **Sidebar Graphite** (sidebar-graphite / light-sidebar): activity bar, explorer, tab strip, Yara sidebar, status bar, inputs, approval cards, dialogs and palette.
- **Raised Graphite** (raised-graphite / light-raised): default buttons, box headers, table header rows, approval and dialog footers, kbd keys.
- **Seam Graphite** (seam-graphite / light-seam): every 1px divider between workbench regions, rows and card sections; also the third surface step (hover on default buttons, inline code, meter tracks, skeletons).
- **Strong Seam** (border-strong): control borders (buttons, inputs, composer, dialogs) and scrollbar thumbs.
- **Text ramp** (text / text-2 / text-3): primary content; secondary labels and inactive-but-readable rows; tertiary metadata, icons, placeholders, column heads.
- **Hover / Active veils**: translucent white (dark) or black (light) washes for row hover and current-row state, so they work on any surface step.
- **Terminal Black** (terminal-black): console and log streams in both themes (the light theme sets it to editor graphite #1e1f22, still dark). Log text #c9ccd2, timestamps #7d828c, errors #ff8a90; xterm uses foreground #d9dce1 and the accent as cursor.

### Named Rules
**The One Blue Rule.** Blue is the only hue that means "this is where you are or what needs you": focus, current tab, current activity, primary action, pending approval. Never use it as decoration or for a second meaning.

**The Soft-Tint Status Rule.** Status color appears as text on its own ~14% tint (pill) or as a dot with a 3px tint halo. Solid status fills are reserved for meter bars and the danger button.

**The Terminal Stays Dark Rule.** Console and log surfaces are terminal-black in every theme; their text colors are fixed, not theme tokens.

## Typography

**Display Font:** YekanBakh (variable, weight 100–950, self-hosted), falling back to Vazirmatn, Tahoma, system-ui
**Body Font:** YekanBakh
**Label/Mono Font:** Cascadia Mono, JetBrains Mono, ui-monospace, Consolas

**Character:** One Persian variable family does all the talking, its weight axis (400–800, including 650 and 750 steps) carrying hierarchy instead of size jumps; the monospace face marks anything the machine said.

### Hierarchy
- **Display** (800, clamp(2.6rem, 6.2vw, 5.2rem), 1.15, -0.025em, max 18ch): landing hero only.
- **Headline** (800, clamp(1.7rem, 3.2vw, 2.6rem), 1.2, -0.02em): landing section heads; the closing line runs to clamp(1.9rem, 4vw, 3.2rem).
- **Title** (750, 20px): page heads in the editor; 22px for auth and settings pages; 22px/750 tabular for headline stats.
- **Body** (400, 14px, 1.7): the base for every app surface. Controls run 13–13.5px, weight 600 on buttons.
- **Prose** (400, 14.5px, 1.85): Yara's markdown replies (14px inside the sidebar), inner headings 15px/700.
- **Label** (700, 11.5–12.5px): explorer headers and groups, table column heads, panel tabs, box headers, chat title. Never uppercase, never letter-spaced (Persian has no case).
- **Mono** (12px, 1.6): logs, JSON, code blocks (12.5px), resource targets, kbd keys (11px).

### Named Rules
**The LTR Island Rule.** Code, logs, JSON, resource names, team IDs and confirm-to-type fields are mono or isolated `direction: ltr` inside the RTL flow, every time.

**The Tabular Numbers Rule.** Any number that updates or compares (stats, metrics, table cells, timestamps) uses `tabular-nums`.

## Layout

The app is one CSS grid: `48px | explorer | editor | Yara` columns over a `1fr | 24px` row pair, filling 100dvh. Explorer and Yara collapse to 0 by toggling `data-side` / `data-chat`; Yara's width is drag-resizable from its inner edge (a 5px handle that lights accent-line). The editor column stacks a 35px tab strip, the scrolling editor, and an optional bottom panel (Console, Logs), closed by default, resizable from a 6px top handle, height min(--panel-h 300px, 45vh), and maximizable.

Pages inside the editor are a max-1200px grid with 22px 28px 40px padding and 20px gaps. The editor is a size container: under 760px of its own width (for example when Yara's sidebar is open), `.hide-sm` columns drop and two-column `.cols` (1.4fr / 1fr) stack. Under 900px viewport, the grid becomes `44px | 0 | 1fr | 0` and the explorer and Yara become fixed overlays above the status bar with the large shadow.

Rhythm: chrome rows at 35px (tabs, panel tabs, explorer and chat heads), tree rows 26px, table rows 40px with 32px heads, status cells 22px in a 24px bar. Gaps cluster at 2, 6, 8, 14, 20 and 28px. The landing page uses max-1200px sections with clamp() padding and a scaled-down live workbench as its hero image.

## Elevation & Depth

Inside the workbench the system is flat and tonal: regions separate by graphite step and 1px seams, never by shadow. Shadows are reserved for things that float over the workbench: the command palette, dialogs, the landing composer and hero shot, and the explorer/Yara overlays on narrow screens. Focus and approval use rings (spread box-shadow) rather than lift.

### Shadow Vocabulary
- **Hairline lift** (`--shadow-sm`: `0 1px 2px rgb(0 0 0 / 0.35)`, light `0.06`): primary buttons (with a 1px inner top highlight), the logo mark, the checked segment of a segmented control.
- **Floating layer** (`--shadow-lg`: `0 0 0 1px rgb(255 255 255 / 0.06), 0 16px 48px -12px rgb(0 0 0 / 0.65), 0 4px 12px -4px rgb(0 0 0 / 0.4)`; light uses a black 6% ring and softer drops): palette, dialogs, overlays, hero shot.
- **Focus halo** (`0 0 0 3px` accent-soft): focused inputs.
- **Approval ring** (`0 0 0 4px` accent-soft plus accent-line border): a pending approval card; it drops to a plain seam border once resolved.

### Named Rules
**The Seams Not Shadows Rule.** Docked regions (activity bar, explorer, tabs, panel, Yara sidebar, status bar) are separated only by 1px seam borders. A shadow means the thing is floating.

## Shapes

Small, consistent radii: 4px on icon buttons, explorer-adjacent controls and compact selects; 6px on buttons, inputs, palette rows and segmented controls; 8px on content boxes, approval cards, code blocks and steps; 14px only on floating layers (palette, dialogs, composer) and 16px on the landing hero shot. Pills and dots are fully round. Indicators are hairlines: a 1px accent line across the top of the active tab, a 2px rounded bar beside the active activity button, a 1px underline under the selected panel tab. Meters are 4px tall with 2px radius. The kbd key has a 2px bottom border to read as a physical key.

## Components

### Buttons
Compact, quiet, and confident.
- **Shape:** gently rounded (6px), 32px tall, 12px inline padding, weight 600 at 13.5px; large variant 40px, 18px padding, 10px radius (landing CTAs).
- **Primary:** blue fill, white ink, hairline lift plus a 1px inner top highlight.
- **Default:** raised graphite on a strong-seam border.
- **Hover / Active:** fill steps (raised to seam graphite; accent to accent-hover) in 140ms on the expo-out ease; press scales to 0.98. Disabled is 45% opacity.
- **Ghost:** transparent, text-2, hover veil. **Danger:** red fill, used for high-risk approval and destructive confirms.
- **Icon button:** 28px square, 4px radius, text-3 that brightens on hover. Buttons may carry an inline kbd hint, hidden on touch.

### Chips (pills and dots)
- **Style:** 22px fully round pill, 12px/600, status text on its own soft tint; neutral pill is text-2 on the hover veil; accent pill for building/queued.
- **Dots:** 7px, up/down with a 3px halo.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** box on editor graphite; approval, steps, settings cards on sidebar graphite.
- **Shadow Strategy:** none; see Elevation.
- **Border:** 1px seam; headers are 38px raised-graphite bars with a 12.5px/700 text-2 label.
- **Internal Padding:** 14px (16px in settings rows).

### Inputs / Fields
- **Style:** 36px, sidebar graphite, strong-seam border, 6px radius, 11px padding; compact 24px variants (target select, log filter) at 4px radius in panel toolbars.
- **Focus:** border turns accent with a 3px accent-soft halo; no outline.
- **Error / Disabled:** `aria-invalid` turns the border danger; field labels 13px/600, hints 12.5px text-3.

### Navigation
- **Activity bar:** 40px icon buttons in text-3; active or pressed goes to text with a 2px accent bar on the inline-start edge; count badge is a 16px accent pill.
- **Explorer:** 35px head, collapsible groups (11.5px/700) with counts, 26px rows indented 24px, hover veil, current row active veil, trailing metadata 11px text-3.
- **Editor tabs:** 35px, sidebar graphite, separated by inline-end seams; the active tab takes editor graphite and the 1px accent top line; the close button shows on hover or when active.
- **Status bar:** 24px, 12px text-2 cells with 3px radius; the pending-approvals cell turns solid accent.
- **Command palette:** 620px floating layer at 14vh, 50px input, 38px rows, active row on the active veil, kbd legend footer.

### Approval Card (signature)
The product's spine. 8px card on sidebar graphite. While pending it carries an accent-line border and a 4px accent-soft ring; resolved, it falls back to a plain seam. The header row states the decision state with a shield icon and a risk pill (low/medium/high as ok/warn/danger). Body: 15px/700 action title with a mono target chip, a markdown summary, collapsible raw JSON. High-risk actions require typing the resource name into an LTR confirm field. The raised footer holds the reassurance note with a Ctrl/⌘+↵ kbd hint and Deny (ghost) / Approve (primary, or danger when high risk). In the Yara sidebar and under 560px the footer stacks and the buttons share the width. Approval success draws its check stroke in 380ms.

### Yara Sidebar
Full-height column on sidebar graphite with a 35px head (logo mark, conversation title, new / history / close icon buttons). History swaps the thread for a 34px-row list of past conversations with relative times and a hover delete action. Inside, assistant turns drop the avatar column, user turns are raised-graphite bubbles at 8px radius, evidence "steps" are 36px collapsible rows inside a seam-bordered card, and the composer is an 8px box without shadow that takes an accent-line border on focus.

### Data Table
Full-width, 13px, 40px rows with seam bottoms, 32px raised-graphite heads at 11.5px/700 text-3, hover veil per row, row links at 650 that turn accent on hover, inline meters (56×4px) and tabular metrics, trailing row actions at 55% opacity until hover.

## Do's and Don'ts

### Do:
- **Do** separate docked workbench regions with 1px seams and graphite steps (#1e1f22 / #181a1f / #232529), never shadows.
- **Do** keep blue for focus, current location, primary action and pending approval only.
- **Do** show status as tinted pills or haloed dots in the ok / warn / danger family.
- **Do** use logical properties so every layout reads correctly right-to-left.
- **Do** isolate code, logs, identifiers and confirm fields as LTR mono islands.
- **Do** keep chrome on the 35px / 26px / 24px row rhythm and controls at 32px / 36px.
- **Do** route every change through the approval card, with typed confirmation for high-risk actions.
- **Do** give every motion the expo-out ease (cubic-bezier(0.16, 1, 0.3, 1)) at 120–240ms and honor reduced motion.

### Don't:
- **Don't** build a centered-chatbot layout; Yara lives in the sidebar beside the resources.
- **Don't** introduce a second accent hue or use status colors decoratively.
- **Don't** add uppercase or letter-spaced labels; hierarchy comes from YekanBakh's weight axis.
- **Don't** theme the console or logs light; terminal surfaces stay dark.
- **Don't** imitate Liara's branding or use its marks.
- **Don't** use metaphor-driven decoration (stamps, tickets, forms, transit); this is a product tool.
