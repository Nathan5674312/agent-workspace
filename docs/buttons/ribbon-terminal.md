---
tier: DECIDE
control: The square-terminal "Terminal" icon in the left ribbon
location: src/renderer/panes/vault/LeftRibbon.tsx:33 (definition), :41-52 (render)
status: NOT STARTED
---

> **⚠ STALE IN ONE PLACE (checked 2026-08-18).** Everything below about the
> sidebar going blank when this icon is clicked is fixed. `activeRibbon` used
> to have exactly one consumer; commit `4bc9878` added
> `src/renderer/panes/vault/SidebarPlaceholder.tsx`, which renders a panel
> naming the feature this icon is a promise of. Skip the "fix the blank panel
> first" instruction. The scope question this file asks is still open and is
> still why the icon is not built.


# Ribbon: Terminal

## Today

Clicking it changes state that nothing consumes, and **empties the sidebar**.

- `src/renderer/panes/vault/LeftRibbon.tsx:26-35` defines eight views; `terminal`
  is at `LeftRibbon.tsx:33`.
- `src/renderer/panes/vault/LeftRibbon.tsx:41-52` renders each as a button whose
  `onClick` is `() => onViewChange(id)`.
- `onViewChange` is `setActiveRibbon` (`src/renderer/panes/vault/VaultPane.tsx:342`),
  writing the state at `VaultPane.tsx:47`.
- **`activeRibbon` has exactly one consumer**, at
  `src/renderer/panes/vault/VaultPane.tsx:345` — the `activeRibbon === 'files'`
  branch rendering the explorer header and folder tree. There is no else.

The sidebar collapses to the vault switcher row (`VaultPane.tsx:362-365`) while
the icon lights up and reports `aria-pressed` (`LeftRibbon.tsx:43,48`).

## What it should do

**This is a DECIDE item. Do not write an implementation plan; get an answer to
the scope question first.**

### The question a human must answer

**Is this a shell, or is it a chat with an agent? They are opposite decisions and
the icon does not say which.**

The label "Terminal" and the `SquareTerminal` icon are ambiguous between two
completely different products:

1. **A real shell.** Spawn a process, stream stdio, run arbitrary commands. This
   is a security decision, not a feature decision — see below.
2. **An agent chat pane.** A conversation with Claude, scoped to this vault. The
   shared IPC contract already carries a half-built surface for exactly this and
   it has been sitting unused (see "What already exists").
3. **Neither — remove the icon.**

If the answer is 2, a second question follows immediately: **should an agent
conversation live in the sidebar at all, when this app already has a dedicated
agent surface?** The agent corner (`src/renderer/panes/corner/AgentCorner.tsx`)
is described as *"The only original surface in the app"*
(`AgentCorner.tsx:3-4`) and its stated design rule is *"Silence is the default.
If the common path is not 'nothing happened', it is wrong"*
(`AgentCorner.tsx:11-13`). A persistent chat panel is close to the opposite
principle. Whether the app wants both is a real product question.

### Where this duplicates Obsidian

**Partially, and less than the other ribbon items — which is why answer 3 is not
automatic here.** Obsidian has no first-party terminal; there are community
plugins that embed one. So a terminal is not re-solving an Obsidian core feature
the way Search, Bookmarks, Canvas and Daily Notes are.

But under answer 2 the duplication target is different and closer to home:
**Claude Code already exists** as a CLI, a desktop app, a web app and IDE
extensions. Building a general chat pane here re-solves that, not Obsidian. The
thing this app has that Claude Code does not is the *oversight* surface — the
Inbox of agent proposals awaiting a human (`src/renderer/panes/vault/InboxView.tsx:4-20`)
and the consent prompts in the corner. That is the direction with a reason to
exist.

### What is at stake either way

**If answer 1 (a real shell):** this is the highest-risk item in the entire
`docs/buttons/` set, and it should be treated as a security decision rather than
a feature.

The renderer in this app is deliberately, thoroughly sandboxed, and a terminal
punches straight through it:

- `test/review-s2-vault-pane.test.mjs:143-155` bans `fetch(`, `require(`,
  `XMLHttpRequest`, `WebSocket`, `from 'electron'`, `from 'node:`,
  `ipcRenderer` and `process.` in every pane source.
- `src/shared/ipc.ts:4-9` states the rule: *"The renderer has NO node integration
  and NO network access to the vault. Everything crosses this boundary… Anything
  that mutates the vault or touches the network is a `consent:` gated call."*
- `src/main/ipc.ts:21-47` refuses IPC from any subframe, and the comment at
  `:14-20` documents a fail-open bug that was closed — an unidentifiable sender
  is treated as a reason to refuse.
- `src/renderer/panes/corner/ArtifactItem.tsx:33-48` documents a real bypass
  found in review: an agent-supplied `javascript:` path executed page script
  holding the full `window.api` bridge, from which
  `corner.decide({ allow: true })` and `network.trust(true)` were reachable with
  no human involved.

A shell channel is a general-purpose "run anything" door in an app whose whole
IPC design assumes there isn't one. Note text is untrusted and agent-generated
content flows through this app; a command-execution channel plus any injection
path is arbitrary code execution. **If answer 1 is chosen, it needs an explicit
threat model and a human sign-off, not a ticket.**

**If answer 2 (agent chat):** materially smaller, because the contract is
partly drafted already — but it is still a feature, and the main-process module
behind it is uncommitted work by another session (see below).

**If answer 3 (remove):** `test/review-s2-vault-pane.test.mjs:70-84` asserts all
eight ribbon ids exist and will fail. That test encodes the original brief's
eight-icon layout, so removing an icon is a deliberate spec revision — update the
test in the same change and say so.

### The one thing to do regardless of the answer

**The sidebar must not silently empty.** Either the unbuilt ribbon icons become
`disabled` with a title — the idiom used everywhere else in this pane, see
`src/renderer/panes/vault/TabBar.tsx:38-48` — or `VaultPane.tsx:345` gains an
else-branch with an explicit "Not built yet" panel.

## What already exists to build on

- **The ribbon and its state:** `src/renderer/panes/vault/LeftRibbon.tsx:21-56`,
  `src/renderer/panes/vault/VaultPane.tsx:47`, `:342`, `:345`.
- **The sidebar container** is `.vault-sidebar` at `VaultPane.tsx:344-366`.
- **A drafted-but-unwired agent contract, if answer 2 is chosen.**
  `src/shared/ipc.ts:62-88` already defines `SessionId`, `Session`
  (`{ id, title, cwd, status: 'idle'|'running'|'awaiting-permission'|'error', updatedAt }`),
  `ChatBlock` (`text` | `thinking` | `tool_use` | `tool_result`), `ChatMessage`
  and `PermissionMode`. `CH` at `src/shared/ipc.ts:149-153` declares five
  channels: `claude:new-session`, `claude:send`, `claude:interrupt`,
  `claude:history`, `claude:set-permission-mode`. `EV` at `:167-168` declares
  `claude:message` and `claude:session-update`.
  **They are declared and not implemented.** `src/preload/index.ts:22-50` exposes
  no `claude` surface, and `src/main/ipc.ts:49-60` registers none of the five.
  `Api` at `src/shared/ipc.ts:175-205` has `vault`, `corner`, `network` and
  `settings` — no `claude`.
- **`src/main/claude.ts` exists as untracked work from another session.** Run
  `git status` before assuming anything about it. It is the most likely home for
  answer 2 and it is not yours.
- **`@anthropic-ai/claude-agent-sdk` is already a dependency** (`package.json`).
- **The subscribe/unsubscribe pattern for streamed main→renderer events:**
  `src/preload/index.ts:11-20` (the `on()` helper returning its own
  unsubscribe) and `src/renderer/panes/corner/AgentCorner.tsx:54-80` (a mount
  effect that fetches initial state, subscribes to pushes and resolutions, and
  cleans up both). Copy this exactly for a message stream.
- **The consent surface, for anything gated:**
  `src/renderer/panes/corner/ConsentItem.tsx`, and the `CornerItem` /
  `ConsentDecision` / `NetworkTrust` types at `src/shared/ipc.ts:96-136`.
- **Icon and selected-state conventions:** `LeftRibbon.tsx:41-52`.

## What does NOT exist yet

- **Any terminal, shell, PTY or process spawn.** Grep `src/` for `spawn`,
  `exec`, `child_process`: nothing. No `node-pty`, no `xterm.js` in
  `package.json`.
- **Any implementation behind the five `claude:*` channels.** They are names in
  `CH` and nothing else — confirmed by `src/main/ipc.ts:49-60` and
  `src/preload/index.ts:22-50`.
- **No `claude` surface on `window.api`.** `src/shared/ipc.ts:175-205`.
- **Any panel for a non-`files` ribbon view.** `VaultPane.tsx:345` has one branch
  and no else.

## Constraints

- **The scope question must be answered by a human before any code is written**,
  and under answer 1 the answer must include a threat model. This is the one item
  in this directory where "just try the small version" is actively unsafe.
- **The vault pane may only reach `window.api.vault` and `window.api.settings`.**
  `test/review-s2-vault-pane.test.mjs:164-172` — the test's comment at
  `:157-163` explains the rule: *"`corner` and `network` belong to other panes,
  and the vault pane reaching into either is the coupling this guards against."*
  A `window.api.claude` used from the sidebar would fail that test, and widening
  `ALLOWED_API` is a deliberate architectural change, not a test fix. **This is a
  strong argument that an agent chat belongs in the corner pane, not the vault
  sidebar.**
- **No node, electron or network access in the renderer.**
  `test/review-s2-vault-pane.test.mjs:143-155`.
- **No `dangerouslySetInnerHTML`, no `.innerHTML`, no `document.write`.**
  `test/review-s2-vault-pane.test.mjs:220-226`. Model output is untrusted text
  and must render as text.
- **No timers.** `test/review-s2-vault-pane.test.mjs:230-240`, `:796-801`. A
  polling terminal is not an option; use the push/subscribe pattern.
- **No inline styles, no hex colours, no `rgb()`/`hsl()`, no `app.css` import.**
  `test/review-s2-vault-pane.test.mjs:185-216`.
- **Every subscription must return and call its unsubscribe.**
  `src/preload/index.ts:4-10`: *"Renderer components must call it on unmount —
  without that, remounting a pane stacks duplicate handlers."*
- **`src/main/claude.ts` and `src/shared/ipc.ts` carry another session's
  uncommitted work.** Run `git status` before touching either.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/app.css`.

## Acceptance

**For the decision itself:** a written answer naming which of the three options
was chosen. Under answer 1 it must include a threat model covering how untrusted
note and agent content is prevented from reaching a command channel. Under answer
2 it must say why the panel belongs in the vault sidebar rather than the agent
corner, given the `ALLOWED_API` rule above. Then update `status:` in this file's
frontmatter.

**For the sidebar-empties bug**, closable now without the decision:

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Manual, in `npm run dev`: click the Terminal icon. The sidebar must show either a
real panel or an explicit "not built" message — never an empty column with the
icon lit. Clicking Files must restore the tree with its expansion state intact.

**If the decision is "remove the icon":** `test/review-s2-vault-pane.test.mjs:70-84`
will fail. Update it in the same commit and state in your report that you changed
a spec assertion, not just code.
