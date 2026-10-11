import { day } from '../../../shared/time.ts'

// LEARNED as a timeline: lessons under Today / Yesterday / Earlier (UTC days, like every other
// date in the cockpit), newest first inside each group; a group with nothing in it is not drawn.

export type DayGroup<T> = { label: 'Today' | 'Yesterday' | 'Earlier'; items: T[] }

export function lessonDays<T>(items: T[], at: (x: T) => number, now: number): DayGroup<T>[] {
  const t = day(now), y = day(now - 86_400_000)
  const g: Record<DayGroup<T>['label'], T[]> = { Today: [], Yesterday: [], Earlier: [] }
  for (const x of [...items].sort((a, b) => at(b) - at(a))) {
    const d = day(at(x))
    g[d !== '-' && d >= t ? 'Today' : d === y ? 'Yesterday' : 'Earlier'].push(x)
  }
  return (['Today', 'Yesterday', 'Earlier'] as const).filter(k => g[k].length).map(label => ({ label, items: g[label] }))
}
