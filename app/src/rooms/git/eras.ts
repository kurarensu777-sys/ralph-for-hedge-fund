// Pure helpers for the Git room's era band (tested in test/git-eras.test.ts).

export type Era = { id: string; book: string; title: string | null; from: string | null; to: string | null; error: string | null; counts: Record<string, number | null> }

/** "Sep 21 - Sep 24" / "Sep 21 - now"; a year only when the span leaves this one */
export function eraSpan(from: string, to: string): string {
  const y = new Date().getFullYear()
  const f = (d: string) => { const [yy, mm, dd] = d.split('-').map(Number); const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mm - 1]; return yy === y ? `${m} ${dd}` : `${m} ${dd} ${yy}` }
  if (to === from) return f(from)   // a one-day era is its day, never "Sep 24 - Sep 24"
  return `${f(from)} - ${to === 'open' ? 'now' : f(to)}`
}

/** the log's date range for the selected era; null = no era picked (or it no longer exists / is bad) */
export function eraRange(eras: Era[] | undefined, id: string): { since: string; until: string } | null {
  const e = id ? eras?.find(x => x.id === id) : undefined
  return e && !e.error && e.from && e.to ? { since: e.from, until: e.to } : null
}
