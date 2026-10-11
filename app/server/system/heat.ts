import { db as store, ops, type Queryable } from '../db.ts'
import { probeKey } from './probes.ts'

/**
 * The 24h HEAT STRIP of the floor probes: one cell per clock hour, coloured from the record
 * (health_readings, probe_id `system:<id>`, target 'system'). Pure except probeHeat, which reads it.
 *
 * The record: every writer records its own reading there (a probe through fund_db, the scheduler
 * through @fund/db; server/system/probes.ts), stamped with its own probed_ts, status = what it
 * CLAIMED, detail = the whole reading (its window_s included). Nothing is recorded for a probe that
 * did not run.
 *
 * A cell is the hour [a, a + 1h):
 *   - readings taken inside it: the worst of them (fail > warn > unknown > ok), and it is `seen`;
 *   - else the last reading before it, while its own window still covers the hour start: that
 *     verdict still holds (a daily probe is green all day, not green for one hour and grey after);
 *   - else, when an older reading exists but its window ran out: `stale` (amber hollow, as the
 *     live table shows a stale row), never the old verdict;
 *   - else `none`: nothing recorded yet (grey). Never green by default.
 */

export const HOUR = 3_600_000
export type HeatState = 'ok' | 'warn' | 'fail' | 'unknown' | 'stale' | 'none'
export type HeatCell = {
  s: HeatState
  at: number | null            // the reading drawn (its own time); null for none
  reading: string              // what it said ('' for none)
  n: number                    // readings taken inside the hour
  seen: boolean                // true = read in this hour, false = carried from an earlier one
}
export type HeatRow = { id: string; cells: HeatCell[] }
export type Reading = { ts: number; status: string; reading: string; windowS: number | null }

const RANK: Record<string, number> = { ok: 0, unknown: 1, warn: 2, fail: 3 }
const norm = (s: string): 'ok' | 'warn' | 'fail' | 'unknown' => (s === 'ok' || s === 'warn' || s === 'fail' ? s : 'unknown')

/** the hour grid ending in the current (partial) hour: `hours` starts, oldest first */
export function hourGrid(now: number, hours = 24): { from: number; starts: number[] } {
  const last = Math.floor(now / HOUR) * HOUR
  const from = last - (hours - 1) * HOUR
  return { from, starts: Array.from({ length: hours }, (_, i) => from + i * HOUR) }
}

/** one probe's cells from its readings (any order; readings after `now` are ignored) */
export function heatCells(readings: Reading[], now: number, hours = 24): HeatCell[] {
  const rs = readings.filter(r => r.ts <= now).sort((a, b) => a.ts - b.ts)
  const { starts } = hourGrid(now, hours)
  return starts.map(a => {
    const b = a + HOUR
    const inside = rs.filter(r => r.ts >= a && r.ts < b)
    if (inside.length) {
      const w = inside.reduce((x, y) => (RANK[norm(y.status)] >= RANK[norm(x.status)] ? y : x))
      return { s: norm(w.status), at: w.ts, reading: w.reading, n: inside.length, seen: true }
    }
    let prev: Reading | null = null
    for (const r of rs) { if (r.ts < a) prev = r; else break }
    if (!prev) return { s: 'none', at: null, reading: '', n: 0, seen: false }
    const covers = prev.windowS !== null && prev.ts + prev.windowS * 1000 >= a
    return covers
      ? { s: norm(prev.status), at: prev.ts, reading: prev.reading, n: 0, seen: false }
      : { s: 'stale', at: prev.ts, reading: prev.reading, n: 0, seen: false }
  })
}

export { probeKey }

/** the heat rows for the given probe ids, from the record */
/** a stored reading -> the heat input; detail_json is jsonb (an object; older text rows parse too) */
export function toReading(r: { ts: number; status: string; reading: string | null; detail_json: unknown }): Reading {
  let windowS: number | null = null
  try {
    const d = (typeof r.detail_json === 'string' ? JSON.parse(r.detail_json) : r.detail_json) as { window_s?: unknown } | null
    windowS = Number.isFinite(Number(d?.window_s)) && d?.window_s ? Number(d.window_s) : null
  } catch { /* none */ }
  return { ts: Number(r.ts), status: String(r.status), reading: String(r.reading ?? ''), windowS }
}

export async function probeHeat(ids: string[], now: number, hours = 24, q: Queryable = store): Promise<{ from: number; hours: number; items: HeatRow[] }> {
  const { from } = hourGrid(now, hours)
  if (!ids.length) return { from, hours, items: [] }
  const keys = ids.map(probeKey)
  type Raw = { probe_id: string; ts: number; status: string; reading: string | null; detail_json: unknown }
  // readings inside the grid, plus each probe's last one before it (a window may still cover the first hour)
  const inWin: Raw[] = await ops.healthBetween(keys, from, now, q)
  const before: Raw[] = await ops.healthBefore(keys, from, q)
  const items = ids.map(id => {
    const key = probeKey(id)
    const rows = inWin.filter(r => r.probe_id === key).map(toReading)
    const b = before.find(r => r.probe_id === key)
    if (b) rows.unshift(toReading(b))
    return { id, cells: heatCells(rows, now, hours) }
  })
  return { from, hours, items }
}
