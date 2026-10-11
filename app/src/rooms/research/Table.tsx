import { useState } from 'react'
import { FORMATS, FORMAT_IDS, metricsOf, type FormatId, type Study } from '../../../shared/research.ts'
import { Chip, Empty, Pill, Tag } from '../../ui/kit.tsx'
import { useStored } from '../../lib/api.ts'
import { FilterBar, useFilter } from './Filters.tsx'
import { shortName } from './list.ts'
import { active, matches } from './filter.ts'
import { TABLE_COLS, day, fmtMetric, formatOf, manifestOf, stateWord, toneOf, verdictTone } from './format.ts'

// Studies of ONE format side by side, on that format's metrics (shared/research.ts FORMATS): a carry
// study and an evidence study share no columns, so they are never ranked together. Each row is also
// ONE window, and the head says so. Eight columns by default (Verdict, Window, six of the format's
// metrics: TABLE_COLS); the Columns picker shows the rest. Notebooks without a format fold below.

export function StudyTable({ studies, pick }: { studies: Study[]; pick: (id: string) => void }) {
  const every = studies.filter(s => s.group === 'studies')
  const [flt, setFlt] = useFilter()
  const all = every.filter(s => matches(s, flt))
  const byFormat = new Map<FormatId, Study[]>(FORMAT_IDS.map(f => [f, all.filter(s => formatOf(manifestOf(s)) === f)]))
  const present = FORMAT_IDS.filter(f => byFormat.get(f)!.length)
  const [stored, setStored] = useStored<FormatId | null>('research.format', null)
  const [picked, setPicked] = useStored<Partial<Record<FormatId, string[]>>>('research.cols', {})
  const [colsOpen, setColsOpen] = useState(false)
  const everyFmt = FORMAT_IDS.filter(f => every.some(s => formatOf(manifestOf(s)) === f))
  const fmt: FormatId | null = stored && everyFmt.includes(stored) ? stored : present[0] ?? everyFmt[0] ?? null
  // a threshold belongs to the format it was set on: switching format drops the others'
  const pickFormat = (f: FormatId) => { setStored(f); setFlt({ ...flt, conds: flt.conds.filter(c => metricsOf(f).some(x => x.key === c.k)) }) }
  const rest = all.filter(s => !formatOf(manifestOf(s)))
  const cols = fmt ? (picked[fmt] ?? TABLE_COLS[fmt]).filter(k => metricsOf(fmt).some(x => x.key === k)) : []
  const setCols = (keys: string[]) => fmt && setPicked({ ...picked, [fmt]: keys })
  const picker = fmt && <span className="research-colpick">
    <Chip sm on={colsOpen} onClick={() => setColsOpen(!colsOpen)} title="the metric columns shown (Verdict and Window always are)">Columns {cols.length + 2}/{metricsOf(fmt).length + 2}</Chip>
    {colsOpen && <div className="research-colmenu">
      {metricsOf(fmt).map(c => <label key={c.key} title={c.title}><input type="checkbox" checked={cols.includes(c.key)} onChange={() => setCols(cols.includes(c.key) ? cols.filter(k => k !== c.key) : [...cols, c.key])} />{c.label}</label>)}
      <button className="lnk" onClick={() => setPicked({ ...picked, [fmt]: undefined })}>default</button>
    </div>}
  </span>
  return <div className="research-table-wrap">
    <div className="research-frow research-fmts">
      <span className="research-flbl">Format</span>
      {FORMAT_IDS.map(f => <Chip key={f} sm on={f === fmt} disabled={!everyFmt.includes(f)} title={`${FORMATS[f].title}\n${byFormat.get(f)!.length} studies match`} onClick={() => pickFormat(f)}>{FORMATS[f].label} <span className="research-faint">{byFormat.get(f)!.length}</span></Chip>)}
      {active(flt) && <Pill lbl tone="accent" title="studies matching the filter / studies">{all.length}/{every.length} match</Pill>}
    </div>
    <FilterBar f={flt} set={setFlt} studies={every} fmt={fmt} right={picker} />
    {fmt ? (byFormat.get(fmt)!.length ? <FormatTable f={fmt} cols={cols} rows={byFormat.get(fmt)!} pick={pick} /> : <Empty inline title="NO MATCH">no {FORMATS[fmt].label} study matches the filter</Empty>) : <Empty inline title="NO FORMATS YET">no study names a format yet: each gets one when it is rebuilt into the nine sections and re-run</Empty>}
    {rest.length > 0 && <details className="research-fd research-rest">
      <summary title="notebooks without a format: legacy, not run, or a manifest with nothing to compare">Legacy<span className="bd">{rest.length}, no metrics</span></summary>
      <table className="research-table"><tbody>{rest.map(s => {
        const w = stateWord(s)
        return <tr key={s.id} className="nocard" onClick={() => pick(s.id)}>
          <td className="nm" title={s.id}>{shortName(s.name)}</td>
          <td className="rest"><Pill lbl tone={w.tone} title={w.why}>{w.word}</Pill>{s.loop[0]?.headline && <span className="research-faint" title={`loop record ${s.loop[0].run}: ${s.loop[0].headline}`}> {s.loop[0].run}: {s.loop[0].headline}</span>}</td>
        </tr>
      })}</tbody></table>
    </details>}
  </div>
}

/** the window as the row shows it: the year dropped when both ends share it (the hover has it whole) */
const winText = (from: string | undefined, to: string | undefined) => {
  const a = day(from), b = day(to)
  return a.slice(0, 4) === b.slice(0, 4) ? `${a.slice(5)} -> ${b.slice(5)}` : `${a} -> ${b}`
}

function FormatTable({ f, cols: keys, rows, pick }: { f: FormatId; cols: string[]; rows: Study[]; pick: (id: string) => void }) {
  const cols = keys.map(k => metricsOf(f).find(c => c.key === k)!).filter(Boolean)
  const [sort, setSort] = useState<{ k: string; desc: boolean }>({ k: FORMATS[f].lead, desc: true })
  const key = metricsOf(f).some(c => c.key === sort.k) || sort.k === 'name' ? sort.k : FORMATS[f].lead
  const val = (s: Study) => manifestOf(s)?.metrics?.[key] ?? null
  const sorted = [...rows].sort((a, b) => {
    if (key === 'name') return a.name.localeCompare(b.name) * (sort.desc ? -1 : 1)
    const va = val(a), vb = val(b)
    if (va === null && vb === null) return a.name.localeCompare(b.name)
    if (va === null) return 1
    if (vb === null) return -1
    return (va - vb) * (sort.desc ? -1 : 1)
  })
  const head = (k: string, label: string, title?: string) =>
    <th key={k} className={key === k ? 'on' : ''} title={title} onClick={() => setSort(s => ({ k, desc: s.k === k ? !s.desc : k !== 'name' }))}>{label}{key === k && <span className="research-sort">{sort.desc ? '↓' : '↑'}</span>}</th>
  return <table className="research-table">
    <thead><tr>{head('name', 'Study')}<th>Verdict</th><th title="verify() checks passed / run">Verify</th><th>Window</th>{cols.map(c => head(c.key, c.label, c.title))}</tr></thead>
    <tbody>{sorted.map(s => {
      const m = manifestOf(s)!
      return <tr key={s.id} onClick={() => pick(s.id)}>
        <td className="nm" title={`${m.title}\n${s.id}`}>{shortName(s.name)}</td>
        <td><Tag tone={verdictTone(m.verdict.word)}>{m.verdict.word}</Tag></td>
        <td className={m.verify.passed === m.verify.total ? 'ok' : 'fail'}>{m.verify.passed}/{m.verify.total}</td>
        <td className="win" title={`${day(m.window.from)} -> ${day(m.window.to)}, ${m.window.regimes ?? '?'} regimes`}>{winText(m.window.from, m.window.to)}</td>
        {cols.map(c => { const v = m.metrics?.[c.key] ?? null; const t = fmtMetric(c, v); return <td key={c.key} className={t === null ? 'na' : toneOf(c, v)} title={t === null ? `n/a: ${m.na?.[c.key] ?? ''}` : undefined}>{t ?? 'n/a'}</td> })}
      </tr>
    })}</tbody>
  </table>
}
