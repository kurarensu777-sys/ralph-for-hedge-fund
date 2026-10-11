/**
 * Health HISTORY: what the dashboard checks read over a window, from health_readings. Pure (the
 * room runs the query), so the rule is testable.
 *
 * A RUN is one checkDashboard() pass: every probe of a dashboard written with the same ts. Its
 * state follows the live status rule (health.ts dashStatus): a failed PORT check = off (stopped,
 * nobody started it; grey, not red), else any fail = fail, any warn = warn, any unknown = unknown,
 * else ok. UPTIME is read from the SAME runs the strip draws: the share of runs that were serving
 * (ok or warn) over the runs whose state is known (ok, warn, fail, off). A failing health check
 * with the port open is DOWN here, exactly as the strip paints it red. The window before the first
 * run is not sampled: the strip leaves it empty and the percentage covers only `first`..now. No
 * known run in the window = uptime null (unknown), never 0.
 */

export type RunState = 'ok' | 'warn' | 'fail' | 'off' | 'unknown'
/** a cell's state: a run state, or `part` = the hour held a stop AND serving runs (drawn half green,
 *  half grey), so a strip never reads all grey beside an uptime that says it served */
export type CellState = RunState | 'part'
export type HistRow = { probe_id: string; ts: number; status: string; reading?: string | null }
/** what a cell shows on hover: the run it draws (its time), how many runs fell in it, and the
 *  checks that were not ok in that run (`check: reading`), or '' when every check was ok */
export type CellNote = { at: number; n: number; note: string }
export type DashHistory = {
  id: string
  runs: number                   // check passes in the window
  up: number                     // of which were serving (ok or warn)
  measured: number               // runs with a known state (ok, warn, fail, off)
  uptime: number | null          // up / measured, 0..1; null = cannot tell
  first: number | null           // the first run in the window: the percentage covers first..to
  counts: Record<RunState, number>
  cells: (CellState | null)[]    // one per bucket, oldest first; null = no run in that bucket
  notes: (CellNote | null)[]     // index-aligned with cells
  from: number; to: number; bucketMs: number
}

// a bucket shows its worst run; a stop inside a healthy bucket is shown, not averaged away
const RANK: Record<RunState, number> = { ok: 0, off: 1, unknown: 2, warn: 3, fail: 4 }
export const worst = (a: RunState | null, b: RunState): RunState => (a === null || RANK[b] > RANK[a] ? b : a)

/** `dash:<id>/<check>` -> [id, check]; null for any other probe */
export function parseProbe(probe: string): [string, string] | null {
  const m = /^dash:([^/]+)\/(.+)$/.exec(probe)
  return m ? [m[1], m[2]] : null
}

/** the state of one run from its (check id -> status) readings */
export function runState(readings: Map<string, string>, portChecks: Set<string>): RunState {
  const ports = [...readings.entries()].filter(([c]) => portChecks.has(c))
  if (ports.some(([, s]) => s === 'fail')) return 'off'
  const ss = [...readings.values()]
  if (ss.includes('fail')) return 'fail'
  if (ss.includes('warn')) return 'warn'
  if (ss.length === 0 || ss.some(s => s !== 'ok')) return 'unknown'
  return 'ok'
}

/**
 * @param rows      health_readings rows (target = 'dashboard') inside [now - windowMs, now]
 * @param dashes    id -> the ids of its port checks (from the dashboard.json files)
 */
export function summarize(rows: HistRow[], dashes: Map<string, Set<string>>, now: number, windowMs = 24 * 3_600_000, buckets = 48): DashHistory[] {
  return summarizeFrom(rows, dashes, now - windowMs, now, windowMs / buckets, buckets)
}

/** the heat strip: `hours` CLOCK hours, the last one the hour in progress (13:00-14:00Z is one cell) */
export function summarizeHours(rows: HistRow[], dashes: Map<string, Set<string>>, now: number, hours = 24): DashHistory[] {
  const H = 3_600_000
  const from = Math.floor(now / H) * H - (hours - 1) * H
  return summarizeFrom(rows, dashes, from, now, H, hours)
}

function summarizeFrom(rows: HistRow[], dashes: Map<string, Set<string>>, from: number, now: number, bucketMs: number, buckets: number): DashHistory[] {
  type Rd = Map<string, { s: string; r: string }>
  const runs = new Map<string, Map<number, Rd>>()
  for (const r of rows) {
    if (r.ts < from || r.ts > now) continue
    const p = parseProbe(r.probe_id)
    if (!p || !dashes.has(p[0])) continue
    let byTs = runs.get(p[0])
    if (!byTs) runs.set(p[0], byTs = new Map())
    let rd = byTs.get(r.ts)
    if (!rd) byTs.set(r.ts, rd = new Map())
    rd.set(p[1], { s: r.status, r: r.reading ?? '' })
  }
  return [...dashes.entries()].map(([id, portChecks]) => {
    const counts: Record<RunState, number> = { ok: 0, warn: 0, fail: 0, off: 0, unknown: 0 }
    const cells: (RunState | null)[] = Array(buckets).fill(null)
    const served: boolean[] = Array(buckets).fill(false)
    const notes: (CellNote | null)[] = Array(buckets).fill(null)
    let measured = 0
    let up = 0
    let first: number | null = null
    const byTs = runs.get(id) ?? new Map<number, Rd>()
    for (const [ts, rd] of [...byTs].sort((a, b) => a[0] - b[0])) {
      const st = runState(new Map([...rd].map(([c, x]) => [c, x.s])), portChecks)
      counts[st]++
      if (first === null || ts < first) first = ts
      const b = Math.min(buckets - 1, Math.max(0, Math.floor((ts - from) / bucketMs)))
      const prev = cells[b]
      cells[b] = worst(prev, st)
      const n = (notes[b]?.n ?? 0) + 1
      // the note follows the run the cell draws: the first run of the worst state (later runs of the same state keep it)
      if (prev === null || cells[b] !== prev) {
        const bad = [...rd].filter(([, x]) => x.s !== 'ok').map(([c, x]) => `${c}: ${x.s}${x.r ? ` (${x.r})` : ''}`)
        notes[b] = { at: ts, n, note: bad.join('; ') }
      } else notes[b] = { ...notes[b]!, n }
      if (st !== 'unknown') { measured++; if (st === 'ok' || st === 'warn') { up++; served[b] = true } }
    }
    const shown: (CellState | null)[] = cells.map((c, b) => (c === 'off' && served[b] ? 'part' : c))
    return { id, runs: byTs.size, up, measured, uptime: measured ? up / measured : null, first, counts, cells: shown, notes, from, to: now, bucketMs }
  })
}
