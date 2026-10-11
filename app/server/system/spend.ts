/**
 * SPEND: the usage table as a 30-day series per agent, and each agent's ceiling.
 *
 * The metric is BILLABLE = input + cache writes + output (app/tools/budget's default metric, named in
 * every payload). The ceiling is the roster's and only its: `budgetTokensPerDay` on the
 * agent, else a top-level `defaults.budgetTokensPerDay`; an agent with neither has NO ceiling and
 * says so (null), never an invented one.
 */

export const SPEND_METRIC = 'billable'

export type DayRow = { agent: string; day: string; billable: number; cost: number; n: number }
export type Series = {
  days: string[]                 // oldest first, `n` local days ending today
  agents: string[]               // most spend first
  cells: number[][]              // cells[day][agent] billable tokens
  totals: number[]               // per day
  max: number                    // the tallest day
}

const shiftDay = (day: string, by: number): string => {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(y, m - 1, d + by)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/** the last `n` local days ending `today`, oldest first, every day present (a quiet day is 0) */
export function spendSeries(rows: DayRow[], today: string, n = 30): Series {
  const days = Array.from({ length: n }, (_, i) => shiftDay(today, i - (n - 1)))
  const idx = new Map(days.map((d, i) => [d, i]))
  const byAgent = new Map<string, number>()
  for (const r of rows) if (idx.has(r.day)) byAgent.set(r.agent, (byAgent.get(r.agent) ?? 0) + r.billable)
  const agents = [...byAgent.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a]) => a)
  const aIdx = new Map(agents.map((a, i) => [a, i]))
  const cells = days.map(() => agents.map(() => 0))
  for (const r of rows) {
    const d = idx.get(r.day), a = aIdx.get(r.agent)
    if (d !== undefined && a !== undefined) cells[d][a] += r.billable
  }
  const totals = cells.map(c => c.reduce((s, x) => s + x, 0))
  return { days, agents, cells, totals, max: Math.max(0, ...totals) }
}

/** per-agent daily ceiling from the raw roster; null = no ceiling written down */
export function ceilings(raw: any): { byAgent: Record<string, number | null>; fallback: number | null } {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  const fallback = num(raw?.defaults?.budgetTokensPerDay)
  const byAgent: Record<string, number | null> = {}
  for (const a of Array.isArray(raw?.agents) ? raw.agents : []) {
    if (a && typeof a.id === 'string') byAgent[a.id] = num(a.budgetTokensPerDay) ?? fallback
  }
  return { byAgent, fallback }
}

/** colour slot per charted agent: COLOUR FOLLOWS THE ENTITY, never its spend rank. Agents are
 *  taken in roster order (unknown ids after, alphabetical), the first `n` get slots 0..n-1 and the
 *  rest share slot `n` ("other"), so a quiet day never repaints anyone. */
export function colorSlots(agents: string[], order: string[], n = 5): Record<string, number> {
  const pos = new Map(order.map((id, i) => [id, i]))
  const sorted = [...agents].sort((a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9) || a.localeCompare(b))
  return Object.fromEntries(sorted.map((a, i) => [a, Math.min(i, n)]))
}
