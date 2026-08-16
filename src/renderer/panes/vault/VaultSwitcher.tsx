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
      <div className="vault-switcher-name">Universal Vault</div>
      {/* Help is still a console.log stub and stays disabled — there is no help
          content to show. Settings now opens the real modal. */}
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
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
