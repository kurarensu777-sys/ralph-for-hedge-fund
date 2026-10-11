import { useState } from 'react'
import { api, relTime, stamp } from '../../lib/api.ts'
import { Btn, Empty, Meter } from '../../ui/kit.tsx'
import type { CacheUsage, Evicted, PinRow } from '../../../server/data/storage.ts'
import { NotAvailable, type NA } from './common.tsx'
import { fmtBytes, fmtInt } from './model.ts'

// THE STORAGE VIEW's two new parts (B-0327): the CACHE against its budget, with the one move it has
// (evict to budget: a dry run held by fundd, the phrase typed, a second dry run that must match),
// and the PINS - the exact rows each recorded result used, immutable, never evicted. The wire
// types are the server's own (type-only). Server: server/data/storage.ts.

export type Storage = {
  cache: (CacheUsage & { available: true }) | NA
  pins: { available: true; count: number; bytes: number; rows: PinRow[] } | NA
  read_ms: number
}
type EvictPlan = { available: true; key: string | null; before_bytes: number; after_bytes: number; max_bytes: number; evicted: Evicted[]; phrase: string | null; expires_ms: number }

/** the share of the budget used, and its tone: amber from 90%, red over the budget */
export function budgetTone(c: Pick<CacheUsage, 'bytes' | 'max_bytes'>): { share: number; tone: 'ok' | 'warn' | 'fail' } {
  const share = c.max_bytes > 0 ? c.bytes / c.max_bytes : 1
  return { share, tone: share > 1 ? 'fail' : share >= 0.9 ? 'warn' : 'ok' }
}

function Evict({ c }: { c: CacheUsage }) {
  const [plan, setPlan] = useState<EvictPlan | null>(null)
  const [typed, setTyped] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const norm = (s: string) => s.trim().split(/\s+/).join(' ').toLowerCase()
  const doPlan = async () => {
    setBusy(true); setMsg(null); setPlan(null); setTyped('')
    try { setPlan(await api<EvictPlan>('/api/data/cache/evict/plan', { body: {} })) }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  const doApply = async () => {
    if (!plan?.key) return
    setBusy(true); setMsg(null)
    try {
      const r = await api<{ partitions: number; bytes: number; after_bytes: number }>('/api/data/cache/evict/apply', { body: { key: plan.key, phrase: typed } })
      setPlan(null); setTyped('')
      setMsg({ ok: true, text: `evicted ${fmtInt(r.partitions)} partitions, ${fmtBytes(r.bytes)}; the cache is ${fmtBytes(r.after_bytes)}` })
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  return <div className="data-ret">
    <div className="data-bar">
      <Btn sm disabled={busy} onClick={() => void doPlan()} title={`dry run: the least-recently-read month partitions that take the cache back to its budget (${fmtBytes(c.max_bytes)}). The cache is rebuildable: an evicted month is pulled from the venue again on its next read`}>{busy && !plan ? 'Planning' : 'Evict to budget'}</Btn>
    </div>
    {plan && (!plan.evicted.length ? <Empty inline>within budget: nothing to evict</Empty> : <>
      <div className="mono faint">{fmtInt(plan.evicted.length)} partitions · {fmtBytes(plan.before_bytes)} to {fmtBytes(plan.after_bytes)} of {fmtBytes(plan.max_bytes)}</div>
      <div className="data-scroll"><table className="data-tbl">
        <thead><tr><th>Dataset</th><th>Venue</th><th>Month</th><th>Size</th><th title="when a reader last asked for it">Read</th></tr></thead>
        <tbody>{plan.evicted.slice(0, 200).map(e => <tr key={`${e.dataset}|${e.venue}|${e.interval ?? ''}|${e.month}`}>
          <td>{e.dataset}{e.interval ? <span className="faint"> {e.interval}</span> : null}</td><td>{e.venue}</td><td className="mono">{e.month}</td>
          <td className="n">{fmtBytes(e.bytes)}</td><td className="mono faint">{e.last_read_ms ? relTime(e.last_read_ms) : 'never'}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="data-confirm">
        <span className="cap">Type</span><code className="data-phrase">{plan.phrase}</code>
        <input className="input sm code" value={typed} onChange={e => setTyped(e.target.value)} onPaste={e => e.preventDefault()} aria-label="Type the confirmation phrase" autoComplete="off" spellCheck={false} />
        <Btn kind="danger" disabled={busy || !plan.phrase || norm(typed) !== plan.phrase.toLowerCase()} onClick={() => void doApply()}>{busy ? 'Evicting' : 'Evict'}</Btn>
      </div>
    </>)}
    {msg && <div className={msg.ok ? 't-ok' : 'data-refused'}>{!msg.ok && <span className="dot fail" />}{msg.text}</div>}
  </div>
}

export function CacheSec({ c }: { c: Storage['cache'] }) {
  if (!c.available) return <NotAvailable reason={c.reason} />
  const b = budgetTone(c)
  return <>
    <div className="data-budget" title={`${fmtBytes(c.bytes)} of ${fmtBytes(c.max_bytes)} (database/retention.toml [cache] max_bytes)${c.root ? `\n${c.root}` : ''}`}>
      <Meter v={b.share} tone={b.tone} grow />
      <span className={`mono ${b.tone === 'ok' ? '' : `t-${b.tone}`}`}>{fmtBytes(c.bytes)} / {fmtBytes(c.max_bytes)}</span>
      <span className="mono faint">{Math.round(b.share * 100)}%</span>
      <span className="mono faint" title="the least recently read partition: the first an eviction takes">{c.oldest_read_ms ? `oldest read ${relTime(c.oldest_read_ms)}` : ''}</span>
    </div>
    {!c.datasets.length ? <Empty inline>the cache is empty</Empty> : <table className="data-tbl">
      <thead><tr><th>Dataset</th><th>Size</th><th>Partitions</th><th>Files</th></tr></thead>
      <tbody>{c.datasets.map(d => <tr key={d.dataset}><td>{d.dataset}</td><td className="n">{fmtBytes(d.bytes)}</td><td className="n">{fmtInt(d.partitions)}</td><td className="n">{fmtInt(d.files)}</td></tr>)}</tbody>
    </table>}
    <Evict c={c} />
  </>
}

const winOf = (p: PinRow) => p.window_from && p.window_to ? `${new Date(p.window_from).toISOString().slice(0, 10)} .. ${new Date(p.window_to).toISOString().slice(0, 10)}` : '-'

export function PinsSec({ p }: { p: Storage['pins'] }) {
  if (!p.available) return <NotAvailable reason={p.reason} />
  if (!p.count) return <Empty inline>no pins yet: a recorded result pins the rows it read</Empty>
  return <div className="data-scroll"><table className="data-tbl">
    <thead><tr><th>Pin</th><th>Series</th><th>Window</th><th>Rows</th><th>Size</th><th title="the runs and studies that cite it">Used by</th></tr></thead>
    <tbody>{p.rows.map(r => <tr key={r.hash}>
      <td className="mono" title={`${r.hash}${r.created_ms ? `\npinned ${stamp(r.created_ms)}` : ''}`}>{r.hash.slice(0, 12)}</td>
      <td className="clip mono" title={`${r.venue}:${r.symbol}:${r.dataset}:${r.interval ?? '-'}`}>{r.venue}:{r.symbol} <span className="faint">{r.dataset}{r.interval ? ` ${r.interval}` : ''}</span></td>
      <td className="mono faint">{winOf(r)}</td>
      <td className="n">{fmtInt(r.rows)}</td><td className="n">{fmtBytes(r.bytes)}</td>
      <td className="clip" title={r.refs.map(x => `${x.ref}${x.reason ? ` (${x.reason})` : ''}`).join('\n')}>{r.refs.length ? r.refs.map(x => x.ref).join(', ') : <span className="faint">none</span>}</td>
    </tr>)}</tbody>
  </table></div>
}
