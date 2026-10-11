import type { Age, ReadCell, Run } from './runs.ts'

/**
 * The fixed-age reads that are due or late, oldest due first: ONE rule, shared by the lab room's
 * snapshot (readsDue) and the board's debt scanner (server/board/debt.ts). A read is owed at the
 * result's ts + 7d / + 30d (runs.ts groupRuns decides the state); only 'due' and 'late' are owed.
 */
export type DueRead = { key: string; desk: string; run: string; age: Age; due: number | null; state: 'due' | 'late' }

export const AGES_OWED: Age[] = ['7d', '30d']
const owed = (c: ReadCell): c is ReadCell & { state: 'due' | 'late' } => c.state === 'due' || c.state === 'late'

export function dueReads(runs: Pick<Run, 'key' | 'desk' | 'run' | 'reads'>[]): DueRead[] {
  return runs
    .flatMap(r => AGES_OWED.filter(age => owed(r.reads[age])).map(age => ({
      key: r.key, desk: r.desk, run: r.run, age, due: r.reads[age].due, state: r.reads[age].state as 'due' | 'late',
    })))
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0))
}
