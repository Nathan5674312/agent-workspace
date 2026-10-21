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

type Entry = { path: string; tf: Map<string, number>; len: number }
export type Index = { entries: Entry[]; df: Map<string, number>; avg: number }

export function buildIndex(docs: Doc[]): Index {
  const df = new Map<string, number>()
  const entries = docs.map((d) => {
    const tf = new Map<string, number>()
    const add = (t: string, w: number) => tf.set(t, (tf.get(t) ?? 0) + w)
    const body = terms(d.text)
    for (const t of body) add(t, 1)
    const title = terms(d.title)
    for (const t of title) add(t, TITLE_WEIGHT)
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    return { path: d.path, tf, len: body.length + title.length * TITLE_WEIGHT }
  })
  const avg = entries.reduce((n, e) => n + e.len, 0) / Math.max(1, entries.length)
  return { entries, df, avg }
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
