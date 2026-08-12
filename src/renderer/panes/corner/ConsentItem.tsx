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

          {/*
            OUR determination gets the prominent block. The public-network line
            below is driven by `osProfile`, which is the user-set Windows flag —
            advisory, frequently wrong, and never a reason to suppress anything.
            Previously it was the only warning with any structural weight, so
            the strongest signal on screen came from the weakest source: a
            network Windows calls "Private" that we have never seen before
            rendered as a one-line "Status: Untrusted" indistinguishable from
            the SSID line above it.

            Structure and text only. No colour is involved in either warning,
            so neither depends on a palette entry that does not exist.
          */}
          {!item.network.trusted && (
            <div className="network-warning">
              <strong>This network is not one you have trusted.</strong> Nothing
              here has been marked trusted in this app, so what you send crosses a
              network we cannot vouch for.
            </div>
          )}

          {isPublicNetwork && (
            <div className="network-warning">
              <strong>Windows also reports this network as public.</strong> Avoid
              sending sensitive data over it.
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

      {/*
        Dismiss denies (src/main/corner.ts `dismiss`). A third control on a
        consent card whose effect is not stated is a consent-clarity defect in
        its own right: the safe reading has to be the obvious one, not the one
        you learn by reading the main process.
      */}
      <button className="consent-dismiss-link" onClick={onDismiss}>
        Dismiss (denies)
      </button>
    </div>
  )
}
