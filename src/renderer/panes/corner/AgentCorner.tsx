/**
 * SECTION 3 — the agent corner (bottom right).
 *
 * The only original surface in the app. Two jobs:
 *   A. Show what the agent MADE. A generated skill renders here in full —
 *      its contents and its key points — not a "done" toast.
 *   B. Ask before something consequential. e.g. pushing the vault to a phone
 *      from a coffee-shop network: "This is a public network. Don't send
 *      anything sensitive over it." On a trusted home network: no prompt.
 *
 * Rules:
 *   - Silence is the default. If the common path is not "nothing happened",
 *     it is wrong.
 *   - Never a bare yes/no — state what, to which device, over which network.
 *   - Dismissible without losing content (artifacts are files on disk).
 *
 * NO styling beyond structure.
 */
import { useEffect, useState, useCallback } from 'react'
import type { CornerItem, ConsentDecision } from '../../../shared/ipc.js'
import { ArtifactItem } from './ArtifactItem.js'
import { ConsentItem } from './ConsentItem.js'

/**
 * A blocking consent outranks an informational artifact. Without this, a tool
 * call can sit behind a "skill created" card until someone clears it.
 */
function nextToShow(list: CornerItem[]): CornerItem | null {
  return list.find((i) => i.kind === 'consent') ?? list[0] ?? null
}

export function AgentCorner(): React.ReactElement {
  const [items, setItems] = useState<CornerItem[]>([])

  /**
   * What is on screen is DERIVED from `items`, not a second piece of state.
   *
   * It used to be its own `useState` kept in step with a `useRef`, and the
   * `onResolved` handler called `setDisplayQueue` from inside the `setItems`
   * updater. React updaters must be pure; under StrictMode they are invoked
   * twice, and updating another component's state from inside one is the exact
   * pattern React warns about ("Cannot update a component while rendering a
   * different component"). It also gave three copies of one fact — `items`,
   * `displayQueue`, `displayQueueRef` — that could disagree, on the surface
   * whose whole job is showing the human the right prompt.
   *
   * `nextToShow` already encodes the policy (a consent outranks everything,
   * otherwise oldest first), so deriving it is behaviourally identical and
   * cannot drift.
   */
  const displayQueue = nextToShow(items)

  // Load initial items and set up subscriptions once on mount.
  useEffect(() => {
    let live = true

    // Fetch current items on mount. A consent raised before any window existed
    // was broadcast to nobody, so this fetch is the only thing that surfaces
    // it — the caller is still blocked on it.
    void window.api.corner.items().then((initial) => {
      if (live) setItems(initial)
    })

    // Subscribe to new items pushed from main.
    const unsubscribePush = window.api.corner.onPush((item) => {
      setItems((prev) => (prev.some((i) => i.id === item.id) ? prev : [...prev, item]))
    })

    // Main broadcasts this for BOTH decided and dismissed items, so it is the
    // single place the queue shrinks.
    const unsubscribeResolved = window.api.corner.onResolved((id) => {
      setItems((prev) => prev.filter((i) => i.id !== id))
    })

    return () => {
      live = false
      unsubscribePush()
      unsubscribeResolved()
    }
  }, [])

  const handleDecide = useCallback(
    (allow: boolean) => {
      if (!displayQueue || displayQueue.kind !== 'consent') return

      const decision: ConsentDecision = {
        id: displayQueue.id,
        allow,
      }

      void window.api.corner.decide(decision)
    },
    [displayQueue],
  )

  const handleDismiss = useCallback(() => {
    if (!displayQueue) return

    void window.api.corner.dismiss(displayQueue.id)
  }, [displayQueue])

  // Nothing to display: silence is the default.
  if (!displayQueue) {
    return (
      <div className="corner-empty">
        {/* Intentionally empty. The common path is "nothing happened". */}
      </div>
    )
  }

  return (
    <div className="corner-container">
      {displayQueue.kind === 'artifact' && (
        <ArtifactItem item={displayQueue} onDismiss={handleDismiss} />
      )}

      {displayQueue.kind === 'consent' && (
        <ConsentItem
          item={displayQueue}
          onAllow={() => handleDecide(true)}
          onDeny={() => handleDecide(false)}
          onDismiss={handleDismiss}
        />
      )}

      {displayQueue.kind === 'notice' && (
        <div className="corner-notice">
          <h3>{displayQueue.title}</h3>
          <p>{displayQueue.detail}</p>
          <button onClick={handleDismiss}>Close</button>
        </div>
      )}

      {/* Show count of pending items if there are more. */}
      {items.length > 1 && (
        <div className="corner-queue-info">
          {items.length - 1} more item{items.length > 2 ? 's' : ''} pending
        </div>
      )}
    </div>
  )
}
