import { day } from '../../../shared/time.ts'

// The landing's RECENT timeline: rows grouped under the UTC day they last moved, newest first.
// UTC like every other date in the cockpit (shared/time.ts), so "Today" is the UTC today.

/** the header for a UTC day: "Today", "Yesterday", else the ISO date */
export function dayLabel(ms: number, now: number): string {
  const d = day(ms), t = day(now)
  if (d === '-') return '-'
  if (d === t) return 'Today'
  if (d === day(now - 86_400_000)) return 'Yesterday'
  return d
}

/** consecutive items (already sorted newest first) bucketed by dayLabel, order kept */
export function byDay<T>(items: T[], at: (x: T) => number, now: number): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = []
  for (const x of items) {
    const label = dayLabel(at(x), now)
    const last = out[out.length - 1]
    if (last && last.label === label) last.items.push(x)
    else out.push({ label, items: [x] })
  }
  return out
}

/** within each day, rows that wait on the owner lead (stable: each half keeps its newest-first order) */
export function askFirst<T>(groups: { label: string; items: T[] }[], asks: (x: T) => boolean): { label: string; items: T[] }[] {
  return groups.map(g => ({ label: g.label, items: [...g.items.filter(asks), ...g.items.filter(x => !asks(x))] }))
}
