import { ops, transaction } from '../db.ts'
import { publish } from '../events.ts'

/**
 * BURN-RATE ALERT: an agent's LAST HOUR of billable tokens against its trailing 7-day hourly
 * median. Fires when last hour >= BURN_MULTIPLE x median AND >= BURN_FLOOR (the volume floor,
 * which is what stops a quiet agent's 3k -> 20k from paging anyone), at most once per agent per
 * hour. The median counts every one of the 168 hours, quiet ones as 0, so it is the agent's
 * typical hour, not its typical busy hour; a median of 0 has no multiple (null) and the floor
 * alone decides.
 */

export const BURN_MULTIPLE = 5
export const BURN_FLOOR = 200_000
export const BURN_KEEP = 20
const HOUR = 3_600_000
const WEEK_H = 168

export type UsageRow = { agent: string; ts: number; billable: number }
export type BurnAlert = { agent: string; ts: number; billable: number; median: number; multiple: number | null }

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** pure: the alerts due at `now` from raw usage rows; `lastFired` = agent -> ms of its newest alert */
export function burnAlerts(rows: UsageRow[], now: number, lastFired: Record<string, number> = {}): BurnAlert[] {
  const start = now - HOUR, weekStart = start - WEEK_H * HOUR
  const by = new Map<string, { last: number; hours: number[] }>()
  for (const r of rows) {
    if (r.ts >= now || r.ts < weekStart) continue
    let a = by.get(r.agent)
    if (!a) by.set(r.agent, (a = { last: 0, hours: new Array(WEEK_H).fill(0) }))
    if (r.ts >= start) a.last += r.billable
    else a.hours[Math.min(WEEK_H - 1, Math.floor((r.ts - weekStart) / HOUR))] += r.billable
  }
  const out: BurnAlert[] = []
  for (const [agent, a] of by) {
    if (a.last < BURN_FLOOR) continue
    const med = median(a.hours)
    if (med > 0 && a.last < BURN_MULTIPLE * med) continue
    const lf = lastFired[agent]
    if (lf !== undefined && now - lf < HOUR) continue
    out.push({ agent, ts: now, billable: a.last, median: med, multiple: med > 0 ? a.last / med : null })
  }
  return out.sort((x, y) => x.agent.localeCompare(y.agent))
}

// ---- the stored side ----
export type StoredAlert = BurnAlert & { id: number }

export async function recentBurn(limit = BURN_KEEP): Promise<StoredAlert[]> {
  return (await ops.listSpendAlerts({ limit })).map(r => ({ id: r.id, ts: r.ts, agent: r.agent, billable: r.billable, median: r.median, multiple: r.multiple }))
}

/** one pass: read 7 days + 1 hour of usage, store + publish what fires, keep the newest 20 */
export async function checkBurn(now = Date.now()): Promise<BurnAlert[]> {
  const rows: UsageRow[] = await ops.billableRows(now - (WEEK_H + 1) * HOUR, now)
  const last = await ops.lastSpendAlerts()
  const fired = burnAlerts(rows, now, Object.fromEntries(last))
  if (!fired.length) return fired
  await transaction(async c => {
    for (const a of fired) await ops.addSpendAlert(a.agent, a.billable, a.median, { multiple: a.multiple, ts: a.ts, keep: BURN_KEEP }, c)
  })
  for (const a of fired) publish('system:alert', { kind: 'burn', ...a })
  return fired
}
