# Canvas / whiteboard — researched backlog

**Status legend:** every item below is `planned` — researched, specified, **not started**. Nothing in this document is built.

> **This is researched backlog, not committed roadmap.** It is the output of a competitor and specification review, kept here so the work does not have to be re-derived. It is not a commitment to build any of it, and it is not ordered by intent — only by cost.
>
> **The committed goal list is `src/shared/roadmap.ts`**, which renders in-app through `RoadmapView.tsx`. That file is the real one. This document deliberately does not touch it, and the whiteboard entry there stays `status: 'partial'` with its existing wording until someone has opened the running app and used the feature.
>
> **Notion was investigated and rejected as a reference.** No native infinite whiteboard could be confirmed from Notion's own documentation — official sources show board (kanban) view, timeline view, Mermaid inside code blocks, and a Miro *connection*, none of which is a canvas. Every source claiming Notion shipped a whiteboard is SEO or vendor marketing, and they contradict each other on the date; a competitor's blog argues the opposite outright. **Obsidian Canvas and the JSON Canvas specification are the reference**, because they are what this app must round-trip with.

---

## The spec, and what this app currently ignores

[JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/). Top level is `nodes` and `edges`, both optional arrays. Nodes are stored **in ascending z-index order** — position in the array *is* the stacking order.

| Field | Where | This app |
|---|---|---|
| `id` `type` `x` `y` `width` `height` | all nodes | used |
| `color` | any node | **preserved, never rendered** |
| `text` | text node | used |
| `file` | file node | used |
| `subpath` (`#heading` or `#^block`) | file node | **preserved, never used** |
| `url` | link node | used |
| `label` | group node | used |
| `background`, `backgroundStyle` (`cover`/`ratio`/`repeat`) | group node | **preserved, never rendered** |
| `fromNode` `toNode` | edge | used |
| `fromSide` `toSide` (`top`/`right`/`bottom`/`left`) | edge | **preserved, but `edgeAnchor()` always derives sides and ignores them** |
| `fromEnd` (default `none`), `toEnd` (default `arrow`) | edge | **preserved, never rendered** |
| `color` | edge | **preserved, never rendered** |
| `label` | edge | **preserved, never rendered** |
| array order | nodes | **not honoured** — the app uses CSS `z-index` instead |

Colour values are either a preset string `"1"`–`"6"` (red, orange, yellow, green, cyan, purple) or a hex string such as `"#FF0000"`.

### The four fidelity gaps

`planned` · These are not missing features. They are places where a board authored in Obsidian **renders wrongly here**. No data is lost — the preservation rule holds and every field survives the round trip — but the board does not look like the user's board.

1. `planned` — **Arrowheads are never drawn.** `toEnd` defaults to `arrow` when absent, so *every* edge authored in Obsidian currently appears here as a plain line.
2. `planned` — **Explicit `fromSide` / `toSide` are overridden.** `edgeAnchor()` always derives the nearest pair from geometry, so an edge the user deliberately routed renders differently here than in Obsidian.
3. `planned` — **Card and edge colours vanish.** `color` is carried through the file untouched and never painted.
4. `planned` — **Edge labels vanish.** `label` is carried through and never painted.

---

## NATIVE — representable in JSON Canvas today

Ranked by build cost against the current `CanvasView.tsx` and `canvas.css`, cheapest first.

**File scope tags:** **[2 files]** = `CanvasView.tsx` + `canvas.css` only · **[3 files]** = also needs a prop threaded through `MainCanvas.tsx` · **[BLOCKED]** = needs `src/main/vault.ts` or `src/shared/ipc.ts`, both currently off limits.

### Tier 1 — hours each, and they close the fidelity gaps above

| # | Item | Field | Scope | Status |
|---|---|---|---|---|
| 1 | Draw arrowheads. One SVG `<marker>` in CSS, two attributes on the existing `<line>`. Must default `toEnd` to `arrow` when absent or the fix is half done. | `edge.fromEnd` / `edge.toEnd` | [2 files] | `planned` |
| 2 | Honour explicit sides when present, fall back to `edgeAnchor()` when not. A branch in front of a function that already exists and is tested. | `edge.fromSide` / `toSide` | [2 files] | `planned` |
| 3 | Zoom to fit / zoom to selection. Nothing persisted; `fit()` already exists at `CanvasView.tsx:194`. | — | [2 files] | `planned` |
| 4 | Render edge labels. An SVG `<text>` at the line midpoint. | `edge.label` | [2 files] | `planned` |
| 5 | Card and edge colours. Presets `"1"`–`"6"` map to a `data-color` attribute and six token-based CSS rules. | `color` | [2 files] | `planned` |
| 6 | Duplicate a card — clone with a fresh `canvasId()` and an offset. Alt+drag in Obsidian. | — | [2 files] | `planned` |
| 7 | Selection state, single and multi. Pure UI, nothing persisted. Prerequisite for most of tier 2. | — | [2 files] | `planned` |

> **Constraint on item 5.** `review-s2-vault-pane.test.mjs` bans hex literals and inline style objects in this pane. Preset colours are fine as CSS rules; arbitrary hex values must go through `style.setProperty` on a CSS custom property — the pattern `appearance.ts` already uses — never `style={{}}`.

### Tier 2 — around a day each

| # | Item | Field | Scope | Status |
|---|---|---|---|---|
| 8 | Honour array z-order, and bring-to-front on select. Replaces the CSS `z-index` hack that currently keeps groups behind cards. Cheap in code, but it reverses an existing decision, so it wants care. | node array order | [2 files] | `planned` |
| 9 | Resize a card — corner and edge handles, reusing save-on-release. | `width` / `height` | [2 files] | `planned` |
| 10 | Create a group around the selection. Needs item 7 first. | `group` node + `label` | [2 files] | `planned` |
| 11 | Edit a group label. Reuses the text editor already built. | `group.label` | [2 files] | `planned` |
| 12 | Add a link card. A small URL prompt; the card already renders. Keep it non-clickable — this is a renderer with node integration, and an `<a>` would open an arbitrary URL in the app's own window. | `url` | [2 files] | `planned` |
| 13 | Snap to grid. Pure UI, rounds `x`/`y` on drop. A setting in Obsidian. | — | [2 files] | `planned` |
| 14 | Reconnect or redirect an existing edge. | `fromNode` / `toNode` | [2 files] | `planned` |

### Tier 3 — needs a prop that does not reach the view yet

| # | Item | Field | Scope | Status |
|---|---|---|---|---|
| 15 | Add a file card by picking a note. The vault tree already exists in `CanvasList`; `CanvasView` never receives it. Threading it through is a `MainCanvas.tsx` edit, not a `vault.ts` one. | `file` | [3 files] | `planned` |
| 16 | Link to a heading or block inside a file card. Trivial once 15 exists, but needs a heading list the tree does not carry. | `subpath` | likely [BLOCKED] | `planned` |

### Tier 4 — native by the spec, blocked by this app's architecture

| # | Item | Why blocked | Scope | Status |
|---|---|---|---|---|
| 17 | Media cards — images, PDFs, audio | Renderer CSP is `default-src 'none'`; it cannot load `file://` assets without a new channel. | [BLOCKED] | `planned` |
| 18 | Group background images (`background`, `backgroundStyle`) | Same CSP problem. | [BLOCKED] | `planned` |
| 19 | Web page cards (Obsidian renders these in an iframe) | `connect-src 'none'` forbids it, and loading arbitrary remote content into this window would be a real security regression, not a config change. **Arguably should stay blocked.** | [BLOCKED] | `planned` |

---

## DESTRUCTIVE — native, but needs an explicit ask before anyone builds them

All of these are trivially representable: remove from `doc.nodes` or `doc.edges`. That is exactly why they are dangerous — the code is easy and the consequences are not.

| Item | Note | Status |
|---|---|---|
| Delete a card | Must also delete every edge referencing it. The view silently skips dangling edges at `CanvasView.tsx:392-394`, so the corruption would be invisible here and only show up when Obsidian opened the file. | `planned` |
| Delete an edge | | `planned` |
| Cut / clear selection | | `planned` |
| "Convert to file" (Obsidian's own) — turn a text card into a real note | Writes a new markdown file and rewrites the node from `text` to `file`. **[BLOCKED]** anyway. | `planned` |
| "Swap file" on a file card | Replaces what the card points at. | `planned` |

> **Recommendation, and it stands until overruled: no delete of any kind ships before an undo or an explicit confirm.**
>
> There is no undo in this view. Every one of these writes straight through `save()`, which does take a pre-write backup, so recovery exists but is manual and the user has to know to look. This is a product call, not an agent's.

---

## EXTENSION — needs data the spec has no field for

> **The assumption underneath this entire section is unverified.** The spec does not require a reader to preserve unknown keys. **This app does, deliberately.** Whether *Obsidian* does is undocumented, and it was not tested. Until someone measures it, assume anything stored in a non-spec key may be **silently dropped the next time Obsidian saves that file**.
>
> Testing this is cheap and should happen before any item below is built: write a canvas with a junk key, open and move something in Obsidian, read the file back.

| Item | Status |
|---|---|
| Freehand drawing / ink strokes (the spec has no geometry primitive) | `planned` |
| Shapes — rectangle, ellipse, diamond, arrow-as-object | `planned` |
| Sticky-note styling beyond `color` | `planned` |
| Per-card font, size, or alignment | `planned` |
| Edge routing style (curved, elbow, orthogonal) and manual waypoints | `planned` |
| Locked or pinned cards | `planned` |
| Layers | `planned` |
| Comments and annotations | `planned` |
| Presentation mode with a slide order | `planned` |
| Card icons or emoji | `planned` |
| Board-level metadata: title, description, tags | `planned` |
| Templates | `planned` |

**The safe design for any of these is a sidecar file** — `<board>.canvas.meta.json` beside the board, never inside it. The `.canvas` file stays exactly spec-conformant, Obsidian round-trips it untouched, and this app's extra data lives somewhere Obsidian will never rewrite. It costs a second file write, so it is **[BLOCKED]** today, but it is the design worth choosing when that block lifts.

Obsidian's own [Advanced Canvas](https://community.obsidian.md/plugins/advanced-canvas) plugin already does the in-file version of several of these. That is evidence the approach *can* work, not evidence it is safe — a plugin author who breaks their own users is a different risk profile from an app breaking someone else's vault.

---

## INCOMPATIBLE — do not build these

A feature that silently corrupts an Obsidian-authored board is worse than a missing feature, because the user finds out later and cannot tell what happened.

| Item | Why | Status |
|---|---|---|
| Rewriting node or edge ids on save | Breaks every edge, and breaks any `![[board.canvas]]` embed or external reference. No upside — ids are already unique. | `planned` (never) |
| Reconstructing the document on serialize — building a fresh `{nodes, edges}` from known fields | **The single most dangerous change anyone could make to this file.** It looks like a tidy refactor and it deletes the user's groups, colours, labels and `subpath`s on the first save, with no error anywhere. Already pinned by a mutation-checked test in `test/canvas-authoring.test.mjs`. **Leave it pinned.** | `planned` (never) |
| Hijacking a spec field for app data — metadata in `node.text`, a state flag in `node.color` | Obsidian renders `text` as markdown and `color` as a colour, so the user sees the app's internals printed on their board. | `planned` (never) |
| A new `type` value — `'canvas'` for nested boards, `'shape'`, etc. | The spec enumerates four types. An unknown type is undefined behaviour in Obsidian and may make the file refuse to open. This app tolerates someone else's unknown type (there is a test); that is not the same as inventing one. | `planned` (never) |
| Reformatting the JSON on write | Already correct — two-space indent, trailing newline, matching Obsidian, with a test. Changing it produces a whole-file diff in the user's git history every time the two apps take turns. | `planned` (never) |
| Inlining binary data — ink, thumbnails, base64 images | Makes a shared, human-diffable text file enormous and unopenable. | `planned` (never) |
| Real-time multiplayer editing (the Notion pitch) | Not a format question: it needs a server, and the free tier of this product is explicitly local, no account, no backend. | `planned` (never) |
| Writing the board on a timer, a debounce, or on blur | Not a spec issue, a product rule. `review-s2-vault-pane.test.mjs:241` bans it pane-wide, it has already caught one attempt, and the reason is that Obsidian may hold the same file open. | `planned` (never) |

---

## Sources

- [JSON Canvas 1.0 specification](https://jsoncanvas.org/spec/1.0/) — the authoritative field list
- [obsidianmd/jsoncanvas spec on GitHub](https://github.com/obsidianmd/jsoncanvas/blob/main/spec/1.0.md)
- [Canvas Visual System — obsidian-help (DeepWiki)](https://deepwiki.com/obsidianmd/obsidian-help/6-canvas-visual-system) — the fullest Obsidian Canvas feature list found
- [Getting Started with Obsidian Canvas — Obsidian Rocks](https://obsidian.rocks/getting-started-with-canvas-in-obsidian/)
- [Advanced Canvas plugin](https://community.obsidian.md/plugins/advanced-canvas) — the in-file extension precedent
- Notion, official: [features](https://www.notion.com/product/features) · [board view](https://www.notion.com/help/boards) · [timeline view](https://www.notion.com/help/timelines) · [Miro connection](https://www.notion.com/connections/miro)
- [AFFiNE: Notion's lack of a whiteboard](https://affine.pro/blog/notion-whiteboard-productivity-and-alternatives) — the counter-claim to the marketing pages
