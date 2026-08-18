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
      {/* Both open a real modal now. Help was disabled for want of content
          rather than machinery, and the content it needed was a description of
          what this app already does — see HelpDialog.tsx. */}
      <div className="vault-switcher-actions">
        <button
          className="vault-switcher-button"
          onClick={onHelp}
          title="Help"
          aria-label="Help"
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
