import { ArrowRight, Inbox as InboxIcon } from 'lucide-react'
import type { InboxItem } from '../../../shared/notemeta.js'

/**
 * The Inbox — what agents proposed while you were not looking.
 *
 * This is the surface the other two views do not provide and Claude Code does
 * not have: human oversight of agent work. The capture path deliberately stops
 * short of filing, writing its proposal into frontmatter (`proposed_folder`,
 * `alternatives`, `proposed_type`) and leaving the note in Inbox/ for a person
 * to agree with. That data has existed since 2026-08-06 and nothing rendered
 * it, so ten captures sat unreviewed and invisible.
 *
 * READ-ONLY for now, and the boundary is honest rather than arbitrary:
 * approving means MOVING a file out of Inbox/, which needs a write channel that
 * does not exist yet (`save()` writes a path, nothing deletes the original).
 * Adding one means editing shared/ipc.ts, which currently carries another
 * agent's uncommitted work. Seeing the queue is most of the value and it ships
 * today; acting on it is one channel away.
 */
export interface InboxViewProps {
  items: InboxItem[] | null
  loading: boolean
  error: string | null
  onOpenNote: (path: string) => Promise<boolean>
}

export function InboxView({ items, loading, error, onOpenNote }: InboxViewProps) {
  if (error) return <div className="vault-graph-error">Inbox failed: {error}</div>
  if (loading && !items) return <div className="db-empty">Loading inbox…</div>

  if (items && items.length === 0) {
    return (
      <div className="inbox-zero">
        <InboxIcon size={20} aria-hidden="true" />
        {/* Says what the state MEANS, not just that a list is empty. An empty
            queue here is the system working, not a missing feature. */}
        <p>Nothing waiting. Everything an agent captured has been filed.</p>
      </div>
    )
  }

  return (
    <div className="inbox-view">
      <div className="inbox-head">
        <span className="inbox-count">{items!.length} waiting</span>
        <span className="inbox-hint">Captured by an agent, not yet filed</span>
      </div>

      <ul className="inbox-list">
        {items!.map((item) => (
          <li key={item.path} className="inbox-item">
            <button
              type="button"
              className="inbox-open"
              onClick={() => void onOpenNote(item.path)}
              title={item.path}
            >
              <span className="inbox-title">{item.title}</span>
              {item.captured && <span className="inbox-date">{item.captured}</span>}
            </button>

            {/* The proposal, which is the entire point of the queue: where the
                agent wants this to go, and what it considered instead. */}
            {item.folder && (
              <div className="inbox-proposal">
                <ArrowRight size={12} aria-hidden="true" />
                <span className="db-tag inbox-target">{item.folder}</span>
                {item.type && <span className="db-tag">{item.type}</span>}
                {item.alternatives.length > 0 && (
                  <span className="inbox-alts">
                    or {item.alternatives.join(', ')}
                  </span>
                )}
              </div>
            )}

            {item.body && <p className="inbox-body">{item.body}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}
