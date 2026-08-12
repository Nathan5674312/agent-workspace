# Accessibility

Status: **honest inventory, not a conformance claim.** Nothing here has been
tested with a screen reader or audited against WCAG by a person. What follows
is what the code actually does and what it actually does not.

## Scope note on the ADA

The Americans with Disabilities Act reaches places of public accommodation.
A single-user desktop app running on its owner's machine is not one, so the ADA
does not currently apply to this software. That is a statement about legal
scope, not an excuse — the work below was done because the app should be usable,
and it is what any future obligation would be built on.

## What the app does today

**Three independent system preferences are honoured separately.** They are
different requests from different people and are deliberately not collapsed
into one switch.

| Preference | Effect |
|---|---|
| `prefers-reduced-motion` | The graph simulation runs to rest synchronously and paints the settled result instead of animating. Gesture momentum and rubber-banding are skipped. |
| `prefers-reduced-transparency` | Translucent materials become opaque, and the canvas artwork layer is removed entirely — an image under text is exactly the problem this preference is asking to avoid. |
| `prefers-contrast: more` | Separators strengthen, the artwork layer is removed, and the artwork credit gets *louder* rather than disappearing. It is a person's name; it should gain legibility when someone asks for legibility. |

**Colour is never the only signal.** The public-network consent warning — the
highest-stakes moment in the app — is distinguishable by structure and wording
with no colour at all: its own block, its own heading, the word "Warning"
rendered by CSS content rather than implied by a hue. There is a test holding
this, and it should stay.

**Contrast is measured, not estimated.** Body text runs at 10.0:1 and secondary
text at 7.4:1 against the window ground, both AAA. Tertiary text is 5.0:1, AA.
Values come from `Universal Vault/Business/Claude Code Extension/07 - Design -
Color.md`, measured with `palette.py`. One palette colour (Taupe, 3.7:1 at its
best) is forbidden for text and used only for decoration.

**Structure and naming.**

- Every interactive element has a `:focus-visible` ring. Focus is never
  suppressed without a replacement.
- Icon-only buttons carry an accessible name; the icon itself is
  `aria-hidden`, so nothing announces twice.
- The folder tree uses `aria-expanded` on disclosure rows, and the whole row is
  the hit target rather than a 12px chevron.
- The ribbon uses `aria-pressed` to report which view is selected.
- Controls that cannot act are `disabled` with a title explaining why, rather
  than looking live and silently doing nothing.
- Errors are announced with `role="alert"` rather than only changing colour.

## Known gaps

Stated plainly because an inventory that only lists wins is marketing.

- **No screen-reader testing has been done.** Not with NVDA, JAWS, or Narrator.
  The ARIA above is correct by construction, not by observation.
- **The graph view is a `<canvas>` with no accessible representation.** A
  sighted pointer user can pan, zoom, hover and drag nodes; a screen-reader user
  gets nothing at all. The underlying data is a list of notes and links and
  could be exposed as one, and until it is, the graph is sighted-pointer-only.
- **The tab bar has no roving tabindex or arrow-key navigation**, which the
  project's own component spec requires.
- **Graph interaction is pointer-only.** No keyboard equivalent for pan, zoom,
  or selecting a node.
- **No reduced-data or text-size preference handling** beyond the layout being
  in `rem`, which does scale with system text size.

## If this is ever distributed

The gaps above stop being acceptable, and the graph one becomes the priority:
it is the app's signature screen and it is currently unusable without sight.
