/**
 * IS THE APP DOING SOMETHING? — one counter, for one indicator.
 *
 * The app reads the vault on a search, on a graph build, on a note open, and
 * on every view that loads a list. Each of those already tracks its own
 * `loading` flag for its own empty state, and none of them can tell the WINDOW
 * that work is in flight. So the window said nothing, and a 200ms read looked
 * like a click that missed.
 *
 * A counter rather than a boolean, because two things load at once routinely —
 * open a note while the graph is still building — and a boolean is wrong the
 * moment the first one finishes: it would turn the indicator off while the
 * second was still running.
 *
 * NOT REACT STATE, and deliberately so. This is subscribed to by exactly one
 * component (`<LoadingGlow>`), and every caller is an async function in a
 * handler or an effect, several of them in a pane that re-renders on every
 * keystroke. A context would re-render that whole tree twice per operation to
 * move a bar at the top of the window.
 *
 * Lives in `renderer/` rather than `shared/`: nothing in main has an opinion
 * about whether the window looks busy.
 */

type Listener = (busy: boolean) => void

let depth = 0
const listeners = new Set<Listener>()

function publish(): void {
  const busy = depth > 0
  for (const l of listeners) l(busy)
}

/**
 * Say that something has started. Call the returned function when it ends.
 *
 * The function is idempotent — calling it twice must not drop the count below
 * what is actually running. A `.finally()` that fires after an early `end()` in
 * a `.then()` is a normal shape and would otherwise leave the counter negative,
 * which is an indicator that never comes back on.
 */
export function begin(): () => void {
  depth++
  publish()
  let ended = false
  return () => {
    if (ended) return
    ended = true
    depth--
    publish()
  }
}

/** Wrap a promise. The counter falls whether it resolves or rejects. */
export function track<T>(work: Promise<T>): Promise<T> {
  const end = begin()
  return work.finally(end)
}

/** Subscribe to busy/idle. Returns the unsubscribe, for an effect cleanup. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  listener(depth > 0)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether anything is in flight. For tests and for a first render. */
export function isBusy(): boolean {
  return depth > 0
}

/** Test seam. Nothing in the app resets a counter it does not own. */
export function reset(): void {
  depth = 0
  listeners.clear()
}
