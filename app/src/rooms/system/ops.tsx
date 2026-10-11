import { useState, type CSSProperties } from 'react'
import { Btn, Dot, Empty, HeatBlank, Icon, Load, Meter, Tag } from '../../ui/kit.tsx'
import { api, relTime, stamp, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { agentColor, categoryOf, isKnownAgent } from '../../ui/categories.ts'
import { handsLine, type HandsView } from './hands.ts'

// OPS views of the System room: backups, the 30-day spend chart, the phone bridge.

export const tok = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`

// ---------- hands ----------
/** the dim line under Health: the agent processes fundd holds (server/system/hands.ts) */
export function HandsLine() {
  const q = useApi<HandsView>('/api/system/hands', ['system', 'chat'])
  if (q.error) return <div className="system-orphans faint" title={q.error}>hands failed</div>
  if (!q.data) return <div className="system-orphans faint">hands: loading</div>
  const l = handsLine(q.data)
  return <div className="system-orphans faint" title={l.title}>{l.text}</div>
}

// ---------- backups ----------
export type BackupFile = { file: string; day: string; bytes: number; mtime: number }
export type Backups = {
  dir: string; keep: number; files: BackupFile[]; status: string; reading: string; running: boolean
  job: { id: string; cadence: string; enabled: boolean } | null
  lastJob: { status: string; start: number | null; end: number | null; detail: string | null } | null
  lastManual: { at: number; result?: { file: string; bytes: number; method: string; tookMs: number }; error?: string } | null
}
export const useBackups = () => useApi<Backups>('/api/system/backups', ['system'])
export type Mode = { mode: 'dev' | 'prod'; pid: number; dataDir: string; db: string }
export const useMode = () => useApi<Mode>('/api/system/mode', [])

/** the Backups line of the Health table */
/** `q`: the Health view's own backups query, so the row and the lead/ok split read one answer */
export function BackupsRow({ q }: { q: ReturnType<typeof useBackups> }) {
  const { openDrawer } = useNav()
  const b = q.data
  // the owner is a 3px category-coloured left edge (app); its name rides in the row's title
  const edge = { '--c': categoryOf('app').color } as CSSProperties
  const own = 'owner app (the cockpit database)'
  if (!b) return <tr title={own}><td className="system-edge" style={edge}><Dot s="unknown" /></td><td className="mono">backups</td><td className="system-rd">{q.error ? `failed: ${q.error}` : ''}</td><td className="system-heat-td"><HeatBlank state="unknown" why={q.error ? `backups failed: ${q.error}` : 'loading'} /></td><td /><td /></tr>
  const newest = b.files[0]
  const jobNote = !b.job ? 'no db-backup job in schedule.json' : !b.job.enabled ? 'db-backup job is off' : b.job.cadence
  return <tr className="click" title={own} onClick={() => openDrawer({ title: 'backups', body: <BackupsBody /> })}>
    <td className="system-edge" style={edge}><Dot s={b.running ? 'run' : b.status} title={b.status === 'warn' ? 'newest copy older than 36h' : b.status} /></td>
    <td className="mono">backups</td>
    <td className="system-rd" title={`${b.reading}\n${b.dir}\n${jobNote}`}>{newest ? <>{b.files.length} · {mb(newest.bytes)}</> : b.reading}{!b.job && <> <Tag tone="warn">no job</Tag></>}</td>
    <td className="system-heat-td"><HeatBlank why="backups: no hourly reading is recorded (it is not a floor probe)" /></td>
    <td className={`num ${b.status === 'warn' ? 't-warn' : 'faint'}`} title={newest ? stamp(newest.mtime) : 'never'}>{newest ? relTime(newest.mtime).replace(/^in /, '').replace(/ ago$/, '') : '-'}</td>
    <td className="num faint" title={jobNote}>{b.job?.enabled ? '1d' : '-'}</td>
  </tr>
}

function BackupsBody() {
  const q = useBackups()
  const { toast } = useNav()
  const [busy, setBusy] = useState(false)
  const now = async () => {
    setBusy(true)
    try { const r = await api('/api/system/backups/run', { body: {} }); toast(`backup ${r.file}: ${mb(r.bytes)}`) } catch (e: any) { toast(`backup: ${e.message}`, true) } finally { setBusy(false) }
  }
  return <Load q={q}>{b => <>
    <div className="system-ops-bar">
      <Btn sm kind="primary" disabled={busy || b.running} title="pg_dump of the ops store now, checked with pg_restore --list (replaces today's copy)" onClick={now}>{busy || b.running ? 'backing up' : 'Back up now'}</Btn>
      <span className="faint mono">keep {b.keep}</span>
    </div>
    <table className="kv"><tbody>
      <tr><td>dir</td><td className="mono">{b.dir}</td></tr>
      <tr><td>job</td><td className="mono">{b.job ? `${b.job.id} · ${b.job.cadence}${b.job.enabled ? '' : ' · off'}` : <span className="t-warn">not in schedule.json</span>}</td></tr>
      {b.lastJob && <tr><td>last job</td><td className="mono">{b.lastJob.status} · {b.lastJob.start ? relTime(b.lastJob.start) : '-'}{b.lastJob.detail ? ` · ${b.lastJob.detail}` : ''}</td></tr>}
      {b.lastManual && <tr><td>last manual</td><td className={`mono ${b.lastManual.error ? 't-fail' : ''}`}>{relTime(b.lastManual.at)} · {b.lastManual.error ?? `${b.lastManual.result!.method} · ${b.lastManual.result!.tookMs} ms`}</td></tr>}
    </tbody></table>
    {b.files.length === 0 ? <Empty>no backup yet</Empty> : <table className="tbl dense system-tbl">
      <thead><tr><th>File</th><th className="num">Size</th><th className="num">Written</th></tr></thead>
      <tbody>{b.files.map(f => <tr key={f.file}><td className="mono">{f.file}</td><td className="num">{mb(f.bytes)}</td><td className="num faint" title={stamp(f.mtime)}>{relTime(f.mtime)}</td></tr>)}</tbody>
    </table>}
  </>}</Load>
}

// ---------- spend chart ----------
export type Daily = {
  metric: string; today: string; costUsd: number
  series: { days: string[]; agents: string[]; cells: number[][]; totals: number[]; max: number }
  todayBy: { agent: string; billable: number; ceiling: number | null; capped?: boolean; lifted?: boolean; alerts?: BurnAlert[] }[]
  slots: Record<string, number>
}
/** an agent's colour is its category's (src/ui/categories.ts), the dashboards one shade each of the
 *  dashboards family, an id no category claims neutral: the same colours every other room shows */
export function colorOf(d: Daily, a: string): string {
  return agentColor(a, [...d.series.agents, ...d.todayBy.map(r => r.agent)])
}

/** the name an agent carries everywhere else ("dash:preds" -> "Prediction Spreads"); the id rides in the tooltip */
export function useAgentNames(): (id: string) => string {
  const q = useApi<{ agents: { id: string; name: string }[] }>('/api/system/agents', ['config'])
  const m = new Map((q.data?.agents ?? []).map(a => [a.id, a.name]))
  // a seat shared by several agents ("dash:trade+dash:datactl") reads as their names joined
  return (id: string) => m.get(id) ?? (id.includes('+') ? id.split('+').map(x => m.get(x) ?? x).join(' + ') : id)
}

const DAYS = 14

function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const m = [1, 2, 2.5, 5, 10].find(x => x * p >= v)!
  return m * p
}

/** the chart's own window: the last DAYS days, and what the cockpit's usage table billed across them */
export function spendWindow(d: Daily) {
  const days = d.series.days.slice(-DAYS)
  return { days, from: days[0] ?? '', to: days[days.length - 1] ?? '', total: d.series.totals.slice(-DAYS).reduce((s, v) => s + v, 0) }
}

export function SpendChart({ d }: { d: Daily }) {
  const [hover, setHover] = useState<number | null>(null)
  const name = useAgentNames()
  // a fixed 14-day axis ending today: a day with no usage is a zero tick, so one day of data is one bar in its place
  const days = d.series.days.slice(-DAYS), cells = d.series.cells.slice(-DAYS), totals = d.series.totals.slice(-DAYS)
  const { agents } = d.series
  const W = 900, H = 200, L = 44, R = 8, T = 8, B = 22
  const top = niceMax(Math.max(0, ...totals))   // the 14 days drawn, not the 30 the series holds
  const pw = W - L - R, ph = H - T - B
  const slot = pw / Math.max(DAYS, days.length)
  const bw = Math.min(24, Math.max(4, slot - 6))
  const y = (v: number) => T + ph - (v / top) * ph
  const ticks = [0, top / 2, top]
  const hi = hover
  // the legend sums the same 14 days the bars show. Agents past the named slots share one colour on
  // the bars, so they share ONE legend entry ("other"), never several entries in one colour
  const sumOf = (a: string) => cells.reduce((s, c) => s + c[agents.indexOf(a)], 0)
  // ids no category claims share the neutral mark, so they share ONE legend entry ("other")
  const sharedN = agents.filter(a => !isKnownAgent(a)).length
  const legend: { key: string; label: string; ids: string[]; sum: number; color: string }[] = []
  for (const a of agents) {
    if (sharedN > 1 && !isKnownAgent(a)) {
      const o = legend.find(g => g.key === '~other')
      if (o) { o.ids.push(a); o.sum += sumOf(a) } else legend.push({ key: '~other', label: 'other', ids: [a], sum: sumOf(a), color: colorOf(d, a) })
    } else legend.push({ key: a, label: name(a), ids: [a], sum: sumOf(a), color: colorOf(d, a) })
  }
  for (const g of legend) if (g.key === '~other') { g.label = `other ${g.ids.length}`; g.ids = g.ids.map(name) }
  legend.sort((x, y) => y.sum - x.sum)
  return <div className="system-chart">
    {/* balanced rows: never one entry alone on a second line (at most 7 a row, rows evened out) */}
    <div className="system-legend" style={{ gridTemplateColumns: `repeat(${Math.ceil(legend.length / Math.ceil(legend.length / 7)) || 1}, auto)` }}>
      {legend.map(g => <span key={g.key} className="system-lg" title={`${g.ids.join(', ')}${NL}${tok(g.sum)} billable, ${days[0]} to ${days[days.length - 1]}`}><i style={{ background: g.color }} /><span className="system-agent">{g.label}</span><b>{tok(g.sum)}</b></span>)}
    </div>
    <div className="system-plot">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`billable tokens per day per agent, ${days[0]} to ${days[days.length - 1]}`} onMouseLeave={() => setHover(null)}>
        {ticks.map(t => <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'system-axis' : 'system-grid'} />
          <text x={L - 6} y={y(t) + 3} textAnchor="end" className="system-tick">{tok(t)}</text>
        </g>)}
        {days.map((day, i) => {
          const x = L + i * slot + (slot - bw) / 2
          let acc = 0
          return <g key={day} onMouseEnter={() => setHover(i)}>
            <rect x={L + i * slot} y={T} width={slot} height={ph} className={`system-hit ${hover === i ? 'on' : ''}`} />
            {agents.map((a, j) => {
              const v = cells[i][j]
              if (!v) return null
              const y1 = y(acc + v), h = y(acc) - y1
              acc += v
              return <rect key={a} x={x} y={y1} width={bw} height={Math.max(0, h - (acc === totals[i] ? 0 : 2))} fill={colorOf(d, a)} rx={acc === totals[i] ? 2 : 0} />
            })}
            {!totals[i] && <line x1={x} x2={x + bw} y1={y(0) - 0.5} y2={y(0) - 0.5} className="system-zero" />}
            {(days.length - 1 - i) % 2 === 0
              ? <text x={L + i * slot + slot / 2} y={H - 6} textAnchor="middle" className="system-tick">{day.slice(5)}</text> : null}
          </g>
        })}
      </svg>
      {hi !== null && <div className="system-tip" style={{ left: `${Math.min(100 - 22, ((L + (hi + 1) * slot + 8) / W) * 100)}%` }}>
        <div className="mono">{days[hi]}{hi === days.length - 1 ? ' · today' : ''}</div>
        {totals[hi] === 0 ? <div className="faint">no usage</div> : agents.map((a, j) => cells[hi][j] ? <div key={a} className="system-tip-r"><i style={{ background: colorOf(d, a) }} /><span>{name(a)}</span><b title={cells[hi][j].toLocaleString()}>{tok(cells[hi][j])}</b></div> : null)}
        {totals[hi] > 0 && <div className="system-tip-r system-tip-t"><i /><span>total</span><b title={totals[hi].toLocaleString()}>{tok(totals[hi])}</b></div>}
      </div>}
    </div>
  </div>
}

export type BurnAlert = { ts: number; billable: number; median: number; multiple: number | null }

/** a 14px stroke glyph this room draws itself (the kit has no bell) */
export function SysIcon({ d, title, tone }: { d: string; title?: string; tone?: string }) {
  return <svg className={`ico ${tone ?? ''}`} viewBox="0 0 16 16" aria-label={title} role={title ? 'img' : undefined}>{title && <title>{title}</title>}<path d={d} /></svg>
}
export const BELL = 'M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.8 14a1.3 1.3 0 0 0 2.4 0'

const NL = String.fromCharCode(10)
const hhmm =(t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** the cap cell: a thin fill (dim, amber from 80%, red at the cap), a lock when capped (click lifts), a bell per burn alert */
export function CapCell({ agent, used, ceiling, capped, lifted, alerts }: { agent: string; used: number; ceiling: number | null; capped: boolean; lifted: boolean; alerts: BurnAlert[] }) {
  const { toast } = useNav()
  const [busy, setBusy] = useState(false)
  const lift = async () => {
    setBusy(true)
    try { await api(`/api/system/cap/${encodeURIComponent(agent)}/lift`, { body: {} }); toast(`${agent}: cap lifted until midnight`) } catch (e: any) { toast(`lift: ${e.message}`, true) } finally { setBusy(false) }
  }
  const pct = ceiling ? used / ceiling : null
  const bell = alerts.length > 0 && <span className="system-bell" title={alerts.map(a => `${hhmm(a.ts)}  ${tok(a.billable)}  ${a.multiple === null ? 'median 0' : `${a.multiple.toFixed(1)}x`}`).join(NL)}><SysIcon d={BELL} tone="warn" /></span>
  if (pct === null) return <span className="system-capc"><span className="nil" title="no budgetTokensPerDay for this agent in its roster file" />{bell}</span>
  return <span className="system-capc">
    <span className={`meter thin system-cap ${pct >= 1 ? 'fail' : pct >= 0.8 ? 'warn' : ''}`} title={`${tok(used)} / ${tok(ceiling!)} today (${Math.round(pct * 100)}%)${lifted ? `${NL}cap lifted until midnight` : ''}`}><i style={{ width: `${Math.min(100, pct * 100)}%` }} /></span>
    {capped ? <button className="system-lock" disabled={busy} title={`capped: ${used.toLocaleString()} / ${ceiling!.toLocaleString()}${NL}click to lift until midnight`} onClick={lift}><Icon name="lock" tone="fail" /></button>
      : lifted ? <span className="system-lock" title="cap lifted until midnight"><Icon name="lock" tone="faint" /></span> : <span className="system-lock" />}
    {bell}
  </span>
}

/** today per agent against its roster ceiling (none written down = none shown, never invented) */
/** today's budget reading (ops.health_readings system:budget), as SpendToday needs it */
export type TreeToday = { total: number | null; bySeat: Record<string, number> | null; over: string[] } | null

// ---------- remote ----------
type Bridge = { repo: string; path: string; allowed: boolean; blocked: string | null; running: boolean; status: string; name: string | null; pid: number | null; url: string | null; sessions: number; capacity: number; error: string | null; since: number | null; tail: string[] }
type RemoteV = { cli: { available: boolean; reason: string | null; version: string | null; bin: string | null }; account: { loggedIn: boolean; plan: string | null } | null; bridges: Bridge[] }
export const useRemote = () => useApi<RemoteV>('/api/system/remote', ['system'])
const TONE: Record<string, string> = { connected: 'ok', connecting: 'run', starting: 'run', error: 'fail', off: 'off' }

/** the CLI version and plan, as tags in the room header while Remote is open */
export function RemoteHead() {
  const q = useRemote()
  const r = q.data
  if (!r?.cli.available) return null
  return <>
    <span title={r.cli.bin ?? ''}><Tag>claude {r.cli.version ?? '?'}</Tag></span>
    {r.account ? r.account.loggedIn ? <span title={`Claude plan: ${r.account.plan ?? 'logged in'}`}><Tag>{r.account.plan ?? 'logged in'}</Tag></span> : <Tag tone="warn">logged out</Tag> : null}
  </>
}

export function RemoteView() {
  const q = useRemote()
  const { toast, openDrawer } = useNav()
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (repo: string, on: boolean) => {
    setBusy(repo)
    try { await api(`/api/system/remote/${on ? 'start' : 'stop'}`, { body: { repo } }); toast(`${repo}: bridge ${on ? 'starting' : 'stopped'}`) } catch (e: any) { toast(`${repo}: ${e.message}`, true) } finally { setBusy(null) }
  }
  return <Load q={q}>{r => {
    if (!r.cli.available) return <Empty state={r.cli.bin ? 'failed' : 'unknown'} title="UNAVAILABLE">{r.cli.reason ?? 'claude remote-control is not available'}</Empty>
    // one compact card per repo: the dot, the name, the action (or the lock that says why not);
    // sessions, link and since only while a bridge runs
    return <div className="system-rgrid">
      {r.bridges.map(b => {
        const s = b.allowed ? TONE[b.status] ?? 'unknown' : 'off'
        return <div key={b.repo} className={`card system-rc ${b.allowed ? '' : 'blocked'} ${b.tail.length ? 'click' : ''}`} title={`${b.path}\n${b.blocked ?? b.error ?? b.status}${b.tail.length ? '\nclick: its output' : ''}`}
          onClick={() => b.tail.length && openDrawer({ title: `remote ${b.repo}`, body: <pre className="pre system-pre">{b.tail.join('\n')}</pre> })}>
          <div className="system-rc-h">
            <Dot s={s} title={b.error ?? b.status} />
            <span className="mono system-rc-nm">{b.repo}</span>
            <span className="sp" />
            <span onClick={e => e.stopPropagation()}>
              {b.running ? <Btn sm kind="danger" disabled={busy === b.repo} title={`stop the bridge (pid ${b.pid ?? '?'})`} onClick={() => act(b.repo, false)}>Stop</Btn>
                : b.allowed ? <Btn sm disabled={busy === b.repo} title={`claude remote-control --name fund-${b.repo} in ${b.path}`} onClick={() => act(b.repo, true)}>Start</Btn>
                : <Icon name="lock" tone="faint" title={b.blocked ?? 'blocked'} />}
            </span>
          </div>
          {(b.running || b.error) && <div className="system-rc-f">
            {b.error ? <span className="t-fail system-rc-err" title={b.error}>{b.error}</span> : <>
              <span className="system-rc-m" title={b.capacity ? `${b.sessions} of ${b.capacity} sessions` : 'capacity not reported'}><Meter v={b.capacity ? b.sessions / b.capacity : null} sm tone="accent" /><span className="mono">{b.capacity ? `${b.sessions}/${b.capacity}` : '-'}</span></span>
              {b.url && <a className="mono" href={b.url} target="_blank" rel="noreferrer" title={b.url} onClick={e => e.stopPropagation()}>open</a>}
              <span className="sp" />
              {b.since && <span className="faint mono" title={stamp(b.since)}>{relTime(b.since).replace(/ ago$/, '')}</span>}
            </>}
          </div>}
        </div>
      })}
    </div>
  }}</Load>
}
