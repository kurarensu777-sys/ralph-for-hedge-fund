import type { ReactNode } from 'react'
import { useStored } from '../../lib/api.ts'

// ---- the card's fold: the caps label is the button, a badge on the right; its state is remembered ----

/** open by default: the fixed card's OVERVIEW, TRADE, RESULT, GATES, METRICS (B-0275) */
const OPEN: Record<string, boolean> = {
  overview: true, trade: true, result: true, gates: true, metrics: true, loop: true,
}

export function Fold({ id, label, badge, title, children }: { id: string; label: string; badge?: ReactNode; title?: string; children: ReactNode }) {
  const [folds, setFolds] = useStored<Record<string, boolean>>('research.folds', {})
  const open = folds[id] ?? OPEN[id] ?? false
  return <details className="research-fd" open={open} onToggle={e => { const o = (e.currentTarget as HTMLDetailsElement).open; if (o !== open) setFolds({ ...folds, [id]: o }) }}>
    <summary title={title}>{label}{badge !== undefined && <span className="bd">{badge}</span>}</summary>
    <div className="b">{children}</div>
  </details>
}
