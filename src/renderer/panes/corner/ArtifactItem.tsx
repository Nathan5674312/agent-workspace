/**
 * Display an artifact (something the agent created).
 * This is a VIEW of a file on disk, never the only copy.
 * Dismissing does not delete the file.
 */
import type { CornerItem } from '../../../shared/ipc.js'

interface Props {
  item: Extract<CornerItem, { kind: 'artifact' }>
  onDismiss: () => void
}

export function ArtifactItem({ item, onDismiss }: Props): React.ReactElement {
  return (
    <div className="corner-artifact">
      <h3 className="artifact-title">{item.title}</h3>

      <div className="artifact-body">
        <pre>{item.body}</pre>
      </div>

      {item.keyPoints.length > 0 && (
        <div className="artifact-keypoints">
          <h4>Key points</h4>
          <ul>
            {item.keyPoints.map((point: string, idx: number) => (
              <li key={idx}>{point}</li>
            ))}
          </ul>
        </div>
      )}

      {/*
        The path is TEXT, never an <a href>. `item.file` is agent-generated and
        therefore attacker-influenced; `href={item.file}` accepted any scheme.
        `will-navigate`/`will-frame-navigate` in src/main/index.ts do NOT fire
        for a `javascript:` URL — Chromium runs it as script in the current
        document instead of navigating — so clicking "Open file" on an artifact
        whose `file` was `javascript:...` executed page script holding the full
        `window.api` bridge. From there `corner.decide({ id, allow: true })`
        allows a pending consent and `network.trust(true)` marks the current
        network trusted, with no human involved. That is the exact bypass this
        pane exists to prevent.

        There is no shell.openPath channel on the bridge, so the anchor could
        not open anything anyway. Showing the path costs nothing and removes
        the vector entirely.
      */}
      <div className="artifact-file">
        <span className="label">File:</span> <code>{item.file}</code>
      </div>

      <div className="artifact-actions">
        <button onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  )
}
