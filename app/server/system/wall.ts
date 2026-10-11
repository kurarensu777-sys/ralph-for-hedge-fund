import { fromWall, lastOccurrence, toWall } from './schedule.ts'

/**
 * THE CADENCE WALL's pure half (System > Schedule > Wall): what each job OWED over a window
 * against what actually RAN. No I/O; pinned in test/system-wall.test.ts.
 *
 *   occurrence  every scheduled moment of a cadence inside [from, to], stepped on the LOCAL wall
 *               clock exactly as the scheduler steps it (sched/plan.ts occurrences), so a daily
 *               06:30 stays 06:30 across a DST change and the wall never disagrees with the planner
 *   consumed    a job_runs row whose due_at equals the occurrence; the row's status is the mark
 *   missed      unconsumed and older than the job's window_s (the scheduler never runs it late)
 *   owed        unconsumed and still inside its window, or in the future
 * A manual run (due_at NULL) is an actual that consumes nothing. A row whose due_at matches no
 * enumerated occurrence (the cadence changed since) is still drawn, at its own due_at.
 */

const DAY = 86_400_000
const DAILY = /^daily\s/i, WEEKLY = /^weekly\s/i, AT = /^at\s/i
const EVERY = /^every\s+(\d+)\s*([hm])$/i

/** the wall-clock step of a cadence (ms), or null for `at` / an unparsable cadence */
export function stepOf(cadence: string): number | null {
  const c = cadence.trim()
  const m = EVERY.exec(c)
  if (m) return +m[1] > 0 ? (m[2].toLowerCase() === 'h' ? 3600 : 60) * +m[1] * 1000 : null
  if (WEEKLY.test(c)) return 7 * DAY
  if (DAILY.test(c)) return DAY
  return null
}

/** every scheduled moment in [from, to], ascending, de-duplicated (a spring-forward gap maps two
 *  wall moments onto one instant). `max` bounds a fine cadence over a long window. */
export function occurrencesIn(cadence: string, from: number, to: number, max = 5000): number[] {
  const c = (cadence ?? '').trim()
  if (to < from) return []
  const last = lastOccurrence(c, to)
  if (last === null) return []
  if (AT.test(c)) return last >= from ? [last] : []
  const step = stepOf(c)
  if (step === null) return []
  const w = toWall(last)
  const out = new Set<number>()
  for (let k = 0; k < max; k++) {
    const t = fromWall(w - k * step)
    // a DST hour can reorder two neighbouring instants: stop only well past `from`
    if (t < from - 2 * 3_600_000) break
    if (t >= from && t <= to) out.add(t)
  }
  return [...out].sort((a, b) => a - b)
}

export type WallRun = { id: number; due_at: number | null; started_at: number | null; ended_at: number | null; status: string; trigger?: string; detail?: string | null }
export type Mark = {
  t: number                    // the occurrence (or the run's own start, for a manual run)
  end: number | null           // a run's end; an owed mark's grace end
  kind: 'run' | 'owed' | 'missed' | 'skipped'
  status: string               // ok | fail | unknown | running | missed | skipped | owed
  row: number | null           // job_runs id
  manual?: boolean
  detail?: string
}

export type LaneJob = { cadence: string; windowS: number; enabled: boolean }

/** one job's marks over [from, to] at `now`. `since` = when the run record begins: an unconsumed
 *  occurrence before it is neither missed nor owed - the record cannot tell - so it is not drawn. */
export function laneMarks(job: LaneJob, runs: WallRun[], from: number, to: number, now: number, since = -Infinity): Mark[] {
  const occ = job.enabled ? occurrencesIn(job.cadence, from, to) : []
  const byDue = new Map<number, WallRun>()
  for (const r of runs) {
    if (r.due_at === null) continue
    // a 'missed' the scheduler wrote on first start for an occurrence whose grace ended before the
    // record began: the record cannot vouch for it either way, so it is not drawn (same rule as below)
    if (r.status === 'missed' && r.due_at + job.windowS * 1000 < since) continue
    const cur = byDue.get(r.due_at)
    // a skipped row and a real run for one occurrence: the run is the mark
    if (!cur || (cur.status === 'skipped' && r.status !== 'skipped') || (cur.status === r.status && r.id > cur.id)) byDue.set(r.due_at, r)
  }
  const marks: Mark[] = []
  const put = (r: WallRun, t: number, manual = false) => {
    const kind: Mark['kind'] = r.status === 'missed' ? 'missed' : r.status === 'skipped' ? 'skipped' : 'run'
    marks.push({ t, end: kind === 'run' ? (r.ended_at ?? (r.status === 'running' ? now : r.started_at)) : null, kind, status: r.status, row: r.id, manual, detail: r.detail ?? '' })
  }
  const seen = new Set<number>()
  for (const t of occ) {
    const r = byDue.get(t)
    if (r) { put(r, r.status === 'missed' || r.status === 'skipped' ? t : r.started_at ?? t); seen.add(t); continue }
    const graceEnd = t + job.windowS * 1000
    if (graceEnd < since) continue
    if (t <= now && now > graceEnd) marks.push({ t, end: null, kind: 'missed', status: 'missed', row: null, detail: 'no run recorded' })
    else marks.push({ t, end: graceEnd, kind: 'owed', status: 'owed', row: null })
  }
  for (const [due, r] of byDue) {
    if (seen.has(due) || due < from || due > to) continue
    put(r, r.status === 'missed' || r.status === 'skipped' ? due : r.started_at ?? due)
  }
  for (const r of runs) {
    if (r.due_at !== null) continue
    const t = r.started_at ?? r.ended_at
    if (t === null || t < from || t > to) continue
    put(r, t, true)
  }
  return marks.sort((a, b) => a.t - b.t)
}

/** the tally a lane's tooltip carries */
export function laneTally(marks: Mark[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of marks) out[m.status] = (out[m.status] ?? 0) + 1
  return out
}

// ---------------------------------------------------------------- lab fixed-age reads
export type ReadIn = { key: string; desk: string; run: string; reads: Record<'7d' | '30d', { due: number | null; state: string; row?: Record<string, any> }> }
const iso = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null }
  return null
}
/** one lane per lab run whose +7d / +30d read falls in the window, or is owed (due / late) now */
export function readLanes(runs: ReadIn[], from: number, to: number): { key: string; desk: string; run: string; marks: Mark[] }[] {
  const out: { key: string; desk: string; run: string; marks: Mark[] }[] = []
  for (const r of runs) {
    const marks: Mark[] = []
    for (const age of ['7d', '30d'] as const) {
      const c = r.reads[age]
      if (!c || c.due === null) continue
      const owed = c.state === 'due' || c.state === 'late'
      const at = c.state === 'done' ? iso(c.row?.ts) ?? c.due : c.due
      if (!owed && (at < from || at > to)) continue
      const detail = `+${age} read`
      if (c.state === 'done') marks.push({ t: Math.max(at, from), end: Math.max(at, from), kind: 'run', status: 'ok', row: null, detail })
      else if (c.state === 'missed' || c.state === 'late') marks.push({ t: Math.max(c.due, from), end: null, kind: 'missed', status: c.state, row: null, detail })
      else if (c.state === 'due' || c.state === 'pending') marks.push({ t: Math.max(c.due, from), end: c.due + 4 * DAY, kind: 'owed', status: 'owed', row: null, detail })
    }
    if (marks.length) out.push({ key: r.key, desk: r.desk, run: r.run, marks: marks.sort((a, b) => a.t - b.t) })
  }
  return out.sort((a, b) => (a.marks[0]?.t ?? 0) - (b.marks[0]?.t ?? 0))
}
