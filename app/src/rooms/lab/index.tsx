import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { RoomDef } from '../types.ts'
import { Btn, Dot, Empty, Group, HeatStrip, Icon, Load, Markdown, Pill, Seg, Tag } from '../../ui/kit.tsx'
import { api, relTime, stamp, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { shared } from './store.ts'
import { DeskChart } from './Chart.tsx'
import { Mechanics, StagePill } from './Mechanics.tsx'
import { Prereg } from './Prereg.tsx'
import { ReadAction, useJobs } from './Reads.tsx'
import { TrialChips, TrialsSection } from './Trials.tsx'
import { perDay, winShort, winSpan } from './window.ts'
import { readHeat, type ReadIn } from './readheat.ts'
import { daysOver, kpis, type KRetro } from './kpis.ts'
import { KpiStrip } from './KpiStrip.tsx'
import { ReadsTimeline } from './Timeline.tsx'
import { agentColor, UNKNOWN_COLOR } from '../../ui/categories.ts'
import { day as utcDay } from '../../../shared/time.ts'
import { DrawerHead, KvCards, ReadDots, Sec, Tiles, type KvRow, type ReadMark } from '../drawers/index.tsx'
import './lab.css'

// ROOM: lab - every experiment in lab/**/data/runs.jsonl, with its results-log entry.

type ReadCell = { age: '7d' | '30d'; due: number | null; state: 'done' | 'missed' | 'due' | 'late' | 'pending' | 'void' | 'none'; row?: any; fp?: string | null; match?: boolean | null }
type FpIn = { venue: string; symbol: string; dataset: string; interval: string; first_ts: number | null; last_ts: number | null; rows: number; trunc?: boolean }
type Fp = { digest: string; window: { from: number; to: number } | null; inputs: FpIn[] }
type Run = {
  key: string; desk: string; run: string; kind: string | null; mechanic: string | null; preregistered: boolean
  predicted: Record<string, string>; window: any; verify: any; headline: string; metrics: Record<string, number>
  ts: number | null; stage: string; void: string | null; reads: Record<'7d' | '30d', ReadCell>
  seat: string | null; agent: string | null; owner?: string | null
  mstage: string | null
  dsr: number | null; pbo: number | null; n_trials: number | null
  fingerprint: Fp | null; fp: string | null; trunc: boolean | null; chain: string[]
  pins: { pinned: number; of: number; known: boolean } | null
}
type Desk = { desk: string; seat: string | null; hasFile: boolean; bad: number; runs: number; imported: number; preregistered: number; retro?: KRetro | null }
type Due = { key: string; desk: string; run: string; age: string; due: number; state: string; job: { running: boolean; code: number | null; dry: boolean } | null }
type Snap = { now: number; runs: Run[]; desks: Desk[]; readsDue: Due[]; running: number }

const deskF = shared<string>('lab.desk', '')
const kindF = shared<string>('lab.kind', 'all')
const sortS = shared<{ col: string; dir: 1 | -1 }>('lab.sort', { col: 'ran', dir: -1 })
const pick = shared<string[]>('lab.pick', [])
const stageF = shared<string>('lab.stage', 'all')
const metricF = shared<Record<string, string>>('lab.metric', {})
const STAGE_OPTS = ['all', 'idea', 'tested', 'paper', 'live', 'unset']

/** ONE desk name everywhere in this room (table, sidebar, drawer): the lab path without lab/, e.g.
 * platform/carry, example. The full path rides in the tooltip. */
const short = (d: string) => d.replace(/^(lab|desks)\//, '')
const day = (ms: number | null) => { if (!ms) return '-'; const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const band = (p: Record<string, string>) => Object.entries(p ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ')
const win = (w: any) => {
  if (!w) return '-'
  const f = String(w.from ?? '?').replace('T', ' ').replace(/Z$/, ''), t = String(w.to ?? '?').replace('T', ' ').replace(/Z$/, '')
  return f === t ? f : `${f} → ${t}`
}
const winTail = (w: any) => [w?.hours ? `${Number(w.hours).toLocaleString()}h` : '', w?.regimes ? `${w.regimes} regime${Number(w.regimes) === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
const verifyTxt = (v: any) => v && v.total != null ? `${v.passed ?? '?'}/${v.total}` : '-'
const kindOf = (r: Run) => r.kind ?? '-'
const num = (v: unknown) => typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : v === undefined || v === null ? '-' : String(v)

function useSnap() { return useApi<Snap>('/api/lab/runs', ['lab']) }

function useRows(snap: Snap | null): Run[] {
  const [desk] = deskF.use()
  const [kind] = kindF.use()
  const [sort] = sortS.use()
  const [stage] = stageF.use()
  return useMemo(() => {
    if (!snap) return []
    const rows = snap.runs.filter(r => (!desk || r.desk === desk) && (kind === 'all' || kindOf(r) === kind)
      && (stage === 'all' || (stage === 'unset' ? !r.mstage : r.mstage === stage)))
    const key = (r: Run): string | number => {
      switch (sort.col) {
        case 'run': return r.run
        case 'desk': return r.desk
        case 'kind': return kindOf(r)
        case 'stage': return `${r.mstage ? STAGE_OPTS.indexOf(r.mstage) : 9} ${r.mechanic ?? ''}`
        case 'verify': return r.verify?.total ? (r.verify.passed ?? 0) / r.verify.total : -1
        case 'ann': return r.metrics.ann_pct ?? -Infinity
        case 'pnl': return r.metrics.pnl_usd ?? -Infinity
        case 'dd': return r.metrics.max_dd_pct ?? -Infinity
        case 'd7': return r.reads['7d'].due ?? 0
        case 'd30': return r.reads['30d'].due ?? 0
        default: return r.ts ?? 0
      }
    }
    return [...rows].sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : a.key.localeCompare(b.key)) * sort.dir })
  }, [snap, desk, kind, sort, stage])
}

/** one fixed-age read as a dot; its date, state and value ride in the tooltip */
function readTitle(a: string, c: ReadCell): string {
  const when = c.due ? `due ${stamp(c.due)}` : 'no result yet'
  const m = c.row?.metrics ? Object.entries(c.row.metrics) as [string, number][] : []
  const what = c.state === 'late' ? 'late - past the 4-day tolerance: remeasure would log it missed' : c.state === 'void' ? 'void - no read owed' : c.state === 'none' ? 'none' : c.state
  return [`+${a} ${what}`, when, ...m.map(([k, v]) => `${metricLabel(k)} ${num(v)}`)].join('\n')
}

/** the reads as three heat cells: at-run, +7d, +30d (readheat.ts); each cell's read, date and state ride in its tooltip */
function ReadsTd({ r }: { r: Run }) {
  const m = (c: ReadIn) => c.row?.metrics ? (Object.entries(c.row.metrics) as [string, number][]).map(([k, v]) => `${metricLabel(k)} ${num(v)}`) : []
  return <td className="num lab-rd"><HeatStrip cells={readHeat(r, m)} label="fixed-age reads: at run, +7d, +30d" /></td>
}

/** a run's kind as a tinted mark on the RUN cell where the KIND column folds away (under 1600px): explore and wild only */
const KIND_ICON: Record<string, string> = { explore: 'scan', wild: 'bulb' }
/** the KIND cell: import blank, exploit a dim word, explore and wild tinted chips */
function KindMark({ k }: { k: string | null }) {
  if (!k || k === 'import') return null
  return k === 'explore' || k === 'wild' ? <span className={`tag tint lab-kchip k-${k}`}>{k}</span> : <span className="lab-kind">{k}</span>
}


const fixed1 = (v: number) => v.toFixed(1)
/** a dollar figure as the table reads it: 154273 -> 154k, 1.2e6 -> 1.2M */
const usd = (v: number) => { const a = Math.abs(v); return a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v)) }

/** the window fingerprint's inputs, one per line, for a tooltip */
const utc = (ms: number | null) => ms === null ? '?' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
const fpLines = (f: Fp | null) => !f ? [] : f.inputs.map(i => `${i.venue}:${i.symbol}:${i.dataset}${i.interval ? ':' + i.interval : ''}  ${i.rows.toLocaleString()} rows  ${utc(i.first_ts)} -> ${utc(i.last_ts)}${i.trunc ? '  HEAD MISSING' : ''}`)

/** inline glyphs this room needs: a chain link (shared window), a cut (truncated head), a pin (rows kept) */
function PinG() { return <svg className="lab-g" viewBox="0 0 16 16" aria-hidden><path d="M6 2.5h4M7 2.5v4.2L4.5 9.5h7L9 6.7V2.5M8 9.5V14" /></svg> }
function LinkG() { return <svg className="lab-g" viewBox="0 0 16 16" aria-hidden><path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 013.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 01-3.7-3.7L5.3 7.8" /></svg> }
function CutG() { return <svg className="lab-g" viewBox="0 0 16 16" aria-hidden><circle cx="4.5" cy="4.5" r="2" /><circle cx="4.5" cy="11.5" r="2" /><path d="M6.2 5.6L14 12M6.2 10.4L14 4" /></svg> }

/** the window hash chip + its two flags: a link when other runs share the window, a cut when the store's head is missing */
/** the pin flag: every input pinned (its rows kept past any cache eviction), or some not; an index
 *  that could not be read shows nothing rather than calling an input unpinned */
function PinFlag({ p }: { p: Run['pins'] }) {
  if (!p || !p.of) return null
  if (p.pinned === p.of) return <span className="lab-flag lab-pinned" title={`pinned: all ${p.of} input${p.of === 1 ? '' : 's'} kept past any cache eviction, so this window can be re-read`}><PinG /></span>
  if (!p.known) return null
  return <span className="lab-flag lab-unpin" title={`unpinned: ${p.of - p.pinned} of ${p.of} input${p.of === 1 ? '' : 's'} not pinned - once the cache evicts those rows this window cannot be re-read`}><PinG /></span>
}

function FpMark({ r }: { r: Pick<Run, 'fp' | 'fingerprint' | 'chain' | 'trunc' | 'pins'> }) {
  if (!r.fp) return null
  return <span className="lab-fp">
    <span className="lab-hash" title={[`window ${r.fp}`, ...fpLines(r.fingerprint)].join('\n')}>{r.fp}</span>
    {r.chain.length > 0 && <span className="lab-flag lab-linkd" title={`same window as ${r.chain.map(k => short(k)).join(', ')}\ntogether: 1 observation`}><LinkG /></span>}
    {r.trunc && <span className="lab-flag lab-cut" title={`truncated: the rows read start later than the window's from\n${fpLines(r.fingerprint).filter(l => l.includes('HEAD')).join('\n') || 'a head is missing'}`}><CutG /></span>}
    <PinFlag p={r.pins} />
  </span>
}

/** one number column read from the run's own metrics; the headline sentence rides in the tooltip */
function Metric({ r, k, f }: { r: Run; k: string; f: (v: number) => string }) {
  const v = r.metrics?.[k]
  const title = r.void ? `VOID: ${r.void}
${r.headline}` : r.headline || (r.stage === 'preflight' ? 'pending' : '')
  return <td className="num" title={title}>{typeof v === 'number' ? f(v) : <Nil />}</td>
}

/** an empty cell: a short faint rule, low contrast - an honest unknown, never a bold '-' */
function Nil({ title }: { title?: string }) { return <span className="nil" title={title ?? 'no value'} aria-label="no value" /> }

/** a check count as the table reads it: 35915 -> 35.9k */
const kCount = (n: number) => n >= 100_000 ? `${Math.round(n / 1000)}k` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n)

/** VERIFY: a full pass is a green dot and the count of checks; any fail is the red passed/total;
 *  an unknown pass count is faint; not run is the faint rule. The suite and n/n ride in the tooltip */
function VerifyCell({ v }: { v: any }) {
  const title = v?.none_because ?? v?.suite ?? ''
  if (v?.total == null || !(v.total > 0)) return <td className="num lab-vcell" title={title || 'not run'}><span className="lab-vn off"><Nil title={title || 'not run'} /></span></td>
  const passed = typeof v.passed === 'number' ? v.passed : null
  const tone = passed === null ? 'off' : passed >= v.total ? 'ok' : 'bad'
  return <td className="num lab-vcell" title={`${v.suite ? v.suite + ' ' : ''}${passed ?? '?'}/${v.total} passed`}>
    <span className={`lab-vn ${tone}`}>{tone === 'ok' ? <><span className="dot ok sm" />{kCount(v.total)}</> : tone === 'bad' ? `${kCount(passed!)}/${kCount(v.total)}` : `?/${kCount(v.total)}`}</span>
  </td>
}

/** a window as [from, to] ms, or null when its dates do not parse */
const winMs = (w: any): [number, number] | null => {
  const f = Date.parse(String(w?.from ?? '')), t = Date.parse(String(w?.to ?? ''))
  return Number.isFinite(f) && Number.isFinite(t) ? [f, Math.max(f, t)] : null
}

/** WINDOW: a bar on ONE time axis shared by every shown row (so overlap and length read at a glance),
 *  then its length; the dates ride in the tooltip. A window whose dates do not parse stays text */
function WinCell({ w, axis }: { w: any; axis: [number, number] | null }) {
  const m = winMs(w)
  const sp = winSpan(w)
  const title = `${win(w)}${winTail(w) ? `\n${winTail(w)}` : ''}`
  if (!w) return <td className="lab-win"><Nil title="no window recorded" /></td>
  if (!m || !axis) return <td className="mono lab-win" title={title}>{winShort(w)}</td>
  const span = axis[1] - axis[0] || 1
  const clip = m[0] < axis[0]
  const a = Math.max(m[0], axis[0])
  const l = (a - axis[0]) / span * 100, wd = (m[1] - a) / span * 100
  return <td className="lab-win" title={`${title}${clip ? `\nstarts before this axis (${utcDay(axis[0])})` : ''}`}>
    <span className="lab-wbar"><i className={clip ? 'clip' : ''} style={{ left: `min(${l}%, calc(100% - 3px))`, width: `max(3px, ${wd}%)` }} /></span>
    {sp && <span className="lab-wspan">{sp}</span>}
  </td>
}

/** the desk's owner colour (the agent that may write it) as a small chip; neutral when no agent claims it */
function DeskChip({ agent }: { agent: string | null }) {
  return <span className="lab-dchip" style={{ background: agent ? agentColor(agent) : UNKNOWN_COLOR }} title={agent ? `owner ${agent}` : 'no agent writes this desk'} />
}

const WDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** a metric key as a label: ann_pct -> ANN %, max_dd_pct -> MAXDD %, pnl_usd -> P&L $ */
const LABEL: Record<string, string> = { ann_pct: 'ANN %', max_dd_pct: 'MAXDD %', pnl_usd: 'P&L $', liquidations: 'LIQ', sharpe: 'SHARPE', trades: 'TRADES' }
const metricLabel = (k: string) => LABEL[k] ?? k.replace(/_pct$/, ' %').replace(/_usd$/, ' $').replace(/_/g, ' ').toUpperCase()

function Th({ col, children, num, cls, title }: { col: string; children: ReactNode; num?: boolean; cls?: string; title?: string }) {
  const [sort, setSort] = sortS.use()
  const on = sort.col === col
  return <th title={`${title ? title + ' · ' : ''}sort; a third click goes back to by date`} className={`lab-th ${num ? 'num' : ''} ${on ? 'on' : ''} ${cls ?? ''}`} onClick={() => setSort(!on ? { col, dir: -1 } : sort.dir === -1 ? { col, dir: 1 } : { col: 'ran', dir: -1 })}>
    {children}{on ? (sort.dir === 1 ? ' ▴' : ' ▾') : ''}
  </th>
}

function openRun(openDrawer: ReturnType<typeof useNav>['openDrawer'], r: { desk: string; run: string }) {
  // the same desk name the table's DESK column shows; the full lab path is the tooltip
  openDrawer({ title: <span className="mono" title={r.desk}>{short(r.desk)} #{r.run}</span>, body: <RunDetail desk={r.desk} run={r.run} /> })
}

function RunDetail({ desk, run }: { desk: string; run: string }) {
  const q = useApi<any>(`/api/lab/run?desk=${encodeURIComponent(desk)}&run=${encodeURIComponent(run)}`, ['lab'])
  const jobs = useJobs()
  const { go } = useNav()
  return <Load q={q} skel="lines">{d => <div className="lab-detail">
    <RunHead r={d} />
    <RunCards r={d} />
    <Sec>Metrics</Sec>
    <Tiles items={Object.entries(d.metrics ?? {}).map(([k, v]) => ({ k: metricLabel(k), v: num(v), title: k, tone: k === 'liquidations' && Number(v) > 0 ? 'fail' : undefined }))} />
    <Sec>Reads</Sec>
    <ReadDots run={d.ts ? day(d.ts).slice(5) : null} reads={(['7d', '30d'] as const).map(a => readMark(a, d.reads[a], d.fp))} />
    {(['7d', '30d'] as const).filter(a => d.reads[a].state === 'due' || d.reads[a].state === 'late' || jobs.data?.jobs.some(j => j.key === `${d.desk}#${d.run}@${a}`)).map(a =>
      <ReadAction key={a} desk={d.desk} run={d.run} age={a} state={d.reads[a].state} />)}
    <Sec>Trials</Sec>
    <TrialsSection runKey={d.key} />
    <Fold label="Results log" right={d.logFile && <button className="lnk mono lab-link" title={d.logFile} onClick={() => go('library', d.logFile)}>{d.logFile.split('/').pop()}</button>}
      empty={!d.entry && (d.logFile ? `no ### ${run} entry` : 'no results-log.md')}>
      {d.entry && <Markdown text={d.entry} />}
    </Fold>
    <Fold label="Rows" right={<span className="faint">{d.rows.length}</span>} empty={!d.rows.length && 'none'}>
      <pre className="pre">{d.rows.map((x: any) => JSON.stringify(x, null, 2)).join('\n\n')}</pre>
    </Fold>
  </div>}</Load>
}

/** the drawer head: whose desk (its owner's square), the run, and VERIFY · ANN · MAXDD · LIQ. A
 *  metric the run did not record is a dim dash, never a zero */
function RunHead({ r }: { r: any }) {
  const m = r.metrics ?? {}
  const v = r.verify
  const full = v?.total != null && v.passed === v.total
  const pct = (k: string) => typeof m[k] === 'number' ? `${fixed1(m[k])}%` : null
  return <DrawerHead agent={r.owner ?? r.seat ?? r.agent} title={<span title={r.desk}>{short(r.desk)} <span className="mono">#{r.run}</span></span>}
    sub={[r.preregistered ? (r.kind ?? 'run') : 'import', r.mechanic, r.ts ? day(r.ts) : null].filter(Boolean).join(' · ')}
    chips={[
      { k: 'VERIFY', v: v?.total != null ? verifyTxt(v) : null, tone: v?.total == null ? '' : full ? 'ok' : 'fail', title: v?.none_because ?? `${v?.suite ?? 'verify'} ${verifyTxt(v)}` },
      { k: 'ANN', v: pct('ann_pct'), title: 'annualised return, % (the run\'s own metric)' },
      { k: 'MAXDD', v: pct('max_dd_pct'), title: 'max drawdown, %' },
      { k: 'LIQ', v: typeof m.liquidations === 'number' ? m.liquidations : null, tone: typeof m.liquidations === 'number' ? (m.liquidations > 0 ? 'fail' : 'ok') : '', title: 'liquidations' },
    ]} />
}

/** Identity · Window · Result as key/value cards; a row with nothing to say is not drawn */
function RunCards({ r }: { r: any }) {
  const both = r.seat && r.agent && r.seat === r.agent
  return <KvCards cards={[
    { title: 'Identity', rows: [
      ['desk', <span className="mono" title={r.desk}>{short(r.desk)}</span>],
      // seat (the lab desk's owner) and agent (who ran it) are one row when they are the same name
      ...(both ? [['agent', r.agent] as [string, ReactNode]] : [r.seat ? ['seat', r.seat] : null, r.agent ? ['agent', r.agent] : null] as KvRow[]),
      // kind and registration are one fact: an import is never pre-registered
      ['kind', <span title={r.preregistered ? 'pre-registered by preregister.py' : 'imported by backfill.py - evidence, not a prediction'}>
        <Tag tone={r.preregistered ? 'ok' : undefined}>{r.preregistered ? (r.kind ?? 'run') : 'import'}</Tag></span>],
      r.mechanic ? ['mechanic', <>{r.mechanic}{r.mstage ? <> <StagePill s={r.mstage} /></> : null}</>] : null,
      r.preflight ? ['pre-flight', <PreflightTag text={String(r.preflight).replace(/\*\*/g, '').trim()} />] : null,
    ] },
    { title: 'Window', rows: [
      ['window', r.window ? <span className="mono">{win(r.window)}</span> : null],
      winTail(r.window) ? ['span', <span className="mono">{winTail(r.window)}</span>] : null,
      r.fp ? ['data', <FpMark r={r} />] : null,
      ['ran', r.ts ? <span className="mono">{new Date(r.ts).toISOString().replace('T', ' ').slice(0, 16)}Z</span> : null],
    ] },
    { title: 'Result', wide: !!r.void, rows: [
      ['verify', r.verify?.total != null || r.verify?.suite ? <span className="mono" title={r.verify?.none_because}>{r.verify?.suite ? `${r.verify.suite} ` : ''}{verifyTxt(r.verify)}{r.verify?.none_because ? ' (no count)' : ''}</span> : null],
      band(r.predicted) ? ['predict', <span className="mono">{band(r.predicted)}</span>] : null,
      r.void ? ['void', <span className="t-fail">{r.void}</span>] : null,
    ] },
  ]} />
}

/** one fixed-age read on the timeline: filled = read, hollow = due, red = missed or late */
function readMark(a: '7d' | '30d', c: ReadCell, runFp?: string | null): ReadMark {
  const m = c.row?.metrics ? Object.entries(c.row.metrics) as [string, number][] : []
  const state: ReadMark['state'] = c.state === 'done' ? 'read' : c.state === 'due' ? 'due' : c.state === 'late' || c.state === 'missed' ? 'missed' : 'off'
  const label = c.state === 'done' ? (m.length ? num(m[0][1]) : 'read') : c.state === 'missed' ? 'missed' : c.state === 'late' ? 'late' : c.due ? day(c.due).slice(5) : null
  const match = c.match == null ? [] : [c.match ? `match: read ${c.fp} = run ${runFp ?? '?'} - the same window, not a new observation` : `drift: read ${c.fp} vs run ${runFp ?? '?'} - a rolled window`]
  return { age: a, state, label, title: [readTitle(a, c), ...match].join('\n') }
}

/** a drawer section folded shut until asked for: the long text is one click away, never in the way */
function Fold({ label, right, empty, children }: { label: string; right?: ReactNode; empty?: string | false | null; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <>
    <div className="cap dsec lab-fold">
      <button className="lab-fold-b" disabled={!!empty} onClick={() => setOpen(!open)} aria-expanded={open} title={empty || (open ? 'Collapse' : 'Expand')}>
        <span className="lab-chev">{empty ? '' : open ? '▾' : '▸'}</span>{label}
      </button>
      {right}
      {empty && <span className="faint lab-fold-e">{empty}</span>}
    </div>
    {open && !empty && children}
  </>
}


/** a transcribed run ("none - ...") has no pre-flight to grade against; the sentence rides in the tooltip */
function PreflightTag({ text }: { text: string }) {
  const none = text.toLowerCase().startsWith('none')
  return <span title={text}><Tag tone={none ? undefined : 'ok'}>{none ? 'ungraded' : 'on file'}</Tag></span>
}


function Compare({ keys, snap }: { keys: string[]; snap: Snap }) {
  const [a, b] = keys.map(k => snap.runs.find(r => r.key === k))
  if (!a || !b) return <Empty state="unknown">one of the two runs is gone from the ledger</Empty>
  const metrics = [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])]
  const line = (k: string, f: (r: Run) => ReactNode) => <tr key={k}><td className="faint mono">{k}</td><td>{f(a)}</td><td>{f(b)}</td></tr>
  return <table className="tbl lab-cmp"><thead><tr><th /><th>{short(a.desk)} #{a.run}</th><th>{short(b.desk)} #{b.run}</th></tr></thead><tbody>
    {line('kind', kindOf)}
    {line('mechanic', r => r.mechanic ?? '-')}
    {line('registered', r => r.preregistered ? 'pre-registered' : 'imported')}
    {line('predict', r => band(r.predicted) || '-')}
    {line('window', r => <span className="mono">{win(r.window)} {winTail(r.window)}</span>)}
    {line('data', r => r.fp ? <FpMark r={r} /> : <span className="faint" title="no fingerprint: recorded without --input">-</span>)}
    <tr><td className="faint mono">evidence</td><td colSpan={2}>{!a.fp || !b.fp
      ? <Pill tone="faint" title="one of the two runs carries no window fingerprint">window ?</Pill>
      : a.chain.includes(b.key) || a.fp === b.fp
        ? <Pill tone="warn" title="the two runs read the same stored rows: together they are ONE observation, not a replication">1 obs</Pill>
        : <Pill title="disjoint windows: two observations">2 obs</Pill>}</td></tr>
    {line('verify', r => <span className="mono" title={r.verify?.suite}>{verifyTxt(r.verify)}</span>)}
    {line('result', r => r.headline || '-')}
    {line('ran', r => day(r.ts))}
    {line('reads', r => <HeatStrip cells={readHeat(r)} label="fixed-age reads: at run, +7d, +30d" />)}
    {metrics.map(m => line(m, r => <span className="mono">{num(r.metrics[m])}</span>))}
  </tbody></table>
}

function RunsTable() {
  const q = useSnap()
  const rows = useRows(q.data)
  const { openDrawer } = useNav()
  const [picked, setPicked] = pick.use()
  const [desk] = deskF.use()
  const [sort] = sortS.use()
  return <Load q={q} skel="table">{snap => {
    if (snap.runs.length === 0) return <Empty title="NO RUNS">no desk has a row in data/runs.jsonl</Empty>
    if (rows.length === 0) return <Empty>no run matches the filters</Empty>
    const toggle = (k: string) => setPicked(picked.includes(k) ? picked.filter(x => x !== k) : [...picked.slice(-1), k])
    // a column that is empty on every shown row is noise: it only appears once something fills it
    const hasM = (k: string) => rows.some(r => typeof r.metrics?.[k] === 'number')
    const has = { desk: !desk, kind: new Set(rows.map(kindOf)).size > 1, band: rows.some(r => band(r.predicted)), stage: rows.some(r => r.mechanic), win: rows.some(r => r.window), fp: rows.some(r => r.fp), verify: rows.some(r => r.verify?.total > 0 || r.verify?.suite), trials: rows.some(r => r.n_trials !== null), ann: hasM('ann_pct'), pnl: hasM('pnl_usd'), dd: hasM('max_dd_pct') }
    // the WINDOW bars' one axis over the shown rows: the 10th-percentile from (so one old outlier does
    // not crush every other bar to a sliver; an earlier start is drawn clipped) to the latest to
    const spans = rows.map(r => winMs(r.window)).filter((x): x is [number, number] => x !== null)
    const froms = spans.map(x => x[0]).sort((p, q) => p - q)
    const axis: [number, number] | null = spans.length ? [froms[Math.floor((froms.length - 1) * 0.1)], Math.max(...spans.map(x => x[1]))] : null
    // by date (the default sort): thin day-header rows group the runs; any other sort is one flat list
    const byDay = sort.col === 'ran'
    const cols = 1 + 1 + [has.desk, has.kind, has.stage, has.band, has.win, has.fp, has.verify, has.trials, has.ann, has.pnl, has.dd].filter(Boolean).length + 1
    const count = new Map<string, number>()
    for (const r of rows) { const d = utcDay(r.ts); count.set(d, (count.get(d) ?? 0) + 1) }
    const body: ReactNode[] = []
    let last: string | null = null
    for (const r of rows) {
      const d = utcDay(r.ts)
      if (byDay && d !== last) {
        last = d
        const wd = r.ts ? WDAY[new Date(r.ts).getUTCDay()] : ''
        const n = count.get(d) ?? 0
        body.push(<tr key={`d:${d}`} className="lab-dayrow"><td colSpan={cols}>{d === '-' ? <span title="the run carries no timestamp">no date</span> : <><span className="lab-dday">{d}</span><span className="lab-dwd">{wd}</span></>}<span className="lab-dn">{n} run{n === 1 ? '' : 's'}</span></td></tr>)
      }
      body.push(<tr key={r.key} className={`click ${r.void ? 'lab-void' : ''} ${picked.includes(r.key) ? 'picked' : ''}`} onClick={() => openRun(openDrawer, r)}>
        <td className="lab-ck" onClick={e => { e.stopPropagation(); toggle(r.key) }}><input type="checkbox" className="ck" readOnly checked={picked.includes(r.key)} /></td>
        <td className="mono lab-run" title={`${r.ts ? `ran ${stamp(r.ts)}` : 'no timestamp'}
kind ${r.preregistered ? (r.kind ?? 'run') : 'import'}`}>{r.kind && KIND_ICON[r.kind] && <span className={`lab-kico k-${r.kind}`}><Icon name={KIND_ICON[r.kind]} title={`kind ${r.kind}`} /></span>}{r.run}{r.void && <> <Tag tone="fail">void</Tag></>}</td>
        {has.desk && <td className="lab-desk" title={`${r.desk}${r.seat ? `
seat ${r.seat}` : ''}${r.agent ? `
agent ${r.agent}` : ''}`}><DeskChip agent={r.owner ?? r.agent} />{short(r.desk)}</td>}
        {has.kind && <td className="lab-wide" title={`${r.preregistered ? 'pre-registered by preregister.py' : 'imported by backfill.py - evidence, not a prediction'}${r.mechanic ? `
mechanic ${r.mechanic}` : ''}`}><KindMark k={r.preregistered ? r.kind : 'import'} /></td>}
        {has.stage && <td className="lab-stcell" title={r.mechanic ? `${r.mechanic}: ${r.mstage ?? 'no stage set'}` : 'no mechanic named'}>{r.mechanic ? <><span className="mono faint">{r.mechanic}</span>{r.mstage ? <> <StagePill s={r.mstage} /></> : null}</> : <Nil title="no mechanic named" />}</td>}
        {has.band && <td className="mono lab-band lab-wide" title={band(r.predicted)}>{band(r.predicted) || <Nil title="no pre-registered band" />}</td>}
        {has.win && <WinCell w={r.window} axis={axis} />}
        {has.fp && <td className="lab-fpcell">{r.fp ? <FpMark r={r} /> : <Nil title="no fingerprint: recorded without --input" />}</td>}
        {has.verify && <VerifyCell v={r.verify} />}
        {has.trials && <td className="lab-tcell"><TrialChips runKey={r.key} dsr={r.dsr} pbo={r.pbo} n={r.n_trials} /></td>}
        {has.ann && <Metric r={r} k="ann_pct" f={fixed1} />}
        {has.pnl && <Metric r={r} k="pnl_usd" f={usd} />}
        {has.dd && <Metric r={r} k="max_dd_pct" f={fixed1} />}
        <ReadsTd r={r} />
      </tr>)
    }
    return <table className="tbl lab-tbl">
      <thead><tr>
        <th className="lab-ck" title="pick two to compare" />
        <Th col="run">Run</Th>{has.desk && <Th col="desk">Desk</Th>}{has.kind && <Th col="kind" cls="lab-wide">Kind</Th>}{has.stage && <Th col="stage">Mech</Th>}{has.band && <th className="lab-wide" title="the pre-registered prediction band">Band</th>}{has.win && <th title={axis ? `each run's window as a bar on one axis: ${utcDay(axis[0])} to ${utcDay(axis[1])}; its length beside it` : 'the window each run read'}>Window</th>}{has.fp && <th title="the window fingerprint: a digest of the stored rows the run read">Data</th>}
        {has.verify && <Th col="verify" num title="a green dot and the check count when every check passed; passed/total in red on any fail">Verify</Th>}{has.trials && <th title="the trial ledger: Deflated Sharpe and PBO (CSCV)">Trials</th>}{has.ann && <Th col="ann" num>Ann %</Th>}{has.pnl && <Th col="pnl" num>P&amp;L $</Th>}{has.dd && <Th col="dd" num>MaxDD</Th>}<Th col="d7" num title="the fixed-age reads: at run, +7d, +30d">Reads</Th>
      </tr></thead>
      <tbody>{body}</tbody>
    </table>
  }}</Load>
}

/** the KPI tiles for the lab or the picked desk; nothing until the snapshot answers (the table below
 *  says loading or failed), so no tile ever shows a zero it did not count */
function KpiBar({ desk }: { desk: string }) {
  const q = useSnap()
  if (!q.data) return null
  return <KpiStrip k={kpis(q.data, desk)} now={q.data.now} scope={desk} />
}

/** the desk's reads timeline, from the snapshot the table already holds */
function DeskReads({ desk }: { desk: string }) {
  const q = useSnap()
  if (!q.data) return <Empty state={q.error ? 'failed' : 'loading'} inline>{q.error ?? undefined}</Empty>
  return <ReadsTimeline runs={q.data.runs.filter(r => r.desk === desk)} now={q.data.now} />
}

function Main() {
  const [desk] = deskF.use()
  const [metrics, setMetrics] = metricF.use()
  if (!desk) return <div className="lab-main"><KpiBar desk="" /><RunsTable /></div>
  return <div className="lab-main">
    <KpiBar desk={desk} />
    <div className="lab-strip">
      <DeskChart desk={desk} metric={metrics[desk] ?? ''} onMetric={m => setMetrics({ ...metrics, [desk]: m })} />
      <div className="lab-side">
        <DeskReads desk={desk} />
        <Mechanics desk={desk} />
      </div>
    </div>
    <RunsTable />
  </div>
}

/** 7 cells, one per UTC day, today on the right: a bar per day scaled to the busiest day shown;
 *  a quiet day is bare track, never a drawn zero */
function Spark({ counts, max, what, color }: { counts: number[]; max: number; what: string; color?: string }) {
  const now = Date.now()
  const lines = counts.map((n, i) => `${utcDay(now - (counts.length - 1 - i) * 86_400_000)}  ${n || '-'}`)
  return <span className="lab-spark" style={color ? { '--c': color } as CSSProperties : undefined} title={`${what}: runs per day, last 7 days (UTC)
${lines.join('\n')}`} aria-label={`${counts.reduce((a, b) => a + b, 0)} runs in 7 days`}>
    {counts.map((n, i) => <i key={i} className={n ? 'on' : ''} style={n ? { height: `${Math.max(50, Math.round(n / Math.max(1, max) * 100))}%` } : undefined} />)}
  </span>
}

/** the desk's category colour: the table's own mapping (owner ?? agent of its runs), else its seat */
function deskOwner(snap: Snap, d: Desk): string | null {
  const n = new Map<string, number>()
  for (const r of snap.runs) if (r.desk === d.desk) { const a = r.owner ?? r.agent; if (a) n.set(a, (n.get(a) ?? 0) + 1) }
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? d.seat ?? null
}

/** a read's tone, the same one its dot shows: red once past the 4-day tolerance ('late'),
 *  amber once overdue but inside it, plain while it is still ahead */
const dueTone = (state: string, due: number, now: number) => state === 'late' ? 'fail' : now > due ? 'warn' : ''

/** a read's overdue days as a chip (6d), toned like its dot; one still ahead reads as its countdown */
function DuePill({ due, now, state }: { due: number; now: number; state: string }) {
  const over = now > due
  return <span className={`pill lab-cd ${dueTone(state, due, now)}`} title={`${over ? `overdue ${daysOver(due, now)} days, since` : 'due'} ${stamp(due)}${state === 'late' ? '\npast the 4-day tolerance: remeasure would log it missed' : ''}`}>
    {over ? `${daysOver(due, now)}d` : relTime(due)}
  </span>
}

function Explorer() {
  const q = useSnap()
  const [desk, setDesk] = deskF.use()
  const { openDrawer } = useNav()
  return <Load q={q} skel="table">{snap => {
    const withRuns = snap.desks.filter(d => d.runs > 0)
    const empty = snap.desks.filter(d => d.runs === 0)
    const all = perDay(snap.runs.map(r => r.ts), snap.now)
    const per = new Map(withRuns.map(d => [d.desk, perDay(snap.runs.filter(r => r.desk === d.desk).map(r => r.ts), snap.now)]))
    const max = Math.max(1, ...[...per.values()].flat())
    return <>
      <Group label="Desks" right={<span title={`${withRuns.length} desks with runs, ${snap.desks.length} in all`}>{withRuns.length}</span>}>
        <button className={`row lab-drow ${desk === '' ? 'on' : ''}`} onClick={() => setDesk('')} title={`${snap.runs.length} runs`}><span className="lab-ddot all" /><span className="nm">All</span><Spark counts={all} max={Math.max(1, ...all)} what="all desks" /></button>
        {withRuns.map(d => {
          const who = deskOwner(snap, d)
          const over = snap.readsDue.filter(r => r.desk === d.desk && snap.now > r.due)
          const late = over.some(r => r.state === 'late')
          return <button key={d.desk} className={`row lab-drow ${desk === d.desk ? 'on' : ''}`} onClick={() => setDesk(desk === d.desk ? '' : d.desk)} title={`${d.desk} - ${d.runs} runs: ${d.preregistered} pre-registered, ${d.imported} imported${d.bad ? `, ${d.bad} unreadable line(s)` : ''}${who ? `
owner ${who}` : ''}`}>
            <span className="lab-ddot" style={{ background: who ? agentColor(who) : UNKNOWN_COLOR }} /><span className="nm">{short(d.desk)}</span>
            {d.retro?.due && <span className="lab-rflag" title={`retro due: ${d.retro.why}`} />}
            {over.length > 0 && <span className={`pill lab-oflag ${late ? 'fail' : 'warn'}`} title={`${over.length} read${over.length === 1 ? '' : 's'} overdue${late ? ', past the 4-day tolerance' : ''}`}>{over.length}</span>}
            <Spark counts={per.get(d.desk)!} max={max} what={short(d.desk)} color={who ? agentColor(who) : undefined} />
          </button>
        })}
        {empty.length > 0 && <div className="lab-quiet"><span className="nchip faint" title={`${empty.length} desks with no runs:
${empty.map(d => `${short(d.desk)}${d.hasFile ? '' : ' (no runs.jsonl)'}`).join('\n')}`}>{empty.length} idle</span></div>}
      </Group>
      <Group label="Reads due" right={<span>{snap.readsDue.length}</span>}>
        {snap.readsDue.length === 0 && <div className="lab-quiet"><Empty inline title="NONE" /></div>}
        {snap.readsDue.map(r => <button key={r.key + r.age} className={`row lab-rrow`} onClick={() => openRun(openDrawer, r)} title={`${r.desk} #${r.run} +${r.age}
due ${stamp(r.due)}${r.state === 'late' ? ' - past tolerance' : ''}${r.job?.running ? '\nread running' : ''}
python app/loop/tools/remeasure.py --desk ${r.desk} --run ${r.run} --age ${r.age}`}>
          <Dot s={r.job?.running ? 'run' : r.state === 'late' ? 'fail' : 'warn'} />
          <span className="mono lab-rr-run">{r.run}</span><span className="lab-rr-age">+{r.age}</span>
          <span className="nm lab-rr-desk">{short(r.desk)}</span>
          <DuePill due={r.due} now={snap.now} state={r.state} />
        </button>)}
      </Group>
    </>
  }}</Load>
}

function openPrereg(openDrawer: ReturnType<typeof useNav>['openDrawer'], snap: Snap, desk: string) {
  openDrawer({ title: 'Pre-register', body: <Prereg desks={snap.desks.map(d => d.desk)} initial={desk} /> })
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function Head() {
  const q = useSnap()
  const [kind, setKind] = kindF.use()
  const [picked, setPicked] = pick.use()
  const { openDrawer } = useNav()
  const live = new Set(q.data?.runs.map(kindOf) ?? [])
  const kinds = ['exploit', 'explore', 'wild', 'import'].filter(k => live.has(k) || kind === k)
  const [stage, setStage] = stageF.use()
  const [desk] = deskF.use()
  return <>
    <Seg value={kind} onChange={setKind} options={[{ id: 'all', label: 'All' }, ...kinds.map(k => ({ id: k, label: cap(k) }))]} />
    <select className={`input lab-hsel ${stage !== 'all' ? 'on' : ''}`} value={stage} title="filter runs by their mechanic's promotion stage (stages.json)" onChange={e => setStage(e.target.value)}>
      {STAGE_OPTS.map(s => <option key={s} value={s}>{s === 'all' ? 'Stage' : cap(s)}</option>)}
    </select>
    <Btn sm disabled={!q.data} title="pre-register a run: app/loop/tools/preregister.py decides" onClick={() => q.data && openPrereg(openDrawer, q.data, desk)}>Pre-register</Btn>
    <Btn sm kind={picked.length === 2 ? 'primary' : undefined} disabled={picked.length !== 2 || !q.data} title="tick two rows to compare them side by side" onClick={() => q.data && openDrawer({ title: 'Compare', body: <Compare keys={picked} snap={q.data} />, actions: <Btn sm kind="ghost" onClick={() => { setPicked([]); openDrawer(null) }}>clear</Btn> })}>Compare{picked.length ? ` ${picked.length}/2` : ''}</Btn>
  </>
}

export const room: RoomDef = {
  id: 'lab',
  label: 'Lab',
  title: 'Lab',
  icon: <><path d="M9 3v6l-5 10h16l-5-10V3M8 3h8"/></>,
  Explorer,
  Main,
  Head,
  palette: async nav => {
    const s = await api<Snap>('/api/lab/runs')
    return [
      { kind: 'lab', label: 'Pre-register a run', run: () => openPrereg(nav.openDrawer, s, deskF.get()) },
      ...s.runs.map(r => ({ kind: 'run', label: `${short(r.desk)} #${r.run}`, hint: r.headline.slice(0, 60), run: () => { deskF.set(r.desk) } })),
    ]
  },
}
