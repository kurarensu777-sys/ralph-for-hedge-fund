// The status bar's model (pure, tested in test/shell-status.test.ts): the next job's chip with its
// ring, and today's spend with a 7-day sparkline drawn only when 7 whole days were recorded.

export type SchedJob = { id: string; next: number | null; last?: { trigger?: string; due?: number | null } | null }
export type NextJob = { id: string; inMs: number; frac: number | null }

/** the soonest enabled job, and how far the clock has run from the occurrence it last ran for to the
 *  next one. frac is null (no ring) unless that previous occurrence is known: a manual run has no
 *  due, and a guessed cycle would draw a ring that is not measured */
export function nextJobOf(jobs: SchedJob[] | null | undefined, now: number): NextJob | null {
  const soon = (jobs ?? []).filter(j => typeof j.next === 'number' && j.next! > now).sort((a, b) => a.next! - b.next!)[0]
  if (!soon) return null
  const due = soon.last?.trigger === 'schedule' ? soon.last.due ?? null : null
  const frac = due !== null && due < now ? Math.min(1, Math.max(0, (now - due) / (soon.next! - due))) : null
  return { id: soon.id, inMs: soon.next! - now, frac }
}

/** the one countdown format (server/system/schedule.ts fmtIn): 26m, 3h, 2d */
export function fmtIn(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${Math.max(m, 0)}m`
  if (m < 48 * 60) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

export type SpendRow = { day: string; tin?: number | null; tout?: number | null; cw?: number | null }

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** billable tokens per local day for the last 7 days ending today (input + cache writes + output,
 *  the budget probe's metric); null unless EVERY one of the 7 days has a recorded usage row */
export function spendWeek(rows: SpendRow[] | null | undefined, today: Date): number[] | null {
  if (!rows) return null
  const by = new Map<string, number>()
  for (const r of rows) by.set(r.day, (by.get(r.day) ?? 0) + (r.tin ?? 0) + (r.cw ?? 0) + (r.tout ?? 0))
  const out: number[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const v = by.get(dayKey(d))
    if (v === undefined) return null
    out.push(v)
  }
  return out
}

/** polyline points for a w x h sparkline, lowest value on the bottom edge */
export function sparkPoints(vals: number[], w: number, h: number, pad = 1.5): string {
  if (vals.length < 2) return ''
  const lo = Math.min(...vals), hi = Math.max(...vals)
  const span = hi - lo || 1
  return vals.map((v, i) => `${((i / (vals.length - 1)) * (w - 2 * pad) + pad).toFixed(1)},${(h - pad - ((v - lo) / span) * (h - 2 * pad)).toFixed(1)}`).join(' ')
}
