import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Router } from '../http.ts'
import { HttpError } from '../http.ts'
import type { Agent, ServiceGroup, ServiceRow } from '../../shared/types.ts'
import { logEvent, ops } from '../db.ts'
import { publish } from '../events.ts'
import { onRunJob, onStop, onSummary } from '../hooks.ts'
import { AGENTS_DIR, AGENTS_REL, CONTROLS_FILE, FUND_ROOT, LOCAL_TZ, PYTHON, SCHEDULE_FILE, STOP_FILE, TOOLS_DIR } from '../paths.ts'
import { readControlsState } from '../system/controls.ts'
import { writeControls } from '../system/controlsfile.ts'
import { commitPaths, repoOf } from '../loop/gitops.ts'
import { serial } from '../loop/engine.ts'
import { setJobBrain } from '../sched/edit.ts'
import { agentFileName } from '../../shared/agentfile.ts'
import { checkEffort, checkModel, readPermitted } from '../chat/models.ts'
import { EFFORTS } from '../chat/launch.ts'
import { doorsFromLaw, type Doors } from '../system/credentials.ts'
import { roster, saveAgents, config } from '../config.ts'
import { agentEnv } from '../chat/env.ts'
import { expectedSet, latestReading, loadProbes, splitOrphans, worst } from '../system/probes.ts'
import { probeHeat } from '../system/heat.ts'
import { fmtIn, lastOccurrence, nextOccurrence } from '../system/schedule.ts'
import { Scheduler, lastRunPerJob, lastStarted, recentRuns, runBanner, runRow, type RunRow } from '../sched/index.ts'
import { start as chatStart } from '../chat/runner.ts'
import { tailLines } from '../proc/manager.ts'
import { floorStopped } from '../system/floor.ts'
import { parseEnd, readStopState, setStop } from '../system/stop.ts'
import { opsServiceRows, opsStop, registerOps } from '../system/ops.ts'
import { registerHands } from '../system/hands.ts'
import { checkBurn } from '../system/burn.ts'
import { laneMarks, laneTally, readLanes, type WallRun } from '../system/wall.ts'
import { loadAll } from '../lab/runs.ts'

// ROOM: system - health (<floor>/health, FLOOR_DIR), schedule (app/schedule.json + the job_runs table, run by
// server/sched), spend (usage table + the budget meter's reading, ops.health_readings system:budget), agents (the roster, app/agents/), connectors
// (the doors table of app/library/law/how-we-work.md, server/system/credentials.ts).
// NOTE: /api/system/summary and /api/system/stop are fundd's own routes (hooks); not here.

const STARTED = Date.now()

const python = () => (existsSync(PYTHON) ? PYTHON : 'python')   // <fund>/.venv

// ---- background processes this room starts (the probes run) ----
type Proc = { what: string; started: number; ended: number | null; code: number | null; tail: string }
const procs = new Map<string, Proc>()

function start(key: string, what: string, cmd: string, args: string[], timeoutMs: number) {
  if (procs.get(key)?.ended === null) throw new HttpError(409, `${what} is already running`)
  const p: Proc = { what, started: Date.now(), ended: null, code: null, tail: '' }
  procs.set(key, p)
  const child = spawn(cmd, args, { cwd: FUND_ROOT, windowsHide: true, env: agentEnv({ ...process.env, FUND_ROOT, PYTHONUNBUFFERED: '1' }) as NodeJS.ProcessEnv })
  const keep = (b: Buffer) => { p.tail = (p.tail + b.toString('utf8')).slice(-4000) }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, timeoutMs)
  const done = (code: number | null) => {
    if (p.ended !== null) return
    clearTimeout(timer)
    p.ended = Date.now(); p.code = code
    logEvent('job', `${what} exited ${code}`, { payload: { tail: p.tail.slice(-600) } })
    publish('system', { done: key }); publish('services')
  }
  child.on('exit', code => done(code))
  child.on('error', e => { keep(Buffer.from(String(e.message))); done(-1) })
  publish('system', { started: key })
}

const procView = (key: string) => procs.get(key) ?? null

// ---- health ----
/** every reading, split by staleness.py's expected set: `probes` are judged (tiles, groups, dots,
 *  the badge, the rail), `orphans` are readings nothing is known to write, shown as one dim line.
 *  `orphansWhy` says why nothing could be folded (the set could not be read) */
async function judged(now: number) {
  const [all, ex] = await Promise.all([loadProbes(now), expectedSet(join(TOOLS_DIR, 'probes', 'staleness.py'), python(), FUND_ROOT)])
  return { ...splitOrphans(all, ex.set), orphansWhy: ex.why }
}

async function health() {
  const now = Date.now()
  const { probes, orphans, orphansWhy } = await judged(now)
  return {
    now,
    fundd: { pid: process.pid, started: STARTED, rssMb: Math.round(process.memoryUsage().rss / 1048576) },
    probes, orphans, orphansWhy,
    run: await sweepView(),
  }
}

/** the 24h heat strip of every probe that has a reading */
async function heat() {
  const now = Date.now()
  const { probes } = await judged(now)
  return { now, ...(await probeHeat(probes.map(p => p.id), now, 24)) }
}

/** the newer of: the probe-sweep JOB's last started run (what Run probes starts now), and a
 *  room-private run_all child (only when schedule.json has no probe-sweep job) */
async function sweepView() {
  const row = await lastStarted(SWEEP_JOB)
  const job = row ? runBanner(row, row.log_path ? (tailLines(row.log_path, 40)?.lines ?? []).filter(l => !l.startsWith('----')).join('\n').slice(-4000) : '') : null
  const proc = procView('probes')
  if (!job) return proc
  if (!proc) return job
  return proc.started > job.started ? proc : job
}
const SWEEP_JOB = 'probe-sweep'

// ---- schedule: app/schedule.json + the job_runs table, run by fundd's own scheduler ----
export const scheduler = new Scheduler({
  startAgent: async job => {
    const agents = config.agents()
    const desk = job.desk.replace(/\\/g, '/')
    const a = agents.find(x => x.id === job.agent) ?? agents.find(x => x.id === desk)
      ?? agents.find(x => desk !== '.' && x.writes.some(w => (desk + '/').startsWith(w.replace(/\\/g, '/'))))
    if (!a) throw new Error(`agent job ${job.id}: no roster agent for ${job.agent || job.desk}`)
    // a job may name its own model and effort; both are checked against Claude Code's permitted list at
    // run time (a model it no longer permits fails the run and says so), else the roster's are used
    if (job.model) { const pm = await checkModel(job.model); if (job.effort) checkEffort(pm, job.effort) }
    return (await chatStart(a.id, job.prompt, `${job.id} (scheduled)`, { model: job.model || null, effort: job.effort || null })).id
  },
})

/** fundd calls this once it listens. FUND_SCHEDULER=0 = a test instance (scripts/prod.mjs on
 *  alternate ports) that must never run a job the real fundd also runs. */
export function startScheduler() {
  if (process.env.FUND_SCHEDULER === '0') { logEvent('system', 'scheduler off (FUND_SCHEDULER=0)'); return }
  scheduler.start()
  const burn = () => { checkBurn().catch((e: any) => { void logEvent('system', `burn check: ${e?.message ?? e}`) }) }
  setInterval(burn, 5 * 60_000).unref()
  burn()
}

// ---- market alerts (server/alerts) ----
const runView = (r: RunRow | null | undefined) => r ? {
  row: r.id, job: r.job_id, status: r.status, trigger: r.trigger, due: r.due_at, start: r.started_at, end: r.ended_at,
  code: r.exit_code, detail: r.detail ?? '', log: !!r.log_path, conversation: r.conversation_id,
} : null

async function schedule() {
  const now = Date.now()
  const s = scheduler.load()
  const last = await lastRunPerJob()
  const running = scheduler.running()
  const lastDue = s.found ? await scheduler.lastDue(s.jobs) : new Map<string, number>()
  const jobs = s.jobs.map(j => {
    const next = nextOccurrence(j.cadence, now)
    const prevOcc = lastOccurrence(j.cadence, now)
    const ld = lastDue.get(j.id)
    // the latest occurrence has no row yet and its window is still open: the next pass takes it
    const unrun = j.enabled && prevOcc !== null && now - prevOcc < j.windowS * 1000 && (ld === undefined || prevOcc > ld)
    return {
      id: j.id, kind: j.kind, desk: j.kind === 'agent' ? (j.agent || j.desk) : j.cwd, cadence: j.cadence, enabled: j.enabled,
      command: j.kind === 'agent' ? `agent: ${j.prompt.slice(0, 80)}` : j.cmd.join(' '),
      note: j.note, windowS: j.windowS, timeoutS: j.timeoutS, model: j.model, effort: j.effort,
      next: j.enabled ? next : null, unrun, running: running.has(j.id),
      last: runView(last.get(j.id)),
    }
  })
  floorStopped()                                  // an end-timed stop that has run out is cleared before it is read
  const stop = readStopState(STOP_FILE)
  const runs = await ops.count('job_runs')
  return { now, found: s.found, errors: s.errors, stopped: stop.stopped, stopText: stop.text, stopAt: stop.at, stopUntil: stop.until, jobs, runs, lastPass: scheduler.lastPass, run: [] as unknown[] }
}

// ---- the cadence wall: owed vs actual per job, the alert engine's clock, the lab's fixed-age reads ----
let wallCache: { key: number; at: number; body: unknown } | null = null
async function wall(days: number) {
  const now = Date.now()
  if (wallCache && wallCache.key === days && now - wallCache.at < 5_000) return wallCache.body
  const DAY = 86_400_000
  const from = now - days * DAY, to = now + DAY
  const s = scheduler.load()
  const runs: (WallRun & { job_id: string })[] = await ops.jobRunsInWindow(from, to)
  const span = await ops.jobRunSpan()
  const since = span.first
  const byJob = new Map<string, WallRun[]>()
  for (const r of runs) { if (!byJob.has(r.job_id)) byJob.set(r.job_id, []); byJob.get(r.job_id)!.push(r) }
  // per job, the record begins at its FIRST scheduled row: the scheduler writes a row (run, missed or
  // skipped) for every occurrence after that one, so before it the job was not judged at all - it did
  // not exist yet in schedule.json, or fundd was not running. A job never judged claims nothing yet.
  const firstDue = span.first_due
  const jobs = s.jobs.map(j => {
    const jobSince = Math.max(since ?? now, firstDue.get(j.id) ?? now)
    const marks = laneMarks({ cadence: j.cadence, windowS: j.windowS, enabled: j.enabled }, byJob.get(j.id) ?? [], from, to, now, jobSince)
    return { id: j.id, kind: 'job' as const, desk: j.kind === 'agent' ? (j.agent || j.desk) : j.cwd, agent: j.kind === 'agent', cadence: j.cadence, enabled: j.enabled, windowS: j.windowS, marks, tally: laneTally(marks) }
  })
  let reads: unknown[] = [], readsError: string | null = null
  try {
    reads = readLanes(loadAll(FUND_ROOT, now).flatMap(d => d.runs), from, to).map(r => ({ id: r.key, kind: 'read' as const, desk: r.desk, run: r.run, cadence: '+7d +30d', enabled: true, marks: r.marks, tally: laneTally(r.marks) }))
  } catch (e: any) { readsError = String(e?.message ?? e) }
  const body = { now, from, to, days, since, found: s.found, errors: s.errors, stopped: floorStopped(), lanes: [...jobs, ...reads], readsError }
  wallCache = { key: days, at: now, body }
  return body
}

function writeStop() { setStop(STOP_FILE, true) }

async function nextJob(): Promise<string | undefined> {
  if (floorStopped()) return 'stopped'
  const s = await schedule()
  const soon = s.jobs.filter(j => j.next !== null).sort((a, b) => a.next! - b.next!)[0]
  return soon ? `${soon.id} in ${fmtIn(soon.next! - s.now)}` : undefined
}

// ---- spend ----
const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

async function spend() {
  const since = Date.now() - 14 * 86_400_000
  // per (agent, local day in LOCAL_TZ): the old SQLite date(..., 'localtime') grouping
  const rows = (await ops.usageByDay(since, LOCAL_TZ)).map(({ billable: _b, ...r }) => r)
  const total = await ops.count('usage')
  const budget = await latestReading('budget')
  return {
    today: localDay(Date.now()),
    rows, usageRows: total,
    budget: budget ? {
      status: budget.status ?? 'unknown', reading: budget.reading ?? '', metric: budget.metric ?? null,
      probedAt: budget.probed_ts ? budget.probed_ts * 1000 : null,
      totalToday: typeof budget.total_today === 'number' ? budget.total_today : null,
      bySeat: budget.by_seat_today ?? null, over: budget.over_budget ?? [], drift: budget.tier_drift ?? [],
      detail: typeof budget.detail === 'string' ? budget.detail : '',
    } : null,
  }
}

/** the one token format on every screen: 12.7M, 840k, 312 (src/rooms/system/ops.tsx tok) */
const fmtTok = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

/** billable = input + cache writes + output (the budget probe's metric). The budget reading scans
 *  every transcript in this tree, so it wins when it was probed today; else the cockpit's usage table. */
async function spendToday(): Promise<string | undefined> {
  const today = localDay(Date.now())
  const b = await latestReading('budget')
  if (b && typeof b.total_today === 'number' && b.probed_ts && localDay(b.probed_ts * 1000) === today) return fmtTok(b.total_today)
  const r = await ops.billableOnDay(today, LOCAL_TZ, Date.now() - 2 * 86_400_000)
  if (r.n > 0 && r.billable !== null) return fmtTok(r.billable)
  return undefined
}

// ---- connectors: the `## The doors and their keys` chapter of the law shelf, found by heading (server/system/credentials.ts), read as data; no .env, no secret, ever ----
function connectors(): Doors {
  const { book: _book, ...doors } = doorsFromLaw(FUND_ROOT, config.shelves())
  return doors
}

export function register(r: Router) {
  onStop(async () => { try { writeStop() } catch { /* the floor is gone: nothing to write */ } await scheduler.killAll(); await opsStop(); publish('system', { stopped: true }) })
  onRunJob(id => scheduler.runNow(id))
  onSummary(async () => ({ nextJob: await nextJob(), spendToday: await spendToday() }))

  r.get('/api/system/health', () => health())
  r.get('/api/system/health/heat', () => heat())
  r.post('/api/system/probes/run', async () => {
    // one sweep, one record: when the schedule carries probe-sweep, the button runs THAT job
    // (a manual job_runs row, its log, the scheduler's one-at-a-time guard)
    if (scheduler.load().jobs.some(j => j.id === SWEEP_JOB)) {
      try { return { started: true, row: await scheduler.runNow(SWEEP_JOB) } } catch (e: any) { throw new HttpError(e.status ?? 500, e.message) }
    }
    const script = join(TOOLS_DIR, 'probes', 'run_all.py')
    if (!existsSync(script)) throw new HttpError(404, 'app/tools/probes/run_all.py is missing')
    start('probes', 'probes run_all', python(), [script, '--quiet'], 45 * 60_000)
    return { started: true }
  })

  r.get('/api/system/schedule', () => schedule())
  r.get('/api/system/schedule/wall', ({ query }) => {
    const d = Math.round(Number(query.get('days') ?? 7))
    if (!Number.isFinite(d) || d < 1 || d > 60) throw new HttpError(400, 'days is 1..60')
    return wall(d)
  })
  r.post('/api/system/schedule/run', async ({ body }) => {
    const { id } = await body()
    const jobId = String(id ?? '')
    if (!/^[A-Za-z0-9_.-]+$/.test(jobId)) throw new HttpError(400, 'bad job id')
    try { return { started: true, row: await scheduler.runNow(jobId) } } catch (e: any) { throw new HttpError(e.status ?? 500, e.message) }
  })
  // an agent job's model/effort, written into schedule.json (checked against Claude Code's permitted list)
  r.patch('/api/system/schedule/:id', async ({ params, body }) => {
    const b = await body()
    const brain: { model?: string | null; effort?: string | null } = {}
    const no = (e: Error) => { throw new HttpError(400, e.message) }
    if (b.model !== undefined) brain.model = b.model ? String(b.model) : null
    if (b.effort !== undefined) brain.effort = b.effort ? String(b.effort) : null
    if (brain.model) {
      const pm = await checkModel(brain.model).catch(no)
      if (pm && !pm.efforts.length) brain.effort = null
      else if (pm && brain.effort) try { checkEffort(pm, brain.effort) } catch (e) { no(e as Error) }
    }
    try {
      const out = setJobBrain(SCHEDULE_FILE, params.id, brain)
      logEvent('system', `job ${params.id}: model ${out.model || '(roster)'} effort ${out.effort || '(roster)'}`)
      publish('system', { job: params.id })
      return { ok: true, ...out }
    } catch (e: any) { throw new HttpError(e.status ?? 500, e.message) }
  })
  r.get('/api/system/schedule/runs', async ({ query }) => {
    const job = query.get('job')
    return { runs: (await recentRuns(job && /^[A-Za-z0-9_.-]+$/.test(job) ? job : null, Math.min(Number(query.get('limit')) || 50, 500))).map(runView) }
  })
  r.get('/api/system/schedule/log', async ({ query }) => {
    const row = await runRow(Number(query.get('row')))
    if (!row) throw new HttpError(404, 'no such run')
    if (!row.log_path) return { row: row.id, lines: [], note: row.detail ?? '' }
    const t = tailLines(row.log_path, 400)
    if (!t) throw new HttpError(404, `log ${row.log_path} is gone`)
    return { row: row.id, path: row.log_path, lines: t.lines, size: t.size }
  })
  r.post('/api/system/halt', async ({ body }) => {
    const { on, until } = await body()
    if (on !== true && on !== false) throw new HttpError(400, 'body is {on: true|false, until?: <ISO instant>}')
    const { end, error } = parseEnd(on, until)
    if (error) throw new HttpError(400, error)
    setStop(STOP_FILE, on, new Date(), end)
    logEvent('system', on ? `floor/STOP written${end ? ` until ${end.toISOString()}` : ''}` : 'floor/STOP cleared')
    publish('system'); publish('services')
    return { stopped: existsSync(STOP_FILE), until: end ? end.getTime() : null }
  })

  r.get('/api/system/spend', () => spend())

  r.get('/api/system/agents', async () => {
    // the roster's mtime = its newest file's (an edit to any one agent moves it)
    let mtime: number | null = null
    try { for (const f of readdirSync(AGENTS_DIR)) if (f.endsWith('.md')) mtime = Math.max(mtime ?? 0, statSync(join(AGENTS_DIR, f)).mtimeMs) } catch { /* none */ }
    const r = roster()
    const pm = await readPermitted()
    return { agents: r.agents, problems: r.problems, models: pm.models, modelsError: pm.error, efforts: EFFORTS, mtime }
  })
  r.patch('/api/system/agents/:id', async ({ params, body }) => {
    const b = await body()
    const agents = config.agents()
    const a = agents.find(x => x.id === params.id)
    if (!a) throw new HttpError(404, `no agent ${params.id}`)
    const next: Agent = { ...a }
    const no = (e: Error) => { throw new HttpError(400, e.message) }
    if (b.model !== undefined) { await checkModel(String(b.model)).catch(no); next.model = b.model }
    if (b.effort !== undefined) { if (!(EFFORTS as readonly string[]).includes(b.effort)) throw new HttpError(400, `effort is one of ${EFFORTS.join('|')}`); next.effort = b.effort }
    // the effort is checked against the model the agent will run (Claude Code's list); a model that takes
    // none keeps the roster's effort on file, and the launch sends it none
    if (b.effort !== undefined) {
      const pm = (await readPermitted()).models.find(m => m.id === next.model)
      if (pm) try { checkEffort(pm, next.effort) } catch (e) { no(e as Error) }
    }
    if (next.model === a.model && next.effort === a.effort) return { agent: a, changed: false }
    saveAgents([next])
    logEvent('system', `agent ${a.id}: ${a.model}/${a.effort} -> ${next.model}/${next.effort}`, { agent: a.id })
    publish('config', { file: `${AGENTS_REL}/${agentFileName(a.id)}` })
    return { agent: next, changed: true }
  })

  // ---- Controls (server/system/controls.ts): one read of every decision, and the writes that have no room of their own ----
  r.get('/api/system/controls', async () => readControlsState(config.agents()))
  r.post('/api/system/controls', async ({ body }) => {
    const b = (await body().catch(() => ({}))) ?? {}
    const no = (m: string) => new HttpError(400, m)
    const set: { wakes?: boolean; tokenCap?: number | null } = {}
    if (b.wakes !== undefined) { if (typeof b.wakes !== 'boolean') throw no('wakes is true or false'); set.wakes = b.wakes }
    if (b.tokenCap !== undefined) {
      if (b.tokenCap !== null && !(typeof b.tokenCap === 'number' && Number.isInteger(b.tokenCap) && b.tokenCap > 0)) throw no('tokenCap is a whole number of tokens, or null for no cap')
      set.tokenCap = b.tokenCap
    }
    const model = b.defaultModel
    if (model !== undefined && typeof model !== 'string') throw no('defaultModel is an exact model id')
    if (!Object.keys(set).length && model === undefined) throw no('nothing to set: wakes, tokenCap or defaultModel')
    const pm = typeof model === 'string' ? await checkModel(model).catch(e => { throw no(e.message) }) : null
    const files: string[] = []
    const said: string[] = []
    await serial(FUND_ROOT, async () => {
      if (Object.keys(set).length) {
        writeControls(CONTROLS_FILE, set)
        files.push('app/controls.json')
        if (set.wakes !== undefined) said.push(`dashboard wakes ${set.wakes ? 'on' : 'off'}`)
        if (set.tokenCap !== undefined) said.push(`daily token cap ${set.tokenCap ?? 'none'}`)
      }
      if (pm) {
        // every roster agent boots on it; an effort the new model does not take is clamped to its highest (a model with none keeps the file's)
        const next = config.agents().filter(a => a.model !== pm.id).map(a => ({ ...a, model: pm.id, effort: !pm.efforts.length || pm.efforts.includes(a.effort) ? a.effort : pm.efforts[pm.efforts.length - 1] }))
        if (next.length) { files.push(...saveAgents(next)); said.push(`${next.length} agents on ${pm.id}`) }
      }
      if (!files.length) return
      const { repo, prefix } = repoOf(FUND_ROOT, files[0])
      try { await commitPaths(repo, files.map(f => f.slice(prefix.length)), `controls (owner): ${said.join(', ')}`, 'Agent: owner\nControls: ' + files.length + ' files') }
      catch (e) { console.error('[controls] commit', (e as Error).message) }
    })
    if (said.length) logEvent('system', `controls: ${said.join(', ')}`)
    publish('system', { controls: true }); publish('config')
    return readControlsState(config.agents())
  })

  r.get('/api/system/connectors', () => connectors())

  registerOps(r)
  registerHands(r)
}

/**
 * The rail's schedule row. Green: when the next job fires. Red or amber: the FAULT, from the
 * scheduler probe's own tally ("1 fail · 8 missed"), never "next ..." beside a red dot.
 */
export function scheduleRow(p: { status: ServiceRow['status']; reading: string } | undefined, stopped: boolean, nj: string | null | undefined): ServiceRow {
  const base = { id: 'sys:schedule', label: 'schedule', room: 'system', target: 'schedule' }
  if (stopped) return { ...base, status: 'warn', reading: 'stopped', hint: 'floor/STOP holds every job' }
  const status = p?.status ?? 'unknown'
  const next = nj ? `next ${nj}` : 'no job due'
  if (p && (status === 'fail' || status === 'warn')) {
    const parts = p.reading.replace(/\s+of\s+\d+.*$/, '').split(' · ').map(x => x.trim()).filter(Boolean)
    const faults = parts.filter(x => /fail|missed/.test(x))
    return { ...base, status, reading: (faults.length ? faults : parts).join(' · ') || status, hint: `${p.reading}\n${next}` }
  }
  return { ...base, status, reading: next, hint: p ? `${p.reading}\n${next}` : `no scheduler probe yet\n${next}` }
}

export async function services(): Promise<ServiceGroup | null> {
  const { probes: ps } = await judged(Date.now())
  const ok = ps.filter(p => p.status === 'ok').length
  const bad = ps.filter(p => p.status === 'fail').length
  const stale = ps.filter(p => p.stale).length
  const stopped = floorStopped()
  const nj = stopped ? null : await nextJob()
  return {
    id: 'system', label: 'System',
    rows: [
      { id: 'sys:probes', label: 'probes', room: 'system', target: 'health', status: ps.length ? worst(ps) : 'unknown',
        reading: !ps.length ? 'no probe files' : bad || stale ? [bad && `${bad} fail`, stale && `${stale} stale`].filter(Boolean).join(' · ') : `${ok} ok` },
      scheduleRow(ps.find(p => p.id === 'scheduler'), stopped, nj),
      ...opsServiceRows(),
    ],
  }
}
