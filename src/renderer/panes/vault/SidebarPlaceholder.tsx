import { featureForRibbon } from '../../../shared/roadmap.js'

/**
 * What a left-ribbon icon shows before its feature exists.
 *
 * The bug this fixes: `activeRibbon` had exactly one consumer, the
 * `=== 'files'` branch in VaultPane, with no else. Clicking any of the other
 * seven icons lit the icon, set `aria-pressed`, and EMPTIED the sidebar — the
 * app looked broken rather than unfinished, and the only way to get the file
 * tree back was to guess that Files was a button.
 *
 * A placeholder is not a lesser fix than hiding the icons. The icons are the
 * shape of the product, and the roadmap in `shared/roadmap.ts` is what each one
 * is a promise of, so this reads the status straight from there rather than
 * hardcoding a second copy of it. If a feature ever ships, its ribbon panel
 * stops being rendered by this component and nothing here needs editing.
 */
export function SidebarPlaceholder({ view, label }: { view: string; label: string }) {
  const feature = featureForRibbon(view)

  return (
    <div className="sidebar-placeholder">
      <h2 className="sidebar-placeholder-title">{label}</h2>
      <p className="sidebar-placeholder-status">
        {feature?.status === 'partial' ? 'Partly built' : 'Not built yet'}
      </p>
      {feature && <p className="sidebar-placeholder-feature">{feature.label}</p>}
      {feature?.note && <p className="sidebar-placeholder-note">{feature.note}</p>}
      <p className="sidebar-placeholder-hint">
        Tracked on the Roadmap tab. The file tree is under the Files icon above.
      </p>
    </div>
  )
}
