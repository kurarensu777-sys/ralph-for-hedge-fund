// ROOM: lab - how a run's window reads in the table's WINDOW cell. Pure, so a test can hold it.

import { day } from '../../../shared/time.ts'

type W = { from?: unknown; to?: unknown; hours?: unknown } | null | undefined

/** a window as its two dates in the cockpit's one date style (shared/time.ts day(): YYYY-MM-DD),
 *  whatever year they fall in, so every row of the column reads alike; one day is that day */
export function winShort(w: W): string {
  if (!w) return '-'
  const ok = (x: unknown) => /^\d{4}-\d{2}-\d{2}/.test(String(x ?? ''))
  if (!ok(w.from) || !ok(w.to)) return `${String(w.from ?? '?')} → ${String(w.to ?? '?')}`
  const a = String(w.from).slice(0, 10), b = String(w.to).slice(0, 10)
  return a === b ? day(`${a}T00:00Z`) : `${day(`${a}T00:00Z`)} → ${day(`${b}T00:00Z`)}`
}

/** the window's length: hours when the run published them (1,746h), else days from the dates (180d),
 * else years past one year (5.5y). '' when the dates do not parse or the window is one day. */
export function winSpan(w: W): string {
  if (!w) return ''
  if (w.hours) return `${Number(w.hours).toLocaleString('en-US')}h`
  const f = Date.parse(String(w.from ?? '')), t = Date.parse(String(w.to ?? ''))
  if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) return ''
  const d = Math.round((t - f) / 86_400_000)
  if (d < 1) return ''
  return d >= 365 ? `${(d / 365.25).toFixed(1)}y` : `${d}d`
}

/** runs per UTC day over the last `days` days, oldest first, today last (the DESKS sparkbar).
 *  A run with no timestamp or outside the span is not counted; a quiet day is 0, drawn as bare track. */
export function perDay(ts: (number | null)[], now: number, days = 7): number[] {
  const DAY = 86_400_000
  const today = Math.floor(now / DAY)
  const out = new Array(days).fill(0)
  for (const t of ts) {
    if (typeof t !== 'number' || !Number.isFinite(t)) continue
    const i = days - 1 - (today - Math.floor(t / DAY))
    if (i >= 0 && i < days) out[i]++
  }
  return out
}
