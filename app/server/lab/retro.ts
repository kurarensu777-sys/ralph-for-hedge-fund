import { retroStatus } from '../loop/sources.ts'
import { parseJsonl } from './runs.ts'

// ROOM: lab - a desk's retro clock for the rail and the KPI tiles: the loop's ONE rule
// (retroStatus, the port of retro_due.py: 7 days or 5 runs), read from the same two files the
// Loop room reads (beliefs.md, data/runs.jsonl), slimmed to what the lab draws.

export type DeskRetro = { due: boolean; date: string | null; since: number; why: string }

/** beliefs / runs are the files' text, null when the file is absent (the rule decides what that means) */
export function deskRetro(desk: string, beliefs: string | null, runs: string | null, now: number): DeskRetro {
  const r = retroStatus(desk, beliefs, runs === null ? [] : parseJsonl(runs).rows, now)
  return { due: r.due, date: r.stamp.date, since: r.since, why: r.reasons.join('; ') }
}
