/**
 * Vault switcher — bottom row of the explorer panel.
 * Vault name, help, settings.
 *
 * The name was the literal "Universal Vault", left as a deliberate `ponytail:`
 * shortcut for v1 on the grounds that there was no multi-vault yet. There was
 * always exactly one vault, but it was always MOVEABLE — the settings modal has
 * shipped a folder picker the whole time — so this line stated one machine's
 * folder as a fact and went on stating it after the folder changed. Pointed at
 * Downloads it still read "Universal Vault", which is the most direct possible
 * way to tell someone their setting did not take effect when it had.
 */
import { Settings } from 'lucide-react'
export interface VaultSwitcherProps {
  /** The open vault's folder name, from the tree root. */
  name: string
  onSettings: () => void
  onHelp: () => void
}

export function VaultSwitcher({ name, onSettings, onHelp }: VaultSwitcherProps) {
  return (
    <div className="vault-switcher">
      {/* `title` because a long folder name ellipsises in this row, and the
          whole point of the label is being able to tell which vault is open. */}
      <div className="vault-switcher-name" title={name}>
        {name}
      </div>
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
