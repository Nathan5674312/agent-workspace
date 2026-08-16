import { VaultPane } from './panes/vault/VaultPane.js'
import { AgentCorner } from './panes/corner/AgentCorner.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { LoadingScreen } from './LoadingScreen.js'

/**
 * The vault IS the app — it owns the whole window. The agent corner floats over
 * the bottom-right and is invisible until something needs a human, so it costs
 * the vault no layout space.
 *
 * Each is wrapped separately on purpose. The vault pane holds the user's unsaved
 * buffer in React state, so a crash in the agent corner must not unmount it.
 */
export function App(): React.ReactElement {
  return (
    <div className="app">
      {/* Overlays the whole window and removes itself. Deliberately OUTSIDE the
          error boundaries and mounted last: it must never be able to keep the
          vault from mounting behind it, and the panes below are already loading
          while it plays. */}
      <LoadingScreen />
      <section className="pane-vault">
        <ErrorBoundary name="vault">
          <VaultPane />
        </ErrorBoundary>
      </section>
      <section className="pane-corner">
        <ErrorBoundary name="agent corner">
          <AgentCorner />
        </ErrorBoundary>
      </section>
    </div>
  )
}
