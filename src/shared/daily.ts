/**
 * Daily-note convention, as THIS vault actually practises it.
 *
 * Lives in shared/ rather than beside the component for the reason
 * DatabaseView states about `statusTone`: a .tsx module cannot be imported by
 * the `node --test` suite, because type stripping does not handle JSX. Logic
 * about what a note contains is testable logic and belongs where it can be
 * tested against real strings.
 *
 * Nothing here was invented. `Daily/_Template.md` in the vault is a document
 * ABOUT the template — a heading, "Copy this into Daily/ as `YYYY-MM-DD.md`
 * each day", a `---`, and then the thing to copy — and the folder holds
 * `YYYY-MM-DD.md` files. Both facts are read off the vault, not assumed.
 */

/** The folder daily notes live in. */
export const DAILY_DIR = 'Daily'

/** The template beside them. Absent in another vault, which is handled. */
export const DAILY_TEMPLATE = `${DAILY_DIR}/_Template.md`

/** `Daily/2026-08-18.md` for a date string. */
export function dailyPath(date: string): string {
  return `${DAILY_DIR}/${date}.md`
}

/**
 * Is this filename a daily note?
 *
 * Shape, not name: `_Template.md` and any README in the folder fall out of this
 * without being listed as exceptions, so adding a file to `Daily/` never turns
 * it into a calendar entry by accident.
 */
export function dailyDateFromFilename(name: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(name)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * The body for a new daily note.
 *
 * Everything after the FIRST `---` is the template proper — taking the whole
 * file would open every daily note with "Copy this into Daily/…". A template
 * with no separator is used whole, because another vault may keep a bare one
 * and slicing on a separator that is not there must not hand back nothing.
 * Later `---` lines are ordinary horizontal rules and are preserved.
 */
export function noteFromTemplate(template: string | null, date: string): string {
  if (!template) return `# ${date}\n\n`
  const parts = template.split(/^---$/m)
  const body = (parts.length > 1 ? parts.slice(1).join('---') : template).trim()
  return `${body.replace(/\{\{date\}\}/g, date)}\n`
}

/**
 * Today, in the USER's timezone.
 *
 * NOT `toISOString().slice(0, 10)`, which is UTC and names yesterday for anyone
 * working after their timezone's UTC midnight — precisely the hour a daily note
 * gets written.
 */
export function todayLocal(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
