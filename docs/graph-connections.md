# Connecting two notes from the graph — scope

**Status:** **BUILT and watched running.** Alt+drag a node onto another in the graph and the link is written into the source note's Markdown. Everything below is the reasoning it was built from; the two open decisions at the end are still open and still one-line changes.

> This is the other half of what the r/PKMS commenter asked for. The first half shipped in `f316354`: a property edited in the database table is written into the note's own frontmatter. This document scopes the second half — *"or add a connection"* — so it does not have to be re-derived.
>
> **The committed goal list is `src/shared/roadmap.ts`.** This is working-out, not a commitment. Every number below was measured against Nathan's real vault on 2026-08-27, read-only.

---

## What a connection actually is here

A `[[wikilink]]` in a note's **body**. Nothing else. The graph, the Links/Backlinks columns and the backlinks list are all derived from `parseWikilinks` over the body text; none of them is stored. So "add a connection from A to B" means exactly one thing: **write `[[B]]` into A's Markdown**, and let everything else re-derive.

That is the whole reason this is worth doing rather than easy to fake. A connection that lived anywhere but the file would be the app's first private store, and the commenter's point was that there should not be one.

### It is not frontmatter

| | |
|---|---|
| Notes with a wikilink in a frontmatter **value** | **4 of 1900 (0.2%)** |

Re-measured, and it agrees with the 2026-08-19 scan that put it at 1 of 280. The Notion-style typed relation has no data in this vault and no convention behind it. A connection goes in the body.

---

## The hard question: where in the body?

This was the reason the previous commit stopped. It is answerable, and the vault answers it unambiguously.

### There is already a convention, and it is exceptionless about position

| | |
|---|---|
| Non-skill notes | 439 |
| ...with a `## Related` / `## Links` section | 68 |
| ...where that section is the **last heading in the file** | **78 of 78** |

Zero exceptions. Every note in the vault that has a related-notes section keeps it at the bottom. (78 > 68 because the second count includes a few more heading spellings.)

**So: append at the end of the file.** Not at the cursor, not after the first paragraph, not in frontmatter.

### What the section is called

Vault-wide, `## Links` leads (39 to 28). Restricted to `Fate/`, which is the corpus a person would actually be connecting in the graph, it inverts:

| Heading | `Fate/` | whole vault |
|---|---|---|
| `## Related` | **28** | 28 |
| `## Links` | 23 | 39 |
| `## Related notes` | 1 | 1 |

→ **Decision for Nathan, not for an agent.** Recommendation: **adopt whatever the note already has**, and only pick a default when creating the section fresh. For that default, `## Related` — narrowly ahead where it matters, and `Links` collides with the Links/Backlinks columns in the database and with the app's own vocabulary for edge counts.

### What a line in it looks like

| Shape | Count |
|---|---|
| `- [[A]]` bullet | 60 |
| `[[A]] · [[B]] · [[C]]` on one line | 33 |
| a bare single link | 1 |

Both shapes are real and neither is rare. Same rule as the heading: **match the note**, and only choose when creating the section. Recommendation for the fresh case: one link per bullet, because appending to a bullet list is a line insert while appending to a `·` line is a string edit inside prose the user wrote.

### File endings

433 of 439 notes end with a newline; **0 end with a blank line.** The writer must normalise the tail rather than assume it — `text.replace(/\s*$/, '')` then append — or the vault grows a trailing blank line on every note this touches.

---

## The second hard question: which spelling of the link

The graph hands you a **path** (`Fate/Decisions.md`). A wikilink addresses a **name**. `indexNotesByName` (helpers.ts) builds names first, then full paths, **first-wins on collision** — so a duplicate stem silently resolves to whichever note the tree walk reached first.

| | |
|---|---|
| Notes reachable only ambiguously by stem, whole vault | **1336 of 1900 (70.3%)** |
| ...excluding `System/Skills/` | 103 of 439 |
| ...of which `skill` (55) and `readme` (18) | infrastructure files, not notes |

The 70% is dominated by 1120 files called `SKILL.md`. For the notes a person connects in the graph, stems are effectively unique — but "effectively" is not a thing to write into someone's file.

**Now measured exactly, by the round-trip test running over the real vault:**

| Corpus | Short `[[Stem]]` | Needed `[[path\|Stem]]` |
|---|---|---|
| Whole vault, 1900 files | 599 | **1301** |
| Excluding the skills library, 212 notes | **206** | **6** |

So the fallback fires for 6 notes out of 212 in practice, and for two thirds of the vault if the skills library is ever drawn in the graph. Both numbers argue the same way: the check is cheap, it is right either way, and skipping it would be wrong 6 times in the corpus that matters and 1301 times in the one that does not.

**The rule, and it is testable:** write the shortest form that resolves *back to the note you meant*.

```
resolveWikilink(stem, index) === targetPath
    ? `[[${stem}]]`                       // unambiguous
    : `[[${path}|${stem}]]`               // always resolves; the vault already uses this
```

The path form is not an invention — `Fate/Agent Workspace - Task Queue.md` already contains
`[[System/Fable Backbone/Coding & Building|Coding & Building]]`.

This gives a clean round-trip property to test: **for every note in the vault, writing a link to it and re-resolving must return the note you started from.** That is one test over the real corpus and it is the one that matters.

---

## The gesture

`GraphView.tsx` is a `<canvas>` with hand-rolled events. What the gestures already mean:

| Gesture | Currently |
|---|---|
| drag a node | move it, and pin it into the simulation |
| click a node | open the note |
| hover a node | light its neighbourhood, dim everything else |
| right-click / modifiers / selection | **unused — all of it** |

So **drag-to-connect is taken**, and taking it back would break the one gesture the physics is built around.

| Option | Cost | Verdict |
|---|---|---|
| **A. Alt+drag from node to node** | low — one modifier check in the existing pointer handlers, plus a rubber-band line in the render loop | **Recommended.** Nothing else uses a modifier; the drag machinery, hit-testing and hover highlight all already exist. |
| B. A "Connect" mode toggle in the view controls | medium — a mode means a state, an indicator, and an escape from it | Rejected: a mode you can forget you are in, over a control that writes to files. |
| C. Right-click a node → "Link to…" → note picker | medium — needs a picker this pane does not have | Weaker: it is the graph, and the second endpoint is already on screen. Worth having later as the keyboard path. |
| D. Drag a note from the tree onto a graph node | low-medium — the tree is already `draggable` with `CANVAS_DROP_MIME` | Good **second** gesture; reuses the canvas drop precedent exactly. Not the primary, since both endpoints are usually already in the graph. |

**Direction is not a detail.** An edge is directional: dragging A→B writes into **A**. The rubber band has to start at the source and the preview has to name it, or half the connections will be written into the wrong file.

---

## Confirm before writing, and what it must say

The database cell writes on Enter with no confirmation, and that is fine — it replaces one frontmatter value with another. This is different: it **appends a line to prose**, in a file that is usually not on screen. It gets a confirmation, and the confirmation shows the exact text and the exact destination:

```
Add to  Fate/Decisions.md
        ## Related
      + [[Agent Workspace - Task Queue]]
```

Reusing `handleSetProperty`'s posture: route through `vault.saveNote` so the write keeps a pre-edit copy in `.backups/` and runs the lost-update guard; read fresh immediately before writing rather than trusting the graph's snapshot; and **refuse** when the source note is open in the editor with unsaved edits.

---

## Work breakdown

| # | Piece | Where | Status |
|---|---|---|---|
| 1 | `addWikilink(text, link)` — normalise the tail, find or create the section, match the note's existing shape, append | `src/shared/wikilink.ts` | **BUILT** |
| 2 | `linkTextFor(path, resolve)` — shortest form that round-trips | `src/shared/wikilink.ts` | **BUILT** |
| 3 | `handleAddLink(from, to)` — read, apply, `saveNote`, refuse on dirty buffer, update buffer if open | `VaultPane.tsx` | **BUILT** |
| 4 | Alt+drag, rubber band, drop target, confirm | `GraphView.tsx` | **BUILT** |
| 5 | Refresh after the write | `MainCanvas.tsx` | **BUILT** |
| 6 | Unit tests for 1 and 2, incl. the round-trip over the real corpus | `test/wikilink-write.test.mjs` | **BUILT** — 24 tests |
| 7 | Watched-running pass over CDP against a scratch vault, asserting the **file** | `test/graph-link.test.mjs` + the run below | **BUILT** — 20 tests |

Pieces 1, 2 and 6 are the half that carries the risk and can be proven with no UI at all, which is why they went first. The gesture is now a thin layer over functions already known to be correct.

### What building them changed

- **`indexNotesByName` and `resolveWikilink` moved** out of the vault pane's `helpers.ts` into `shared/wikilink.ts`, which re-exports them from there so no caller changed. They had to: the normalisation they share was private to the renderer, and a writer that could not reach it would have had to copy it — a writer and a resolver disagreeing about what one address is would produce links the app creates and then fails to follow. `helpers.ts` may hold only type-only imports (`review-s2` enforces it), and moving the functions satisfies that guard rather than widening it.
- **The `·` rule got stricter.** The first cut extended any non-bullet link line. Three notes in the vault are of the form `[[motion-system]] — scroll layer, one-ticker rule, …`, where that would have appended the new link after somebody's sentence. It now extends a line only when the line **already contains** ` · `; anything else — a bare link, a link with prose after it, a table row — gets its own line below. No table rows exist in a related section today, and this is why one appearing later cannot corrupt the table.
- **Idempotence is checked against every real note**, not just fixtures: adding the same link twice to all 1900 files is a no-op in all 1900.
- **`moved = true` on Alt+press is load-bearing.** Releasing the pointer fires a click, and `onClick` opens the note unless the gesture was a drag. Without it, every connection would also yank you into the editor for the note you dragged *from*.
- **A latent GraphView bug became reachable and is fixed.** `hover` is a local of the simulation effect; `hoverLabel` is React state. A rebuild resets one and not the other, and `onMove` reconciles on `hit?.id !== hover?.id` — over empty canvas after a rebuild that is `undefined !== undefined`, so it never fires and the name of a node from the *previous* simulation stays on screen permanently, following the cursor into the corners. Nothing rebuilt the graph mid-hover before; Alt+drag does exactly that. The effect's cleanup now clears the label.

### Watched running, 2026-08-27

Real mouse input over CDP against a throwaway scratch vault, `window.confirm` replaced by a recorder so the blocking dialog could not hang the driver and the answer could be scripted both ways. Every row checks **the file**, not the table:

| Case | Result |
|---|---|
| source note already has a section | `- [[Beta]]` appended under its `## Related`, bullet shape matched |
| source note has none | `## Related` created at the end, `# Gamma` heading and body intact |
| confirm answered **no** | confirm shown, md5 identical either side |
| link already present | **no confirm at all**, nothing written |
| source open in the editor, dirty | refused, banner names the note, md5 identical |
| cursor over a valid target | becomes `copy`; the band snaps to the target's centre |
| after a write | still on the graph — not yanked into the editor |
| every write | exactly one copy in `.backups/` |

The confirm text distinguishes the two cases, correctly: `In its related-notes section:` vs `In a new "## Related" section:`.

The refresh needed a second look. A first run showed the UI stuck at `4 notes, 4 links` across a write — which was **not** a missing refresh: the new content edge replaced a structural edge between the same pair, so the total genuinely did not move. Re-run on a pair with no relationship, the rendered graph went `4 links → 5 links` live, matching a freshly-built graph over IPC, with no reload and no tab switch.

---

## Open decisions for Nathan

1. **`## Related` or `## Links`** for a section created fresh. Recommendation `## Related`; the data is close.
2. **Bullet or `·` line** for a section created fresh. Recommendation bullet.
3. **Should the edge be bidirectional?** A wikilink is one-way, and B gains a backlink automatically. Writing into both files doubles the blast radius of a mis-drag. Recommendation: one direction, source → target, and let backlinks do the rest.
4. **Alt+drag, or wait for a keyboard/picker path first?** The gesture is discoverable only if something says so; the graph has no help text today.

## Explicitly out of scope

- **Removing** a connection from the graph. Deleting a `[[link]]` means editing a line someone wrote, possibly mid-sentence, and 591 of 1479 links in this vault are in prose rather than in a list. Removal belongs in the editor.
- Link **aliases**, `#heading` and `#^block-id` targets. The parser handles all three; authoring them from a graph node has no gesture and no demand.
- Typed / labelled relations. Same finding as before: 4 notes in 1900, no convention to follow.
