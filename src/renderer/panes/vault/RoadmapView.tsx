import { Check, CircleDashed, CircleDot } from 'lucide-react'
import {
  ROADMAP,
  countByStatus,
  type Feature,
  type FeatureStatus,
} from '../../../shared/roadmap.js'

/**
 * The roadmap, rendered from `src/shared/roadmap.ts`.
 *
 * This exists instead of scattering thirty inert buttons through the chrome.
 * The app already carries sixteen controls that do nothing (docs/buttons/
 * INDEX.md), and the lesson of that queue is that a button which does nothing
 * is worse than no button: it costs a click, a wait, and a look at the console
 * before anyone learns it was never wired. One honest surface that says what is
 * built, what is half-built and what is not started is the base to build from.
 *
 * Read-only by design. Editing status from the UI would make this a second
 * source of truth about the code, and it would immediately start lying —
 * a feature is `built` when someone watched it work, which is a judgement made
 * at a commit, not in a browser.
 */

const TONE: Record<FeatureStatus, { label: string; Icon: typeof Check }> = {
  built: { label: 'Built', Icon: Check },
  partial: { label: 'Partial', Icon: CircleDot },
  planned: { label: 'Planned', Icon: CircleDashed },
}

function FeatureRow({ feature }: { feature: Feature }) {
  const { label, Icon } = TONE[feature.status]
  return (
    <li className={`roadmap-item roadmap-item--${feature.status}`}>
      <span className={`roadmap-pill roadmap-pill--${feature.status}`}>
        <Icon size={12} strokeWidth={2.25} aria-hidden="true" />
        {label}
      </span>
      <div className="roadmap-item-body">
        <span className="roadmap-item-label">{feature.label}</span>
        {/* The note is the whole value of a `built` or `partial` row: it is the
            difference between "we think this works" and "this is what was
            verified, and this is the gap". */}
        {feature.note && <p className="roadmap-item-note">{feature.note}</p>}
      </div>
      {feature.surface && <span className="roadmap-item-surface">{feature.surface}</span>}
    </li>
  )
}

export function RoadmapView() {
  const counts = countByStatus()
  const total = counts.built + counts.partial + counts.planned

  return (
    <div className="roadmap-view">
      <div className="roadmap-head">
        <div className="roadmap-counts">
          <span className="roadmap-pill roadmap-pill--built">{counts.built} built</span>
          <span className="roadmap-pill roadmap-pill--partial">{counts.partial} partial</span>
          <span className="roadmap-pill roadmap-pill--planned">{counts.planned} planned</span>
        </div>
        <span className="roadmap-total">{total} features</span>
      </div>

      {ROADMAP.map((group) => (
        <section className="roadmap-group" key={group.title}>
          <h2 className="roadmap-group-title">
            {group.title}
            {group.subtitle && <span className="roadmap-group-subtitle">{group.subtitle}</span>}
          </h2>
          <ul className="roadmap-list">
            {group.features.map((f) => (
              <FeatureRow feature={f} key={f.label} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
