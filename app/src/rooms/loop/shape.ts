// Pure shapes the Loop room draws (no React): the Learned grid, the retro chips, the funnel.

const DAY = 86_400_000
const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY
const md = (ms: number) => new Date(ms).toISOString().slice(5, 10)

// ---- LEARNED: lessons as an agent x day grid (UTC days, like every other date in the cockpit) ----

export type GridCol = { from: number; to: number; label: string }
export type GridRow<T> = { agent: string | null; cells: T[][]; total: number }
export type Grid<T> = { cols: GridCol[]; rows: GridRow<T>[]; max: number; bucket: number }

/** one column per UTC day of the range (7d, 30d), today on the right; `all` spans the first lesson to
 *  today in at most `cap` columns (a column then holds several days). One row per agent, the most
 *  lessons first; the unattributed row (agent null) last. A lesson older than the first column (the
 *  range cut mid-day) joins the first column's day, never dropped */
export function lessonGrid<T>(items: T[], at: (x: T) => number, who: (x: T) => string | null, days: number | null, now: number, cap = 30): Grid<T> {
  const today = dayStart(now)
  const first = items.length ? dayStart(Math.min(...items.map(at))) : today
  const start = days === null ? Math.min(first, today) : Math.min(first, today - (days - 1) * DAY)
  const span = Math.round((today - start) / DAY) + 1
  const bucket = days === null ? Math.max(1, Math.ceil(span / cap)) : 1
  const n = Math.ceil(span / bucket)
  // the last column ends today; the first may be short when the span does not divide
  const cols: GridCol[] = Array.from({ length: n }, (_, i) => {
    const to = today + DAY - (n - 1 - i) * bucket * DAY
    const from = Math.max(start, to - bucket * DAY)
    return { from, to, label: bucket === 1 ? md(from) : `${md(from)} to ${md(to - DAY)}` }
  })
  const byAgent = new Map<string | null, T[][]>()
  for (const x of items) {
    const t = at(x)
    let i = cols.findIndex(c => t >= c.from && t < c.to)
    if (i < 0) i = t < cols[0].from ? 0 : cols.length - 1
    const k = who(x)
    if (!byAgent.has(k)) byAgent.set(k, cols.map(() => []))
    byAgent.get(k)![i].push(x)
  }
  const rows = [...byAgent.entries()].map(([agent, cells]) => ({ agent, cells, total: cells.reduce((s, c) => s + c.length, 0) }))
    .sort((a, b) => Number(a.agent === null) - Number(b.agent === null) || b.total - a.total || String(a.agent).localeCompare(String(b.agent)))
  const max = Math.max(0, ...rows.flatMap(r => r.cells.map(c => c.length)))
  return { cols, rows, max, bucket }
}

/** a cell's fill, 0..1: zero is empty; any lesson is at least a clear tint, the busiest cell full */
export const heat = (n: number, max: number) => (n <= 0 || max <= 0 ? 0 : 0.3 + 0.7 * Math.min(1, n / max))

// ---- RETROS: a desk as a chip, coloured by how stale its beliefs stamp is ----

export type RetroLike = { desk: string; due: boolean; ageDays: number | null; since: number; graded: number; stamp: { date: string | null } }
export type RetroChip = { tone: 'due' | 'fresh' | 'idle'; mark: string; group: string; name: string }

/** due = the retro clock says so (amber); fresh = a stamp, not due (green); idle = nothing to grade
 *  (grey). The mark: the stamp's age in days, else the runs waiting since there is no stamp */
export function retroChip(r: RetroLike): RetroChip {
  const d = r.desk === '.' ? 'fund' : r.desk.replace(/^(lab|desks)\//, '')
  const cut = d.lastIndexOf('/')
  const group = cut > 0 ? d.slice(0, cut) : ''
  const name = cut > 0 ? d.slice(cut + 1) : d
  const tone = r.due ? 'due' : r.stamp.date ? 'fresh' : 'idle'
  const mark = r.ageDays !== null ? `${Math.floor(r.ageDays)}d` : r.since > 0 ? String(r.since) : ''
  return { tone, mark, group, name }
}

// ---- THE FUNNEL: learned -> proposed -> watching -> kept / reverted / vetoed ----

export type FunnelIn = { state: string; unjudged: boolean }
export type Funnel = { proposed: number; watching: number; kept: number; unjudged: number; reverted: number; vetoed: number }

export function funnel(ps: FunnelIn[]): Funnel {
  const n = (s: string) => ps.filter(p => p.state === s).length
  return { proposed: n('proposed'), watching: n('applied') + n('watching'), kept: n('kept'), unjudged: ps.filter(p => p.state === 'kept' && p.unjudged).length, reverted: n('reverted'), vetoed: n('vetoed') }
}
