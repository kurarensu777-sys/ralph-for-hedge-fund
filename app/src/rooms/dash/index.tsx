import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { RoomDef, PaletteItem } from '../types.ts'
import { api, relTime, useApi, useStored } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Btn, CardGroup, Dot, Empty, FailLine, HeatBlank, HeatStrip, Icon, Load, MarketTag, Pill, Tag } from '../../ui/kit.tsx'
import { groupHeat } from './groupHeat.ts'
import { Heat, Uptime, summaryTitle, useHistory, type DashHistory } from './Heat.tsx'
import { SummaryCard } from './SummaryCard.tsx'
import type { DashSummaryView } from '../../../shared/types.ts'
import './dash.css'

// ROOM: dash - a launcher. Start, stop, health-check and open dashboards in the browser;
// never embed one. Server: server/rooms/dash.ts (/api/dash/).

type State = 'running' | 'stale' | 'failing' | 'stopped' | 'dev' | 'starting'
type Check = { id: string; check: string; target: string; status: string; reading: string; ts: number | null }
export type DashView = {
  id: string; name: string; market: string; agent: string; kind: 'dashboard' | 'tool'; open: string
  key: string; sharedWith: string[]; port: number | null; portUp: boolean; state: State; measured: boolean
  owner: 'ours' | 'adopted' | null; pid: number | null; mode: 'prod' | 'dev' | null; since: number | null
  health: { ok: number; total: number; failing: string[]; warning: string[] }
  checks: Check[]; canStart: boolean; canDev: boolean; every: string; lastCheck: number | null
  summary: DashSummaryView
}
type Run = { id: number; mode: string; pid: number | null; port: number | null; cmd: string; started_at: number; stopped_at: number | null; exit_code: number | null }
type Detail = DashView & { on_fail: string | null; runs: Run[]; start: { cmd: string; cwd: string; port: number; shared?: string } | null; start_dev: { cmd: string; cwd: string; port: number } | null }

export function dotOf(v: DashView): string {
  switch (v.state) {
    case 'running': return v.measured ? 'ok' : 'unknown'
    case 'stale': return 'warn'
    case 'failing': return 'fail'
    case 'dev': case 'starting': return 'run'
    default: return 'off'
  }
}

/** problems = a dashboard.json the server could not register (unreadable, wrong shape) or a fault
 *  between two of them; each is shown, never silently dropped */
type DashList = { items: DashView[]; problems?: { path: string; error: string }[] }

function useDash() {
  const q = useApi<DashList>('/api/dash', ['dash', 'config'])
  useEffect(() => { const t = setInterval(q.reload, 30_000); return () => clearInterval(t) }, [q.reload])
  return q
}

const nameOf = (items: DashView[] | undefined, id: string) => items?.find(x => x.id === id)?.name ?? id

/** the actions an in-page confirm guards; returns an error message or null */
function useActions() {
  const { toast } = useNav()
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (id: string, what: 'start' | 'stop' | 'restart' | 'check', body: unknown = {}) => {
    setBusy(`${id}:${what}`)
    try {
      const r: any = await api(`/api/dash/${id}/${what}`, { body })
      if (what === 'start') toast(r?.adopted ? `${id}: already running, adopted` : `${id}: starting`)
      else if (what === 'stop') toast(`${r?.stopped ?? id}: stopped`)
      else if (what === 'restart') toast(`${id}: restarting`)
    } catch (e: any) { toast(`${id} ${what}: ${e.message}`, true) } finally { setBusy(null) }
  }
  return { busy, act }
}

/** the port as one untruncated chip: a click copies the URL and the chip flashes 'copied' */
function PortChip({ v }: { v: DashView }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1200); return () => clearTimeout(t) }, [copied])
  if (!v.port) return <span className="nil" title={`${v.open}: no port`} />
  const copy = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    navigator.clipboard?.writeText(v.open).then(() => setCopied(true), () => setCopied(false))
  }
  return <button className={`pill out dash-port ${copied ? 'copied' : ''} ${v.portUp ? 'up' : ''}`} onClick={copy} onKeyDown={e => e.stopPropagation()}
    title={`${v.open}${v.portUp ? '' : ' (not serving)'} - click to copy`}>{copied ? 'copied' : `:${v.port}`}</button>
}

/** the one port a whole card serves on: every row the same non-null port, else null (rows keep their own chips) */
export function cardPort(vs: DashView[]): number | null {
  const p = vs[0]?.port ?? null
  return p !== null && vs.every(v => v.port === p) ? p : null
}

/** the name's dot tooltip: the state, then who started it and how */
function stateTitle(v: DashView): string {
  const since = v.portUp && v.since ? `serving for ${relTime(v.since)}` : ''
  return [v.state, since, v.owner === 'adopted' ? 'started outside the cockpit; stop still works' : '', v.pid ? `pid ${v.pid}` : '', v.mode === 'dev' ? 'dev mode' : ''].filter(Boolean).join(' - ')
}

function StateCell({ v }: { v: DashView }) {
  const word = v.state
  const title = [v.owner === 'adopted' ? 'started outside the cockpit; stop still works' : '', v.pid ? `pid ${v.pid}` : '', v.mode === 'dev' ? 'dev mode' : ''].filter(Boolean).join(' - ')
  // stopped is the quiet default: a grey dot, the word only in the tooltip
  if (v.state === 'stopped') return <span className="dash-state" title={['stopped', title].filter(Boolean).join(' - ')}><Dot s="off" title="stopped" /></span>
  return <span className="dash-state" title={title || undefined}><Dot s={dotOf(v)} /><span>{word}</span></span>
}

/** the table's ONE state chip: dot + word, the checks passing (x/y) and how long it has served, all
 *  measured; stopped is a quiet dot with the word in the tooltip, never a stale score */
function StateChip({ v }: { v: DashView }) {
  const bits = [v.owner === 'adopted' ? 'started outside the cockpit; stop still works' : '', v.pid ? `pid ${v.pid}` : '', v.mode === 'dev' ? 'dev mode' : '']
  if (v.state === 'stopped') return null
  const bad = [...v.health.failing, ...v.health.warning]
  const checks = v.checks.map(c => `${c.id} (${c.check} ${c.target}): ${c.status}${c.reading ? ` - ${c.reading}` : ''}`)
  const since = v.portUp && v.since ? relTime(v.since) : null
  const title = [`${v.state}${since ? `, serving for ${since}` : ''}`, ...bits, bad.length ? `not ok: ${bad.join(', ')}` : '', ...checks].filter(Boolean).join('\n')
  const tone = v.health.failing.length ? 't-fail' : v.health.warning.length ? 't-warn' : ''
  const d = dotOf(v)
  return <span className={`pill out dash-chip ${d === 'off' ? 'clear' : d === 'unknown' || d === 'run' ? '' : d}`} title={title}>
    <span>{v.state}</span>
    {v.health.total > 0 && <span className={`sep ${tone}`}>{v.health.ok}/{v.health.total}</span>}
    {since && <span className="sep dash-chip-t">{since}</span>}
  </span>
}

/** Start / Stop / Restart with an in-page confirm naming who else goes down */
function Controls({ v, items, sm = true, row = false }: { v: DashView; items?: DashView[]; sm?: boolean; row?: boolean }) {
  const { busy, act } = useActions()
  const [confirm, setConfirm] = useState<'stop' | 'restart' | null>(null)
  const isBusy = !!busy
  if (confirm) {
    const others = v.sharedWith.map(id => nameOf(items, id))
    return (
      <span className="dash-confirm">
        <span className="dash-confirm-t" title={others.length ? `${v.key} serves ${[v.name, ...others].join(', ')}` : undefined}>
          {confirm === 'stop' ? 'Stop' : 'Restart'} {v.key}{others.length ? <> - also {others.join(', ')}</> : null}?
        </span>
        <Btn sm kind="danger" onClick={() => { setConfirm(null); void act(v.id, confirm) }}>{confirm === 'stop' ? 'Stop' : 'Restart'}</Btn>
        <Btn sm kind="ghost" onClick={() => setConfirm(null)}>Cancel</Btn>
      </span>
    )
  }
  const up = v.portUp || v.state === 'starting'
  return (
    <>
      {!up && v.canStart && <Btn sm={sm} disabled={isBusy} onClick={() => void act(v.id, 'start')}>Start</Btn>}
      {!up && v.canDev && <Btn sm={sm} disabled={isBusy} onClick={() => void act(v.id, 'start', { dev: true })} title="Start the dev server">Dev</Btn>}
      {up && (() => { const stop = <Btn sm={sm} disabled={isBusy || v.state === 'starting'} onClick={() => setConfirm('stop')} title={v.pid ? `pid ${v.pid}` : undefined}>{v.mode === 'dev' ? 'Stop dev' : 'Stop'}</Btn>
        // in a table row Stop never hides with the hover-only buttons: a running thing keeps its off switch in view
        return row ? <span className="dash-keep">{stop}</span> : stop })()}
      {up && v.canStart && <Btn sm={sm} disabled={isBusy || v.state === 'starting'} onClick={() => setConfirm('restart')}>Restart</Btn>}
      {!v.canStart && !up && <span className="faint mono">manual</span>}
    </>
  )
}

/** a health poll: the cockpit's own GET of /api/health answered 2xx */
export const isPoll = (l: string) => /\/api\/health\b/.test(l) && /\b2\d\d\b/.test(l)
/** a line carrying an HTTP status: 4xx amber, 5xx red; anything else plain */
export function lineTone(l: string): '' | 'warn' | 'fail' {
  const m = /(?:"\s|\s)([1-5]\d\d)(?=\s|$)/.exec(l)
  if (!m) return /\b(error|traceback|exception)\b/i.test(l) ? 'fail' : ''
  return m[1][0] === '5' ? 'fail' : m[1][0] === '4' ? 'warn' : ''
}

/** "INFO:     127.0.0.1 ..." -> "127.0.0.1 ...": the colour carries the level, the word is noise */
export const dropLevel = (l: string) => l.replace(/^(INFO|DEBUG|WARNING|WARN|ERROR|CRITICAL):\s+/, '')
/** no blank lines before the first line or after the last */
function trimBlank(ls: string[]): string[] {
  let a = 0, b = ls.length
  while (a < b && !ls[a].trim()) a++
  while (b > a && !ls[b - 1].trim()) b--
  return ls.slice(a, b)
}

function LogView({ id, dev }: { id: string; dev?: boolean }) {
  const q = useApi<{ path: string; lines: string[]; missing?: boolean; mtime?: number }>(`/api/dash/${id}/logs${dev ? '?dev=1' : ''}`)
  const [hide, setHide] = useStored('dash.hidePolls', true)
  const polls = q.data ? q.data.lines.filter(isPoll).length : 0
  return (
    <div className="dash-logs">
      <div className="dash-logs-head">
        <span className="mono faint" title={q.data?.path}>{q.data && q.data.lines.length ? `${q.data.lines.length} lines${q.data.mtime ? ` · ${relTime(q.data.mtime)}` : ''}` : ''}</span>
        <span className="sp" />
        <button className={`iconbtn dash-poll ${hide ? 'on' : ''}`} disabled={!polls} onClick={() => setHide(!hide)} title={`${polls} health poll${polls === 1 ? '' : 's'} (GET /api/health 2xx) ${hide ? 'hidden: click to show' : 'shown: click to hide'}`}><Icon name={hide ? 'eyeoff' : 'quiet'} />{polls > 0 && <span className="mono">{polls}</span>}</button>
        <Btn sm onClick={q.reload}>Refresh</Btn>
      </div>
      <Load q={q} skel="lines">{d => d.missing || d.lines.length === 0
        ? <Empty title="NO LOG">{d.missing ? 'not started from the cockpit' : undefined}</Empty>
        : <pre className="pre log dash-log">{trimBlank(d.lines.filter(l => !hide || !isPoll(l))).map((l, i) => { const t = lineTone(l); const s = dropLevel(l); return t ? <span key={i} className={`dash-l-${t}`}>{s}{'\n'}</span> : s + '\n' })}</pre>}</Load>
    </div>
  )
}

function useOpeners() {
  const nav = useNav()
  const logs = (v: DashView) => nav.openDrawer({ title: <>{v.name} <span className="faint mono">log</span></>, body: <LogView id={v.id} dev={v.mode === 'dev'} /> })
  const detail = (id: string, name = id) => { nav.select('dash', id); nav.openDrawer({ title: name, body: <DashDetail id={id} /> }) }
  const agent = async (v: DashView) => {
    try {
      const r: any = await api('/api/chats', { body: { agent: v.agent } })
      const cid = r?.id ?? r?.conversation?.id ?? r?.conversationId
      nav.go('chats', cid ?? null)
    } catch (e: any) { nav.toast(`agent ${v.agent}: ${e.message}`, true) }
  }
  return { logs, detail, agent }
}

/** the log icon: a page with lines (the word rides in the tooltip) */
function LogIcon() {
  return <svg className="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5.5l2.5 2.5v8.5H4zM9.5 2.5V5H12M6 8.5h4M6 11h4" /></svg>
}

function Row({ v, items, h, hmissing, shared }: { v: DashView; items: DashView[]; h: DashHistory | undefined; hmissing: string; shared: number | null }) {
  const o = useOpeners()
  return (
    <div className="dash-r" role="button" tabIndex={0} onClick={() => o.detail(v.id, v.name)} onKeyDown={e => { if (e.key === 'Enter') o.detail(v.id, v.name) }}>
      <span className="dash-nm"><Dot s={dotOf(v)} title={stateTitle(v)} /><span className="dash-name" title={`${v.name} - ${v.id} - agent ${v.agent}`}>{v.name}</span><StateChip v={v} /></span>
      <span className="dash-wc">{v.port !== null && v.port === shared ? null : <PortChip v={v} />}</span>
      <span className="dash-hist">{h ? <Heat h={h} /> : <HeatBlank state={hmissing === 'history failed' ? 'unknown' : 'none'} why={hmissing || 'loading'} />}<span className="dash-up"><Uptime h={h} /></span></span>
      <span className="dash-acts" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
        {v.portUp && <span className="dash-keep"><Btn sm kind="primary" onClick={() => { window.open(v.open, '_blank', 'noopener') }} title={`open ${v.open}`}>Open</Btn></span>}
        <Controls v={v} items={items} row />
        <button className="iconbtn dash-ib" onClick={() => o.logs(v)} title="log" aria-label="log"><LogIcon /></button>
        <button className="iconbtn dash-ib" onClick={() => void o.agent(v)} title={`talk to ${v.agent}`} aria-label="Agent"><Icon name="bot" /></button>
      </span>
    </div>
  )
}

/** Start all / Stop all behind one in-page confirm naming the servers; never automatic */
function useAll() {
  const q = useApi<{ items: DashView[] }>('/api/dash', ['dash'])
  const { toast } = useNav()
  const [confirm, setConfirm] = useState<'start' | 'stop' | null>(null)
  const [busy, setBusy] = useState(false)
  const items = q.data?.items ?? []
  const up = items.filter(v => v.portUp)
  const down = items.filter(v => !v.portUp && v.canStart)
  const servers = (vs: DashView[]) => [...new Set(vs.map(v => v.key))]
  const run = async (what: 'start' | 'stop') => {
    setConfirm(null); setBusy(true)
    try {
      const r: any = await api(`/api/dash/${what}-all`, { body: {} })
      const res = Object.entries(r?.results ?? {}).map(([k, s]) => `${k} ${s}`).join(', ')
      toast(res || `nothing to ${what}`, /error/.test(res))
    } catch (e: any) { toast(`${what} all: ${e.message}`, true) } finally { setBusy(false) }
  }
  let confirmEl: ReactElement | null = null
  if (confirm) {
    const list = servers(confirm === 'start' ? down : up)
    confirmEl = (
      <span className="dash-confirm">
        <span className="dash-confirm-t">{confirm === 'start' ? 'Start' : 'Stop'} {list.length ? list.join(', ') : 'nothing'}?</span>
        <Btn sm kind={confirm === 'stop' ? 'danger' : 'primary'} disabled={!list.length} onClick={() => void run(confirm)}>{confirm === 'start' ? 'Start all' : 'Stop all'}</Btn>
        <Btn sm kind="ghost" onClick={() => setConfirm(null)}>Cancel</Btn>
      </span>
    )
  }
  return { q, items, up, down, busy, setConfirm, confirmEl }
}

/** nothing serves (and something is listed): the page says so in one line */
export const allStopped = (items: DashView[]) => items.length > 0 && items.every(v => !v.portUp && v.state !== 'starting')

/** one option-B card per market: icon square in the market's hue, name, "n/m up", its rows */
function MarketCard({ g, vs, items, hist, hmissing }: { g: Group; vs: DashView[]; items: DashView[]; hist: Map<string, DashHistory>; hmissing: string }) {
  const [shut, setShut] = useStored<string[]>('dash.mainFolded', [])
  const closed = shut.includes(g.id)
  const up = vs.filter(v => v.portUp).length
  const port = cardPort(vs)
  // the header chip copies a serving row's URL when one serves, else the first row's
  const portV = port === null ? null : (vs.find(v => v.portUp) ?? vs[0])
  const worst = vs.some(v => v.state === 'failing') ? 'fail' : vs.some(v => v.state === 'stale') ? 'warn' : null
  const ref = useRef<HTMLDivElement>(null)
  const [flash, setFlash] = useState(0)
  useEffect(() => {
    // the explorer index asks for this card: unfold it, bring it into view, flash its edge once
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== g.id) return
      if (closed) setShut(shut.filter(x => x !== g.id))
      ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      setFlash(n => n + 1)
    }
    window.addEventListener(REVEAL, on)
    return () => window.removeEventListener(REVEAL, on)
  }, [g.id, closed, shut, setShut])
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(0), 1000); return () => clearTimeout(t) }, [flash])
  return (
    <div ref={ref} className={`dash-cardw ${flash ? 'flash' : ''}`}>
    <CardGroup abbr={g.abbr} color={g.color} name={g.name} closed={closed} dim={!up}
      onToggle={() => setShut(closed ? shut.filter(x => x !== g.id) : [...shut, g.id])}
      right={<>{portV && <PortChip v={portV} />}{worst && <Dot s={worst} title={worst === 'fail' ? 'a dashboard is failing' : 'a dashboard is stale'} />}<span className={`cg-n ${up ? 'on' : ''}`} title={`${up} of ${vs.length} serving`}>{up}/{vs.length} up</span></>}>
      <div className="dash-r dash-cap" aria-hidden="true"><span /><span /><span className="dash-cap-24" title="health over the last 24 clock hours, one cell an hour; the % after it is serving time">24h</span><span /></div>
      {vs.map(v => <Row key={v.id} v={v} items={items} h={hist.get(v.id)} hmissing={hmissing} shared={port} />)}
    </CardGroup>
    </div>
  )
}

/** the dashboards (never a tool or a service) whose LIVE SUMMARY CARDS lead the room, in order */
export const cardsOf = (items: DashView[]) => items.filter(v => v.kind === 'dashboard')

/** THE LIVE SUMMARY CARDS: one per dashboard, three tiles each, read by fundd while its port is up */
function SummaryCards({ items }: { items: DashView[] }) {
  const o = useOpeners()
  const vs = cardsOf(items)
  if (!vs.length) return null
  return (
    <div className="dsc-grid" aria-label="live summary cards">
      {vs.map(v => <SummaryCard key={v.id} id={v.id} name={v.name} summary={v.summary} onOpen={() => o.detail(v.id, v.name)}
        actions={<>
          {v.portUp && <Btn sm kind="primary" onClick={() => { window.open(v.open, '_blank', 'noopener') }} title={`open ${v.open}`}>Open</Btn>}
          <Controls v={v} items={items} />
        </>} />)}
    </div>
  )
}

function Main() {
  const q = useDash()
  const hq = useHistory()
  const hist = new Map((hq.data?.items ?? []).map(x => [x.id, x]))
  const hmissing = hq.error ? 'history failed' : hq.data ? 'no history' : ''
  return (
    <div className="main-pad dash-main">
      <Load q={q} skel="cg" empty={d => d.items.length === 0}>{d => <>
        <SummaryCards items={d.items} />
        <div className="dash-cards">{groupsOf(d.items).map(([g, vs]) => <MarketCard key={g.id} g={g} vs={vs} items={d.items} hist={hist} hmissing={hmissing} />)}</div>
      </>}</Load>
    </div>
  )
}

function Head() {
  const a = useAll()
  if (a.confirmEl) return a.confirmEl
  const stopped = allStopped(a.items)
  return <>
    {stopped && <Pill out tone="clear" title="nothing serves; Start all is a click, never automatic">all stopped</Pill>}
    <Btn sm kind={stopped ? 'primary' : undefined} disabled={a.busy || !a.down.length} onClick={() => a.setConfirm('start')} title={a.down.length ? undefined : 'nothing startable from the cockpit'}>Start all</Btn>
    <Btn sm disabled={a.busy || !a.up.length} onClick={() => a.setConfirm('stop')}>Stop all</Btn>
  </>
}

// MARKET colours (styles.css --crypto / --tradfi / --predmkts / --mk-all / --mk-tools): their own
// hues, never an agent's category colour nor a state colour, so "all" never reads as the
// Dashboards agent and "tradfi" never as Research
const DASH_C = 'var(--mk-all)'
const TOOL_C = 'var(--mk-tools)'
type Group = { id: string; name: string; abbr: string; color: string }
const GROUPS: Group[] = [
  { id: 'crypto', name: 'Crypto', abbr: 'CR', color: 'var(--crypto)' },
  { id: 'tradfi', name: 'TradFi', abbr: 'TF', color: 'var(--tradfi)' },
  { id: 'predmkts', name: 'Prediction', abbr: 'PM', color: 'var(--predmkts)' },
  { id: 'all', name: 'All', abbr: 'AL', color: DASH_C },
]
const OTHER: Group = { id: 'other', name: 'Other', abbr: 'OT', color: DASH_C }
const TOOLS: Group = { id: 'tools', name: 'Tools', abbr: 'TL', color: TOOL_C }

/** the cards in order: each market that has a dashboard, any with no known market, then the tools */
export function groupsOf(items: DashView[]): [Group, DashView[]][] {
  const dashes = items.filter(x => x.kind !== 'tool')
  const out: [Group, DashView[]][] = GROUPS.map(g => [g, dashes.filter(v => v.market === g.id)])
  out.push([OTHER, dashes.filter(v => !GROUPS.some(g => g.id === v.market))])
  out.push([TOOLS, items.filter(x => x.kind === 'tool')])
  return out.filter(([, vs]) => vs.length > 0)
}

/** the explorer asks the main pane for a card by group id (window event: the two panes share a page) */
const REVEAL = 'dash:reveal'

/** THE EXPLORER INDEX: the dashboards themselves live in the main pane only; here one row per
 *  group - its colour square, name, n/m up and its last 6 hours (the worst hour across the group),
 *  a click scrolls the main pane to that card */
function Explorer() {
  const q = useDash()
  const hq = useHistory()
  if (!q.data) return q.error ? <Empty inline state="failed">{q.error}</Empty> : <Empty state="loading" skel="cg" />
  const hist = new Map((hq.data?.items ?? []).map(x => [x.id, x]))
  return <div className="cg-list dash-ix">
    {groupsOf(q.data.items).map(([g, vs]) => {
      const up = vs.filter(v => v.portUp).length
      const hs = vs.map(v => hist.get(v.id)).filter((h): h is DashHistory => !!h)
      const cells = groupHeat(hs, 6)
      const why = hq.error ? 'history failed' : hq.data ? 'no check in this hour' : 'loading'
      const h0 = hq.data?.items[0]
      const at = (i: number) => h0 ? `${new Date(h0.from + (h0.cells.length - 6 + i) * h0.bucketMs).toISOString().slice(11, 16)}Z  ` : ''
      const worst = vs.some(v => v.state === 'failing') ? 'fail' : vs.some(v => v.state === 'stale') ? 'warn' : null
      return (
        <CardGroup key={g.id} index abbr={g.abbr} color={g.color} name={g.name} dim={!up} title={`${g.name}: ${vs.map(v => v.name).join(', ')}`}
          role={<span className={up ? 't-ok' : ''} title={`${up} of ${vs.length} serving`}>{up}/{vs.length} up</span>}
          onPick={() => window.dispatchEvent(new CustomEvent(REVEAL, { detail: g.id }))}
          right={<>{worst && <Dot s={worst} title={worst === 'fail' ? 'a dashboard is failing' : 'a dashboard is stale'} />}
            <HeatStrip label={`${g.name}: the last 6 hours, the worst hour across its dashboards`}
              cells={cells.map((c, i) => ({ cls: `hc-${c ?? (hq.error ? 'unknown' : 'none')}`, title: `${at(i)}${c ?? why}` }))} /></>} />
      )
    })}
    {(q.data.problems ?? []).map(p => <FailLine key={`${p.path}|${p.error}`} what={p.path.replace(/^platform\/dashboards\/?/, '') || 'registry'} detail={`${p.path}: ${p.error}`} />)}
  </div>
}

function DetailHistory({ id }: { id: string }) {
  const hq = useHistory()
  const h = hq.data?.items.find(x => x.id === id)
  return <>
    <div className="grp dash-grp"><span title={h ? summaryTitle(h) : undefined}>24h</span><span className="dash-lc">{h ? <Uptime h={h} /> : ''}</span></div>
    {hq.error ? <Empty inline state="failed">{`history: ${hq.error}`}</Empty>
      : !h ? (hq.data ? <Empty inline title="NO HISTORY" /> : <Empty inline state="loading" />)
      : <div className="dash-hist-big"><Heat h={h} big /><div className="dash-axis mono faint"><span>{new Date(h.from).toISOString().slice(11, 16)}Z</span><span>now</span></div></div>}
  </>
}

/** a check target without what the check column already says: "http://127.0.0.1:8791/api/health" -> "/api/health" */
export function shortTarget(t: string): string {
  const m = /^[a-z]+:\/\/[^/]+(\/.*)?$/i.exec(t)
  if (m) return m[1] || '/'
  if (/^\d+$/.test(t)) return `:${t}`
  return t.replace(/^(127\.0\.0\.1|localhost)(?=:)/, '')
}

function DashDetail({ id }: { id: string }) {
  const q = useApi<Detail>(`/api/dash/${id}`, ['dash'])
  const all = useApi<{ items: DashView[] }>('/api/dash', ['dash'])
  const o = useOpeners()
  const { busy, act } = useActions()
  return (
    <Load q={q} skel="lines">{v => (
      <div className="dash-detail">
        <div className="dash-detail-top">
          <StateCell v={v} />
          <MarketTag m={v.market} />
          {v.owner === 'adopted' && <Tag>adopted</Tag>}
          {v.key !== v.id && <Tag>{`shared: ${v.key}`}</Tag>}
          {v.on_fail === 'wake_agent' && <span title={`a new failure starts a conversation with ${v.agent} (at most once per 6h)`}><Tag tone="accent">wakes agent</Tag></span>}
          <span className="mono faint">{v.pid ? `pid ${v.pid}` : ''}</span>
        </div>
        <div className="dash-detail-acts">
          <Btn sm kind="primary" disabled={!v.portUp} onClick={() => window.open(v.open, '_blank', 'noopener')}>Open</Btn>
          <Controls v={v} items={all.data?.items} />
          <Btn sm disabled={!!busy} onClick={() => void act(v.id, 'check')}>Check</Btn>
          <Btn sm onClick={() => o.logs(v)}>Logs</Btn>
          <Btn sm onClick={() => void o.agent(v)} title={`talk to ${v.agent}`}>Agent</Btn>
        </div>
        <DetailHistory id={v.id} />
        <div className="grp dash-grp"><span>Checks</span><span title="how often the checks run">every {v.every}</span></div>
        <table className="tbl">
          <thead><tr><th>Check</th><th>Target</th><th>Reading</th><th>When</th></tr></thead>
          <tbody>{v.checks.map(c => (
            <tr key={c.id}>
              <td><span className="dash-state"><Dot s={v.state === 'stopped' && c.status === 'fail' && (c.check === 'port' || c.check === 'http') ? 'off' : c.status} /><span>{c.id}</span></span></td>
              <td className="mono faint dash-target" title={`${c.check} ${c.target}`}>{shortTarget(c.target)}</td>
              <td className="mono">{c.reading || '-'}</td>
              <td className="mono faint">{relTime(c.ts)}</td>
            </tr>
          ))}</tbody>
        </table>
        <div className="grp dash-grp"><span>Command</span></div>
        <div className="pre dash-cmd">{v.start ? <>{v.start.cmd}<span className="faint"> (cwd {v.start.cwd})</span></> : <span className="faint">none declared</span>}</div>
        {v.start_dev && <div className="pre dash-cmd"><span className="faint">dev </span>{v.start_dev.cmd}</div>}
        {v.sharedWith.length > 0 && <div className="faint dash-shared">{v.key} also serves {v.sharedWith.map(x => nameOf(all.data?.items, x)).join(', ')}</div>}
        <div className="grp dash-grp"><span>Runs</span></div>
        {v.runs.length === 0 ? <Empty inline title="NONE">from the cockpit</Empty> : (
          <table className="tbl">
            <thead><tr><th className="dash-rdot" /><th>Started</th><th>Mode</th><th>Pid</th><th>Stopped</th><th>Exit</th></tr></thead>
            <tbody>{v.runs.map(r => (
              <tr key={r.id}>
                <td className="dash-rdot">{r.stopped_at ? <Dot s="off" title="stopped" /> : <Dot s="ok" title="still running" />}</td>
                <td className="mono" title={new Date(r.started_at).toISOString()}>{relTime(r.started_at)}</td>
                <td className="mono">{r.mode}</td>
                <td className="mono">{r.pid ?? '-'}</td>
                <td className="mono faint">{r.stopped_at ? relTime(r.stopped_at) : '-'}</td>
                <td className="mono faint">{r.exit_code ?? '-'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    )}</Load>
  )
}

export const room: RoomDef = {
  id: 'dash',
  label: 'Dash',
  title: 'Dashboards',
  icon: <><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M7 15l3-4 3 2 4-5"/></>,
  Explorer,
  Main,
  Head,
  useBadge: () => {
    const q = useApi<{ items: DashView[] }>('/api/dash', ['dash'])
    const n = q.data?.items.filter(v => v.state === 'failing').length ?? 0
    return n ? { n, tone: 'fail' } : null
  },
  palette: async (): Promise<PaletteItem[]> => {
    const d = await api<{ items: DashView[] }>('/api/dash')
    return d.items.flatMap(v => [
      { kind: 'dash', agent: v.agent, label: `open ${v.name}`, hint: v.open, run: () => { window.open(v.open, '_blank', 'noopener') } },
      ...(v.canStart && !v.portUp ? [{ kind: 'dash', agent: v.agent, label: `start ${v.name}`, hint: v.port ? `:${v.port}` : undefined, run: () => { void api(`/api/dash/${v.id}/start`, { body: {} }).catch(() => null) } }] : []),
    ])
  },
}
