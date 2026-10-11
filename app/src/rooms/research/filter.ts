import { FORMATS, MARKETS, type Study } from '../../../shared/research.ts'
import { manifestOf, stateWord } from './format.ts'

// Finding results: one text search (the list and the table share it) plus the table's facets and
// metric thresholds. Pure, so the rules are tested (test/research.test.ts). A threshold on a metric
// a study does not carry (null, or no metrics block) does NOT match: an unknown is never a pass.

export type Cond = { k: string; op: '>=' | '<='; v: number }
export type Filter = { q: string; verdicts: string[]; desks: string[]; statuses: string[]; conds: Cond[] }
export const NO_FILTER: Filter = { q: '', verdicts: [], desks: [], statuses: [], conds: [] }

/** the words a study can be found by */
export function haystack(s: Study): string {
  const m = manifestOf(s)
  return [s.name, s.id, s.tag, ...s.labels.markets.flatMap(k => [k, MARKETS[k].label]), s.labels.format && FORMATS[s.labels.format].label, m?.title, m?.question, m?.desk, m?.kind, m?.format, m?.verdict.word, m?.strategy?.name, m?.strategy?.thesis,
    ...(m?.profile?.venues ?? m?.strategy?.venues ?? []), ...(m?.profile?.instruments ?? m?.strategy?.instruments ?? []), m?.run.run_id,
    ...(m?.caveats ?? []), ...s.loop.flatMap(l => [l.run, l.desk, l.headline])].filter(Boolean).join(' \n ').toLowerCase()
}

/** every word of the query must appear somewhere (order free) */
export function matchesText(s: Study, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const h = haystack(s)
  return words.every(w => h.includes(w))
}

/** every word of the query is in the study's NAME (file name, id, tag or manifest title; - and _ read as spaces):
 *  the list ranks these before the studies the rest of the manifest text happened to match (B-0514) */
export function nameMatches(s: Study, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return false
  const h = [s.name, s.id, s.tag, manifestOf(s)?.title].filter(Boolean).join(' ').toLowerCase().replace(/[-_]+/g, ' ')
  return words.every(w => h.includes(w.replace(/[-_]+/g, ' ')))
}

export const verdictOf = (s: Study) => manifestOf(s)?.verdict.word ?? stateWord(s).word
export const deskOf = (s: Study) => manifestOf(s)?.desk ?? s.loop[0]?.desk ?? null
export const statusOf = (s: Study) => manifestOf(s)?.status ?? null

export function matches(s: Study, f: Filter): boolean {
  if (!matchesText(s, f.q)) return false
  if (f.verdicts.length && !f.verdicts.includes(verdictOf(s))) return false
  if (f.desks.length && !f.desks.includes(deskOf(s) ?? '')) return false
  if (f.statuses.length && !f.statuses.includes(statusOf(s) ?? '')) return false
  for (const c of f.conds) {
    const v = manifestOf(s)?.metrics?.[c.k]
    if (typeof v !== 'number' || !Number.isFinite(v)) return false
    if (c.op === '>=' ? v < c.v : v > c.v) return false
  }
  return true
}

/** the values a facet can take across these studies, most common first */
export function facet(studies: Study[], of: (s: Study) => string | null): { value: string; n: number }[] {
  const n = new Map<string, number>()
  for (const s of studies) { const v = of(s); if (v) n.set(v, (n.get(v) ?? 0) + 1) }
  return [...n].map(([value, k]) => ({ value, n: k })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
}

export const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter(y => y !== x) : [...xs, x])
export const active = (f: Filter) => !!(f.q.trim() || f.verdicts.length || f.desks.length || f.statuses.length || f.conds.length)
