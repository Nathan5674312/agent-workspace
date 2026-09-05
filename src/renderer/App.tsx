import { VaultPane } from './panes/vault/VaultPane.js'
import { AgentCorner } from './panes/corner/AgentCorner.js'
import { AgentActivity } from './panes/corner/AgentActivity.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { LoadingScreen } from './LoadingScreen.js'
import { Onboarding } from './Onboarding.js'

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
          <AgentActivity />
          <AgentCorner />
        </ErrorBoundary>
      </section>
      {/* LAST, so it draws over both panes, and inside its own boundary for the
          same reason the others have one: a first run is the worst possible
          moment for a crash, and the vault must still mount behind a tour that
          failed. It removes itself once seen — see Onboarding.tsx. */}
      <ErrorBoundary name="onboarding">
        <Onboarding />
      </ErrorBoundary>
    </div>
  )
}
