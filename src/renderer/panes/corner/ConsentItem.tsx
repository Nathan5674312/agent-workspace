/**
 * Display a consent request. Blocks until the human chooses allow/deny.
 * Never a bare yes/no — state what, to which device, over which network.
 *
 * For public networks, the warning is expressed through STRUCTURE and TEXT,
 * not color (the palette has no semantic warning colour yet).
 */
import type { CornerItem } from '../../../shared/ipc.js'

interface Props {
  item: Extract<CornerItem, { kind: 'consent' }>
  onAllow: () => void
  onDeny: () => void
  onDismiss: () => void
}

export function ConsentItem({
  item,
  onAllow,
  onDeny,
  onDismiss,
}: Props): React.ReactElement {
  const isPublicNetwork = item.network?.osProfile === 'public'

  return (
    <div
      className={`corner-consent ${item.severity === 'warn' ? 'consent-warn' : 'consent-info'}`}
    >
      <h3 className="consent-title">{item.title}</h3>

      <p className="consent-detail">{item.detail}</p>

      {item.network && (
        <div className="consent-network-info">
          <div className="network-header">Network</div>

          {item.network.ssid && (
            <div className="network-ssid">
              <span className="label">SSID:</span> {item.network.ssid}
            </div>
          )}

          <div className="network-fingerprint">
            <span className="label">Fingerprint:</span>
            {item.network.fingerprint ? (
              <span className="fingerprint-value">{item.network.fingerprint}</span>
            ) : (
              <span className="fingerprint-unknown">(unknown)</span>
            )}
          </div>

          <div className="network-trust">
            <span className="label">Status:</span>
            {item.network.trusted ? (
              <span className="trust-trusted">Trusted</span>
            ) : (
              <span className="trust-untrusted">Untrusted</span>
            )}
          </div>

          {item.network.osProfile !== 'unknown' && (
            <div className="network-os-profile">
              <span className="label">OS profile:</span>
              {item.network.osProfile}
              <span className="label-note">(advisory only)</span>
            </div>
          )}

          {isPublicNetwork && (
            <div className="network-warning">
              <strong>Public network detected.</strong> Avoid sending sensitive data
              over public WiFi.
            </div>
          )}
        </div>
      )}

      <div className="consent-actions">
        <button className="consent-allow" onClick={onAllow}>
          Allow
        </button>
        <button className="consent-deny" onClick={onDeny}>
          Deny
        </button>
      </div>

      <button className="consent-dismiss-link" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  )
}
