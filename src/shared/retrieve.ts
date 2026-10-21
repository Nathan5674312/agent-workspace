/**
 * RANKED RETRIEVAL FOR A WHOLE MESSAGE, NOT A SEARCH BOX QUERY.
 *
 * `search.ts` answers a person typing two words into a sidebar: every word must
 * appear, names first. Handed an agent's whole message — "pc was super laggy
 * just sitting there, what was causing it" — that AND finds nothing, because no
 * note contains "super" and "sitting" and "causing". This ranks instead: BM25
 * over each note's body and name, so rare words carry the weight and filler
 * carries almost none.
 *
 * A CANDIDATE, NOT A FEATURE. It is scored against the shipped search on a
 * frozen question set (fate-benchmark/retrieval) before anything uses it. Every
 * constant below was fixed BEFORE the first run, so none of them is fitted to
 * those questions:
 *   - STOPWORDS is NLTK's English list, verbatim, not a hand-picked one. A list
 *     written after reading the questions would be train-on-test.
 *   - k1 = 1.2, b = 0.75: the textbook defaults.
 *   - TITLE_WEIGHT = 3: a word in a note's name counts as three in its body.
 *   - plural folding: one rule, applied identically to notes and queries.
 *
 * Pure, so the app, the benchmark and `node --test` compute the same ranking.
 */

/** NLTK's English stopword list (nltk.corpus.stopwords, 'english'), verbatim. */
export const STOPWORDS = new Set(
  (
    'i me my myself we our ours ourselves you your yours yourself yourselves he him his himself ' +
    'she her hers herself it its itself they them their theirs themselves what which who whom ' +
    'this that these those am is are was were be been being have has had having do does did ' +
    'doing a an the and but if or because as until while of at by for with about against between ' +
    'into through during before after above below to from up down in out on off over under again ' +
    'further then once here there when where why how all any both each few more most other some ' +
    'such no nor not only own same so than too very s t can will just don should now d ll m o re ' +
    've y ain aren couldn didn doesn hadn hasn haven isn ma mightn mustn needn shan shouldn wasn ' +
    'weren won wouldn'
  ).split(' '),
)

export const K1 = 1.2
export const B = 0.75
export const TITLE_WEIGHT = 3

/** "adapters" and "adapter" are one word to a reader. "class", "status", "analysis" stay whole. */
function fold(t: string): string {
  return t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t) ? t.slice(0, -1) : t
}

/** Lowercase words of two or more letters or digits, folded, stopwords out. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(fold)
}

export type Doc = { path: string; title: string; text: string }

export type Entry = { path: string; tf: Map<string, number>; len: number }
export type Index = { entries: Entry[]; df: Map<string, number>; avg: number }

/**
 * One note's term counts. Built a note at a time so a caller can drop each
 * note's text as soon as it is counted: holding a whole vault's text at once is
 * the 856 MB main-process peak scan() in vault.ts was rewritten to avoid.
 */
export function entry(d: Doc): Entry {
  const tf = new Map<string, number>()
  const add = (t: string, w: number) => tf.set(t, (tf.get(t) ?? 0) + w)
  const body = terms(d.text)
  for (const t of body) add(t, 1)
  const title = terms(d.title)
  for (const t of title) add(t, TITLE_WEIGHT)
  return { path: d.path, tf, len: body.length + title.length * TITLE_WEIGHT }
}

export function indexOf(entries: Entry[]): Index {
  const df = new Map<string, number>()
  for (const e of entries) for (const t of e.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const avg = entries.reduce((n, e) => n + e.len, 0) / Math.max(1, entries.length)
  return { entries, df, avg }
}

export function buildIndex(docs: Doc[]): Index {
  return indexOf(docs.map(entry))
}

/** Notes ranked by BM25 against every distinct term in `query`. Zero-score notes are dropped. */
export function rank(index: Index, query: string, k = 10): { path: string; score: number }[] {
  const q = [...new Set(terms(query))]
  const n = index.entries.length
  const idf = new Map(q.map((t) => [t, Math.log(1 + (n - (index.df.get(t) ?? 0) + 0.5) / ((index.df.get(t) ?? 0) + 0.5))]))
  const scored: { path: string; score: number }[] = []
  for (const e of index.entries) {
    let score = 0
    for (const t of q) {
      const f = e.tf.get(t)
      if (!f) continue
      score += idf.get(t)! * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * e.len) / index.avg)))
    }
    if (score > 0) scored.push({ path: e.path, score })
  }
  // Path as the tie-break, so identical queries give identical order.
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, k)
}

/**
 * What the agent reads in front of the user's message. Paths only, never
 * excerpts: excerpts cut mid-note are what lost 6/16 to 16/16 in the vault's own
 * A/B, and a path makes the agent read the whole note instead. The wording says
 * how they were picked, so a poor match reads as one rather than as a claim.
 */
export function pointerBlock(paths: string[], vaultDir: string): string | undefined {
  if (paths.length === 0) return undefined
  return [
    `Notes in this vault that share the most words with the message below, best first (paths relative to ${vaultDir}).`,
    'Picked by word overlap, not meaning: open the ones that fit before answering, ignore the rest, and search further if none answers it.',
    ...paths.map((p) => `- ${p}`),
  ].join('\n')
}
