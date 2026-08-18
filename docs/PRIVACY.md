# Privacy

Short, because there is very little to say — which is the point.

## What leaves your machine

**Nothing.** There is no telemetry, no analytics, no crash reporting, no update
check, and no account.

The renderer runs under a Content Security Policy of `default-src 'none'` with
`connect-src 'none'`, so the UI layer cannot make a network request even if
something in it tried. The main process makes none either: the app used to
reach a vault server on `http://127.0.0.1:8765` on this same machine, and now
reads and writes the vault directory directly. There is no loopback traffic left
and no port to open.

The one exception is deliberate and requires a click: the artwork credit links
to Instagram, and following it hands the URL to your normal browser. That is a
navigation you initiate, and only `http`/`https` URLs are ever handed over.

## What is stored, and where

| What | Where |
|---|---|
| Your notes | The vault directory on disk. The app reads and writes them itself, in the main process, through a temp file and a rename. |
| A copy of every note you overwrite | `.backups/` inside the vault directory, mirroring the note's path with a timestamp appended. Local, never pruned, never sent anywhere. |
| Network trust decisions | `network-trust.json` in Electron's userData directory. Local only. |
| Nothing else | There is no database, no cache of note contents, and no history file. |

## The graph

The wikilink graph is derived from your notes and held in memory with a 30
second lifetime. It is a cache in the strict sense: deletable at any time,
rebuilt from the files, never authoritative, and never written to disk.

## Scope

This describes the app as it exists now, for one user on one machine. If it ever
syncs to another device or gains a hosted component, this document is wrong and
must be rewritten before that ships.
