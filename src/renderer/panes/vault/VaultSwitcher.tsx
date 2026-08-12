/**
 * Vault switcher — bottom row of the explorer panel.
 * Vault name, help, settings.
 * ponytail: static vault name "Universal Vault" for v1, no multi-vault yet.
 */
import { Settings } from 'lucide-react'
export interface VaultSwitcherProps {
  onSettings: () => void
  onHelp: () => void
}

export function VaultSwitcher({ onSettings, onHelp }: VaultSwitcherProps) {
  return (
    <div className="vault-switcher">
      <div className="vault-name">Universal Vault</div>
      {/* Both were console.log stubs. Disabled until there is something behind
          them — there are no app settings and no help content to show. */}
      <div className="vault-switcher-actions">
        <button
          className="vault-switcher-button"
          onClick={onHelp}
          disabled
          title="Not implemented yet"
        >
          ?
        </button>
        <button
          className="vault-switcher-button"
          onClick={onSettings}
          disabled
          title="Not implemented yet"
        >
          <Settings size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
