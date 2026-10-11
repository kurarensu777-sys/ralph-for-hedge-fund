// The Git room's log query, pure: which commits a filter keeps and which page is served. The route
// (server/rooms/git.ts) reads each repo's whole history once per HEAD and hands it here, so a filter
// always runs over the WHOLE history in scope, never over a page some cap already cut.

export type Q = { agent: string; text: string; range: { since: string; until: string | null } | null }

type C = { sha: string; ts: number; subject: string; body: string; files: string[]; trailers: { agent: string | null } }

/** the agent a trailer names: its first word ("fund (fixer round 1)" -> "fund") */
export const agentOf = (trailer: string | null | undefined) => (trailer ?? '').trim().split(/[\s,]+/)[0] ?? ''

/** the OTHER series of the room's chart: an Agent trailer no roster agent answers to */
export const OTHER = '~'

/** '' any · '-' no Agent trailer · '~' a trailer naming no roster agent · else the trailer's first word */
export function agentIs(want: string, trailer: string | null, roster: Set<string>): boolean {
  if (!want) return true
  if (want === '-') return !trailer
  if (!trailer) return false
  if (want === OTHER) return !roster.has(agentOf(trailer))
  return agentOf(trailer) === want || trailer === want
}

/** every word must be found: in the subject, the body, a file path, or as the start of the sha */
export function textIs(text: string, c: C): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${c.subject}\n${c.body}`.toLowerCase()
  return words.every(w => hay.includes(w) || c.sha.startsWith(w) || c.files.some(f => f.toLowerCase().includes(w)))
}

/** [since 00:00, until+1 00:00) in LOCAL time, as git's own --since/--until read a bare day */
export function rangeMs(r: { since: string; until: string | null }): [number, number] {
  const from = new Date(`${r.since}T00:00:00`).getTime()
  if (!r.until) return [from, Infinity]
  const to = new Date(`${r.until}T00:00:00`)
  to.setDate(to.getDate() + 1)
  return [from, to.getTime()]
}

export function filterLog<T extends C>(all: T[], q: Q, roster: Set<string>): T[] {
  const [from, to] = q.range ? rangeMs(q.range) : [-Infinity, Infinity]
  return all.filter(c => c.ts >= from && c.ts < to && agentIs(q.agent, c.trailers.agent, roster) && textIs(q.text, c))
}

export const PAGE = 100
export const PAGE_MAX = 2000
/** a file list longer than this is cut on the wire; `nfiles` keeps the true count */
export const FILES_WIRE = 40

export function pageOf<T extends { files: string[] }>(rows: T[], offset: number, limit: number): (T & { nfiles: number })[] {
  const o = Math.max(0, Math.floor(offset) || 0)
  const n = Math.min(PAGE_MAX, Math.max(1, Math.floor(limit) || PAGE))
  return rows.slice(o, o + n).map(c => ({ ...c, files: c.files.slice(0, FILES_WIRE), nfiles: c.files.length }))
}
