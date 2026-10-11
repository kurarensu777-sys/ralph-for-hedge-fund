// ROOM: lab - a run's READS as three heat cells: at-run, +7d, +30d. Pure, so a test can hold it.
// Tones are the kit's heat classes: done ok, due amber, overdue or missed red, not yet due hollow.

import { day } from '../../../shared/time.ts'

export type ReadState = 'done' | 'missed' | 'due' | 'late' | 'pending' | 'void' | 'none'
export type ReadIn = { due: number | null; state: ReadState; row?: { ts?: unknown; metrics?: Record<string, number> } | null }
export type RunIn = { preregistered: boolean; stage: string; ts: number | null; void: string | null; reads: Record<'7d' | '30d', ReadIn> }
export type HeatCell = { cls: string; title: string }

const CLS: Record<ReadState, string> = { done: 'hc-ok', due: 'hc-warn', late: 'hc-fail', missed: 'hc-fail', pending: 'hc-unknown', void: 'hc-unknown', none: 'hc-unknown' }
const WORD: Record<ReadState, string> = { done: 'done', due: 'due', late: 'overdue', missed: 'missed', pending: 'not yet due', void: 'void, no read owed', none: 'no read' }

export const IMPORTED = 'imported, no fixed-age reads'

/** the three cells; `extra` adds lines (a read's metrics) under a cell's title */
export function readHeat(r: RunIn, extra: (c: ReadIn) => string[] = () => []): HeatCell[] {
  // an import (backfill.py) owes no reads unless the ledger says one fell due; the rail's READS DUE
  // list and this strip must agree, so only an import with nothing owed or done goes all hollow
  const owed = (['7d', '30d'] as const).some(a => r.reads[a].row || !['none', 'void'].includes(r.reads[a].state))
  if (!r.preregistered && !owed) return [0, 1, 2].map(() => ({ cls: 'hc-unknown', title: IMPORTED }))
  const at: HeatCell = !r.preregistered
    ? { cls: 'hc-unknown', title: ['at run', `imported ${day(r.ts)}`, 'backfilled evidence, no at-run read'].join('\n') }
    : r.stage === 'result'
    ? { cls: 'hc-ok', title: ['at run', `done ${day(r.ts)}`, r.void ? `void: ${r.void}` : 'done'].join('\n') }
    : { cls: 'hc-warn', title: ['at run', 'pre-registered, no result yet', 'due'].join('\n') }
  const cell = (a: '7d' | '30d'): HeatCell => {
    const c = r.reads[a]
    const when = c.row ? `done ${day(c.row.ts as string | number | null)}` : c.due ? `due ${day(c.due)}` : 'no due date: no result yet'
    return { cls: CLS[c.state] ?? 'hc-unknown', title: [`+${a}`, when, WORD[c.state] ?? c.state, ...extra(c)].join('\n') }
  }
  return [at, cell('7d'), cell('30d')]
}
