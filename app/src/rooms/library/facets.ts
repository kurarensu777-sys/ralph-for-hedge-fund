import type { LibBook, LibBooks, LibChapter } from '../../../server/library/types.ts'
import type { Kind, Need, Read } from './state.ts'

// The room's three facets over a book, pure (test/library-facets.test.ts): what it is about (topics),
// who must read it (boot lists and Recall rows, derived server-side), and who did (the read ledger).

export type Facets = { shelf: string | null; topics: string[]; who: string | null; need: Need; read: Read; type?: Kind; q: string }

/** the agents a book's Recall rows reach: those that load the row's CLAUDE.md at start. null = the
 *  CLAUDE.md list could not be read, so it is unknown (never "none") */
export function recallWho(b: LibBook, loads: LibBooks['loads']): string[] | null {
  if (!loads) return null
  const files = new Set(b.recall.map(r => r.file))
  return Object.keys(loads).filter(a => loads[a].some(f => files.has(f)))
}

const bootsOf = (b: LibBook, who: string | null) => (who ? b.readers.includes(who) : b.readers.length > 0)
const recallsOf = (b: LibBook, rc: string[] | null, who: string | null) => (who ? !!rc?.includes(who) : b.recall.length > 0)

/** the agent lens: it boots with it, a Recall row it loads names it, or it pulled it */
export function inLens(b: LibBook, rc: string[] | null, who: string | null): boolean {
  if (!who) return true
  return b.readers.includes(who) || !!rc?.includes(who) || !!b.use?.who.includes(who)
}

export function needOk(b: LibBook, rc: string[] | null, f: Pick<Facets, 'who' | 'need'>): boolean {
  const boot = bootsOf(b, f.who), recall = recallsOf(b, rc, f.who)
  switch (f.need) {
    case 'boot': return boot
    case 'recall': return recall
    case 'must': return boot || recall
    case 'opt': return !boot && !recall
    default: return true
  }
}

const DAY = 86_400_000
/** a read filter on a book whose reads are unknown matches nothing: the line says unknown, never "0" */
export function readOk(b: LibBook, read: Read, who: string | null, now: number): boolean {
  if (!read) return true
  const u = b.use
  if (!u) return false
  if (read === 'p30') return who ? u.n30 > 0 && u.who.includes(who) : u.n30 > 0
  if (read === 'b30') return u.lastBoot !== null && u.lastBoot >= now - 30 * DAY
  return u.last === null && u.lastBoot === null
}

/** the chapters whose title or Read when line holds the query (none for a `#topic` query or an empty one) */
export function chapterHits(b: LibBook, q: string): LibChapter[] {
  const n = q.trim().toLowerCase()
  if (!n || n.startsWith('#')) return []
  return b.chapters.filter(c => (c.title + '\n' + c.readWhen).toLowerCase().includes(n))
}

/** `#fee` matches a topic by prefix; anything else the book's title, path and moment, or one of its chapters' titles and Read when lines */
export function textOk(b: LibBook, q: string): boolean {
  const n = q.trim().toLowerCase()
  if (!n) return true
  if (n.startsWith('#')) return n.length > 1 && b.topics.some(t => t.startsWith(n.slice(1)))
  return `${b.title} ${b.path} ${b.readWhen}`.toLowerCase().includes(n) || chapterHits(b, q).length > 0
}

/** the type control: '' = all, 'guide' = guides, 'strategy' = strategies (a book with no `type:` shows under All only) */
export const typeOk = (b: LibBook, type: Kind | undefined): boolean => !type || b.type === type

/**
 * the books in list order with a strategy book under its parent: a book whose `parent:` names another book's file
 * (`research` -> research.md) on the same shelf follows that book, one level in; a parent that is not in the list
 * leaves its children at the top level. Otherwise the order given is kept.
 */
export function nested(list: LibBook[]): { book: LibBook; depth: number }[] {
  const stem = (b: LibBook) => b.path.split('/').pop()!.replace(/\.md$/i, '')
  const parentOf = (b: LibBook) => (b.parent ? list.find(p => p !== b && p.shelf === b.shelf && stem(p) === b.parent) : undefined)
  const out: { book: LibBook; depth: number }[] = []
  const placed = new Set<LibBook>()
  for (const b of list) {
    if (placed.has(b) || parentOf(b)) continue
    out.push({ book: b, depth: 0 }); placed.add(b)
    for (const c of list) if (!placed.has(c) && parentOf(c) === b) { out.push({ book: c, depth: 1 }); placed.add(c) }
  }
  for (const b of list) if (!placed.has(b)) out.push({ book: b, depth: 0 })   // a parent cycle: kept, never dropped
  return out
}

/** `<shelf>/<topic>` keys, OR among them; `<shelf>/-` = the shelf's untagged books */
export function topicOk(b: LibBook, keys: string[]): boolean {
  if (!keys.length) return true
  return keys.some(k => k === `${b.shelf}/-` ? b.topics.length === 0 : b.topics.some(t => k === `${b.shelf}/${t}`))
}

export function matcher(data: Pick<LibBooks, 'loads'>, f: Facets, now = Date.now()) {
  const rc = new Map<string, string[] | null>()
  const rcOf = (b: LibBook) => { if (!rc.has(b.path)) rc.set(b.path, recallWho(b, data.loads)); return rc.get(b.path)! }
  return (b: LibBook) => {
    const r = rcOf(b)
    return (!f.shelf || b.shelf === f.shelf) && inLens(b, r, f.who) && needOk(b, r, f) && readOk(b, f.read, f.who, now) && textOk(b, f.q) && typeOk(b, f.type) && topicOk(b, f.topics)
  }
}

export const isFiltered = (f: Facets) => !!(f.topics.length || f.who || f.need || f.read || f.type || f.q.trim())

// ---- the reader tags under a book: filled = boots with it, outlined = a Recall row sends the agent there ----

export type Tag = { text: string; kind: 'boot' | 'recall' | 'demand'; ids: string[]; tip: string; cat: string | null }

/**
 * Who must read it, as a few short tags. A whole group collapses: every agent = ALL, every dashboard
 * agent = DSH; else one tag per agent (its two letters; cat = the agent id, for its colour). Recall shows
 * only the agents that do not already boot with it, except ALL (the Recall row reaches everyone). A
 * Recall row in a CLAUDE.md no agent starts under is `OD`, read on demand; loads unknown = `?`.
 */
export function readerTags(b: LibBook, rc: string[] | null, agents: string[], mark: (id: string) => string): Tag[] {
  const group = (ids: string[], kind: Tag['kind']): Tag[] => {
    if (!ids.length) return []
    if (agents.length && agents.every(a => ids.includes(a))) return [{ text: 'ALL', kind, ids, tip: `every agent (${agents.length})`, cat: null }]
    const out: Tag[] = []
    let rest = [...ids]
    const dash = agents.filter(a => a.startsWith('dash:'))
    if (dash.length > 1 && dash.every(a => rest.includes(a))) {
      out.push({ text: 'DSH', kind, ids: dash, tip: `every dashboard agent (${dash.length})`, cat: dash[0] })
      rest = rest.filter(a => !dash.includes(a))
    }
    for (const a of rest) out.push({ text: mark(a), kind, ids: [a], tip: a, cat: a })
    return out
  }
  const boot = group(b.readers, 'boot')
  if (!b.recall.length) return boot
  const files = [...new Set(b.recall.map(r => r.file))].join(', ')
  if (rc === null) return [...boot, { text: '?', kind: 'recall', ids: [], tip: `a Recall row (${files}); who loads it is unknown`, cat: null }]
  if (!rc.length) return [...boot, { text: 'OD', kind: 'demand', ids: [], tip: `a Recall row in ${files}, which no agent loads at start: read on demand`, cat: null }]
  const everyone = agents.length > 0 && agents.every(a => rc.includes(a))
  if (everyone && b.readers.length === agents.length) return boot
  const recall = everyone ? group(rc, 'recall') : group(rc.filter(a => !b.readers.includes(a)), 'recall')
  return [...boot, ...recall.map(t => ({ ...t, tip: `${t.tip}, from ${files}` }))]
}
