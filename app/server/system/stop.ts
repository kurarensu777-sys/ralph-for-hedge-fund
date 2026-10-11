import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * floor/STOP: while it exists the scheduler (server/sched) starts nothing. Written by
 * the STOP hook, the Schedule view and the Pause switch. It holds until someone clears it, or
 * until the end time it carries: an optional second line `until <ISO instant>` (POST
 * /api/system/halt {on, until}). Whoever reads it for a decision asks `stopHolds`, which clears an
 * expired file itself; a file with no end time, or one whose end time cannot be read, holds.
 */
export type StopState = { stopped: boolean; text: string | null; at: number | null; until: number | null }

const UNTIL = /^until (\S+)[ \t]*$/m

/** the end time a STOP text carries, in ms; null = none, or unreadable (which holds: never a guess) */
export function untilOf(text: string | null): number | null {
  const m = text ? UNTIL.exec(text) : null
  const t = m ? Date.parse(m[1]) : NaN
  return Number.isFinite(t) ? t : null
}

export function readStopState(file: string): StopState {
  if (!existsSync(file)) return { stopped: false, text: null, at: null, until: null }
  let text: string | null = null, at: number | null = null
  try { text = readFileSync(file, 'utf8').trim() || null } catch { /* unreadable: still stopped */ }
  try { at = statSync(file).mtimeMs } catch { /* gone between calls */ }
  return { stopped: true, text, at, until: untilOf(text) }
}

/**
 * Does the STOP hold now? An expired end time clears the file here (`onExpire` gets the end time),
 * so the scheduler and the board's tick are what lift an end-timed stop, with no one pressing Resume.
 */
export function stopHolds(file: string, now = Date.now(), onExpire?: (until: number) => void): boolean {
  const s = readStopState(file)
  if (!s.stopped) return false
  if (s.until === null || s.until > now) return true
  try { unlinkSync(file) } catch { return existsSync(file) }   // gone already: someone else cleared it
  onExpire?.(s.until)
  return false
}

/** on = write the file, with `until` when given (no-op when the floor folder is missing); off = remove it. Returns the new state. */
export function setStop(file: string, on: boolean, now = new Date(), until: Date | null = null): StopState {
  if (on) {
    if (existsSync(dirname(file))) writeFileSync(file, `stopped ${now.toISOString().slice(0, 19)}\n${until ? `until ${until.toISOString()}\n` : ''}`)
  } else if (existsSync(file)) unlinkSync(file)
  return readStopState(file)
}

/** the `until` of a halt request: null when absent; otherwise a future ISO instant with its zone, else a message for the 400 */
export function parseEnd(on: boolean, until: unknown, now = Date.now()): { end: Date | null; error?: string } {
  if (until === undefined || until === null) return { end: null }
  if (!on) return { end: null, error: 'until goes with on: true' }
  const end = typeof until === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/.test(until) ? new Date(until) : null
  if (!end || !Number.isFinite(end.getTime())) return { end: null, error: 'until is an ISO instant with its zone, e.g. 2026-10-05T09:00:00Z' }
  if (end.getTime() <= now) return { end: null, error: 'until is already past' }
  return { end }
}
