import { git } from './run.ts'
import { isDay, nextDay } from './eras.ts'

// ACTIVITY: commits per local day on HEAD, per repo and per agent (the first word of the first
// Agent trailer; '-' = no Agent trailer). Read-only: one `git log` per repo, cached by HEAD. It feeds
// the Git room's charts (a repo card's sparkline, the log's stacked day bars) and nothing else.

/** the --format the activity log is read with: epoch seconds, then the Agent trailer values */
export const ACTIVITY_FORMAT = '%x1e%at%x1f%(trailers:key=Agent,valueonly,separator=%x2C)'

/** the longest range one read covers (an era longer than this shows its last DAYS_CAP days) */
export const DAYS_CAP = 90

export type Activity = { total: number[]; agents: Record<string, number[]> }

const pad = (n: number) => String(n).padStart(2, '0')

/** a timestamp's LOCAL day, YYYY-MM-DD (git's --since/--until read local time too) */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** the day before a YYYY-MM-DD */
function prevDay(s: string): string {
  const d = new Date(`${s}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** every day from `since` to `until` inclusive, oldest first; the last DAYS_CAP when longer; [] when
 *  either end is not a day or since is after until */
export function dayRange(since: string, until: string, cap = DAYS_CAP): string[] {
  if (!isDay(since) || !isDay(until) || since > until) return []
  const out: string[] = []
  for (let d = until; d >= since && out.length < cap; d = prevDay(d)) out.push(d)
  return out.reverse()
}

/** the last n days ending today (local) */
export function lastDays(n: number, now = Date.now()): string[] {
  const today = dayKey(now)
  const out = [today]
  while (out.length < n) out.unshift(prevDay(out[0]))
  return out
}

/** "fund (fixer round 1), app" -> "fund"; empty -> '-' */
export function agentKey(trailer: string | null | undefined): string {
  const first = (trailer ?? '').split(',')[0].trim()
  return first ? first.split(/\s+/)[0] : '-'
}

/** `git log --format=ACTIVITY_FORMAT` -> one { ts, agent } per commit */
export function parseActivity(stdout: string): { ts: number; agent: string }[] {
  const out: { ts: number; agent: string }[] = []
  for (const rec of stdout.split('\x1e')) {
    if (!rec.trim()) continue
    const [at, agent] = rec.split('\x1f')
    const ts = Number(at) * 1000
    if (!Number.isFinite(ts) || ts <= 0) continue
    out.push({ ts, agent: agentKey(agent?.replace(/\n/g, ' ')) })
  }
  return out
}

/** commits into day buckets: total per day, and per agent per day; a commit outside `days` is left out */
export function bucket(entries: { ts: number; agent: string }[], days: string[]): Activity {
  const at = new Map(days.map((d, i) => [d, i]))
  const total = days.map(() => 0)
  const agents: Record<string, number[]> = {}
  for (const e of entries) {
    const i = at.get(dayKey(e.ts))
    if (i === undefined) continue
    total[i]++
    ;(agents[e.agent] ??= days.map(() => 0))[i]++
  }
  return { total, agents }
}

const cache = new Map<string, Activity>()

/** one repo's activity over `days` (oldest first); null when git cannot say (no HEAD, a failed log) */
export async function repoActivity(dir: string, days: string[]): Promise<Activity | null> {
  if (!days.length) return { total: [], agents: {} }
  const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  if (!head) return null
  const since = days[0], until = days[days.length - 1]
  const key = `${dir}|${head}|${since}|${until}`
  const hit = cache.get(key)
  if (hit) return hit
  const out = await git(dir, ['log', `--since=${since} 00:00:00`, `--until=${nextDay(until)} 00:00:00`, `--format=${ACTIVITY_FORMAT}`])
  if (out.code !== 0) return null
  const a = bucket(parseActivity(out.stdout), days)
  if (cache.size > 200) cache.clear()
  cache.set(key, a)
  return a
}
