// ROOM: lab - the KPI tile strip over the runs table, computed from the snapshot the room already
// holds. Pure, so a test can hold it. A figure the snapshot cannot give is null (drawn unknown),
// never a zero nobody measured.

import { perDay } from './window.ts'

export type KRetro = { due: boolean; date: string | null; since: number; why: string }
export type KRun = { desk: string; ts: number | null; verify: { total?: number | null; passed?: number | null } | null }
export type KDesk = { desk: string; runs: number; retro?: KRetro | null }
export type KDue = { desk: string; due: number | null; state: string }
export type KSnap = { now: number; runs: KRun[]; desks: KDesk[]; readsDue: KDue[] }

export type Kpis = {
  /** runs per UTC day, last 7 days, today last; `runs7` their sum */
  perDay: number[]; runs7: number
  /** runs carrying a verify count, and how many of them passed every check; null = none carries one */
  verify: { pass: number; of: number } | null
  /** owed reads in scope: past their due date, of which past the 4-day tolerance ('late'), and not yet at it */
  reads: { over: number; late: number; ahead: number }
  /** one entry per desk in scope (desks with runs, or the picked desk); null = the snapshot carries no retro clock */
  retro: { desk: string; due: boolean; date: string | null; why: string }[] | null
}

/** `desk` '' = the whole lab */
export function kpis(s: KSnap, desk: string): Kpis {
  const runs = s.runs.filter(r => !desk || r.desk === desk)
  const days = perDay(runs.map(r => r.ts), s.now)
  const counted = runs.filter(r => typeof r.verify?.total === 'number' && r.verify.total > 0 && typeof r.verify.passed === 'number')
  const due = s.readsDue.filter(r => !desk || r.desk === desk)
  const over = due.filter(r => r.due !== null && s.now > r.due)
  const desks = s.desks.filter(d => desk ? d.desk === desk : d.runs > 0)
  return {
    perDay: days,
    runs7: days.reduce((a, b) => a + b, 0),
    verify: counted.length ? { pass: counted.filter(r => r.verify!.passed! >= r.verify!.total!).length, of: counted.length } : null,
    reads: { over: over.length, late: over.filter(r => r.state === 'late').length, ahead: due.length - over.length },
    retro: desks.length && desks.every(d => d.retro) ? desks.map(d => ({ desk: d.desk, due: d.retro!.due, date: d.retro!.date, why: d.retro!.why })) : desks.length ? null : [],
  }
}

/** whole days between two instants, floored, never negative: an overdue read's age */
export const daysOver = (due: number, now: number) => Math.max(0, Math.floor((now - due) / 86_400_000))
