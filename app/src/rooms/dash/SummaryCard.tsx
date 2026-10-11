import type { ReactNode } from 'react'
import type { DashSummaryView } from '../../../shared/types.ts'
import { relTime } from '../../lib/api.ts'
import { Dot } from '../../ui/kit.tsx'
import { cardModel } from './summary.ts'

// THE LIVE SUMMARY CARD: one per dashboard, its three headline tiles (value, label, the numbers
// law's tag chip, the hint as a tooltip), the as-of and the health dot the dashboard itself
// reported. `unknown` says why; "no summary published" where a dashboard declares none. The actions
// (Open / Start / Stop / Dev) are the room's own controls, passed in.

const ago = (ms: number) => { const r = relTime(ms); return r.startsWith('in ') ? r : `${r} ago` }

export function SummaryCard({ name, id, summary, actions, onOpen }: { name: string; id: string; summary: DashSummaryView; actions: ReactNode; onOpen: () => void }) {
  const m = cardModel(summary, ago)
  const dotTitle = m.dot === 'off' ? (summary.state === 'stopped' ? 'stopped: its port is closed' : 'no summary published') : m.dot === 'unknown' ? m.line : `the dashboard reports ${m.dot}`
  return (
    <div className={`dsc ${m.stale ? 'stale' : ''} ${summary.state}`} data-dash={id}>
      <div className="dsc-h" role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen() }} title={`${name} - ${id}${summary.url ? ` - reads ${summary.url} every ${summary.every}` : ''}`}>
        <Dot s={m.dot} title={dotTitle} />
        <span className="dsc-name">{name}</span>
        <span className={`dsc-line mono ${summary.state === 'unknown' ? 't-warn' : 'faint'}`} title={m.asOf ? new Date(m.asOf).toISOString() : m.line}>{m.line}</span>
      </div>
      {m.tiles.length > 0 && (
        <div className="dsc-tiles" title={m.stale ? 'what the card last said: not current' : undefined}>
          {m.tiles.map((t, i) => (
            <div key={i} className="dsc-t" title={t.hint || undefined}>
              <span className="dsc-v mono">{t.value}</span>
              <span className="dsc-l">{t.label}{t.tag && <span className="dsc-tag mono">{t.tag}</span>}</span>
            </div>
          ))}
        </div>
      )}
      <div className="dsc-acts" onClick={e => e.stopPropagation()}>{actions}</div>
    </div>
  )
}
