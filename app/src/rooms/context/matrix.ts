import { CTX_TYPES, sharedRow, type CtxAgent, type CtxRow, type CtxType } from '../../../shared/context.ts'

// THE MATRIX, pure: one row per file or chapter any agent loads, one cell per agent. A cell is the agent's row
// when it loads it and undefined when it does not (a blank, never a zero). Pure so the filters are tested.

export type Filter = 'all' | 'shared' | 'differs'
export const FILTERS: { id: Filter; label: string; title: string }[] = [
  { id: 'shared', label: 'Shared', title: 'rows every agent loads, with the same count' },
  { id: 'differs', label: 'Differs', title: 'rows some agent lacks, or loads at another size' },
  { id: 'all', label: 'All', title: 'every row' },
]

export type MRow = { type: CtxType; key: string; label: string; note?: string; cells: (CtxRow | undefined)[]; shared: boolean; n: number }
export type MGroup = { type: CtxType; label: string; title: string; rows: MRow[] }

export function buildMatrix(agents: CtxAgent[], filter: Filter): MGroup[] {
  const order: string[] = []
  const first = new Map<string, CtxRow>()
  for (const a of agents) for (const r of a.rows) if (!first.has(r.key)) { first.set(r.key, r); order.push(r.key) }
  const rows: MRow[] = order.map(key => {
    const f = first.get(key) as CtxRow
    const cells = agents.map(a => a.rows.find(r => r.key === key))
    return { type: f.type, key, label: f.label, note: f.note, cells, shared: agents.length > 0 && sharedRow(cells), n: cells.filter(Boolean).length }
  })
  return CTX_TYPES.map((t): MGroup => ({
    type: t.id, label: t.label, title: t.title,
    // the rows most agents load come first; ties keep the order they were met in
    rows: rows.filter(r => r.type === t.id && (filter === 'all' || (filter === 'shared' ? r.shared : !r.shared))).sort((a, b) => b.n - a.n),
  })).filter(g => g.rows.length)
}

/** how a cell reads: the over-cap and the over-target marks are the cap's own, never the cell's colour alone */
export function cellTone(r: CtxRow): 'ok' | 'warn' | 'fail' | 'unknown' {
  if (r.state === 'missing') return 'fail'
  if (r.state === 'unknown' || r.tokens === null) return 'unknown'
  if (r.cap !== null && r.tokens > r.cap) return 'fail'
  if (r.warn !== undefined && r.tokens > r.warn) return 'warn'
  return 'ok'
}

export function budgetTone(tokens: number, cap: number | null): 'ok' | 'warn' | 'fail' | 'unknown' {
  if (cap === null) return 'unknown'
  return tokens > cap ? 'fail' : tokens > cap * 0.9 ? 'warn' : 'ok'
}
