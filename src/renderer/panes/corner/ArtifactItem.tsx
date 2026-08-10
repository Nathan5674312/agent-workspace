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

      <div className="artifact-actions">
        <button onClick={onDismiss}>Dismiss</button>
        <a href={item.file} className="artifact-file-link">
          Open file
        </a>
      </div>
    </div>
  )
}
