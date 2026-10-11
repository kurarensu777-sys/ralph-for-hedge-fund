import { useState } from 'react'
import { metricsOf, type FormatId, type Study } from '../../../shared/research.ts'
import { Btn, Chip, Pill } from '../../ui/kit.tsx'
import { useStored } from '../../lib/api.ts'
import { NO_FILTER, active, deskOf, facet, statusOf, toggle, verdictOf, type Cond, type Filter } from './filter.ts'

/** the one filter the list and the table share (stored, so it survives a reload) */
export function useFilter(): [Filter, (f: Filter) => void] {
  const [f, set] = useStored<Filter>('research.filter', NO_FILTER)
  return [{ ...NO_FILTER, ...f }, set]
}

export function SearchBox({ f, set, sm = false }: { f: Filter; set: (f: Filter) => void; sm?: boolean }) {
  return <input className={`input ${sm ? 'sm' : ''} research-q`} placeholder="Search studies" value={f.q} title="every word must appear: file name, title, question, desk, verdict, market, venues, instruments, strategy, caveats, loop run and headline"
    onChange={e => set({ ...f, q: e.target.value })} onKeyDown={e => { if (e.key === 'Escape') set({ ...f, q: '' }) }} />
}

/** the table's filters on ONE row: the search, every active filter as a chip (click removes it), a
 *  + filter chip that opens the facets and the metric thresholds, then the Columns picker (`right`) */
export function FilterBar({ f, set, studies, fmt, right }: { f: Filter; set: (f: Filter) => void; studies: Study[]; fmt: FormatId | null; right?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const cols = fmt ? metricsOf(fmt) : []
  const [k, setK] = useState<string>('')
  const [op, setOp] = useState<Cond['op']>('>=')
  const [v, setV] = useState('')
  const key = cols.some(c => c.key === k) ? k : cols[0]?.key ?? ''
  const add = () => {
    const n = Number(v)
    if (!key || v.trim() === '' || !Number.isFinite(n)) return
    set({ ...f, conds: [...f.conds.filter(c => !(c.k === key && c.op === op)), { k: key, op, v: n }] })
    setV('')
  }
  const label = (key: string) => cols.find(c => c.key === key)?.label ?? key
  const on = (name: string, xs: string[], drop: (x: string) => Filter) => xs.map(x => <Chip key={`${name}:${x}`} sm on onClick={() => set(drop(x))} title={`${name}: click to remove`}>{x} x</Chip>)
  const row = (name: string, values: { value: string; n: number }[], sel: string[], pick: (x: string) => void) => values.length > 0 &&
    <div className="research-frow"><span className="research-flbl">{name}</span>{values.map(x => <Chip key={x.value} sm on={sel.includes(x.value)} onClick={() => pick(x.value)}>{x.value} <span className="research-faint">{x.n}</span></Chip>)}</div>
  return <div className="research-filters">
    <div className="research-frow">
      <span className="research-flbl">Filter</span>
      <SearchBox f={f} set={set} sm />
      {on('verdict', f.verdicts, x => ({ ...f, verdicts: toggle(f.verdicts, x) }))}
      {on('desk', f.desks, x => ({ ...f, desks: toggle(f.desks, x) }))}
      {on('status', f.statuses, x => ({ ...f, statuses: toggle(f.statuses, x) }))}
      {f.conds.map(c => <Chip key={`${c.k}${c.op}`} sm on onClick={() => set({ ...f, conds: f.conds.filter(x => x !== c) })} title="a study without the metric does not match: click to remove">{label(c.k)} {c.op} {c.v} x</Chip>)}
      <Chip sm on={open} onClick={() => setOpen(!open)} title="filter by verdict, desk, status or a metric threshold">+ filter</Chip>
      {active(f) && <Btn sm kind="ghost" onClick={() => set(NO_FILTER)} title="clear every filter">Clear</Btn>}
      <span className="research-fsp" />
      <Pill lbl tone="warn" title="how-a-belief-moves.md: each row is one window, often one regime. Rows on different windows are not comparable as a ranking, and a sort is not a verdict.">1 window per row</Pill>
      {right}
    </div>
    {open && <div className="research-fmore">
      {row('Verdict', facet(studies, verdictOf), f.verdicts, x => set({ ...f, verdicts: toggle(f.verdicts, x) }))}
      {row('Desk', facet(studies, deskOf), f.desks, x => set({ ...f, desks: toggle(f.desks, x) }))}
      {row('Status', facet(studies, statusOf), f.statuses, x => set({ ...f, statuses: toggle(f.statuses, x) }))}
      {fmt && <div className="research-frow" title="a study without the metric does not match: an unknown is never a pass">
        <span className="research-flbl">Metric</span>
        <select className="input sm research-fsel" value={key} onChange={e => setK(e.target.value)}>{cols.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
        <select className="input sm research-fop" value={op} onChange={e => setOp(e.target.value as Cond['op'])}><option value=">=">{'>='}</option><option value="<=">{'<='}</option></select>
        <input className="input sm research-fval" inputMode="decimal" placeholder="value" value={v} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} />
        <Btn sm onClick={add} disabled={!key || v.trim() === ''}>Add</Btn>
      </div>}
    </div>}
  </div>
}
