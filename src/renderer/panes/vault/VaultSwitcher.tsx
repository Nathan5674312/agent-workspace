/**
 * Vault switcher — bottom row of the explorer panel.
 * Vault name, help, settings.
 * ponytail: static vault name "Universal Vault" for v1, no multi-vault yet.
 */
export interface VaultSwitcherProps {
  onSettings: () => void
  onHelp: () => void
}

export function VaultSwitcher({ onSettings, onHelp }: VaultSwitcherProps) {
  return (
    <div className="vault-switcher">
      <div className="vault-name">Universal Vault</div>
      <div className="vault-switcher-actions">
        <button
          className="vault-switcher-button"
          onClick={onHelp}
          title="Help"
        >
          ?
        </button>
        <button
          className="vault-switcher-button"
          onClick={onSettings}
          title="Settings"
        >
          ⚙️
        </button>
      </div>
    </div>
  )
}
