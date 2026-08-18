---
tier: WIRE
control: The "More options" ellipsis at the right of the note header, above the view switcher
location: src/renderer/panes/vault/MainCanvas.tsx:200-202
status: DONE
---

# Note header "More options"

## Today

Nothing — and this one is the worst of the dead controls in the app, because it
does not even admit it.

```tsx
// src/renderer/panes/vault/MainCanvas.tsx:200-202
<button className="vault-note-menu" aria-label="More options" title="More options">
  <Ellipsis size={15} aria-hidden="true" />
</button>
```

No `onClick`. No `disabled`. It has a proper `aria-label` and a tooltip that
promises options, it takes focus, it renders the app's hover and
`:active { transform: scale(0.97) }` press feedback from the global button rules
(`src/renderer/app.css:70-73`), and it announces itself to a screen reader as an
actionable button. Then nothing happens.

Every other inert control in this pane is at least `disabled` with a reason —
the three tab-bar buttons at `src/renderer/panes/vault/TabBar.tsx:40-48`, the two
explorer-header buttons at `src/renderer/panes/vault/ExplorerHeader.tsx:30-45`,
the help button at `src/renderer/panes/vault/VaultSwitcher.tsx:19-26`. This one
was missed. Its two immediate neighbours, the back and forward arrows
(`MainCanvas.tsx:172-189`), are fully wired to real navigation history and
disable themselves when they cannot act — the comment at `MainCanvas.tsx:166-169`
says so explicitly. So it sits between two honest controls and is not one.

## What it should do

Two acceptable outcomes. **Pick the first if you are unsure; it is one line and
it removes a live lie.**

**Option A — make it honest (minimum, always correct).**
Add `disabled` and change the title to say why, matching the exact idiom in
`src/renderer/panes/vault/TabBar.tsx:38-48`:

```tsx
<button className="vault-note-menu" disabled aria-label="More options" title="Not implemented yet">
```

**Option B — give it a menu, limited to actions that exist.**
Open a small dropdown for the open note containing only:

- **Copy note path** — `navigator.clipboard.writeText(note.path)`.
- **Copy wikilink** — `[[` + title + `]]`, using `note.title`.
- **Reveal backlinks count** or similar read-only facts — optional.

Disable the whole button when `note` is null. Do **not** add Rename, Delete,
Move, "Open in new pane" or "Reveal in file explorer": none of them has a
channel behind it (see below), and shipping a menu row that does nothing would
recreate this defect one level deeper.

Either way the control must stop claiming an ability it does not have.

## What already exists to build on

- **The exact disabled-with-a-reason idiom to copy** is three files away:
  `src/renderer/panes/vault/TabBar.tsx:7` (`const NOT_YET = 'Not implemented yet'`)
  and `TabBar.tsx:38-48`, with the comment explaining the choice:
  *"Disabled, not inert: none of these three had an onClick at all, so they were
  decoration that read as controls."* That sentence is the whole rationale for
  this task.
- **The note the menu would act on** is already in scope in this component:
  `MainCanvasProps.note: VaultNoteBody | null` at
  `src/renderer/panes/vault/MainCanvas.tsx:18`, destructured at
  `MainCanvas.tsx:41`. `VaultNoteBody` is `VaultNote & { text: string }` and
  `VaultNote` carries `path`, `title`, `mtime` (`src/shared/ipc.ts:14-22`). The
  title is already rendered one element to the left at `MainCanvas.tsx:191-199`.
- **`Ellipsis` is already imported** at `src/renderer/panes/vault/MainCanvas.tsx:8`.
- **Its wired neighbours**, for the conditional-disable idiom:
  `MainCanvas.tsx:172-189` — the back/forward arrows use
  `disabled={!canGoBack}` / `disabled={!canGoForward}`, driven by
  `src/renderer/panes/vault/VaultPane.tsx:101-102`.
- **If you take Option B**, the overlay to copy is
  `src/renderer/panes/vault/SettingsDialog.tsx`:
  - `SettingsDialog.tsx:78-102` — Escape to close, Tab trapped at both edges.
  - `SettingsDialog.tsx:69-76` — capture `document.activeElement`, restore focus
    on close.
  - `SettingsDialog.tsx:125-127` — dismiss on `onMouseDown`, not `onClick`.
  - `SettingsDialog.tsx:14` + `src/renderer/panes/vault/settings.css` — the
    co-located stylesheet pattern, which is the only permitted way to add CSS
    from inside this pane.
- **Icon-button house style:** `src/renderer/panes/vault/LeftRibbon.tsx:41-52` —
  `aria-label` on the button, `aria-hidden="true"` on the Lucide icon,
  `aria-pressed` for toggle state. This button already gets the first two right.

## What does NOT exist yet

- **Rename, delete or move, at any layer.** The IPC contract registers six vault
  channels — `vault:tree`, `vault:list`, `vault:read`, `vault:save`,
  `vault:graph`, `vault:backlinks` (`src/shared/ipc.ts:141-163`, registered at
  `src/main/ipc.ts:50-55`). The note server behind them exposes `/`, `/inbox`,
  `/notes`, `/note`, `/capture` and `/save` and has no delete or rename endpoint
  (`C:\Users\Nathan\Desktop\note-system\app\server.py`, `do_GET` around
  `server.py:636-670`, `do_POST` from `server.py:676`).
- **`shell.openPath` or any "reveal in folder" bridge.** Deliberately absent, and
  the reason is a real security finding:
  `src/renderer/panes/corner/ArtifactItem.tsx:33-48` documents a bypass where an
  agent-supplied `javascript:` path executed page script holding the full
  `window.api` bridge, and records *"There is no shell.openPath channel on the
  bridge."* Do not add one for a context menu.
- **Any menu or popover primitive** in `src/renderer/`. `SettingsDialog` is a
  modal, not a popover.
- **Styling for `.vault-note-menu`.** The class appears nowhere in
  `src/renderer/app.css`; the button inherits the global rules at
  `app.css:70-73`, which include `button:disabled { color: var(--label-quaternary); }`
  — so Option A produces correct visuals with no CSS at all.

## Constraints

- **Do not put a row on the menu that does nothing.** `docs/ACCESSIBILITY.md:48-49`:
  *"Controls that cannot act are `disabled` with a title explaining why, rather
  than looking live and silently doing nothing."*
- **Do not touch the view state or the buffer from this control.** `MainCanvas`
  owns `view` (`MainCanvas.tsx:59`) and `VaultPane` owns `buffer`
  (`VaultPane.tsx:50`). The header comment at `MainCanvas.tsx:10-16` states the
  rule: *"nothing note-related may be stored here."*
- **Do not import `app.css`.** `test/review-s2-vault-pane.test.mjs:191-209`
  permits only a co-located stylesheet matching `^\./[a-z][a-z0-9-]*\.css$`.
- **No inline style objects, no hex colours, no `rgb()`/`hsl()`.**
  `test/review-s2-vault-pane.test.mjs:185-216`.
- **No timers.** `test/review-s2-vault-pane.test.mjs:230-240` and `:796-801` ban
  `setTimeout`, `setInterval` and `queueMicrotask` across this pane.
- **The pane may only reach `window.api.vault` and `window.api.settings`.**
  `test/review-s2-vault-pane.test.mjs:164-172`. `navigator.clipboard` is a web
  API and is fine.
- **Keep the `aria-label`.** It is already correct; the problem is the missing
  behaviour, not the naming.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/app.css`. You are editing `MainCanvas.tsx` — another session has
  edited that file recently, so run `git status` and `git diff` on it before you
  start and keep your change to the one button.

## Acceptance

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

A grep that should hold afterwards — every button in this pane either acts or is
disabled:

```
grep -n "<button" src/renderer/panes/vault/MainCanvas.tsx
```

Every hit must have an `onClick` or a `disabled` within its own JSX element.

Manual, in `npm run dev`:

**If you took Option A:**

1. The ellipsis is visibly greyed, does not respond to hover or press, and its
   tooltip says it is not implemented.
2. Tab through the note header → focus goes back arrow → forward arrow → and
   skips the ellipsis entirely (disabled buttons are not focus stops).

**If you took Option B:**

1. With no note open, the ellipsis is disabled.
2. Open a note, click the ellipsis → a menu appears with only the actions listed
   above.
3. Click "Copy note path", paste into the editor → the vault-relative path
   appears (e.g. `Business/Home.md`).
4. Click "Copy wikilink", paste into the editor → `[[Home]]` appears, and it
   shows up in the Links list below the editor
   (`src/renderer/panes/vault/Editor.tsx:111-130`), which proves the format is
   one the app's own parser accepts.
5. Press Escape → the menu closes and focus returns to the ellipsis.
6. Switch to the Graph view with the menu open → the menu closes and no console
   warning about state updates on an unmounted component appears.
