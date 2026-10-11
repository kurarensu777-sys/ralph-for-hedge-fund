import { useState } from 'react'
import { api, relTime, useApi } from '../../lib/api.ts'
import { Btn, Empty, Load, Seg } from '../../ui/kit.tsx'
import { Sec, Tiles } from '../drawers/index.tsx'
import { NotAvailable } from './common.tsx'
import { fmtBytes, fmtInt } from './model.ts'
import { CacheSec, PinsSec, budgetTone, type Storage } from './storage.tsx'

// THE STORAGE VIEW (the on-demand data migration, B-0327), one section per storage class: the CACHE
// (the default for every read, rebuildable, against its 2 GiB budget, evict to budget) and the PINS
// (./storage.tsx), then the ARCHIVE - the lake's hot and cold tiers, which after database's
// reclassify (B-0324, gated on the pin backfill) hold only what a backtest needs and the source will
// not serve again - and the ops store's size (`python -m fund_db usage --json`), and retention -
// TIER (hot to cold, verified file by file) and PRUNE (into _retired, which only the owner frees;
// archive datasets are never pruned): a dry run held by fundd, the phrase typed, then fundd
// dry-runs again and refuses if the lake moved since the plan.

type NA = { available: false; reason: string }
type Usage = {
  available: true; read_ms: number
  lake: { datasets: { dataset: string; tier: string; root: string; partitions: number; files: number; bytes: number; rows: number | null; first_month: string | null; last_month: string | null }[]; other: { name: string; bytes: number; files: number }[]; total_bytes: number }
  ops: { database_bytes: number; tables: { name: string; bytes: number; est_rows: number }[] } | { error: string }
}
type Item = { dataset?: string; from: string; to: string; bytes: number }
type Plan = { available: true; key: string | null; kind: string; dataset: string | null; items: Item[]; totals: { partitions: number; bytes: number }; phrase: string | null; expires_ms: number }

function Retention({ datasets }: { datasets: string[] }) {
  const [kind, setKind] = useState<'tier' | 'prune'>('tier')
  const [ds, setDs] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [typed, setTyped] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const call = async <T,>(path: string, body: unknown, then: (r: T) => void) => {
    setBusy(true); setMsg(null)
    try {
      const r = await api<T | NA>(path, { body })
      if ((r as NA).available === false) setMsg({ ok: false, text: `not available: ${(r as NA).reason}` })
      else then(r as T)
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  const doPlan = () => { setPlan(null); setTyped(''); void call<Plan>('/api/data/retention/plan', { kind, dataset: ds || null }, setPlan) }
  const doApply = () => plan?.key && void call<{ partitions: number; bytes: number }>('/api/data/retention/apply', { key: plan.key, phrase: typed },
    r => { setPlan(null); setTyped(''); setMsg({ ok: true, text: `${kind === 'tier' ? 'tiered' : 'pruned'} ${fmtInt(r.partitions)} partitions, ${fmtBytes(r.bytes)}` }) })
  const norm = (s: string) => s.trim().split(/\s+/).join(' ').toLowerCase()
  return <div className="data-ret">
    <div className="data-bar">
      <Seg value={kind} onChange={k => { setKind(k); setPlan(null) }} options={[{ id: 'tier', label: 'Tier' }, { id: 'prune', label: 'Prune' }]} />
      <select className="input sm data-select" value={ds} onChange={e => { setDs(e.target.value); setPlan(null) }} aria-label="dataset">
        <option value="">every dataset</option>{datasets.map(d => <option key={d} value={d}>{d}</option>)}
      </select>
      <Btn sm disabled={busy} onClick={doPlan} title={kind === 'tier' ? 'dry run: hot partitions past their tier age, to the cold tier' : 'dry run: partitions past their keep age, into _retired (never deleted)'}>Plan</Btn>
    </div>
    {plan && (!plan.items.length ? <Empty inline>nothing to move</Empty> : <>
      <div className="mono faint">{fmtInt(plan.totals.partitions)} partitions · {fmtBytes(plan.totals.bytes)}</div>
      <div className="data-scroll"><table className="data-tbl">
        <thead><tr><th>From</th><th>To</th><th>Size</th></tr></thead>
        <tbody>{plan.items.slice(0, 200).map(i => <tr key={i.from}><td className="clip mono" title={i.from}>{i.from}</td><td className="clip mono" title={i.to}>{i.to}</td><td className="n">{fmtBytes(i.bytes)}</td></tr>)}</tbody>
      </table></div>
      <div className="data-confirm">
        <span className="cap">Type</span><code className="data-phrase">{plan.phrase}</code>
        <input className="input sm code" value={typed} onChange={e => setTyped(e.target.value)} onPaste={e => e.preventDefault()} aria-label="Type the confirmation phrase" autoComplete="off" spellCheck={false} />
        <Btn kind="danger" disabled={busy || !plan.phrase || norm(typed) !== plan.phrase.toLowerCase()} onClick={doApply}>{busy ? 'Moving' : 'Apply'}</Btn>
      </div>
    </>)}
    {msg && <div className={msg.ok ? 't-ok' : 'data-refused'}>{!msg.ok && <span className="dot fail" />}{msg.text}</div>}
  </div>
}

/** the four tiles: cache used of budget, pins, archive, ops store; a class not read is '-' with its reason */
function StorageTiles({ s, d }: { s: Storage | null; d: Usage | null }) {
  const c = s?.cache.available ? s.cache : null
  const p = s?.pins.available ? s.pins : null
  const ops = d && !('error' in d.ops) ? d.ops : null
  const why = (x: { available: false; reason: string } | { available: true } | undefined) => (x && !x.available ? `not read: ${x.reason}` : 'reading')
  return <Tiles items={[
    { k: 'cache', v: c ? fmtBytes(c.bytes) : '-', tone: c && budgetTone(c).tone !== 'ok' ? budgetTone(c).tone : undefined, title: c ? `${fmtBytes(c.bytes)} of ${fmtBytes(c.max_bytes)}: rebuildable, every read lands here, evicted least-recently-read first` : why(s?.cache) },
    { k: 'pins', v: p ? fmtInt(p.count) : '-', title: p ? `${fmtInt(p.count)} pins, ${fmtBytes(p.bytes)}: the exact rows recorded results used, immutable, never evicted` : why(s?.pins) },
    { k: 'archive', v: d ? fmtBytes(d.lake.total_bytes) : '-', title: 'the lake, hot and cold: kept forever' },
    { k: 'ops store', v: ops ? fmtBytes(ops.database_bytes) : '-', title: ops ? 'the PostgreSQL ops database' : d ? `not read: ${(d.ops as { error: string }).error}` : 'reading' },
  ]} />
}

export function StoreView() {
  const q = useApi<Usage | NA>('/api/data/usage', ['data'])
  const sq = useApi<Storage>('/api/data/storage', ['data'])
  return <div className="main-pad data-main">
    <StorageTiles s={sq.data ?? null} d={q.data?.available ? q.data : null} />
    <Sec right={sq.data ? <span className="faint mono">{relTime(sq.data.read_ms)}</span> : null}>Cache</Sec>
    <Load q={sq} skel="lines">{s => <CacheSec c={s.cache} />}</Load>
    <Sec right={sq.data?.pins.available ? <span className="faint mono">{fmtInt(sq.data.pins.count)}</span> : null}>Pins</Sec>
    <Load q={sq} skel="lines">{s => <PinsSec p={s.pins} />}</Load>
    <Load q={q} skel="table">{d => {
      if (!d.available) return <><Sec>Archive</Sec><NotAvailable reason={d.reason} /></>
      const ops = 'error' in d.ops ? null : d.ops
      const names = [...new Set(d.lake.datasets.map(x => x.dataset))]
      return <>
        <Sec right={<span className="faint mono" title="fund_db usage --json">{relTime(d.read_ms)}</span>}>Archive</Sec>
        <table className="data-tbl">
          <thead><tr><th>Dataset</th><th>Tier</th><th>Size</th><th>Partitions</th><th>Files</th><th>Rows</th><th>Months</th></tr></thead>
          <tbody>{d.lake.datasets.map(x => <tr key={`${x.dataset}${x.tier}`}>
            <td>{x.dataset}</td><td className="faint">{x.tier}</td><td className="n">{fmtBytes(x.bytes)}</td><td className="n">{fmtInt(x.partitions)}</td>
            <td className="n">{fmtInt(x.files)}</td><td className="n" title={x.rows == null ? 'not counted' : undefined}>{fmtInt(x.rows)}</td>
            <td className="mono faint">{x.first_month ?? '-'} .. {x.last_month ?? '-'}</td>
          </tr>)}
          {d.lake.other.map(o => <tr key={o.name} className="faint"><td>{o.name}</td><td /><td className="n">{fmtBytes(o.bytes)}</td><td /><td className="n">{fmtInt(o.files)}</td><td /><td /></tr>)}</tbody>
        </table>
        {ops && <>
          <Sec>Ops store</Sec>
          <table className="data-tbl">
            <thead><tr><th>Table</th><th>Size</th><th title="the planner's estimate (reltuples), not a count">Rows ~</th></tr></thead>
            <tbody>{ops.tables.slice(0, 12).map(t => <tr key={t.name}><td className="mono">{t.name}</td><td className="n">{fmtBytes(t.bytes)}</td><td className="n">{fmtInt(t.est_rows)}</td></tr>)}</tbody>
          </table>
        </>}
        <Sec>Retention</Sec>
        <Retention datasets={names} />
      </>
    }}</Load>
  </div>
}
