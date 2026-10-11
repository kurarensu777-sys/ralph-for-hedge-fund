// One date style for the whole cockpit, server and UI alike: ISO date + HH:MM, UTC, with the Z.
// A locale string (21/09/2026, 8:05:00 am) matches no other room and is never used.

/** 1790000000000 -> "2026-09-21 09:00Z" ('-' when there is no time) */
export function stamp(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined || ms === '') return '-'
  const t = typeof ms === 'string' ? Date.parse(ms) : ms
  if (!Number.isFinite(t)) return '-'
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}Z`
}

/** the date half of stamp(): 1790000000000 or "2026-09-21T09:00Z" -> "2026-09-21" ('-' when there is no time) */
export function day(ms: number | string | null | undefined): string {
  const s = stamp(ms)
  return s === '-' ? s : s.slice(0, 10)
}

/** a duration in seconds as its largest whole unit: 86400 -> "1d", 5400 -> "90m", 604800 -> "7d" */
export function dur(s: number): string {
  if (!Number.isFinite(s)) return '-'
  const a = Math.abs(Math.round(s))
  if (a % 86400 === 0 && a >= 86400) return `${a / 86400}d`
  if (a % 3600 === 0 && a >= 3600) return `${a / 3600}h`
  if (a % 60 === 0 && a >= 60) return `${a / 60}m`
  if (a < 60) return `${a}s`
  if (a < 3600) return `${Math.round(a / 60)}m`
  if (a < 86400) return `${Math.round(a / 3600)}h`
  return `${Math.round(a / 86400)}d`
}

/** an elapsed time as the rail and sidebars print it: "4m", "3h", "2d" (never a clock time) */
export function ago(ms: number): string {
  if (!Number.isFinite(ms)) return '-'
  const m = Math.max(0, Math.floor(ms / 60000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}
