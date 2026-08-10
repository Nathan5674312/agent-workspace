import { ClaudePane } from './panes/claude/ClaudePane.js'
import { VaultPane } from './panes/vault/VaultPane.js'
import { AgentCorner } from './panes/corner/AgentCorner.js'

export function App(): React.ReactElement {
  return (
    <div className="app">
      <section className="pane-claude">
        <ClaudePane />
      </section>
      <section className="pane-vault">
        <VaultPane />
      </section>
      <section className="pane-corner">
        <AgentCorner />
      </section>
    </div>
  )
}
