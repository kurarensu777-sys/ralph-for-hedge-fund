/**
 * The scheduler's cadence grammar, ported exactly from tools/fundcli/schedule.py
 * `occurrences()`: "daily HH:MM" | "every Nh" | "every Nm" | "weekly DOW HH:MM" | "at <iso>",
 * LOCAL time always; `every N` is a grid anchored at the unix epoch in LOCAL wall time (not at
 * the last run), so any two readers agree on what was due. Anything else parses to null and
 * the UI shows "-" rather than a guess.
 */

const DAILY = /^daily\s+(\d{1,2}):(\d{2})$/i
const EVERY = /^every\s+(\d+)\s*([hm])$/i
const WEEKLY = /^weekly\s+([a-z]+)\s+(\d{1,2}):(\d{2})$/i
const AT = /^at\s+(.+)$/i
const DOW: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6, monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6 }
const DAY = 86_400_000

/** local wall-clock ms (as python's naive local datetime) <-> real epoch ms */
export function toWall(t: number): number {
  const d = new Date(t)
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())
}
export function fromWall(w: number): number {
  const d = new Date(w)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()).getTime()
}

function parseLocalIso(s: string): number | null {
  const t = s.trim().replace(/[zZ]$/, '')
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
  if (!m) return null
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
}

/** python's weekday(): Monday = 0 */
const weekday = (wall: number) => (new Date(wall).getUTCDay() + 6) % 7

/** the most recent scheduled moment at or before `now` (python occurrences()[0]), or null */
export function lastOccurrence(cadence: string, now: number): number | null {
  const c = (cadence ?? '').trim()
  const w = toWall(now)
  let m = DAILY.exec(c)
  if (m) {
    const h = +m[1], mi = +m[2]
    if (h > 23 || mi > 59) return null
    let a = Math.floor(w / DAY) * DAY + (h * 60 + mi) * 60_000
    if (a > w) a -= DAY
    return fromWall(a)
  }
  m = WEEKLY.exec(c)
  if (m) {
    const dow = DOW[m[1].toLowerCase()]
    const h = +m[2], mi = +m[3]
    if (dow === undefined || h > 23 || mi > 59) return null
    let a = Math.floor(w / DAY) * DAY + (h * 60 + mi) * 60_000
    a -= ((weekday(a) - dow + 7) % 7) * DAY
    if (a > w) a -= 7 * DAY
    return fromWall(a)
  }
  m = EVERY.exec(c)
  if (m) {
    const n = +m[1]
    if (n <= 0) return null
    const step = (m[2].toLowerCase() === 'h' ? 3600 : 60) * n * 1000
    return fromWall(Math.floor(w / step) * step)
  }
  m = AT.exec(c)
  if (m) {
    const when = parseLocalIso(m[1])
    return when !== null && when <= w ? fromWall(when) : null
  }
  return null
}

/** the first scheduled moment strictly after `now`, or null (a past `at`, or an unparsable cadence) */
export function nextOccurrence(cadence: string, now: number): number | null {
  const c = (cadence ?? '').trim()
  const w = toWall(now)
  let m = DAILY.exec(c)
  if (m) {
    const last = lastOccurrence(c, now)
    return last === null ? null : fromWall(toWall(last) + DAY)
  }
  m = WEEKLY.exec(c)
  if (m) {
    const last = lastOccurrence(c, now)
    return last === null ? null : fromWall(toWall(last) + 7 * DAY)
  }
  m = EVERY.exec(c)
  if (m) {
    const n = +m[1]
    if (n <= 0) return null
    const step = (m[2].toLowerCase() === 'h' ? 3600 : 60) * n * 1000
    return fromWall((Math.floor(w / step) + 1) * step)
  }
  m = AT.exec(c)
  if (m) {
    const when = parseLocalIso(m[1])
    return when !== null && when > w ? fromWall(when) : null
  }
  return null
}

export function parses(cadence: string): boolean {
  const c = (cadence ?? '').trim()
  return [DAILY, EVERY, WEEKLY, AT].some(r => r.test(c)) && (lastOccurrence(c, Date.now()) !== null || nextOccurrence(c, Date.now()) !== null)
}

export type LogRow = { job: string; status: string; due_ts?: number; start?: number | null; end?: number | null; detail?: string; due?: string }

/** the newest schedule-log row per job (by due_ts, then end) */
export function lastRuns(rows: LogRow[]): Map<string, LogRow> {
  const out = new Map<string, LogRow>()
  const key = (r: LogRow) => (r.due_ts ?? 0) * 1e6 + (r.end ?? r.start ?? 0)
  for (const r of rows) {
    if (!r?.job) continue
    const cur = out.get(r.job)
    if (!cur || key(r) >= key(cur)) out.set(r.job, r)
  }
  return out
}

export function fmtIn(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${Math.max(m, 0)}m`
  if (m < 48 * 60) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}
