import type { CSSProperties } from 'react'
import { Dot, Empty, Load, Meter, Pill } from '../../ui/kit.tsx'
import { stamp, useApi, useStored } from '../../lib/api.ts'
import { CapCell, SpendChart, colorOf, spendWindow, tok, useAgentNames, type Daily, type TreeToday } from './ops.tsx'
import { Tiles } from './tiles.tsx'

// ROOM: system - SPEND: tiles (today, the cockpit's share, 7 days, dollars, the top agent, the
// budget), the 14-day stacked bars by agent (ops.tsx SpendChart), today per agent as bars, and the
// usage table folded under them. Agent colours are src/ui/categories.ts's (colorOf). A figure the
// source did not give is drawn unknown, never a zero: the all-sessions total exists only when the
// budget probe (system:budget) read it TODAY, and a budget needs a ceiling written in the roster.

export type Spend = {
  today: string; usageRows: number
  rows: { agent: string; day: string; tin: number; tout: number; cr: number; cw: number; cost: number; n: number }[]
  budget: null | { status: string; reading: string; metric: string | null; probedAt: number | null; totalToday: number | null; bySeat: Record<string, number> | null; over: string[]; drift: string[]; detail: string }
}

const NL = String.fromCharCode(10)
const num = (x: number) => x.toLocaleString()

/** the budget reading counts only when it was taken today */
function treeOf(s: Spend): { fresh: boolean; tree: TreeToday } {
  const b = s.budget
  const fresh = !!(b && b.probedAt && new Date(b.probedAt).toDateString() === new Date().toDateString())
  return { fresh, tree: b && fresh ? { total: b.totalToday, bySeat: b.bySeat, over: b.over } : null }
}

export function SpendView() {
  const q = useApi<Spend>('/api/system/spend', ['system', 'chat'])
  const dq = useApi<Daily>('/api/system/spend/daily', ['system', 'chat'])
  return <Load q={q}>{s => {
    const { fresh, tree } = treeOf(s)
    const b = s.budget
    return <>
      <SpendTiles s={s} d={dq.data} dErr={dq.error} fresh={fresh} tree={tree} />
      <Load q={dq}>{d => { const w = spendWindow(d); return <>
        <div className="cap system-h system-h-row">
          <span title="billable tokens (input + cache writes + output) per day per agent, from the cockpit's usage table">Daily</span>
          <span className="system-h-r" title={`the cockpit's usage table summed over the ${w.days.length} days shown, ${w.from} to ${w.to}; the legend splits it by agent`}><span className="faint">{w.days.length}d</span>{tok(w.total)}</span>
        </div>
        {d.series.max === 0 ? <Empty title="NO SPEND" /> : <SpendChart d={d} />}
      </> }}</Load>
      <div className="cap system-h system-h-row">
        <span title="today per agent: solid = the cockpit's usage table (sessions the cockpit ran); pale = every session in the tree (the budget reading, system:budget), when it was read today">Today</span>
        {b ? <span className="system-h-r" title={[b.reading, b.probedAt ? `probed ${stamp(b.probedAt)}` : '', fresh ? '' : 'not probed today'].filter(Boolean).join(NL)}><Dot s={fresh ? b.status : 'unknown'} />{fresh && b.totalToday !== null ? tok(b.totalToday) : <span className="nil" />}</span>
          : <span className="system-h-r faint" title="no budget reading recorded yet (system:budget)"><span className="nil" /></span>}
        {b && fresh && b.drift.map(x => <span key={x} title={x}><Pill tone="warn" lbl>{/^(?:tier drift:\s*)?(\S+)/.exec(x)?.[1] ?? 'tier'} drift</Pill></span>)}
      </div>
      <Load q={dq}>{d => <SpendBars d={d} tree={tree} />}</Load>
      <UsageFold s={s} d={dq.data} />
    </>
  }}</Load>
}

/** the day at a glance. Unknown (the source did not answer, or no ceiling) is a hollow dash */
export function SpendTiles({ s, d, dErr, fresh, tree }: { s: Spend; d: Daily | null; dErr: string | null; fresh: boolean; tree: TreeToday }) {
  const name = useAgentNames()
  const b = s.budget
  const cockpit = d ? d.todayBy.reduce((a, r) => a + r.billable, 0) : null
  const wk = d ? d.series.totals.slice(-7).reduce((a, v) => a + v, 0) : null
  const usd = s.rows.filter(r => r.day === s.today).reduce((a, r) => a + (r.cost || 0), 0)
  // the top agent: by every session when the budget read today, else by the cockpit's own table
  const by: [string, number][] = tree?.bySeat ? Object.entries(tree.bySeat) : d ? d.todayBy.map(r => [r.agent, r.billable]) : []
  const top = by.filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1])[0]
  const capped = d?.todayBy.filter(r => r.ceiling) ?? []
  const ceil = capped.reduce((a, r) => a + (r.ceiling ?? 0), 0)
  const used = capped.reduce((a, r) => a + r.billable, 0)
  const frac = ceil ? used / ceil : null
  const dWhy = dErr ? `daily failed: ${dErr}` : 'loading'
  return <Tiles min={130} items={[
    { k: 'today', v: fresh && b?.totalToday != null ? tok(b.totalToday) : null, tone: b && fresh ? (b.status === 'fail' ? 'fail' : b.status === 'warn' ? 'warn' : '') : 'faint',
      title: b ? `every session in the tree today (system:budget)${NL}${b.reading}${b.probedAt ? `${NL}probed ${stamp(b.probedAt)}` : ''}${fresh ? '' : `${NL}not probed today: unknown`}${b.totalToday != null ? `${NL}${num(b.totalToday)} billable` : ''}` : 'no budget reading recorded yet (system:budget)' },
    { k: 'cockpit', v: cockpit === null ? null : tok(cockpit), title: cockpit === null ? dWhy : `today, sessions the cockpit ran (its usage table)${NL}${num(cockpit)} billable` },
    { k: '7 days', v: wk === null ? null : tok(wk), title: wk === null ? dWhy : `the cockpit's usage table, the last 7 days${NL}${num(wk)} billable` },
    { k: 'usd today', v: `$${usd.toFixed(2)}`, title: `cost the cockpit's usage table recorded today (its own sessions only; ${s.rows.filter(r => r.day === s.today).length} agent rows)` },
    { k: 'top', v: top ? <><i className="system-sw" style={{ background: d ? colorOf(d, top[0]) : 'var(--off)' }} />{name(top[0])}</> : null, aside: top ? <span className="system-tile-n">{tok(top[1])}</span> : undefined,
      title: top ? `${top[0]}: ${num(top[1])} billable today (${tree?.bySeat ? 'every session' : "the cockpit's table"})` : 'no agent spent today' },
    { k: 'budget', v: frac === null ? <><Meter v={null} /><small>none</small></> : <><Meter v={frac} tone={frac >= 1 ? 'fail' : frac >= 0.8 ? 'warn' : 'ok'} /><small>{Math.round(frac * 100)}%</small></>,
      title: frac === null ? 'no budgetTokensPerDay ceiling in any roster file (app/agents/): no budget to measure against' : `${tok(used)} of ${tok(ceil)} across the ${capped.length} agents with a ceiling` },
  ]} />
}

/**
 * TODAY PER AGENT as bars on one scale: solid = the cockpit's usage table, pale behind it = every
 * session in the tree (the budget reading, when read today). The larger of the two sets the length.
 * An agent with neither today folds into one "quiet" line (its names in the tooltip).
 */
export function SpendBars({ d, tree }: { d: Daily; tree: TreeToday }) {
  const name = useAgentNames()
  const seats = tree?.bySeat ?? {}
  const by = new Map(d.todayBy.map(r => [r.agent, r]))
  const ids = [...new Set([...d.todayBy.map(r => r.agent), ...Object.keys(seats)])]
  const val = (a: string) => Math.max(by.get(a)?.billable ?? 0, seats[a] ?? 0)
  const live = ids.filter(a => val(a) > 0).sort((x, y) => val(y) - val(x) || x.localeCompare(y))
  const quiet = ids.filter(a => val(a) === 0)
  const max = Math.max(1, ...live.map(val))
  const ceil = d.todayBy.some(r => r.ceiling || r.alerts?.length)
  if (!live.length) return <Empty sm title="NO SPEND TODAY" />
  return <div className="system-bars">
    {live.map(a => {
      const r = by.get(a), all = seats[a]
      const over = tree?.over.some(o => o.split(' ')[0] === a)
      const t = [`${name(a)} (${a})`, `cockpit ${r ? num(r.billable) : '-'}`, `all sessions ${all === undefined ? (tree ? '-' : 'unknown (not read today)') : num(all)}`, r?.ceiling ? `ceiling ${num(r.ceiling)}` : ''].filter(Boolean).join(NL)
      return <div key={a} className="system-bar" title={t} style={{ '--c': colorOf(d, a) } as CSSProperties}>
        <span className="system-bar-n"><i className="system-sw" />{name(a)}</span>
        <span className="system-bar-t">
          {all !== undefined && <i className="all" style={{ width: `${(all / max) * 100}%` }} />}
          {r && r.billable > 0 && <i className="own" style={{ width: `${(r.billable / max) * 100}%` }} />}
        </span>
        <b className={over ? 't-fail' : ''}>{tok(val(a))}</b>
        {ceil && <span className="system-bar-cap"><CapCell agent={a} used={r?.billable ?? 0} ceiling={r?.ceiling ?? null} capped={!!r?.capped} lifted={!!r?.lifted} alerts={r?.alerts ?? []} /></span>}
      </div>
    })}
    {quiet.length > 0 && <div className="system-bar quiet" title={quiet.map(name).join(NL)}><span className="system-bar-n faint">+{quiet.length} quiet</span></div>}
  </div>
}

/** the usage table itself (14 days, per day per agent), folded: the bars above are its picture */
export function UsageFold({ s, d }: { s: Spend; d: Daily | null }) {
  const [open, setOpen] = useStored<boolean>('system.spend.usage', false)
  const name = useAgentNames()
  return <>
    <button type="button" className="cap system-h system-h-row system-fold" aria-expanded={open} onClick={() => setOpen(!open)} title="the cockpit's own usage table, last 14 days, per day per agent">
      <span className={`cg-chev ${open ? '' : 'system-fold-shut'}`}><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg></span>Usage<span className="system-h-r faint">{s.rows.length}</span>
    </button>
    {open && (s.rows.length === 0 ? <Empty>the usage table has no rows yet{s.usageRows ? ` in 14 days (${s.usageRows} older)` : ''}</Empty>
      : <table className="tbl dense system-tbl system-fit">
        <thead><tr><th>Day</th><th>Agent</th><th className="num">In</th><th className="num">Out</th><th className="num" title="cache read tokens">Cache r</th><th className="num" title="cache write tokens">Cache w</th><th className="num">USD</th><th className="num">Turns</th></tr></thead>
        <tbody>{s.rows.map((r, i) => <tr key={r.day + r.agent} className={i > 0 && s.rows[i - 1].day !== r.day ? 'system-dayb' : ''}>
          <td className={`mono ${r.day === s.today ? '' : 'faint'}`}>{i === 0 || s.rows[i - 1].day !== r.day ? r.day.slice(5) : ''}</td><td className="system-agent" title={r.agent}>{d ? <i className="system-sw" style={{ background: colorOf(d, r.agent) }} /> : null}{name(r.agent)}</td>
          <td className="num" title={num(r.tin)}>{tok(r.tin)}</td><td className="num" title={num(r.tout)}>{tok(r.tout)}</td><td className="num faint" title={num(r.cr)}>{tok(r.cr)}</td><td className="num faint" title={num(r.cw)}>{tok(r.cw)}</td>
          <td className="num">{r.cost ? r.cost.toFixed(2) : '-'}</td><td className="num faint">{r.n}</td>
        </tr>)}</tbody>
      </table>)}
  </>
}
