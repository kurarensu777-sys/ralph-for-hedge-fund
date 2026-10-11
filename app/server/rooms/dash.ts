import type { Router } from '../http.ts'
import { HttpError } from '../http.ts'
import type { Dashboard, DashSummaryView, HealthCheck, ServiceGroup, SummaryBody } from '../../shared/types.ts'
import { later, logEvent, ops, settled, transaction } from '../db.ts'
import { publish } from '../events.ts'
import { onSummary } from '../hooks.ts'
import { CONTROLS_FILE, FUND_ROOT, LOG_DIR, PORT } from '../paths.ts'
import { floorStopped } from '../system/floor.ts'
import { readControls } from '../system/controlsfile.ts'
import { readRegistry, config } from '../config.ts'
import { dashStatus, fmtAgeMs, parseEvery, reconcilePort, runCheck, type CheckResult, type DashState } from '../proc/health.ts'
import { logPathFor, startProcess, stopProcess, tailLines } from '../proc/manager.ts'
import { pidAlive, pidOnPort, pidStartTime, portOpen, waitPort } from '../proc/ports.ts'
import { shouldWake, wakeHeld, wakePrompt, wakeTitle } from '../proc/wake.ts'
import { summarizeHours, type HistRow } from '../proc/history.ts'
import { readSummary, summaryEveryMs, type SummaryReading } from '../proc/summary.ts'

// ROOM: dash - a LAUNCHER. The cockpit never embeds a dashboard: it starts, stops,
// health-checks and opens them in the browser. Routes under /api/dash/.

type Reading = CheckResult & { ts: number }
type ProcRow = { id: number; dashboard_id: string; mode: string; pid: number | null; port: number | null; cmd: string; started_at: number; stopped_at: number | null; exit_code: number | null; log_path: string | null }

export type DashCheck = { id: string; check: string; target: string; status: CheckResult['status']; reading: string; ts: number | null }
export type DashView = {
  id: string; name: string; market: string; agent: string; kind: NonNullable<Dashboard['kind']>; open: string
  key: string                    // the process key: start.shared or the dashboard id
  sharedWith: string[]           // other dashboards riding the same server
  port: number | null
  portUp: boolean
  state: DashState | 'starting'
  measured: boolean
  owner: 'ours' | 'adopted' | null
  pid: number | null
  mode: 'prod' | 'dev' | null
  since: number | null           // process start (ms), null when unknown
  health: { ok: number; total: number; failing: string[]; warning: string[] }
  checks: DashCheck[]
  canStart: boolean; canDev: boolean
  every: string
  lastCheck: number | null
  summary: DashSummaryView       // the live summary card: state none when it declares no summary
}

const dashboards = () => config.dashboards()
const byId = (id: string) => {
  const d = dashboards().find(x => x.id === id)
  if (!d) throw new HttpError(404, `no dashboard ${id}`)
  return d
}
const keyOf = (d: Dashboard) => d.start?.shared ?? d.id
const devKey = (d: Dashboard) => `${d.id}.dev`
const portOf = (d: Dashboard): number | null => d.start?.port ?? (d.health.find(h => h.check === 'port') as { port: number } | undefined)?.port ?? null
const probeId = (d: Dashboard, c: HealthCheck) => `dash:${d.id}/${c.id}`
const target = (c: HealthCheck) => c.check === 'port' ? `:${c.port}` : c.check === 'http' ? c.url : c.path

// ---- health readings: memory first, database as the record ----
const readings = new Map<string, Reading>()
const lastRun = new Map<string, number>()
let loaded: Promise<void> | null = null
/** once per process: each dashboard check's newest reading from the record (a reading taken since stays) */
function loadReadings(): Promise<void> {
  loaded ??= (async () => {
    try {
      for (const r of await ops.latestHealth({ target: 'dashboard' })) {
        if (readings.has(r.probe_id)) continue
        // detail_json is jsonb (an object); a text row from before still parses
        let detail: any
        try { detail = typeof r.detail_json === 'string' ? JSON.parse(r.detail_json) : (r.detail_json ?? undefined) } catch { detail = undefined }
        readings.set(r.probe_id, { status: r.status as Reading['status'], reading: r.reading ?? '', ts: r.ts, detail })
      }
      // each card's newest reading from the record, and the newest VALID body it carried: what a
      // card last said survives a daemon restart (shown as last seen, never as current)
      for (const r of await ops.latestHealth({ target: SUMMARY_TARGET })) {
        const id = /^dash:([^/]+)\/summary$/.exec(r.probe_id)?.[1]
        if (!id || summaries.has(id)) continue
        let detail: any
        try { detail = typeof r.detail_json === 'string' ? JSON.parse(r.detail_json) : r.detail_json } catch { detail = null }
        const last = detail?.last && typeof detail?.last_read_at === 'number' ? { body: detail.last as SummaryBody, readAt: detail.last_read_at as number } : undefined
        const reading: SummaryReading = r.status !== 'unknown' && detail?.body ? { status: 'ok', body: detail.body, ts: r.ts } : { status: 'unknown', reason: r.reading ?? 'unknown', ts: r.ts }
        summaries.set(id, { reading, last })
      }
    } catch (e) { loaded = null; console.error('[dash] readings not loaded:', (e as Error).message) }
  })()
  return loaded
}

const lastState = new Map<string, string>()
/** the pause before the one re-run of an http check that timed out right after a start */
export const START_RETRY_MS = 5000
/** `afterStart`: the port has only just opened and an app is often still loading, so an http check
 *  that TIMED OUT (not one that was refused or answered badly) is run once more after START_RETRY_MS
 *  and the second answer is the verdict; otherwise it would stand until the next scheduled pass */
export async function checkDashboard(d: Dashboard, opts: { afterStart?: boolean; retryMs?: number; httpTimeoutMs?: number } = {}): Promise<void> {
  const ts = Date.now()
  const runAll = () => Promise.all(d.health.map(c => runCheck(c, { fundRoot: FUND_ROOT, httpTimeoutMs: opts.httpTimeoutMs })))
  let raw = await runAll()
  if (opts.afterStart && d.health.some((c, i) => c.check === 'http' && raw[i].status === 'fail' && raw[i].reading === 'timeout')) {
    await new Promise(r => setTimeout(r, opts.retryMs ?? START_RETRY_MS))
    raw = await runAll()
  }
  const results = reconcilePort(d.health, raw)
  d.health.forEach((c, i) => readings.set(probeId(d, c), { ...results[i], ts }))
  await transaction(async q => {
    for (const [i, c] of d.health.entries()) {
      const r = results[i]
      await ops.recordHealth(probeId(d, c), 'dashboard', r.status, { reading: r.reading, detail: r.detail ?? undefined, ts }, q)
    }
  })
  lastRun.set(d.id, ts)
  await pollSummary(d).catch(() => false)
  const v = await view(d)
  const prev = lastState.get(d.id)
  lastState.set(d.id, v.state)
  if (prev !== undefined && prev !== v.state && v.state === 'failing' && d.on_fail) {
    logEvent('health', `${d.name} failing: ${v.health.failing.join(', ')}`, { payload: { dashboard: d.id } })
  }
  const w = { prev, next: v.state, onFail: d.on_fail, lastWake: await lastWake(d.id), now: ts }
  if (shouldWake(w)) {
    const held = wakeHeld(floorStopped(), readControls(CONTROLS_FILE).wakes)
    if (held) logEvent('health', `wake held: ${held} - ${d.name} failing, ${d.agent} not woken`, { agent: d.agent, payload: { dashboard: d.id } })
    else void wake(d, v)
  }
}


// ---- on_fail: wake_agent. The record (events, kind 'wake') is the debounce, so a daemon restart
// does not re-wake an agent inside the window ----
async function lastWake(id: string): Promise<number | null> {
  try {
    await settled()
    return await ops.lastEventTs('wake', 'dashboard', id)
  } catch { return null }
}

async function wake(d: Dashboard, v: DashView) {
  // written first: a slow or failed POST must not let the next check wake it again
  logEvent('wake', `${d.name} failing - waking ${d.agent}`, { agent: d.agent, payload: { dashboard: d.id, checks: v.health.failing } })
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chats`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: d.agent, prompt: wakePrompt(d.name, v.checks), title: wakeTitle(d.name) }),
    })
    const j: any = await res.json().catch(() => null)
    if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`)
    logEvent('health', `${d.agent} woken for ${d.name}`, { agent: d.agent, conversation: j?.id ?? undefined, payload: { dashboard: d.id } })
  } catch (e) {
    logEvent('health', `could not wake ${d.agent} for ${d.name}: ${(e as Error).message ?? e}`, { agent: d.agent, payload: { dashboard: d.id } })
  }
  publish('dash')
}

// ---- process state ----
const starting = new Map<string, number>()      // key -> started ms, while the port is not up yet
const portCache = new Map<number, { up: boolean; ts: number }>()
const adoptCache = new Map<number, { pid: number | null; ts: number }>()

async function portUp(port: number, maxAgeMs = 3000): Promise<boolean> {
  const c = portCache.get(port)
  if (c && Date.now() - c.ts < maxAgeMs) return c.up
  const up = await portOpen(port, '127.0.0.1', 800)
  portCache.set(port, { up, ts: Date.now() })
  return up
}

async function listener(port: number): Promise<number | null> {
  const c = adoptCache.get(port)
  if (c && Date.now() - c.ts < 30_000) return c.pid
  const pid = await pidOnPort(port)
  adoptCache.set(port, { pid, ts: Date.now() })
  return pid
}

async function openRows(key: string): Promise<ProcRow[]> {
  await settled()
  return ops.select('processes', { where: { dashboard_id: key, stopped_at: null }, orderBy: ['-started_at', '-id'] })
}
/** close a row once: a second close (the exit event after a stop) keeps the first stop and code.
 *  Queued: an exit event calls it synchronously */
function closeRow(id: number, code: number | null = null) {
  const at = Date.now()
  return later('process close', () => ops.closeProcessOnce(id, { exitCode: code, stoppedAt: at }))
}

export async function view(d: Dashboard): Promise<DashView> {
  await loadReadings()
  const key = keyOf(d)
  const port = portOf(d)
  const up = port ? await portUp(port) : false
  const devPort = d.start_dev?.port ?? null
  const devUp = devPort ? (devPort === port ? false : await portUp(devPort)) : false
  const rows = [...await openRows(key), ...(d.start_dev ? await openRows(devKey(d)) : [])]
  for (const r of rows) if (!pidAlive(r.pid) && !starting.has(r.dashboard_id)) void closeRow(r.id)
  const devRow = rows.find(r => r.mode === 'dev' && pidAlive(r.pid))
  const prodRow = rows.find(r => r.mode === 'prod' && pidAlive(r.pid))
  const isDev = !!devRow && (devUp || (devPort === port && up))

  let owner: DashView['owner'] = null
  let pid: number | null = null
  let since: number | null = null
  let mode: DashView['mode'] = null
  if (isDev) { owner = 'ours'; pid = devRow!.pid; since = devRow!.started_at; mode = 'dev' }
  else if (up && prodRow) { owner = 'ours'; pid = prodRow.pid; since = prodRow.started_at; mode = 'prod' }
  else if (up && port) {
    owner = 'adopted'; mode = 'prod'
    pid = await listener(port)
    since = pid ? await pidStartTime(pid) : null
  }

  const checks: DashCheck[] = d.health.map(c => {
    const r = readings.get(probeId(d, c))
    return { id: c.id, check: c.check, target: target(c), status: r?.status ?? 'unknown', reading: r?.reading ?? '', ts: r?.ts ?? null }
  })
  const st = dashStatus(up || isDev, checks.map(c => c.status), isDev)
  const t0 = starting.get(key)
  const isStarting = !up && !isDev && t0 !== undefined && Date.now() - t0 < 90_000
  return {
    id: d.id, name: d.name, market: d.market, agent: d.agent, kind: d.kind ?? 'dashboard', open: d.open,
    key, sharedWith: d.start?.shared ? dashboards().filter(x => x.id !== d.id && x.start?.shared === d.start!.shared).map(x => x.id) : [],
    port, portUp: up || isDev, state: isStarting ? 'starting' : st.state, measured: st.measured,
    owner, pid, mode, since,
    health: {
      ok: checks.filter(c => c.status === 'ok').length, total: checks.length,
      failing: checks.filter(c => c.status === 'fail').map(c => c.id),
      warning: checks.filter(c => c.status === 'warn').map(c => c.id),
    },
    checks,
    canStart: !!d.start, canDev: !!d.start_dev,
    every: d.every ?? '15m',
    lastCheck: lastRun.get(d.id) ?? (checks.reduce<number | null>((m, c) => (c.ts && (!m || c.ts > m) ? c.ts : m), null)),
    summary: summaryView(d, up || isDev),
  }
}

// ---- the LIVE SUMMARY CARD: a dashboard's `summary {url, every}`, read only while its port is up ----
// The contract is server/proc/summary.ts (mirrored from platform/dashboards/registry.py). Each poll
// is a reading of `dash:<id>/summary` in health_readings under its OWN target, so the checks' health
// history (target dashboard) never counts a card read as a check pass.
export const SUMMARY_TARGET = 'summary'
type SummaryState = { reading: SummaryReading | null; last?: { body: SummaryBody; readAt: number } }
const summaries = new Map<string, SummaryState>()
const summaryPolled = new Map<string, number>()
const summaryBusy = new Set<string>()

/** what the card shows: none when undeclared; stopped while the port is measured closed (known, not
 *  unknown: a body read earlier rides along as `last`, never as current); unknown when the last poll
 *  failed or nothing was read yet, with the reason; ok with the body read */
export function summaryView(d: Dashboard, portIsUp: boolean): DashSummaryView {
  if (!d.summary) return { state: 'none', readAt: null }
  const s = summaries.get(d.id)
  const base = { url: d.summary.url, every: d.summary.every, readAt: s?.reading?.ts ?? null, ...(s?.last ? { last: s.last } : {}) }
  if (!portIsUp) return { ...base, state: 'stopped' }
  const r = s?.reading
  if (!r) return { ...base, state: 'unknown', reason: 'not read yet' }
  if (r.status === 'unknown') return { ...base, state: 'unknown', reason: r.reason }
  return { ...base, state: 'ok', body: r.body }
}

/** poll one dashboard's summary now, only when it declares one and its port is up. Records the
 *  reading; resolves whether what the card shows changed. */
export async function pollSummary(d: Dashboard): Promise<boolean> {
  const decl = d.summary
  if (!decl || summaryBusy.has(d.id)) return false
  const port = portOf(d)
  if (!port || !(await portUp(port))) return false
  summaryBusy.add(d.id)
  try {
    const r = await readSummary(decl)
    summaryPolled.set(d.id, r.ts)
    const prev = summaries.get(d.id)
    const last = r.status === 'ok' ? { body: r.body, readAt: r.ts } : prev?.last
    summaries.set(d.id, { reading: r, last })
    const status = r.status === 'ok' ? r.body.health : 'unknown'
    const reading = r.status === 'ok' ? r.body.headline.map(e => `${e.label} ${e.value}`).join(' | ') : r.reason
    void later('summary reading', () => ops.recordHealth(`dash:${d.id}/summary`, SUMMARY_TARGET, status, {
      reading, ts: r.ts,
      detail: { url: decl.url, ...(r.status === 'ok' ? { body: r.body } : { reason: r.reason }), ...(last ? { last: last.body, last_read_at: last.readAt } : {}) },
    }))
    const was = prev?.reading
    const said = (x: SummaryReading) => JSON.stringify(x.status === 'ok' ? x.body : x.reason)
    return !was || was.status !== r.status || said(was) !== said(r)
  } finally { summaryBusy.delete(d.id) }
}

/** poll every declared summary whose `every` has passed since its last poll; resolves whether any card changed */
export async function pollDueSummaries(now = Date.now()): Promise<boolean> {
  const due = dashboards().filter(d => d.summary && now - (summaryPolled.get(d.id) ?? 0) >= summaryEveryMs(d.summary.every))
  const changed = await Promise.all(due.map(d => pollSummary(d).catch(e => { console.error('[dash] summary', d.id, e); return false })))
  return changed.some(Boolean)
}

export async function allViews(): Promise<DashView[]> {
  return Promise.all(dashboards().map(d => view(d)))
}

// ---- actions ----
const busy = new Set<string>()
async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(key)) throw new HttpError(409, `${key} is busy (start/stop in progress)`)
  busy.add(key)
  try { return await fn() } finally { busy.delete(key) }
}

export async function start(d: Dashboard, dev = false) {
  const spec = dev ? d.start_dev : d.start
  if (!spec) throw new HttpError(400, dev ? `${d.id} declares no start_dev` : `${d.id} declares no start`)
  const key = dev ? devKey(d) : keyOf(d)
  return exclusive(key, async () => {
    if (await portOpen(spec.port)) {
      portCache.delete(spec.port)
      return { ok: true, adopted: true, note: `:${spec.port} already listening - adopted` }
    }
    const ts = Date.now()
    let rowId = 0
    let didExit = false, exited: number | null = null
    const s = await startProcess({ key, cmd: spec.cmd, cwd: spec.cwd, port: spec.port }, {
      fundRoot: FUND_ROOT, logDir: LOG_DIR,
      onExit: code => { exited = code ?? null; didExit = true; if (rowId) void closeRow(rowId, code); starting.delete(key); portCache.delete(spec.port); publish('dash') },
    })
    rowId = await ops.addProcess(key, dev ? 'dev' : 'prod', spec.cmd, { pid: s.pid, port: spec.port, logPath: s.logPath, startedAt: ts })
    if (didExit) void closeRow(rowId, exited)     // it exited before its row existed
    starting.set(key, ts)
    logEvent('process', `started ${key} (pid ${s.pid}, :${spec.port}${dev ? ', dev' : ''})`, { payload: { dashboard: d.id } })
    publish('dash')
    void waitPort(spec.port, true, 90_000).then(async upNow => {
      starting.delete(key)
      portCache.delete(spec.port)
      adoptCache.delete(spec.port)
      await Promise.all(dashboards().filter(x => keyOf(x) === key || x.id === d.id).map(x => checkDashboard(x, { afterStart: upNow }).catch(() => null)))
      if (!upNow) logEvent('process', `${key} did not open :${spec.port} within 90s`)
      publish('dash')
    })
    return { ok: true, pid: s.pid, log: s.logPath }
  })
}

export async function stop(d: Dashboard) {
  const devRows = d.start_dev ? await openRows(devKey(d)) : []
  const devLive = devRows.some(r => pidAlive(r.pid))
  const key = devLive ? devKey(d) : keyOf(d)
  const port = devLive ? d.start_dev!.port : portOf(d)
  if (!port) throw new HttpError(400, `${d.id} has no port`)
  return exclusive(key, async () => {
    const rows = await openRows(key)
    const r = await stopProcess(port, rows.map(x => x.pid))
    for (const row of rows) if (!pidAlive(row.pid)) await closeRow(row.id)
    starting.delete(key)
    portCache.delete(port)
    adoptCache.delete(port)
    logEvent('process', `stopped ${key} (:${port}${r.killed.length ? `, pids ${r.killed.join(' ')}` : ''})${r.freed ? '' : ' - port still open'}`, { payload: { dashboard: d.id } })
    publish('dash')
    if (!r.freed) throw new HttpError(500, `:${port} still open after stop${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`)
    return { ok: true, killed: r.killed, stopped: key, alsoStopped: devLive ? [] : dashboards().filter(x => x.id !== d.id && keyOf(x) === key).map(x => x.id) }
  })
}

// ---- the scheduler: each dashboard's checks on its own `every`, plus a cheap port watch ----
let armed = false
function arm() {
  if (armed) return
  armed = true
  const tick = async () => {
    const now = Date.now()
    const due = dashboards().filter(d => now - (lastRun.get(d.id) ?? 0) >= parseEvery(d.every))
    if (!due.length) return
    await Promise.all(due.map(d => checkDashboard(d).catch(e => console.error('[dash] check', d.id, e))))
    publish('dash')
  }
  setTimeout(() => void tick(), 1500).unref()
  setInterval(() => void tick(), 20_000).unref()
  // the summary cards, each on its own `every` (the finest a few seconds), only while its port is up
  setInterval(async () => { if (await pollDueSummaries().catch(() => false)) publish('dash') }, 5_000).unref()
  // port watch: a server started or killed outside the cockpit shows up within ~10s
  const seen = new Map<number, boolean>()
  setInterval(async () => {
    let changed = false
    const ports = [...new Set(dashboards().flatMap(d => [portOf(d), d.start_dev?.port ?? null]).filter((p): p is number => !!p))]
    for (const p of ports) {
      const up = await portUp(p, 0)
      if (seen.has(p) && seen.get(p) !== up) { changed = true; adoptCache.delete(p) }
      seen.set(p, up)
    }
    if (changed) {
      await Promise.all(dashboards().filter(d => ports.includes(portOf(d) ?? -1)).map(d => checkDashboard(d).catch(() => null)))
      publish('dash')
    }
  }, 10_000).unref()
}

// ---- health history: every dashboard's check passes over a window, from the record ----
const H = 3_600_000
/** one cell per CLOCK hour, the last the hour in progress: the heat strip (server/proc/history.ts) */
export async function history(hours = 24) {
  const now = Date.now()
  const from = Math.floor(now / H) * H - (hours - 1) * H
  const rows: HistRow[] = await ops.healthReadingsSince('dash:', 'dashboard', from)
  const dashes = new Map(dashboards().map(d => [d.id, new Set(d.health.filter(h => h.check === 'port').map(h => h.id))]))
  return { hours, buckets: hours, items: summarizeHours(rows, dashes, now, hours) }
}

export function register(r: Router) {
  arm()
  r.get('/api/dash/history', async ({ query }) => {
    const h = Math.min(168, Math.max(1, Math.round(Number(query.get('h') ?? 24)) || 24))
    return history(h)
  })
  r.get('/api/dash', async () => ({ items: await allViews(), problems: readRegistry().problems }))
  r.post('/api/dash/start-all', async () => {
    const seen = new Set<string>()
    const out: Record<string, string> = {}
    for (const d of dashboards()) {
      if (!d.start || seen.has(keyOf(d))) continue
      seen.add(keyOf(d))
      try { const x: any = await start(d); out[keyOf(d)] = x.adopted ? 'running' : 'started' } catch (e: any) { out[keyOf(d)] = `error: ${e.message}` }
    }
    return { ok: true, results: out }
  })
  r.post('/api/dash/stop-all', async () => {
    const seen = new Set<string>()
    const out: Record<string, string> = {}
    for (const d of dashboards()) {
      const v = await view(d)
      if (!v.portUp || seen.has(v.key)) continue
      seen.add(v.key)
      try { await stop(d); out[v.key] = 'stopped' } catch (e: any) { out[v.key] = `error: ${e.message}` }
    }
    return { ok: true, results: out }
  })
  r.get('/api/dash/:id', async ({ params }) => {
    const d = byId(params.id)
    const v = await view(d)
    await settled()
    const runs: ProcRow[] = await ops.select('processes', { where: { dashboard_id: [keyOf(d), devKey(d)] }, orderBy: ['-started_at', '-id'], limit: 12 })
    return { ...v, runs, start: d.start ?? null, start_dev: d.start_dev ?? null, on_fail: d.on_fail ?? null }
  })
  r.post('/api/dash/:id/start', async ({ params, body }) => {
    const b = await body()
    return start(byId(params.id), !!b?.dev)
  })
  r.post('/api/dash/:id/stop', async ({ params }) => stop(byId(params.id)))
  r.post('/api/dash/:id/restart', async ({ params }) => {
    const d = byId(params.id)
    const v = await view(d)
    const dev = v.mode === 'dev'
    if (v.portUp) await stop(d)
    const port = dev ? d.start_dev?.port : portOf(d)
    if (port && !(await waitPort(port, false, 15_000))) throw new HttpError(500, `:${port} did not free`)
    return start(d, dev)
  })
  r.get('/api/dash/:id/logs', async ({ params, query }) => {
    const d = byId(params.id)
    const key = query.get('dev') === '1' ? devKey(d) : keyOf(d)
    const path = logPathFor(LOG_DIR, key)
    const t = tailLines(path, 500)
    return t ? { key, path, lines: t.lines, size: t.size, mtime: t.mtime } : { key, path, lines: [], missing: true }
  })
  r.post('/api/dash/:id/check', async ({ params }) => {
    const d = byId(params.id)
    const port = portOf(d)
    if (port) portCache.delete(port)
    await checkDashboard(d)
    publish('dash')
    return view(d)
  })
}

export async function services(): Promise<ServiceGroup | null> {
  const vs = await allViews()
  return {
    id: 'dash', label: 'Dashboards', tally: upTally(vs),
    rows: vs.map(v => ({
      id: v.id, label: v.name, room: 'dash', target: v.id, kind: v.kind,
      status: v.state === 'running' || v.state === 'dev' ? (v.measured ? 'ok' : 'unknown') : v.state === 'stale' ? 'warn' : v.state === 'failing' ? 'fail' : 'off',
      // a health state that is not ok is the reading; uptime next to a red dot read as healthy
      reading: v.state === 'stopped' ? 'stopped' : v.state === 'starting' ? 'starting' : v.state === 'failing' || v.state === 'stale' ? v.state : v.since ? `up ${fmtAgeMs(Date.now() - v.since)}` : v.state,
      hint: v.since && v.state !== 'stopped' ? `${v.state}, up ${fmtAgeMs(Date.now() - v.since)}` : undefined,
    })),
  }
}

/**
 * THE one count of dashboards up, for the services rail AND the status bar: every row the Dash
 * room lists (dashboards and tools alike), counted by an open port. Counted here only.
 */
export function upTally(vs: { portUp: boolean }[]): string {
  return `${vs.filter(v => v.portUp).length}/${vs.length} up`
}

onSummary(async () => ({ dashboards: upTally(await allViews()) }))
