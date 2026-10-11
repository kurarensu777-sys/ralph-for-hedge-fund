import { CHART_CATEGORIES, type ChartCategoryId, type ChartShow, type ChartType } from '../../../shared/research.ts'

// The Charts view's finding: the search over the question and the read-when line, and the drawn / not
// drawn yet split. Pure, so the arithmetic is pinned (test/research-charts.test.ts). A type is drawn when
// its Exemplar line names a study and a figure, not drawn yet when it says `none yet`; a chapter whose
// Exemplar line is missing or unreadable is neither (a fault the view shows), so it never counts as
// not drawn: that would be a claim nobody measured.

export type ChartFilter = { q: string; show: ChartShow }
export const NO_CHART_FILTER: ChartFilter = { q: '', show: 'all' }

export const isDrawn = (t: ChartType) => t.exemplar.state === 'named'
export const isUndrawn = (t: ChartType) => t.exemplar.state === 'none'

/** the words a type is found by: its question and its read-when line */
const haystack = (t: ChartType) => [t.question, t.readWhen].filter(Boolean).join(' \n ').toLowerCase()

/** every word of the query must appear (order free), and the type must be in the chosen split */
export function chartMatches(t: ChartType, f: ChartFilter): boolean {
  if (f.show === 'drawn' && !isDrawn(t)) return false
  if (f.show === 'undrawn' && !isUndrawn(t)) return false
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const h = haystack(t)
  return words.every(w => h.includes(w))
}

/** the chip counts: of every type, regardless of the search; `unreadable` = neither drawn nor not drawn yet;
 *  `uncategorised` = the Category line is missing or names none of the eight */
export function chartCounts(types: ChartType[]): { all: number; drawn: number; undrawn: number; unreadable: number; uncategorised: number } {
  const drawn = types.filter(isDrawn).length, undrawn = types.filter(isUndrawn).length
  return { all: types.length, drawn, undrawn, unreadable: types.length - drawn - undrawn, uncategorised: types.filter(t => !t.category).length }
}

export type ChartGroup = { id: ChartCategoryId | null; name: string; asks: string | null; types: ChartType[] }

/** the types under their eight categories, in the closed list's order, book order inside each; a category with no type
 *  to show is left out. A type with no readable category goes in a last group of its own, never into one of the eight */
export function chartGroups(types: ChartType[]): ChartGroup[] {
  const out: ChartGroup[] = CHART_CATEGORIES.map(c => ({ id: c.id as ChartCategoryId | null, name: c.name as string, asks: c.asks as string | null, types: types.filter(t => t.category === c.id) }))
  out.push({ id: null, name: 'No category', asks: null, types: types.filter(t => !t.category) })
  return out.filter(g => g.types.length > 0)
}

/** the studies behind a type's figures, each once in first-seen order, and the figure count: the card says
 *  "27 figures in 9 studies", never 27 studies (a study draws one type many times) */
export function usedBy(used: ChartType['used']): { studies: { id: string; name: string }[]; figures: number } {
  const seen = new Map<string, string>()
  for (const u of used) if (!seen.has(u.id)) seen.set(u.id, u.name)
  return { studies: [...seen].map(([id, name]) => ({ id, name })), figures: used.length }
}
