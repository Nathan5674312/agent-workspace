---
tier: WIRE
control: The "?" help button in the vault switcher, bottom row of the sidebar
location: src/renderer/panes/vault/VaultSwitcher.tsx:19-26
status: NOT STARTED
---

# Help "?"

## Today

Nothing. The button is `disabled` and its handler is a console stub:

```tsx
// src/renderer/panes/vault/VaultSwitcher.tsx:19-26
<button
  className="vault-switcher-button"
  onClick={onHelp}
  disabled
  title="Not implemented yet"
>
  ?
</button>
```

`onHelp` is supplied at `src/renderer/panes/vault/VaultPane.tsx:364` as
`onHelp={() => console.log('Help')}` — an inline arrow that logs to a console
the user cannot see.

The comment at `VaultSwitcher.tsx:16-17` states the current position:
*"Help is still a console.log stub and stays disabled — there is no help content
to show. Settings now opens the real modal."*

**Its neighbour is the model.** The gear beside it (`VaultSwitcher.tsx:27-34`)
was the same kind of stub until recently and is now fully built: it calls
`onSettings`, which flips `settingsOpen` at `VaultPane.tsx:363`, which mounts
`<SettingsDialog>` at `VaultPane.tsx:424`. Do the same thing for `?`.

## What it should do

Open a small modal listing what the app can actually do, then close cleanly.

The content is static and short. Ship exactly these sections, all of which
describe behaviour that exists today and can be verified by reading the code:

- **Wikilinks** — `[[note name]]`. Resolution is case-insensitive, tolerates a
  `.md` extension, and accepts `[[Name|alias]]` and `[[Name#heading]]`
  (`src/renderer/panes/vault/helpers.ts`, tested at
  `test/review-s2-vault-pane.test.mjs:505-539`). Links and backlinks are listed
  below the editor (`src/renderer/panes/vault/Editor.tsx:111-151`).
- **Saving** — there is no auto-save. Text is written to disk only when Save is
  clicked (`src/renderer/panes/vault/Editor.tsx:43-68`, and the invariant is
  enforced at `test/review-s2-vault-pane.test.mjs:230-250`). Say this plainly;
  it is the single most surprising thing about the app.
- **Conflicts** — if the file changed on disk since it was opened, Save raises a
  dialog offering keep-mine / keep-disk / merge, and the losing side is retained
  in a "Discarded version" panel until another note is opened
  (`src/renderer/panes/vault/VaultPane.tsx:239-296`,
  `src/renderer/panes/vault/Editor.tsx:153-164`).
- **The four views** — Editor, Graph, Database, Inbox, and one line on what each
  is for (`src/renderer/panes/vault/MainCanvas.tsx:205-244`). The Inbox holds
  what agents captured but did not file
  (`src/renderer/panes/vault/InboxView.tsx:4-20`).
- **Where the data lives** — the vault folder shown in Settings, and the fact
  that every write goes through the local note server on 127.0.0.1:8765
  (`src/main/vault.ts:1-10`). If the server is not running, notes will not load.
- **A link out** — the app's own docs: `docs/ACCESSIBILITY.md`, `docs/PRIVACY.md`,
  `docs/TERMS.md`, `docs/ARTWORK.md`.

Then remove `disabled`, replace the `title` with `"Help"`, and replace the
`console.log` at `VaultPane.tsx:364` with real state.

## What already exists to build on

**`SettingsDialog` is a finished modal with every hard part solved. Copy it.**
`src/renderer/panes/vault/SettingsDialog.tsx`:

- `SettingsDialog.tsx:118` — `if (!isOpen) return null`, so it unmounts when
  closed.
- `SettingsDialog.tsx:129-137` — the dialog element: `role="dialog"`,
  `aria-modal="true"`, `aria-labelledby` pointing at the `<h2>`'s id,
  `tabIndex={-1}` and a ref so the wrapper itself can take focus.
- `SettingsDialog.tsx:69-76` — focus in on open, back to the opener on close, by
  capturing `document.activeElement` rather than taking a ref to the button. The
  comment explains why that is both shorter and more correct.
- `SettingsDialog.tsx:78-102` — `handleKeyDown`: Escape closes (with
  `stopPropagation`), Tab is trapped at both edges. The comment at `:95-97`
  explains why the wrapper counts as the leading edge.
- `SettingsDialog.tsx:21-22` — the `FOCUSABLE` selector string, and why
  `:not(:disabled)` is in it.
- `SettingsDialog.tsx:120-128` — the overlay, dismissing on `onMouseDown` (not
  `onClick`) so a text-selection drag ending on the backdrop is not a dismissal.
- `SettingsDialog.tsx:14` + `src/renderer/panes/vault/settings.css` — the
  co-located stylesheet pattern, which is the only permitted way to add CSS from
  inside this pane.

**The mount pattern in `VaultPane`:**

- `src/renderer/panes/vault/VaultPane.tsx:55` — `const [settingsOpen, setSettingsOpen] = useState(false)`
- `src/renderer/panes/vault/VaultPane.tsx:362-365` — `<VaultSwitcher onSettings={() => setSettingsOpen(true)} onHelp={...} />`
- `src/renderer/panes/vault/VaultPane.tsx:421-424` — `<SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />`, rendered at the same level as the conflict dialog, with a comment explaining why it is unmounted when closed.

**`VaultSwitcherProps`** at `src/renderer/panes/vault/VaultSwitcher.tsx:7-10`
already declares `onHelp: () => void`. The prop exists; only its implementation
is missing.

**A second dialog to read for contrast:**
`src/renderer/panes/vault/ConflictDialog.tsx` — note that it deliberately has
*no* close/cancel/dismiss, enforced at
`test/review-s2-vault-pane.test.mjs:814-820`. Help is the opposite case and
should be dismissible every way; do not copy that constraint.

## What does NOT exist yet

- **Any help content, anywhere.** No markdown file, no constants module, no
  strings. You are writing it, from the sources listed above.
- **A second dialog component.** `SettingsDialog` is the only modal in the pane
  besides `ConflictDialog`. Add `src/renderer/panes/vault/HelpDialog.tsx` and,
  if it needs styles, `src/renderer/panes/vault/help.css`. Do not generalise
  `SettingsDialog` into a shared `<Modal>` for two callers — that is the
  abstraction this codebase would call premature.
- **Keyboard shortcuts.** Do not list any. Grep for `onKeyDown` in
  `src/renderer/panes/vault/` — the only handlers are `SettingsDialog.tsx:78`
  (Escape/Tab inside the dialog). There are no app-level shortcuts to document,
  and inventing a shortcuts table for shortcuts that do not exist would recreate
  the exact defect this queue is closing.
- **In-app rendering of the `docs/*.md` files.** The renderer has no markdown
  renderer, and `test/review-s2-vault-pane.test.mjs:124-133` bans `remark-`,
  `rehype-`, `markdown-it` and `marked` across the whole pane. Name the files as
  text; do not render them.

## Constraints

- **No `dangerouslySetInnerHTML`, no `.innerHTML`.**
  `test/review-s2-vault-pane.test.mjs:220-226`. Help content is JSX, not a
  string of HTML.
- **No markdown library.** `test/review-s2-vault-pane.test.mjs:124-133`.
- **Do not import `app.css`.** `test/review-s2-vault-pane.test.mjs:191-209`
  permits only a co-located `./name.css`. Follow `settings.css`.
- **No inline style objects, no hex colours, no `rgb()`/`hsl()` in the .tsx.**
  `test/review-s2-vault-pane.test.mjs:185-216`. Use tokens from
  `src/renderer/tokens.css`.
- **No timers.** `test/review-s2-vault-pane.test.mjs:230-240` and `:796-801`.
- **The pane may only reach `window.api.vault` and `window.api.settings`.**
  `test/review-s2-vault-pane.test.mjs:164-172`. Help needs neither.
- **`test/review-s2-vault-pane.test.mjs:102-109`** asserts `VaultSwitcher.tsx`
  contains `vault-switcher-name`, `onHelp` and `onSettings`. Keep all three.
- **External links must use `target="_blank"` with `rel="noreferrer noopener"`,
  or not be links at all.** `src/renderer/panes/vault/ArtCredit.tsx:176-193`
  documents why: a plain in-app navigation is killed by the `will-navigate`
  handler in `src/main/index.ts`, while `target="_blank"` routes through
  `setWindowOpenHandler`, which hands http(s) to the real browser and denies
  everything else. For local `docs/*.md` paths, render them as text — there is no
  channel to open a local file (`src/renderer/panes/corner/ArtifactItem.tsx:33-48`).
- **Accessibility** (`docs/ACCESSIBILITY.md:41-50`): focus ring, accessible name
  on the button, focus moved into the dialog on open and restored on close.
  `SettingsDialog` already does all of it.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/panes/vault/SettingsDialog.tsx`, `src/renderer/app.css`.

## Acceptance

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Every claim you put in the help text must be true of the code as written. Before
finishing, re-read `src/renderer/panes/vault/Editor.tsx:43-68` and
`src/renderer/panes/vault/VaultPane.tsx:239-296` and check your sentences against
them. A help dialog that describes behaviour the app does not have is worse than
the disabled button it replaced.

Manual, in `npm run dev`:

1. The "?" is enabled and its tooltip reads "Help", not "Not implemented yet".
2. Click it → a modal opens, focus lands inside it, and the sections listed above
   are present.
3. Press Escape → it closes and focus returns to the "?" button.
4. Reopen, press Tab repeatedly → focus cycles inside the dialog and never
   escapes to the sidebar behind it. Shift+Tab from the first element wraps to
   the last.
5. Click the backdrop → it closes. Press and drag from inside the dialog and
   release on the backdrop → it does **not** close.
6. Type in the editor to make it dirty, open Help, close it → the buffer is
   untouched and still reads "Unsaved changes". Nothing in Help may reach the
   buffer.
7. Open Help while the conflict dialog is up → Help must not obscure or bypass
   the conflict resolution. If it can, gate it the way `loadNote` gates
   navigation (`src/renderer/panes/vault/VaultPane.tsx:147`).
8. `grep -rn "console.log" src/renderer/panes/vault/VaultPane.tsx` → the `'Help'`
   line is gone.
