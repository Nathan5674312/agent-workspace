# Artwork rights

**This is the disclosure that actually matters, and it needs a real answer.**

The canvas background and the credit signature are a third party's original
work. They are committed to this repository, which is hosted on GitHub. Every
other document here is a formality; this one concerns someone else's property.

## What is in the repository

| File | What it is |
|---|---|
| `src/renderer/assets/canvas-art.jpg` | The artist's original scan, unmodified. Kept as the master. |
| `src/renderer/assets/canvas-art-treated.jpg` | A derivative: inverted, levelled, and duotoned into the app palette. |
| `src/renderer/assets/signature.png` | Her handwritten signature, converted to an alpha mask. |

## Artist

**Valentina** — [instagram.com/valentinas.artgallery](https://www.instagram.com/valentinas.artgallery)

The name is currently **inferred from the Instagram handle**, not supplied by
her. Confirm how she wants to be credited before this is treated as settled.

## Open questions — none of these have been answered yet

1. **Permission and scope.** Was permission given for use in this app
   specifically, or generally? Does it extend to a public repository if this one
   is ever made public?
2. **The derivative.** The shipped image is not her file — it is inverted,
   levelled, and recoloured into someone else's palette. Altering an artist's
   work changes what is being shown under her name. She should see the treated
   version, not just the original, and agree to it.
3. **Her signature is a signature.** It is reproduced here as an image asset in
   a git repository. A signature is not the same class of thing as a drawing,
   and she should be asked about it separately and explicitly.
4. **Licence and revocation.** Under what terms, and can she withdraw it? If she
   asks for it to be removed, what is the path — including from git history,
   which does not forget by default.
5. **Distribution.** If this app is ever shared, packaged, or published, does
   her permission travel with it?

## Default position until answered

Assume **all rights reserved by the artist**, used here with informal personal
permission, not licensed. Do not publish this repository, distribute a build
containing these assets, or reuse them in another project until the questions
above have real answers from her.

## Removing the artwork

If it needs to come out: blank `artist` in
`src/renderer/panes/vault/ArtCredit.tsx` and set `--canvas-art: none` in
`src/renderer/tokens.css` — the credit and the layer both disappear cleanly.
Deleting the files removes them from the working tree but **not from git
history**; that requires a history rewrite and a force-push.
