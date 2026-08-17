---
tier: WIRE
control: The chevron-down button at the right of the tab bar
location: src/renderer/panes/vault/TabBar.tsx:40-42
status: NOT STARTED
---

# Tab-list chevron

## Today

Nothing. It is a `disabled` button with no `onClick` at all:

```tsx
// src/renderer/panes/vault/TabBar.tsx:40-42
<button className="vault-tab-chevron" disabled title={NOT_YET}>
  <ChevronDown size={14} aria-hidden="true" />
</button>
```

`NOT_YET` is `'Not implemented yet'` (`TabBar.tsx:7`). The comment directly above
at `TabBar.tsx:38-39` records why it is disabled rather than merely inert:
*"none of these three had an onClick at all, so they were decoration that read as
controls."*

`TabBarProps` (`TabBar.tsx:9-14`) carries `tabs`, `activeTabId`, `onTabChange`
and `onNewTab`. There is no menu prop, no menu state, and no popover anywhere in
`src/renderer/panes/vault/`.

## What it should do

Open a dropdown listing every open tab, and switch to whichever one is clicked.
This is Obsidian's tab-overflow menu: when the tab strip is too narrow to show
every tab, the chevron is how you reach the ones that are off-screen.

Concretely:

1. Local `useState` in `TabBar` for whether the menu is open.
2. On click, render an absolutely-positioned `<ul>` of the `tabs` array — the
   same array already mapped into the strip at `TabBar.tsx:25-33`.
3. Each row calls the existing `onTabChange(tab.id)` prop and closes the menu.
4. Mark the active tab in the list (`aria-current` or a check glyph).
5. Close on Escape, on selecting a row, and on a click outside.
6. Remove `disabled` and the `title={NOT_YET}`.

**Read `tab-bar-tabs.md` in this directory first if it has not been done yet.**
Today a tab is `{ id, name }` and switching one changes nothing but a highlight
(`TabBar.tsx:28` uses `activeTabId` for a class and nothing else consumes it).
A menu that switches between tabs which all show the same thing is a working
control over a broken model. If `tab-bar-tabs.md` is still NOT STARTED, either do
it first or accept that this menu will visibly do nothing until it lands — and
say so in your report.

## What already exists to build on

- **The tab list itself.** `src/renderer/panes/vault/VaultPane.tsx:52-53` owns
  it: `const [tabs, setTabs] = useState([{ id: 'default', name: 'Universal Vault' }])`
  and `const [activeTabId, setActiveTabId] = useState('default')`.
- **It is already threaded down.** `src/renderer/panes/vault/VaultPane.tsx:369-374`
  passes `tabs`, `activeTabId`, `onTabChange={setActiveTabId}` and
  `onNewTab={handleNewTab}` into `<TabBar>`. **You need no new props** — the
  menu can be built entirely from what `TabBar` already receives.
- **The strip that renders the same data** is `TabBar.tsx:24-34`; copy its
  `tabs.map` and its active-class idiom.
- **A complete, correct overlay to copy**, including the focus behaviour:
  `src/renderer/panes/vault/SettingsDialog.tsx`.
  - `SettingsDialog.tsx:78-102` — `handleKeyDown`: Escape closes,
    Tab is trapped at both edges.
  - `SettingsDialog.tsx:69-76` — capture `document.activeElement` on open,
    restore focus to it on close. The comment explains why a ref to the opener
    is the wrong approach.
  - `SettingsDialog.tsx:125-127` — dismiss on `onMouseDown` rather than
    `onClick`, so a drag that ends outside is not a dismissal.
  - `SettingsDialog.tsx:21-22` — the `FOCUSABLE` selector string.
  - It ships its own co-located stylesheet, `src/renderer/panes/vault/settings.css`,
    imported at `SettingsDialog.tsx:14`. That is the sanctioned way to add
    styles from inside this pane (see Constraints).
- **A simpler open/close toggle in the same pane:** the collapsible group headers
  in the database view, `src/renderer/panes/vault/DatabaseView.tsx:140-145`
  (`toggleGroup`) and `DatabaseView.tsx:228-242`.
- **Icon-button conventions:** `src/renderer/panes/vault/LeftRibbon.tsx:41-52`
  shows the house style — `aria-label` on the button, `aria-hidden="true"` on the
  Lucide icon, `aria-pressed` for selected state.
- `ChevronDown` is already imported at `TabBar.tsx:5`.

## What does NOT exist yet

- **Any menu, popover or dropdown primitive.** There is no such component in
  `src/renderer/`. `SettingsDialog` is a modal, not a popover — copy its
  keyboard and focus logic, not its layout.
- **Tab overflow detection.** The tab strip `.vault-tabs` has no measurement
  code. Do not build overflow detection; show the chevron unconditionally and
  list all tabs. A menu that lists everything is correct and is one sitting;
  a menu that lists only what is clipped needs a ResizeObserver and is not.
- **Any styling for `.vault-tab-chevron`.** Grep `src/renderer/app.css` — the
  class appears nowhere; the button inherits the global `button` rules at
  `app.css:70-73`, including `button:disabled { color: var(--label-quaternary); }`.
  A dropdown panel needs positioning CSS you will have to add.
- **A meaningful tab model.** As above: `{ id, name }` only. See
  `tab-bar-tabs.md`.

## Constraints

- **Do not import `app.css`.** `test/review-s2-vault-pane.test.mjs:191-209`
  allows a co-located stylesheet matching `^\./[a-z][a-z0-9-]*\.css$` and rejects
  anything else, explicitly naming `../../app.css` — *"app.css is the shared
  sheet another section owns, and a component pulling it in is how two sections
  end up editing one file."* Add `src/renderer/panes/vault/tabbar.css` beside the
  component if you need styles.
- **No inline style objects, no hex colours, no `rgb()`/`hsl()` in the .tsx.**
  `test/review-s2-vault-pane.test.mjs:185-216`. Use tokens from
  `src/renderer/tokens.css` in your stylesheet.
- **No timers.** `test/review-s2-vault-pane.test.mjs:230-240` and `:796-801` ban
  `setTimeout`, `setInterval` and `queueMicrotask` across the whole pane. A menu
  that closes on a delay is not an option; close on the event.
- **Clean up every listener on unmount.** If you add a document-level
  click-outside listener, remove it in the effect's cleanup. The pane's history
  of leaked listeners is why `test/review-s2-vault-pane.test.mjs:397-424` exists.
- **Keep the class name `vault-tab-chevron`.**
  `test/review-s2-vault-pane.test.mjs:97` asserts it is present.
- **Accessibility** (`docs/ACCESSIBILITY.md:41-50`): the chevron is icon-only, so
  it needs an `aria-label` — it has none today, which is its own small defect.
  Add `aria-expanded` reflecting menu state. Note that
  `docs/ACCESSIBILITY.md:62-63` already records *"The tab bar has no roving
  tabindex or arrow-key navigation"* as a known gap; arrow-key movement within
  your menu is a welcome partial fix but is not required to close this item.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/panes/vault/MainCanvas.tsx`, `src/renderer/app.css`.

## Acceptance

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Manual, in `npm run dev`:

1. The chevron is enabled and has a tooltip that is not "Not implemented yet".
2. Click "+" three times to create three tabs, then click the chevron → a menu
   lists all four tabs including "Universal Vault".
3. The currently active tab is visually marked in the menu.
4. Click a row → the menu closes and that tab becomes active in the strip.
5. Press Escape with the menu open → it closes and focus returns to the chevron.
6. Click anywhere outside the menu → it closes.
7. Tab into the chevron with the keyboard, press Enter → the menu opens and
   focus moves into it.
8. Open and close the menu ten times, then switch to the Graph view and back →
   no console warnings about leaked listeners or state updates on unmounted
   components.
