import type { ReactNode } from 'react'
import { Meter } from '../../ui/kit.tsx'
import { day as utcDay } from '../../../shared/time.ts'
import type { Kpis } from './kpis.ts'

// ROOM: lab - the KPI tile strip: runs in 7 days, verify pass rate, reads overdue, retros due.
// Each tile is a number, a caps label and one small mark; the long form rides in the tooltip.

const short = (d: string) => d.replace(/^(lab|desks)\//, '')

function Tile({ v, k, tone, title, children }: { v: ReactNode; k: string; tone?: string; title: string; children?: ReactNode }) {
  return <div className="card lab-kpi" title={title}>
    <div className="lab-kpi-t"><span className={`lab-kpi-v ${tone ? `t-${tone}` : ''}`}>{v}</span><span className="lab-kpi-k">{k}</span></div>
    {children && <div className="lab-kpi-m">{children}</div>}
  </div>
}

/** unknown: a hollow '?' in the value slot, the reason in the tooltip */
const Q = () => <span className="lab-kpi-q">?</span>

export function KpiStrip({ k, now, scope }: { k: Kpis; now: number; scope: string }) {
  const max = Math.max(1, ...k.perDay)
  const where = scope ? short(scope) : 'all desks'
  const v = k.verify
  const vRate = v ? v.pass / v.of : null
  const r = k.reads
  const retroDue = k.retro?.filter(x => x.due).length ?? null
  return <div className="lab-kpis">
    <Tile v={k.runs7} k="Runs 7d" title={`${where}: runs per UTC day, last 7 days\n${k.perDay.map((n, i) => `${utcDay(now - (6 - i) * 86_400_000)}  ${n || '-'}`).join('\n')}`}>
      <span className="lab-kbars" aria-hidden>{k.perDay.map((n, i) => <i key={i} className={n ? 'on' : ''} style={n ? { height: `${Math.max(18, Math.round(n / max * 100))}%` } : undefined} />)}</span>
    </Tile>
    <Tile v={vRate === null ? <Q /> : `${Math.round(vRate * 100)}%`} k="Verify" tone={v ? (v.pass === v.of ? 'ok' : 'warn') : undefined}
      title={v ? `${where}: ${v.pass} of ${v.of} runs with a verify count passed every check` : `${where}: no run carries a verify count`}>
      <Meter v={vRate} tone={v ? (v.pass === v.of ? 'ok' : 'warn') : undefined} sm />
    </Tile>
    <Tile v={r.over} k="Reads over" tone={r.late ? 'fail' : r.over ? 'warn' : undefined}
      title={`${where}: fixed-age reads past their due date: ${r.over}\npast the 4-day tolerance (late): ${r.late}\nowed, not yet due: ${r.ahead}`}>
      <span className="lab-kdots" aria-hidden>
        {Array.from({ length: r.late }, (_, i) => <i key={`l${i}`} className="late" />)}
        {Array.from({ length: r.over - r.late }, (_, i) => <i key={`o${i}`} className="over" />)}
        {Array.from({ length: r.ahead }, (_, i) => <i key={`a${i}`} className="ahead" />)}
      </span>
    </Tile>
    <Tile v={retroDue === null ? <Q /> : retroDue} k="Retros due" tone={retroDue ? 'warn' : undefined}
      title={k.retro === null ? 'unknown: this fundd does not report the retro clock yet (restart it)' : k.retro.length === 0 ? `${where}: no desk with runs` :
        k.retro.map(x => `${short(x.desk)}  ${x.due ? 'DUE' : 'ok'}${x.date ? `  last ${x.date}` : ''}  ${x.why}`).join('\n')}>
      {k.retro && <span className="lab-kgrid" aria-hidden>{k.retro.map(x => <i key={x.desk} className={x.due ? 'due' : 'ok'} />)}</span>}
    </Tile>
  </div>
}
