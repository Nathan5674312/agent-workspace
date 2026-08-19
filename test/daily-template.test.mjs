/**
 * The daily-note convention — src/shared/daily.ts.
 *
 * Tested against the REAL shape this vault uses: `Daily/_Template.md` is a
 * document ABOUT the template — a heading, an instruction to copy it, a `---`,
 * then the thing to copy. Getting that boundary wrong is quiet: every daily
 * note would simply open with the instructions, and nobody would call it a bug
 * for weeks.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  dailyDateFromFilename,
  dailyPath,
  noteFromTemplate,
  todayLocal,
} from '../src/shared/daily.ts'

/** The template as this vault actually writes it. */
const REAL = `# Daily Note Template

Copy this into Daily/ as \`YYYY-MM-DD.md\` each day.

---

# {{date}}

## Did
-

## Tomorrow
-
`

test('the instructions about the template do not end up in the note', () => {
  // The failure this prevents: every daily note opening with
  // "Copy this into Daily/ as YYYY-MM-DD.md each day."
  const out = noteFromTemplate(REAL, '2026-08-18')
  assert.ok(!out.includes('Copy this into'), 'the instruction line leaked into the note')
  assert.ok(!out.includes('Daily Note Template'), 'the template heading leaked into the note')
  assert.ok(out.startsWith('# 2026-08-18'), `note starts with: ${out.slice(0, 40)}`)
})

test('{{date}} is filled in, everywhere it appears', () => {
  const out = noteFromTemplate('---\n# {{date}}\n\nlogged {{date}}\n', '2026-08-18')
  assert.ok(!out.includes('{{date}}'), 'an unreplaced placeholder reached the note')
  assert.equal((out.match(/2026-08-18/g) ?? []).length, 2)
})

test('the section headings survive intact', () => {
  // The template IS the structure the user writes into. Losing it would make
  // the feature worse than copying the file by hand.
  const out = noteFromTemplate(REAL, '2026-08-18')
  assert.ok(out.includes('## Did'))
  assert.ok(out.includes('## Tomorrow'))
})

test('a vault with no template still gets a usable note', () => {
  assert.equal(noteFromTemplate(null, '2026-08-18'), '# 2026-08-18\n\n')
})

test('a template with no --- is used whole rather than emptied', () => {
  // Another vault may keep a bare template. Slicing on a separator that is not
  // there must not hand back an empty note.
  const out = noteFromTemplate('# {{date}}\n\n## Notes\n-\n', '2026-08-18')
  assert.ok(out.includes('## Notes'))
  assert.ok(out.startsWith('# 2026-08-18'))
})

test('a --- inside the body does not truncate it', () => {
  // Horizontal rules are ordinary markdown; only the FIRST separator divides
  // the instructions from the template.
  const out = noteFromTemplate('intro\n---\n# {{date}}\n\n---\n\n## After the rule\n', '2026-08-18')
  assert.ok(out.includes('## After the rule'), 'content after a second --- was dropped')
})

test('a daily note is recognised by its shape, not by a list of exceptions', () => {
  assert.equal(dailyDateFromFilename('2026-08-18.md'), '2026-08-18')
  // Everything else in Daily/ falls out without being named.
  for (const other of ['_Template.md', 'README.md', '2026-8-1.md', '2026-08-18.txt', 'notes.md']) {
    assert.equal(dailyDateFromFilename(other), null, `${other} should not be a daily note`)
  }
})

test('dailyPath puts the note where the vault keeps them', () => {
  assert.equal(dailyPath('2026-08-18'), 'Daily/2026-08-18.md')
})

test('today is LOCAL, so a late-evening note is not filed as yesterday', () => {
  // The bug: toISOString() is UTC. At 21:00 on the 18th in a UTC-5 zone it is
  // already the 19th in UTC — and a daily note written in the evening is the
  // single most likely note to exist.
  const evening = new Date(2026, 7, 18, 21, 30)
  assert.equal(todayLocal(evening), '2026-08-18')
  const earlyMorning = new Date(2026, 7, 18, 0, 15)
  assert.equal(todayLocal(earlyMorning), '2026-08-18')
})
