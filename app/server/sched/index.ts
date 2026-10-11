import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { later, logEvent, ops, settled } from '../db.ts'
import { publish } from '../events.ts'
import { agentEnv, prependPath } from '../chat/env.ts'
import { FLOOR_DIR, FUND_ROOT, LOG_DIR, PYTHON, SCHEDULE_FILE, within } from '../paths.ts'
import { killTree, pidAlive, pidStartTime } from '../proc/ports.ts'
import { stamp as fmtStamp } from '../../shared/time.ts'
import { tailLines } from '../proc/manager.ts'
import { loadJobs, occurrences, plan, resolveArgv, type Job } from './plan.ts'
import { PROBE_TARGET, probeKey } from '../system/probes.ts'
import { stopHolds } from '../system/stop.ts'

/**
 * THE SCHEDULER - fundd's replacement for the retired `fund tick` (2026-09-24).
 *
 * Every 60 s: read schedule.json, plan the pass (plan.ts: due / missed / skipped), record
 * each decision as a `job_runs` row, and run what is due. A script job is spawned once: argv as
 * written (a leading `python` is the fund venv), cwd fund-relative, env = fundd's env minus
 * anything credential-shaped (chat/env.ts, the same boundary every agent crosses), killed as a
 * tree at `timeout_s`, stdout+stderr to ~/fund-data/logs/jobs/<id>/<stamp>.log. An agent job
 * starts a conversation through the chats runner (only when it is `unattended`). While
 * floor/STOP exists nothing starts. After each pass it takes its own reading (system:scheduler in
 * ops.health_readings, where every probe's reading is).
 *
 * The run record is the ops store (ops.job_runs, through @fund/db). A row is closed from a child's
 * exit event through the write queue (db.later), in order, never thrown.
 */

export type RunRow = {
  id: number; job_id: string; due_at: number | null; started_at: number | null; ended_at: number | null
  status: string; exit_code: number | null; log_path: string | null; conversation_id: string | null; detail: string | null; trigger: string
  pid?: number | null
}

export type SchedOpts = {
  fundRoot?: string
  scheduleFile?: string
  floorDir?: string
  logDir?: string
  python?: string
  everyMs?: number
  /** start an agent conversation; returns its id (the chats runner in fundd) */
  startAgent?: (job: Job) => Promise<string> | string
}

type Live = { rowId: number; pid: number | null; timer: NodeJS.Timeout | null; killedFor: string | null; poll?: NodeJS.Timeout | null }

export class Scheduler {
  readonly fundRoot: string
  readonly scheduleFile: string
  readonly floorDir: string
  readonly logDir: string
  readonly python: string
  private everyMs: number
  private startAgent?: SchedOpts['startAgent']
  private live = new Map<string, Live>()
  private timer: NodeJS.Timeout | null = null
  private passing = false
  /** recover()'s run at start: a pass or a Run now waits for it, so an adopted job is never started twice */
  private recovering: Promise<void> = Promise.resolve()
  lastPass: { at: number; errors: string[]; decisions: number } | null = null

  constructor(o: SchedOpts = {}) {
    this.fundRoot = o.fundRoot ?? FUND_ROOT
    this.scheduleFile = o.scheduleFile ?? (o.fundRoot ? join(o.fundRoot, 'app', 'schedule.json') : SCHEDULE_FILE)
    this.floorDir = o.floorDir ?? FLOOR_DIR
    this.logDir = o.logDir ?? join(LOG_DIR, 'jobs')
    this.python = o.python ?? (existsSync(PYTHON) ? PYTHON : 'python')
    this.everyMs = o.everyMs ?? 60_000
    this.startAgent = o.startAgent
  }

  get stopFile() { return join(this.floorDir, 'STOP') }
  /** does floor/STOP hold now? an end-timed one that has run out is cleared here, and logged (server/system/stop.ts) */
  stopped() {
    return stopHolds(this.stopFile, Date.now(), until => {
      void logEvent('job', `floor/STOP ended on its own (end time ${new Date(until).toISOString()}): cleared`)
      publish('system'); publish('services')
    })
  }

  start(firstDelayMs = 5_000) {
    if (this.timer) return
    this.recovering = this.recover().catch(e => { console.error('[sched] recover:', e); void logEvent('job', `recover after restart failed: ${e?.message ?? e}`) })
    const t = setTimeout(() => { void this.pass() }, firstDelayMs); t.unref?.()
    this.timer = setInterval(() => { void this.pass() }, this.everyMs)
    this.timer.unref?.()
  }

  /**
   * Rows left `running` by a previous fundd. A script job's child is spawned DETACHED so it
   * outlives the daemon: a non-detached child sits in libuv's kill-on-close job object on Windows
   * and died with every fundd restart (2026-09-25: a manual probe-sweep and a budget-week run were
   * killed by the dev watcher's restart on a server edit, and closed `fail` here). A restart must
   * not call a job failed while it still runs, nor let "Run now" or the next occurrence
   * start a second copy. A row whose recorded pid is still alive is ADOPTED: it stays `running`,
   * holds the job's live slot, keeps its timeout, and closes as `unknown` when the pid goes (the
   * exit code of a process we did not spawn cannot be read). A row with no live pid closes as
   * `fail`. A pid whose process started after the row did is a reused pid, not our job.
   */
  async recover(now = Date.now()) {
    const rows: RunRow[] = await ops.runningJobRuns()
    const jobs = this.load().jobs
    for (const r of rows) {
      if (this.live.has(r.job_id)) continue
      const pid = r.pid ?? null
      if (!pid || !pidAlive(pid)) {
        await ops.updateJobRun(r.id, { status: 'fail', ended_at: now, detail: pid ? `fundd restarted while it ran; pid ${pid} was gone` : 'fundd restarted while it ran' })
        continue
      }
      const live: Live = { rowId: r.id, pid, timer: null, killedFor: null, poll: null }
      this.live.set(r.job_id, live)
      logEvent('job', `${r.job_id} adopted after a fundd restart (pid ${pid})`)
      const close = (detail: string) => {
        if (this.live.get(r.job_id) !== live) return
        this.live.delete(r.job_id)
        if (live.timer) clearTimeout(live.timer)
        if (live.poll) clearInterval(live.poll)
        const status = live.killedFor ? 'fail' : 'unknown'
        const endedAt = Date.now()
        void later('job run close', () => ops.updateJobRun(r.id, { status, ended_at: endedAt, detail: live.killedFor ?? detail }))
        logEvent('job', `${r.job_id} ${status} (adopted pid ${pid})`)
        publish('system', { job: r.job_id, status }); publish('services')
      }
      void pidStartTime(pid).then(t => {
        if (t !== null && r.started_at !== null && t > r.started_at + 60_000) close(`fundd restarted while it ran; pid ${pid} now belongs to another process`)
      })
      live.poll = setInterval(() => { if (!pidAlive(pid)) close('ended after a fundd restart; exit code not observable') }, 5_000)
      live.poll.unref?.()
      const job = jobs.find(j => j.id === r.job_id)
      if (job && r.started_at !== null) {
        live.timer = setTimeout(() => { live.killedFor = `timeout after ${job.timeoutS}s`; void killTree(pid).then(() => close('')) }, Math.max(0, r.started_at + job.timeoutS * 1000 - now))
        live.timer.unref?.()
      }
    }
  }

  stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = null }

  load(): { found: boolean; jobs: Job[]; errors: string[]; raw: any } {
    let raw: any = null
    try { raw = JSON.parse(readFileSync(this.scheduleFile, 'utf8')) } catch (e: any) {
      return { found: false, jobs: [], errors: [existsSync(this.scheduleFile) ? `schedule.json: ${e.message}` : 'app/schedule.json is missing'], raw: null }
    }
    return { found: true, raw, ...loadJobs(raw) }
  }

  running(): Set<string> { return new Set(this.live.keys()) }

  /** newest scheduled due per job, from the store (a job it has never seen has none: plan() starts it
   *  from now). The retired floor/schedule-log.jsonl horizon was dropped 2026-09-26: every job had
   *  store rows by then and the file was gone. */
  async lastDue(_jobs: Job[]): Promise<Map<string, number>> {
    await settled()
    return ops.lastDuePerJob()
  }

  /** one pass: plan, record, run. Returns the decisions it acted on. */
  async pass(now = Date.now()) {
    if (this.passing) return []
    this.passing = true
    try {
      await this.recovering
      const s = this.load()
      const decisions = s.found ? plan({
        jobs: s.jobs, now, lastDue: await this.lastDue(s.jobs), running: this.running(), stopped: this.stopped(),
        exists: rel => existsSync(resolve(this.fundRoot, rel)),
      }) : []
      for (const d of decisions) {
        if (d.action === 'run') {
          const job = s.jobs.find(j => j.id === d.job)!
          await this.launch(job, d.due, 'schedule')
        } else {
          await ops.addJobRun(d.job, d.action, { dueAt: d.due, startedAt: null, endedAt: now, detail: d.detail, trigger: 'schedule' })
          if (d.action === 'missed') {
            logEvent('job', `${d.job} missed (${fmtStamp(d.due)})`)
            const job = s.jobs.find(j => j.id === d.job)
            if (job) void this.writeJobHealth(job, 'warn', `missed ${fmtStamp(d.due)}, ${d.detail}`, now)
          }
        }
      }
      this.lastPass = { at: now, errors: s.errors, decisions: decisions.length }
      await this.writeHealth(now, s.errors, s.jobs)
      if (decisions.length) { publish('system', { pass: decisions.length }); publish('services') }
      return decisions
    } finally { this.passing = false }
  }

  /** "Run now": a manual row (due_at NULL), refused while stopped, disabled or already running */
  async runNow(id: string): Promise<number> {
    await this.recovering
    const s = this.load()
    const job = s.jobs.find(j => j.id === id)
    if (!job) throw Object.assign(new Error(`no job ${id} in schedule.json`), { status: 404 })
    if (this.stopped()) throw Object.assign(new Error('stopped (floor/STOP): resume first'), { status: 409 })
    if (!job.enabled) throw Object.assign(new Error(`${id} is disabled in schedule.json`), { status: 409 })
    if (this.live.has(id)) throw Object.assign(new Error(`${id} is already running`), { status: 409 })
    return this.launch(job, null, 'manual')
  }

  private async launch(job: Job, due: number | null, trigger: 'schedule' | 'manual'): Promise<number> {
    const t0 = Date.now()
    const row = await ops.startJobRun(job.id, due, { trigger, startedAt: t0 })
    const finish = (status: string, code: number | null, detail: string, conv: string | null = null) => {
      const endedAt = Date.now()
      void later('job run finish', () => ops.finishJobRun(row, status, { exitCode: code, detail, conversationId: conv, endedAt }))
      logEvent('job', `${job.id} ${status}${code !== null ? ` (exit ${code})` : ''}`, { payload: { detail: detail.slice(0, 600), trigger } })
      if (status === 'ok' || status === 'fail' || status === 'unknown') void this.writeJobHealth(job, status, `${status}${code !== null ? ` (exit ${code})` : ''}${trigger === 'manual' ? ' · manual' : ''}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
      publish('system', { job: job.id, status }); publish('services')
    }
    publish('system', { job: job.id, status: 'running' })

    if (job.kind === 'agent') {
      if (!this.startAgent) { finish('fail', null, 'no agent runner in this process'); return row }
      try { const conv = await this.startAgent(job); finish('ok', null, `started conversation ${conv}`, conv) } catch (e: any) { finish('fail', null, String(e?.message ?? e)) }
      return row
    }

    const cwdAbs = resolve(this.fundRoot, job.cwd)
    const cwd = within(cwdAbs, this.fundRoot) ? cwdAbs : null
    if (!cwd || !existsSync(cwd)) { finish('fail', null, `cwd ${job.cwd} is not on disk`); return row }
    const argv = resolveArgv(job.cmd, this.python)
    const exe = /[\\/]/.test(argv[0]) && !isAbsolute(argv[0]) ? resolve(this.fundRoot, argv[0]) : argv[0]
    const dir = join(this.logDir, job.id)
    mkdirSync(dir, { recursive: true })
    const stamp = new Date(t0).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const logPath = join(dir, `${stamp}-${row}.log`)
    await ops.updateJobRun(row, { log_path: logPath })
    const fd = openSync(logPath, 'a')
    writeSync(fd, `---- ${new Date(t0).toISOString()} ${trigger} ${job.id}: ${[exe, ...argv.slice(1)].join(' ')} (cwd ${job.cwd}, timeout ${job.timeoutS}s)\n`)
    const venv = [join(this.fundRoot, '.venv', 'Scripts'), join(this.fundRoot, '.venv', 'bin')].filter(d => existsSync(d))
    const env = prependPath(agentEnv({ ...process.env, FUND_ROOT: this.fundRoot, FUND_JOB: job.id, FUND_JOB_TRIGGER: trigger, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }), [this.fundRoot, ...venv])
    const live: Live = { rowId: row, pid: null, timer: null, killedFor: null }
    this.live.set(job.id, live)
    const done = (code: number | null, err?: string) => {
      if (this.live.get(job.id) !== live) return
      this.live.delete(job.id)
      if (live.timer) clearTimeout(live.timer)
      try { writeSync(fd, `\n---- ${new Date().toISOString()} exit ${code}${err ? ` (${err})` : ''}${live.killedFor ? ` (${live.killedFor})` : ''}\n`); closeSync(fd) } catch { /* closed */ }
      const tail = (tailLines(logPath, 6)?.lines ?? []).filter(l => l.trim() && !l.startsWith('----')).slice(-1)[0] ?? ''
      finish(exitStatus(code, live.killedFor ?? err ?? null, job.exit), code, live.killedFor ?? err ?? tail.slice(0, 400))
    }
    try {
      // detached: out of fundd's kill-on-close job object (Windows) / its process group (POSIX),
      // so a fundd restart leaves the job running for recover() to adopt; killTree still reaches it
      const child = spawn(exe, argv.slice(1), { cwd, env: env as NodeJS.ProcessEnv, windowsHide: true, shell: false, detached: true, stdio: ['ignore', fd, fd] })
      live.pid = child.pid ?? null
      const pid = live.pid
      if (pid) void later('job run pid', () => ops.updateJobRun(row, { pid }))
      child.once('error', e => done(null, e.message))
      child.once('exit', code => done(code))
      live.timer = setTimeout(() => {
        live.killedFor = `timeout after ${job.timeoutS}s`
        if (live.pid) void killTree(live.pid)
      }, job.timeoutS * 1000)
      live.timer.unref?.()
    } catch (e: any) { done(null, String(e?.message ?? e)) }
    return row
  }

  /** STOP pressed: kill every running job (their rows close as fail) */
  async killAll(reason = 'stopped by STOP') {
    await Promise.all([...this.live.values()].map(async l => { l.killedFor = reason; if (l.pid) await killTree(l.pid) }))
  }

  async counts(sinceMs: number) {
    await settled()          // a run closed from its exit event is queued: count it
    const t = await ops.jobRunTally(sinceMs)
    return { ran: t.ran, ok: t.ok, failed: t.failed, unknown: t.unknown, missed: t.missed, skipped: t.skipped }
  }

  /**
   * The scheduler's reading of a job with `health` true (the default): its last outcome, recorded in
   * the ops store as ops.health_readings `system:<id>` (target `system`, detail = the whole reading),
   * where the probes record theirs. A job with `health: false` records its own reading and is NEVER
   * touched here. window_s = the job's cadence period plus its grace (window_s in the schedule), the
   * moment the next reading is overdue, so a job that stops running goes stale and one on time never
   * does. Queued (db.later): a child's exit event calls it synchronously; returns the queued write.
   */
  writeJobHealth(job: Job, status: 'ok' | 'fail' | 'warn' | 'unknown', reading: string, now = Date.now()): Promise<unknown> {
    if (!job.health || job.id === 'scheduler') return Promise.resolve(null)
    const occ = occurrences(job.cadence, now, 2)
    const period = occ.length === 2 ? Math.round((occ[0] - occ[1]) / 1000) : job.windowS
    const body = {
      id: job.id, label: job.note || job.id, owner: 'scheduler', status, reading,
      probed_ts: Math.floor(now / 1000), window_s: period + job.windowS,
      detail: { cadence: job.cadence, cwd: job.cwd, cmd: job.cmd, written_by: 'app server/sched' },
    }
    return later(`job health ${job.id}`, () => ops.recordHealth(probeKey(job.id), PROBE_TARGET, status, { reading, detail: body, ts: now }))
  }

  /** the scheduler's own reading is recorded at most this often while it says the same thing */
  static readonly HEARTBEAT_MS = 5 * 60_000
  private lastOwn: { at: number; key: string } | null = null

  /**
   * `system:scheduler` - the scheduler's own reading, taken after every pass and RECORDED when any of it
   * changed or HEARTBEAT_MS has passed (a pass a minute would be 1,440 identical rows a day). Its
   * window is three heartbeats, so a scheduler that stops goes stale within 15 minutes. The reading
   * counts JOBS by their newest run (skipped aside), the same basis the Schedule tab and the System
   * sidebar use, so the three never disagree; the 24h run counts ride in `detail`.
   */
  async writeHealth(now: number, errors: string[], jobs: Job[] = this.load().jobs) {
    const c = await this.counts(now - 86_400_000)
    const j = jobTally(jobs, await lastRunPerJob())
    const stopped = this.stopped()
    const reading = `${jobReading(j)} (jobs, newest run)${stopped ? ' · stopped' : ''}${errors.length ? ` · ${errors.length} bad job${errors.length > 1 ? 's' : ''}` : ''}`
    const status = stopped ? 'unknown' : errors.length || j.fail ? 'fail' : j.missed ? 'warn' : 'ok'
    const key = JSON.stringify([status, reading, j, c, errors, stopped, [...this.live.keys()]])
    if (this.lastOwn && this.lastOwn.key === key && now - this.lastOwn.at < Scheduler.HEARTBEAT_MS) return
    const body = {
      id: 'scheduler', label: 'fundd scheduler (schedule.json)', owner: 'app', status, reading,
      probed_ts: Math.floor(now / 1000), window_s: Math.round(3 * Math.max(this.everyMs, Scheduler.HEARTBEAT_MS) / 1000),
      detail: { jobs: j, runs24h: c, running: [...this.live.keys()], errors, stopped },
    }
    this.lastOwn = { at: now, key }
    try { await ops.recordHealth(probeKey('scheduler'), PROBE_TARGET, status, { reading, detail: body, ts: now }) }
    catch (e: any) { this.lastOwn = null; console.error('[sched] own reading not recorded:', e?.message ?? e) }
  }
}

export type JobTally = { on: number; ok: number; fail: number; unknown: number; missed: number; never: number }

/** enabled jobs counted by their newest run: the one basis for every "N fail" the cockpit shows */
export function jobTally(jobs: Pick<Job, 'id' | 'enabled'>[], last: Map<string, Pick<RunRow, 'status'>>): JobTally {
  const t: JobTally = { on: 0, ok: 0, fail: 0, unknown: 0, missed: 0, never: 0 }
  for (const j of jobs) {
    if (!j.enabled) continue
    t.on++
    const st = last.get(j.id)?.status
    if (!st) t.never++
    else if (st === 'ok') t.ok++
    else if (st === 'fail') t.fail++
    else if (st === 'missed') t.missed++
    else if (st === 'unknown') t.unknown++
  }
  return t
}

export function jobReading(t: JobTally): string {
  const bad = [t.fail && `${t.fail} fail`, t.missed && `${t.missed} missed`, t.unknown && `${t.unknown} unknown`].filter(Boolean)
  return bad.length ? `${bad.join(' · ')} of ${t.on}` : `${t.on} ok`
}

/**
 * A script job's exit, read by the probe contract (app/tools/probes/_probe.py EXIT = ok 0, fail 1,
 * unknown 2; schedule.json: "0 ok, 1 fail, else unknown"). A kill (timeout, STOP) or a spawn
 * error is a fail; an exit with no code (a signal) is a fail; any other nonzero code is unknown.
 * A job whose tool speaks another contract says so in its own `exit` map (retro-due: 1 = a retro
 * is due, which is a nag, not a failure: `"exit": {"1": "unknown"}`); the map never overrides a kill.
 */
export function exitStatus(code: number | null, killedOrErr: string | null, map: Record<string, 'ok' | 'fail' | 'unknown'> = {}): 'ok' | 'fail' | 'unknown' {
  if (killedOrErr || code === null) return 'fail'
  const mapped = map[String(code)]
  if (mapped) return mapped
  if (code === 0) return 'ok'
  if (code === 1) return 'fail'
  return 'unknown'
}

export async function recentRuns(jobId: string | null, limit = 50): Promise<RunRow[]> {
  await settled()
  return ops.listJobRuns({ jobId: jobId ?? undefined, limit })
}

/** the newest row per job that says something (not a skip), else the newest row at all */
export async function lastRunPerJob(): Promise<Map<string, RunRow>> {
  await settled()
  return ops.latestJobRunPerJob()
}

export async function runRow(id: number): Promise<RunRow | null> {
  if (!Number.isSafeInteger(id)) return null
  await settled()
  return ops.getJobRun(id)
}

/** the newest run of a job that actually STARTED (missed / skipped rows never started) */
export async function lastStarted(jobId: string): Promise<RunRow | null> {
  await settled()
  return ops.lastStartedJobRun(jobId)
}

export type RunBanner = { what: string; started: number; ended: number | null; code: number | null; status?: string; tail: string }

/**
 * A scheduler run as the System room's "probes running / finished" banner reads it. The Run
 * probes button starts the `probe-sweep` JOB (2026-09-25): a room-private child process was
 * invisible to the scheduler, so the job still read `missed` after a manual sweep, and the two
 * could run the same sweep at once. A `running` row has no end even if ended_at is set.
 */
export function runBanner(row: Pick<RunRow, 'job_id' | 'started_at' | 'ended_at' | 'exit_code' | 'status'> | null, tail: string): RunBanner | null {
  if (!row || row.started_at === null) return null
  const running = row.status === 'running'
  return { what: row.job_id, started: row.started_at, ended: running ? null : (row.ended_at ?? row.started_at), code: running ? null : row.exit_code, status: row.status, tail }
}
