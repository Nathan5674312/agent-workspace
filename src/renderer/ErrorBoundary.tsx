import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * One boundary per pane.
 *
 * Without this, an uncaught throw anywhere in the tree unmounts the ENTIRE root
 * — and the vault pane holds the user's unsaved buffer in React state, so a
 * crash in an unrelated pane destroys their edits with no warning and no way
 * back. That is not hypothetical: the section-2 review proved d3's `forceLink`
 * throws synchronously inside an effect when a graph edge names a node that is
 * not in the node list.
 *
 * So the boundary is not decoration, it is the thing that keeps one pane's bug
 * from eating another pane's unsaved work. Keep the panes independently
 * wrapped; a single boundary around all three would not help, because the vault
 * pane would still unmount.
 *
 * NO styling — structure and text only, like everything else in the renderer.
 */
type Props = { name: string; children: ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Main-process logging would need a channel that does not exist in the
    // contract yet. Console is honest for now and beats swallowing it.
    // ponytail: route to main and persist once there is a log channel.
    console.error(`[${this.props.name}] pane crashed`, error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="pane-crash" role="alert">
        <h2>The {this.props.name} pane stopped</h2>
        <p>
          The other panes are unaffected and any unsaved work in them is intact.
        </p>
        <p className="pane-crash-message">{error.message}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Retry this pane
        </button>
      </div>
    )
  }
}
