import { dur } from '../../shared/time.ts'
import { fromWall, lastOccurrence, toWall } from '../system/schedule.ts'
import { EXACT_ID } from '../../shared/models.ts'

/**
 * THE SCHEDULER'S PURE HALF: schedule.json -> jobs, and (jobs, the run record, now) -> what
 * to do this pass. No I/O here, so every rule below is pinned in test/sched.test.ts.
 *
 * It replaces `fund tick`, ported from the retired fund CLI (git history), and keeps its three
 * promises:
 *   - the cadence grammar is the same one ("daily HH:MM" | "every Nh" | "every Nm" |
 *     "weekly DOW HH:MM" | "at <iso>", LOCAL time, `every N` an epoch-anchored grid), so any two
 *     readers agree on what was due;
 *   - an occurrence whose `window_s` passed with no run is logged MISSED, never run late;
 *   - while floor/STOP exists nothing starts: every due occurrence logs SKIPPED.
 */

export type Job = {
  id: string
  kind: 'script' | 'agent'
  cmd: string[]              // script jobs: argv, never a shell string
  cwd: string                // fund-relative
  prompt: string             // agent jobs
  agent: string              // agent jobs: the roster id (or a desk it writes)
  model: string              // agent jobs: an EXACT id from Claude Code's permitted list ('' = the roster's)
  effort: string             // agent jobs: one of that model's effort levels ('' = the roster's)
  desk: string
  cadence: string
  windowS: number
  timeoutS: number
  enabled: boolean
  unattended: boolean        // agent jobs only: may the scheduler start it by itself
  requires: string           // fund-relative path that must exist, else SKIPPED
  health: boolean
  exit: Record<string, 'ok' | 'fail' | 'unknown'>   // per-job exit-code map over the probe contract
  note: string
}

export const DEFAULTS = { window_s: 7200, timeout_s: 1800 }
const DAY = 86_400_000
const ID = /^[A-Za-z0-9._-]+$/
const norm = (p: unknown) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '')

/**
 * Accepts the 2026-09-24 shape `{id, cadence, cwd, cmd, window_s, timeout_s, health}` and the
 * retired fundcli shape (`command`, `kind`, `desk`, `prompt`, `enabled`, `requires`...). A job that
 * cannot run as written is an ERROR naming it - never a job that silently never fires.
 */
export function loadJobs(doc: unknown): { jobs: Job[]; errors: string[] } {
  const errors: string[] = []
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { jobs: [], errors: ['schedule.json is not an object'] }
  const d = doc as Record<string, any>
  const defs = { ...DEFAULTS, ...(d.defaults && typeof d.defaults === 'object' ? d.defaults : {}) }
  const jobs: Job[] = []
  const seen = new Set<string>()
  for (const row of Array.isArray(d.jobs) ? d.jobs : []) {
    if (!row || typeof row !== 'object') continue
    const id = String(row.id ?? '').trim()
    if (!ID.test(id)) { errors.push(`job id ${JSON.stringify(id)} is missing or not filename-safe`); continue }
    if (seen.has(id)) { errors.push(`two jobs with id ${id}`); continue }
    seen.add(id)
    const rawCmd = row.cmd ?? row.command ?? []
    if (typeof rawCmd === 'string') { errors.push(`${id}: cmd must be an argv LIST, not a shell string`); continue }
    const kind: Job['kind'] = row.kind === 'agent' || (!rawCmd.length && row.prompt) ? 'agent' : 'script'
    const cadence = String(row.cadence ?? '').trim()
    if (!parsesNow(cadence)) { errors.push(`${id}: cadence ${JSON.stringify(cadence)} is not one of daily HH:MM | every Nh | every Nm | weekly DOW HH:MM | at <iso>`); continue }
    const job: Job = {
      id, kind,
      cmd: (Array.isArray(rawCmd) ? rawCmd : []).map(String),
      cwd: norm(row.cwd ?? '') || '.',
      prompt: String(row.prompt ?? ''),
      agent: String(row.agent ?? ''),
      model: String(row.model ?? '').trim(),
      effort: String(row.effort ?? '').trim(),
      desk: norm(row.desk ?? '') || '.',
      cadence,
      windowS: Number(row.window_s ?? defs.window_s) || DEFAULTS.window_s,
      timeoutS: Number(row.timeout_s ?? defs.timeout_s) || DEFAULTS.timeout_s,
      enabled: row.enabled !== false,
      unattended: row.unattended === true,
      requires: norm(row.requires ?? ''),
      health: row.health !== false,
      exit: {},
      note: String(row.note ?? ''),
    }
    if (row.exit !== undefined) {
      if (!row.exit || typeof row.exit !== 'object' || Array.isArray(row.exit)) { errors.push(`${id}: exit must be an object like {"1": "unknown"}`); continue }
      const bad = Object.entries(row.exit).filter(([k, v]) => !/^\d+$/.test(k) || !['ok', 'fail', 'unknown'].includes(String(v)))
      if (bad.length) { errors.push(`${id}: exit maps an exit CODE to ok | fail | unknown (bad: ${bad.map(([k]) => k).join(', ')})`); continue }
      job.exit = Object.fromEntries(Object.entries(row.exit).map(([k, v]) => [k, v as Job['exit'][string]]))
    }
    if (kind === 'script' && !job.cmd.length) { errors.push(`${id}: script job has no cmd`); continue }
    if (kind === 'agent' && !job.prompt.trim()) { errors.push(`${id}: agent job has no prompt`); continue }
    if (kind === 'script' && (job.model || job.effort)) { errors.push(`${id}: a script job runs no model - model/effort belong to agent jobs`); continue }
    if (job.model && !EXACT_ID.test(job.model)) { errors.push(`${id}: model ${JSON.stringify(job.model)} is not an exact id (claude-...; pick one from Claude Code's permitted list, never an alias)`); continue }
    jobs.push(job)
  }
  return { jobs, errors }
}

function parsesNow(c: string): boolean {
  if (!/^(daily|every|weekly|at)\s/i.test(c)) return false
  if (/^at\s/i.test(c)) return /^at\s+\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?[zZ]?$/i.test(c)
  return lastOccurrence(c, Date.now()) !== null
}

/** every scheduled moment at or before `now`, MOST RECENT FIRST (fundcli occurrences()) */
export function occurrences(cadence: string, now: number, limit = 8): number[] {
  const c = cadence.trim()
  const last = lastOccurrence(c, now)
  if (last === null) return []
  if (/^at\s/i.test(c)) return [last]
  let step: number
  const every = /^every\s+(\d+)\s*([hm])$/i.exec(c)
  if (every) step = (every[2].toLowerCase() === 'h' ? 3600 : 60) * Number(every[1]) * 1000
  else if (/^weekly\s/i.test(c)) step = 7 * DAY
  else step = DAY
  // step on the WALL clock, so a daily 06:30 stays 06:30 across a DST change
  const w = toWall(last)
  return Array.from({ length: limit }, (_, k) => fromWall(w - k * step))
}

export type Action = 'run' | 'missed' | 'skipped'
export type Decision = { job: string; due: number; action: Action; detail: string }

export type PlanInput = {
  jobs: Job[]
  now: number
  /** newest SCHEDULED due_at (ms) recorded per job; absent = the job has no scheduled history */
  lastDue: Map<string, number>
  running: Set<string>
  stopped: boolean
  exists: (rel: string) => boolean
  limit?: number
}

/**
 * One pass. Per job, the occurrences after its newest recorded one; oldest first. A job with no
 * history considers only its latest occurrence, and only while that one is still inside its grace:
 * past it, the scheduler cannot tell a miss from a job that did not exist yet (added to
 * schedule.json after the occurrence, B-0038), so it writes nothing and waits for the next one.
 *   window passed                 -> missed (it is never run late)
 *   inside the window             -> skipped (stopped | disabled | requires missing | agent job not
 *                                    unattended | still running | superseded by a newer one), else run
 * At most ONE run per job per pass.
 */
export function plan(i: PlanInput): Decision[] {
  const out: Decision[] = []
  for (const j of i.jobs) {
    const occ = occurrences(j.cadence, i.now, i.limit ?? 8).reverse()
    const horizon = i.lastDue.get(j.id)
    const todo = horizon === undefined
      ? occ.slice(-1).filter(o => i.now - o <= j.windowS * 1000)
      : occ.filter(o => o > horizon)
    const live = todo.filter(o => i.now - o <= j.windowS * 1000)
    const newest = live.length ? live[live.length - 1] : null
    for (const o of todo) {
      const d = (action: Action, detail: string) => out.push({ job: j.id, due: o, action, detail })
      if (!j.enabled) { d('skipped', 'disabled in schedule.json'); continue }
      if (i.now - o > j.windowS * 1000) { d('missed', `no run within its ${dur(j.windowS)} grace`); continue }
      if (i.stopped) { d('skipped', 'stopped (floor/STOP)'); continue }
      if (o !== newest) { d('skipped', 'superseded by a newer occurrence'); continue }
      if (j.requires && !i.exists(j.requires)) { d('skipped', `requires ${j.requires}, which is missing`); continue }
      if (j.kind === 'agent' && !j.unattended) { d('skipped', 'agent job: needs "unattended": true to start by itself'); continue }
      if (i.running.has(j.id)) { d('skipped', 'previous run still running'); continue }
      d('run', '')
    }
  }
  return out
}

/** argv[0] 'python' / 'python3' is the fund venv's interpreter (fundcli did the same) */
export function resolveArgv(cmd: string[], python: string): string[] {
  if (!cmd.length) return cmd
  const [exe, ...rest] = cmd
  return [/^python3?(\.exe)?$/i.test(exe) ? python : exe, ...rest]
}
