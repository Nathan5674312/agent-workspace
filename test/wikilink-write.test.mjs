/**
 * addWikilink / linkTextFor — the half of "connect two notes from the graph"
 * that touches prose.
 *
 * Tested harder than the reading side because the stakes are not symmetric. A
 * reader that is wrong draws a wrong graph and you notice. A writer that is
 * wrong edits a note you are not looking at, and `.backups/` is the only thing
 * between it and text you wrote by hand.
 *
 * Every fixture below is a shape that exists in the real vault. The counts
 * quoted in the names are from the scan in `docs/graph-connections.md`.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  addWikilink,
  linkTextFor,
  normTarget,
  parseWikilinks,
  parseWikilinkRefs,
} from '../src/shared/wikilink.ts'

// --------------------------------------------------------------- linkTextFor

/** The real resolver's rule: names first, full paths too, FIRST-WINS. */
function indexOf(paths) {
  const index = new Map()
  const add = (k, p) => {
    const n = normTarget(k)
    if (n && !index.has(n)) index.set(n, p)
  }
  for (const p of paths) add(p.split('/').pop(), p)
  for (const p of paths) add(p, p)
  return (name) => index.get(normTarget(name)) ?? null
}

test('a unique stem gets the short link', () => {
  const resolve = indexOf(['Fate/Decisions.md', 'Fate/Roadmap/00 - INDEX.md'])
  assert.equal(linkTextFor('Fate/Decisions.md', resolve), '[[Decisions]]')
})

test('a SHARED stem gets the path form, because the short one lands elsewhere', () => {
  // 1336 of 1900 notes share a stem. First-wins means `[[README]]` next to two
  // of them is a link to whichever the walk reached first -- silently, and
  // looking perfectly correct.
  const paths = ['System/README.md', 'Fate/README.md']
  const resolve = indexOf(paths)
  assert.equal(linkTextFor('System/README.md', resolve), '[[README]]', 'the first one keeps the short form')
  assert.equal(
    linkTextFor('Fate/README.md', resolve),
    '[[Fate/README.md|README]]',
    'the loser of the collision must not get the short form',
  )
})

test('whatever it writes, resolving it comes back to the note it was for', () => {
  // The property that matters. Everything else about this function is taste.
  const paths = [
    'Fate/Decisions.md',
    'System/README.md',
    'Fate/README.md',
    'Fate/Claude Code Extension/00 - Product Spec.md',
    'System/Fable Backbone/Coding & Building.md',
  ]
  const resolve = indexOf(paths)
  for (const p of paths) {
    const link = linkTextFor(p, resolve)
    const [ref] = parseWikilinkRefs(link)
    assert.equal(resolve(ref.target), p, `${link} does not resolve back to ${p}`)
  }
})

test('a path that cannot be written as a wikilink is refused, not mangled', () => {
  // No filename in the vault contains these. A filename is user input, so the
  // day one does, refusing beats writing `[[a|b]]` that parses as another link.
  const resolve = () => null
  for (const bad of ['Fate/a|b.md', 'Fate/a]b.md', 'Fate/a#b.md']) {
    assert.throws(() => linkTextFor(bad, resolve), /cannot be written as a wikilink/)
  }
})

// ---------------------------------------------------------------- addWikilink

const BULLETS = ['---', 'title: A', '---', '', 'Body.', '', '## Related', '', '- [[One]]', '- [[Two]]', ''].join('\n')
const DOTS = ['---', 'title: A', '---', '', 'Body.', '', '## Related', '', '[[One]] · [[Two]]', ''].join('\n')
const BARE = ['# A', '', 'Body with no section at all.', ''].join('\n')

test('a bullet section grows another bullet', () => {
  const out = addWikilink(BULLETS, '[[Three]]')
  assert.match(out, /- \[\[Two\]\]\n- \[\[Three\]\]/)
  assert.deepEqual(parseWikilinks(out), ['One', 'Two', 'Three'])
})

test('the bullet MARKER is copied, not assumed', () => {
  // A section written with `*` stays written with `*`.
  const star = BULLETS.split('- [[').join('* [[')
  const out = addWikilink(star, '[[Three]]')
  assert.match(out, /\* \[\[Two\]\]\n\* \[\[Three\]\]/)
  assert.doesNotMatch(out, /^- /m)
})

test('a · line grows another ·, on the same line', () => {
  // The whole point of that shape is that it is one line.
  const out = addWikilink(DOTS, '[[Three]]')
  assert.match(out, /\[\[One\]\] · \[\[Two\]\] · \[\[Three\]\]\n/)
  assert.equal(out.split('\n').filter((l) => l.includes('[[')).length, 1)
})

test('a bare link line gets a NEW line, never a · appended after its prose', () => {
  // Three notes in the vault look like `[[motion-system]] — scroll layer, …`.
  // Appending ` · [[X]]` there would put the link after somebody's sentence.
  const bare = ['# A', '', '## Related', '', '[[One]] — the scroll layer, and why', ''].join('\n')
  const out = addWikilink(bare, '[[Two]]')
  assert.match(out, /\[\[One\]\] — the scroll layer, and why\n\[\[Two\]\]\n/)
  assert.doesNotMatch(out, /why · /)
})

test('a table row in the section is not extended either', () => {
  // Zero of these exist today. A ` · [[X]]` after the closing pipe would break
  // the table, and the rule that protects the bare line protects this too.
  const tbl = ['# A', '', '## Related', '', '| note | why |', '| --- | --- |', '| [[One]] | because |', ''].join('\n')
  const out = addWikilink(tbl, '[[Two]]')
  assert.match(out, /\| \[\[One\]\] \| because \|\n\[\[Two\]\]\n/)
  assert.doesNotMatch(out, /because \| · /)
})

test('no section: one is created at the END of the file', () => {
  // 78 of 78 notes with a section keep it last. Nothing goes at the cursor.
  const out = addWikilink(BARE, '[[One]]')
  assert.equal(out, '# A\n\nBody with no section at all.\n\n## Related\n\n- [[One]]\n')
})

test('the file tail is normalised, not grown', () => {
  // No note in this vault ends with a blank line. Without this every note the
  // feature touched would gain one.
  for (const tail of ['', '\n', '\n\n', '\n\n\n', '   \n\n']) {
    const out = addWikilink('# A\n\nBody.' + tail, '[[One]]')
    assert.equal(out, '# A\n\nBody.\n\n## Related\n\n- [[One]]\n', `tail ${JSON.stringify(tail)}`)
  }
})

test('a section that exists but is empty is filled, not duplicated', () => {
  const empty = ['# A', '', 'Body.', '', '## Related', ''].join('\n')
  const out = addWikilink(empty, '[[One]]')
  assert.equal(out.match(/## Related/g).length, 1)
  assert.match(out, /## Related\n\n- \[\[One\]\]/)
})

test('all six heading spellings are recognised, so no note gets two sections', () => {
  for (const h of ['## Related', '## Links', '# See also', '### References', '## Connections', '## Linked Spec']) {
    const note = ['# A', '', 'Body.', '', h, '', '- [[One]]', ''].join('\n')
    const out = addWikilink(note, '[[Two]]')
    // Exactly as many headings out as in: recognising the section means
    // appending INTO it, never adding a house-style one underneath.
    assert.equal(
      (out.match(/^#{1,6}\s/gm) ?? []).length,
      (note.match(/^#{1,6}\s/gm) ?? []).length,
      `${h} was not recognised and a second section was added`,
    )
    assert.match(out, /- \[\[One\]\]\n- \[\[Two\]\]/, h)
  }
})

test('a link the note already has is not added again', () => {
  assert.equal(addWikilink(BULLETS, '[[One]]'), BULLETS)
  // ...compared on the ADDRESS, not the spelling.
  assert.equal(addWikilink(BULLETS, '[[one]]'), BULLETS)
  assert.equal(addWikilink(BULLETS, '[[One.md]]'), BULLETS)
})

test('a link already in the PROSE counts as present', () => {
  // 591 of 1479 links in this vault are in prose rather than a list. Adding a
  // "Related" entry for something the sentence above already links to is noise.
  const prose = ['# A', '', 'This builds on [[One]] directly.', ''].join('\n')
  assert.equal(addWikilink(prose, '[[One]]'), prose)
})

test('a link in FRONTMATTER does not count as present', () => {
  // 4 notes of 1900 have one. That is four accidents, not a convention, and
  // treating it as the connection would refuse to write the real one.
  const fm = ['---', 'title: A', 'related: [[One]]', '---', '', 'Body.', ''].join('\n')
  const out = addWikilink(fm, '[[One]]')
  assert.match(out, /## Related\n\n- \[\[One\]\]/)
  // ...and the frontmatter is untouched.
  assert.match(out, /^---\ntitle: A\nrelated: \[\[One\]\]\n---/)
})

test('a heading inside FRONTMATTER is not mistaken for the section', () => {
  const fm = ['---', 'title: A', 'note: "## Related"', '---', '', 'Body.', ''].join('\n')
  const out = addWikilink(fm, '[[One]]')
  assert.match(out, /Body\.\n\n## Related\n\n- \[\[One\]\]\n$/)
})

test('the section is found even when another heading follows it', () => {
  // Zero notes in the vault look like this. The writer still must not append
  // into the wrong section when one does.
  const odd = ['# A', '', '## Related', '', '- [[One]]', '', '## Notes', '', 'Trailing prose.', ''].join('\n')
  const out = addWikilink(odd, '[[Two]]')
  assert.match(out, /- \[\[One\]\]\n- \[\[Two\]\]\n\n## Notes/)
  assert.match(out, /Trailing prose\.\n$/)
})

test('CRLF stays CRLF, LF stays LF', () => {
  const crlf = BULLETS.split('\n').join('\r\n')
  const out = addWikilink(crlf, '[[Three]]')
  assert.match(out, /- \[\[Two\]\]\r\n- \[\[Three\]\]\r\n/)
  assert.doesNotMatch(out.split('\r\n').join(''), /\n/, 'a bare LF was introduced')

  const dotsCrlf = DOTS.split('\n').join('\r\n')
  assert.match(addWikilink(dotsCrlf, '[[Three]]'), /\[\[Two\]\] · \[\[Three\]\]\r\n/)

  const newCrlf = addWikilink('# A\r\n\r\nBody.\r\n', '[[One]]')
  assert.equal(newCrlf, '# A\r\n\r\nBody.\r\n\r\n## Related\r\n\r\n- [[One]]\r\n')

  assert.doesNotMatch(addWikilink(BULLETS, '[[Three]]'), /\r/)
})

test('the body outside the section is never touched', () => {
  const out = addWikilink(BULLETS, '[[Three]]')
  assert.match(out, /^---\ntitle: A\n---\n\nBody\.\n\n## Related/)
})

test('a malformed link is refused rather than written', () => {
  for (const bad of ['[[One', 'One', '', '[[]]', '[[#heading]]', '[[One]] [[Two]]']) {
    assert.throws(() => addWikilink(BULLETS, bad), /not a single note wikilink/, JSON.stringify(bad))
  }
})

test('the path form is written and read back correctly', () => {
  const out = addWikilink(BULLETS, '[[Fate/README.md|README]]')
  assert.match(out, /- \[\[Fate\/README\.md\|README\]\]/)
  assert.deepEqual(parseWikilinks(out), ['One', 'Two', 'Fate/README.md'])
})

// ------------------------------------------------- against the REAL corpus
//
// Skipped unless the vault is on this machine, so the suite still passes
// anywhere else. When it is there, this is the test that matters: the rule is
// "the link resolves back to the note you meant" and the only honest place to
// check that is 1900 real filenames, collisions and all.

const VAULT = process.env.AGENT_WORKSPACE_VAULT_DIR ?? 'C:\\Users\\Nathan\\Desktop\\Universal Vault'

test('every note in the real vault gets a link that resolves back to it', { skip: !existsSync(VAULT) }, () => {
  const SKIP = new Set(['.git', '.obsidian', '.trash', '.backups', 'node_modules', '__pycache__'])
  const paths = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.toLowerCase().endsWith('.md')) paths.push(relative(VAULT, p).split('\\').join('/'))
    }
  }
  walk(VAULT)
  assert.ok(paths.length > 100, `only ${paths.length} notes found — is this a vault?`)

  const resolve = indexOf(paths)
  let short = 0
  // Reported separately because the headline number is misleading on its own:
  // 1120 files in this vault are called SKILL.md, so the whole-vault figure is
  // a fact about the skills library, not about the notes anyone connects.
  let notes = 0
  let notesShort = 0
  for (const p of paths) {
    const link = linkTextFor(p, resolve)
    const [ref] = parseWikilinkRefs(link)
    assert.ok(ref, `${link} for ${p} did not parse`)
    assert.equal(resolve(ref.target), p, `${link} resolves to ${resolve(ref.target)}, not ${p}`)
    const isShort = !link.includes('|')
    if (isShort) short++
    if (!p.startsWith('System/Skills/') && !p.startsWith('System/Skill Sources/')) {
      notes++
      if (isShort) notesShort++
    }
  }
  console.log(`      whole vault:  ${paths.length} notes · ${short} short · ${paths.length - short} path form`)
  console.log(`      excl. skills: ${notes} notes · ${notesShort} short · ${notes - notesShort} path form`)
})

test('adding a link to every real note leaves it parseable and one link longer', { skip: !existsSync(VAULT) }, () => {
  const SKIP = new Set(['.git', '.obsidian', '.trash', '.backups', 'node_modules', '__pycache__'])
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.toLowerCase().endsWith('.md')) files.push(p)
    }
  }
  walk(VAULT)

  // A target no note can already link to, so every note must gain exactly one.
  const LINK = '[[__scope_probe_target__]]'
  let touched = 0
  let grewSection = 0
  for (const abs of files) {
    if (statSync(abs).size > 2_000_000) continue
    let text
    try {
      text = readFileSync(abs, 'utf-8')
    } catch {
      continue
    }
    const out = addWikilink(text, LINK)
    touched++

    const before = parseWikilinks(text).length
    const after = parseWikilinks(out).length
    assert.equal(after, before + 1, `${abs} gained ${after - before} links`)
    assert.ok(out.includes(LINK), `${abs} did not get the link`)
    // The original text survives as a prefix of the result whenever a whole new
    // section was appended; when the link went INTO a section it does not, so
    // the check that always holds is that nothing was lost.
    if (out.startsWith(text.replace(/\s+$/, ''))) grewSection++
    for (const line of text.split('\n')) {
      if (line.trim() && !line.includes('·')) {
        assert.ok(out.includes(line.trim()), `${abs} lost a line: ${line.slice(0, 60)}`)
      }
    }
    // Idempotent on the real note too.
    assert.equal(addWikilink(out, LINK), out, `${abs} added the same link twice`)
  }
  assert.ok(touched > 100, `only ${touched} notes read`)
  console.log(`      ${touched} real notes · ${grewSection} got a new section · ${touched - grewSection} appended into one`)
})
