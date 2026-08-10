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
import { useEffect, useState, useCallback, useRef } from 'react'
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
  const [displayQueue, setDisplayQueue] = useState<CornerItem | null>(null)
  const displayQueueRef = useRef<CornerItem | null>(null)

  // Sync ref with state so callbacks can access current displayQueue.
  useEffect(() => {
    displayQueueRef.current = displayQueue
  }, [displayQueue])

  // Load initial items and set up subscriptions once on mount.
  useEffect(() => {
    // Fetch current items on mount.
    void window.api.corner.items().then((initial) => {
      setItems(initial)
      setDisplayQueue(nextToShow(initial))
    })

    // Subscribe to new items pushed from main.
    const unsubscribePush = window.api.corner.onPush((item) => {
      setItems((prev) => (prev.some((i) => i.id === item.id) ? prev : [...prev, item]))
      // A consent takes the surface immediately; anything else waits its turn.
      setDisplayQueue((current: CornerItem | null) =>
        current && !(item.kind === 'consent' && current.kind !== 'consent')
          ? current
          : item,
      )
    })

    // Main broadcasts this for BOTH decided and dismissed items, so it is the
    // single place the queue advances. State updaters stay pure — the next
    // item is computed in its own updater, not as a side effect of another.
    const unsubscribeResolved = window.api.corner.onResolved((id) => {
      setItems((prev) => {
        const remaining = prev.filter((i) => i.id !== id)
        if (displayQueueRef.current?.id === id) {
          setDisplayQueue(nextToShow(remaining))
          displayQueueRef.current = nextToShow(remaining)
        }
        return remaining
      })
    })

    return () => {
      unsubscribePush()
      unsubscribeResolved()
    }
  }, [])

  const handleDecide = useCallback((allow: boolean) => {
    const current = displayQueueRef.current
    if (!current || current.kind !== 'consent') return

    const decision: ConsentDecision = {
      id: current.id,
      allow,
    }

    void window.api.corner.decide(decision)
  }, [])

  const handleDismiss = useCallback(() => {
    const current = displayQueueRef.current
    if (!current) return

    void window.api.corner.dismiss(current.id)
  }, [])

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
