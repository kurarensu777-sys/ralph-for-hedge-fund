import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Router } from '../http.ts'
import { HttpError } from '../http.ts'
import type { ServiceRow } from '../../shared/types.ts'
import { BACKUP_KEEP, backupDb, backupDir, backupStatus, listBackups, localDay, type BackupResult } from '@fund/db'
import { logEvent, ops, where, whereText } from '../db.ts'
import { publish } from '../events.ts'
import { DATA_DIR, FUND_ROOT, LOCAL_TZ, SCHEDULE_FILE } from '../paths.ts'
import { agentsDoc, config } from '../config.ts'
import { agentEnv } from '../chat/env.ts'
import { killTree } from '../proc/ports.ts'
import { ceilings, colorSlots, spendSeries, SPEND_METRIC, type DayRow } from './spend.ts'
import { Remote } from './remote.ts'
import { capOf, liftCap, liftedToday, localMidnight, usedSinceAll } from './cap.ts'
import { recentBurn } from './burn.ts'

// OPS - the System room's operations half: the nightly database backup, the 30-day spend series,
// the phone bridge (claude remote-control) and how this fundd was started (dev or prod).

/** where the nightly archives are: the data layer's own choice (@fund/db backupDir(), the same
 *  folder `python -m fund_db backup` writes: FUND_DB_BACKUP_DIR, else ~/fund-data/backups/db) */
export const BACKUP_DIR = backupDir()
/** the scheduler job that runs `python -m fund_db backup` every night (app/schedule.json) */
export const BACKUP_JOB = 'db-backup'

// ---- backups ----
let lastManual: { at: number; result?: BackupResult; error?: string } | null = null
let backingUp = false

async function backups() {
  const now = Date.now()
  const files = listBackups(BACKUP_DIR)
  const job = jobInSchedule()
  const run = (await ops.select('job_runs', { where: { job_id: BACKUP_JOB }, orderBy: '-id', limit: 1 }))[0]
  return {
    dir: BACKUP_DIR, keep: BACKUP_KEEP, files, ...backupStatus(files, now), running: backingUp,
    job: job ? { id: BACKUP_JOB, cadence: job.cadence ?? '', enabled: job.enabled !== false } : null,
    lastJob: run ? { status: run.status, start: run.started_at, end: run.ended_at, detail: run.detail } : null, lastManual,
  }
}

function jobInSchedule(): any | null {
  try {
    const j = JSON.parse(readFileSync(SCHEDULE_FILE, 'utf8'))
    return (Array.isArray(j.jobs) ? j.jobs : []).find((x: any) => x?.id === BACKUP_JOB) ?? null
  } catch { return null }
}

async function backupNow() {
  if (backingUp) throw new HttpError(409, 'a backup is already running')
  backingUp = true
  publish('system', { backup: 'running' })
  try {
    const result = await backupDb({ conn: where(), dir: BACKUP_DIR })
    lastManual = { at: Date.now(), result }
    logEvent('system', `backup ${result.file}: ${(result.bytes / 1048576).toFixed(1)} MB via ${result.method}`)
    return result
  } catch (e: any) {
    lastManual = { at: Date.now(), error: String(e?.message ?? e) }
    logEvent('system', `backup failed: ${lastManual.error}`)
    throw new HttpError(500, lastManual.error!)
  } finally {
    backingUp = false
    publish('system', { backup: 'done' }); publish('services')
  }
}

// ---- spend: 30 local days per agent, billable = input + cache writes + output ----
export async function spendDaily(days = 30) {
  const today = localDay(Date.now())
  const since = Date.now() - (days + 1) * 86_400_000
  // the owner's local day (LOCAL_TZ, this machine's zone), as the old SQLite 'localtime' grouping was
  const rows: DayRow[] = (await ops.usageByDay(since, LOCAL_TZ)).map(r => ({ agent: r.agent, day: r.day, billable: r.billable, cost: r.cost, n: r.n }))
  const series = spendSeries(rows, today, days)
  const c = ceilings(agentsDoc())             // no roster: no ceilings
  const ti = series.days.length - 1
  const now = Date.now()
  const burn = await recentBurn()
  const used = await usedSinceAll(localMidnight(now))
  const todayBy = series.agents.map((a, i) => {
    const ceiling = a in c.byAgent ? c.byAgent[a] : c.fallback
    const cap = capOf(used.get(a) ?? 0, ceiling, liftedToday(a, now))
    return {
      agent: a, billable: series.cells[ti]?.[i] ?? 0, ceiling,
      capped: cap?.capped ?? false, lifted: cap?.lifted ?? false,
      alerts: burn.filter(x => x.agent === a).map(x => ({ ts: x.ts, billable: x.billable, median: x.median, multiple: x.multiple })),
    }
  })
  const cost = rows.filter(r => series.days.includes(r.day)).reduce((s, r) => s + (r.cost || 0), 0)
  return { metric: SPEND_METRIC, today, series, todayBy, ceilings: c, costUsd: cost, slots: colorSlots(series.agents, config.agents().map(a => a.id)) }
}

// ---- remote: one phone bridge per repo ----
export const remote = new Remote({
  fundRoot: FUND_ROOT,
  stateFile: join(DATA_DIR, 'remote.json'),
  repos: () => config.repos().map(r => ({ id: r.id, path: r.path })),
  env: () => agentEnv({ ...process.env, FUND_ROOT }),
  onChange: () => { publish('system', { remote: true }); publish('services') },
  log: msg => logEvent('system', msg),
  killTree,
})

async function remoteView() {
  const [cli, account] = await Promise.all([remote.availability(), remote.whoami().catch(() => null)])
  return { cli, account, bridges: remote.list() }
}

const repoId = (b: any) => {
  const id = String(b?.repo ?? '')
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new HttpError(400, 'body is {repo: "<repos.json id>"}')
  return id
}

// ---- mode ----
export const MODE = process.env.FUND_MODE === 'prod' || process.argv.includes('--serve-dist') ? 'prod' : 'dev'

export function registerOps(r: Router) {
  r.get('/api/system/backups', () => backups())
  r.post('/api/system/backups/run', () => backupNow())
  r.post('/api/system/cap/:agent/lift', ({ params }) => {
    const a = String(params.agent ?? '')
    if (!config.agents().some(x => x.id === a)) throw new HttpError(404, `no agent ${a}`)
    liftCap(a)
    publish('system', { cap: a })
    return { agent: a, lifted: true }
  })
  r.get('/api/system/spend/daily', ({ query }) => spendDaily(Math.min(Math.max(Number(query.get('days')) || 30, 7), 90)))

  r.get('/api/system/remote', () => remoteView())
  r.post('/api/system/remote/start', async ({ body }) => {
    const id = repoId(await body())
    const cli = await remote.availability()
    if (!cli.available) throw new HttpError(503, cli.reason ?? 'remote-control is unavailable')
    try { return remote.start(id) } catch (e: any) { throw new HttpError(e.status ?? 500, e.message) }
  })
  r.post('/api/system/remote/stop', async ({ body }) => ({ bridge: await remote.stop(repoId(await body())) ?? null }))

  r.get('/api/system/mode', () => ({ mode: MODE, pid: process.pid, dataDir: DATA_DIR, db: whereText() }))

  // bridges a previous fundd left running are reaped and raised again; fundd's own exit takes them along
  void remote.resume({ raise: true }).catch(e => logEvent('system', `remote resume: ${e?.message ?? e}`))
  process.on('exit', () => remote.killAllSync())
}

export function opsStop() { return remote.stopAll() }

export function opsServiceRows(): ServiceRow[] {
  const b = backupStatus(listBackups(BACKUP_DIR), Date.now())
  const live = remote.list().filter(x => x.running)
  const rows: ServiceRow[] = [
    { id: 'sys:backups', label: 'backups', room: 'system', target: 'health', status: b.status, reading: b.reading.split(' · ')[0], hint: b.reading },   // rail: "1 kept"; day + size in the tooltip
  ]
  if (live.length) rows.push({
    id: 'sys:remote', label: 'remote', room: 'system', target: 'remote',
    status: live.some(x => x.status === 'error') ? 'fail' : live.every(x => x.status === 'connected') ? 'ok' : 'unknown',
    reading: live.map(x => `${x.repo} ${x.status}`).join(' · '),
  })
  return rows
}
