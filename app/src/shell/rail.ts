// The services rail's model (pure, tested in test/shell-status.test.ts): which rows are worth a
// line. A row whose every figure is zero ("0", "none due", a clean repo) says nothing the header
// does not, so it is hidden; the header's count chip keeps the card's total.

import type { ServiceGroup, ServiceRow } from '../../shared/types.ts'
import { railParts } from '../ui/value.tsx'

const ZERO = /^[↑↓]?0$/

/** true when the row carries a measured all-zero reading; trouble, unknown and an empty reading
 *  never count as zero (an unmeasured row is not a quiet one) */
export function isZeroRow(r: ServiceRow): boolean {
  if (r.status === 'fail' || r.status === 'warn' || r.status === 'unknown') return false
  const parts = railParts(r.reading)
  if (!parts.length) return false
  return parts.every(p => 'dot' in p || ZERO.test(p.n))
}

export type RailCard = { group: ServiceGroup; shown: ServiceRow[]; total: number; hidden: number }

export function railCard(g: ServiceGroup): RailCard {
  const shown = g.rows.filter(r => !isZeroRow(r))
  return { group: g, shown, total: g.rows.length, hidden: g.rows.length - shown.length }
}

/** a card's state mix, for the header's stacked segment bar. `run` counts as ok (working is
 *  healthy); `off` and `unknown` are one honest grey tail, never folded into ok */
export type RailTally = { fail: number; warn: number; ask: number; ok: number; grey: number; owner: number }

export function railTally(rows: ServiceRow[]): RailTally {
  const t: RailTally = { fail: 0, warn: 0, ask: 0, ok: 0, grey: 0, owner: 0 }
  for (const r of rows) {
    if (r.status === 'fail') t.fail++
    else if (r.status === 'warn') t.warn++
    else if (r.status === 'ask') t.ask++
    else if (r.status === 'ok' || r.status === 'run') t.ok++
    else t.grey++
  }
  // what needs the owner: a row that is down, or one waiting on him
  t.owner = t.fail + t.ask
  return t
}

/** the tooltip of a tally: each count by name, zeros left out */
export function tallyTip(t: RailTally, okWord = 'ok'): string {
  const parts: string[] = []
  if (t.fail) parts.push(`${t.fail} down`)
  if (t.warn) parts.push(`${t.warn} warn`)
  if (t.ask) parts.push(`${t.ask} waiting on you`)
  if (t.ok) parts.push(`${t.ok} ${okWord}`)
  if (t.grey) parts.push(`${t.grey} off or unknown`)
  return parts.join(' · ') || 'empty'
}

/** a repo row's sync state for the repos squares: 'unknown' when it could not be read, 'conflict'
 *  on a conflict or a stopped op (the row's fail tone), 'behind' when it carries anything beyond
 *  clean / local (dirty, ahead, behind), 'sync' otherwise */
export type RepoState = 'sync' | 'behind' | 'conflict' | 'unknown'
export function repoSync(r: ServiceRow): RepoState {
  if (r.status === 'unknown') return 'unknown'
  if (r.status === 'fail') return 'conflict'
  if (r.status === 'warn') return 'behind'
  const rest = (r.reading ?? '').split(/\s+-\s+/).filter(p => p && p !== 'clean' && p !== 'local')
  return rest.length ? 'behind' : 'sync'
}

/** the words a repo square's tooltip gives its state: the reading itself when it says more */
export function repoStateTip(r: ServiceRow): string {
  const st = repoSync(r)
  if (st === 'sync') return 'in sync'
  if (st === 'unknown') return r.reading ? `unknown (${r.reading})` : 'unknown'
  return r.reading || st
}

/** the fixed order of the repos squares: every repos.json id (one repo, the fund root). A repo not
 * listed follows, in its own order. repo-order.test.ts pins it to repos.json, so a repo added or
 * retired there cannot drift here. */
export const REPO_ORDER = ['fund']
export function repoOrder<T extends { id: string }>(rows: T[]): T[] {
  const k = (r: T) => { const i = REPO_ORDER.indexOf(r.id.replace(/^repo:/, '')); return i < 0 ? REPO_ORDER.length : i }
  return rows.map((r, i) => ({ r, i })).sort((a, b) => k(a.r) - k(b.r) || a.i - b.i).map(x => x.r)
}

/** the dashboards card's count from the group's own tally ("3/7 up"); null when it is absent or
 *  unreadable, so the card says unknown and never 0 */
export function dashUp(tally: string | undefined): { up: number; total: number } | null {
  const m = /^(\d+)\/(\d+)\s+up$/.exec((tally ?? '').trim())
  return m ? { up: +m[1], total: +m[2] } : null
}

/** the dashboards row's tooltip: what the count counts, then every counted row by name. The rail
 *  counts every row the Dash room lists (dashboards AND tools), so it can read more than the side
 *  list's dashboard agents; the tools are named so the numbers agree on sight */
export function dashTip(n: { up: number; total: number }, rows: { label: string; reading?: string; kind?: string }[]): string {
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`
  const extra = (['tool'] as const).map(k => [k, rows.filter(r => r.kind === k)] as const).filter(([, rs]) => rs.length)
  const dashes = rows.length - extra.reduce((m, [, rs]) => m + rs.length, 0)
  const what = [plural(dashes, 'dashboard'), ...extra.map(([k, rs]) => `${plural(rs.length, k)} (${rs.map(r => r.label).join(', ')})`)].join(' + ')
  const tag = (k?: string) => (k === 'tool' ? ` (${k})` : '')
  return [`${n.up} of ${n.total} up: ${what}`, ...rows.map(r => `${r.label}${tag(r.kind)}: ${r.reading || 'unknown'}`)].join('\n')
}
