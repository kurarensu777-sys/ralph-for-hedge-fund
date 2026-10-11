import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_TOPICS, chaptersOf, setTopics, slugOf, splitRef, topicsOf } from '../../shared/bookmeta.ts'
import type { Agent, Book, Shelf } from '../../shared/types.ts'
import type { Captured } from './capture.ts'
import { railFor } from './config.ts'
import { AGENTS_REL } from '../paths.ts'
import { agentFileName } from '../../shared/agentfile.ts'
import type { Gate, Kind, Proposal } from './proposals.ts'
import { emptyWatch } from './proposals.ts'
import { caps } from '../library/caps.ts'

/**
 * THE RULES a pass runs. All rule-based (no model call): a proposal's text is assembled from the
 * lessons themselves, word for word, so nothing in it is invented. Three rules:
 *
 *   promote        the same lesson captured at 2+ agents of ONE role (its roster dept) -> one shared
 *                  chapter appended to the book the first lesson sits in (`book.md#new-slug`, B-0347), or,
 *                  for lessons filed as whole books, one shared book on that role's shelf + its _series.md
 *                  row. The only kind the loop may APPLY.
 *   boot-compress  an agent whose boot list is over its token budget -> the books to move out of boot
 *                  (they keep firing through their series row). Advisory: the roster is railed.
 *   unread         books nobody pulled and nobody boots, once the read ledger is old enough to say
 *                  so. Advisory: the owner decides whether a book is dead or just early.
 */

// the boot cap the Library's Agents meter shows: app/tools/context-caps.json "boot", read by server/library/caps.ts
// (pure, so these rules still run on a temp database). One number for every agent; the layers around it
// (base, workspace, the agent's own prompt) have their own caps and are not this rule's.
export const bootBudget = (): number => caps().boot

export type Draft = Omit<Proposal, 'id' | 'created' | 'updated' | 'state' | 'commit' | 'revert' | 'pinned' | 'review'>

// ---- text similarity: the same lesson in different words ----

const STOP = new Set('about above after again against also always because been before being below between both but cannot could does doing down during each every from further have having here into itself just more most must never only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your yours ours which whose'.split(' '))

export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().replace(/`[^`]*`/g, ' ').split(/[^a-z0-9]+/)) {
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue
    out.add(w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w)
  }
  return out
}

/** overlap of two token sets: the larger of Jaccard and 0.8 x containment of the smaller set */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const jac = inter / (a.size + b.size - inter)
  const cont = inter / Math.min(a.size, b.size)
  return Math.max(jac, Math.min(a.size, b.size) >= 4 ? 0.8 * cont : 0)
}

export const SAME = 0.4

/** single-link clusters of lessons that say the same thing */
export function cluster(items: Captured[], threshold = SAME): Captured[][] {
  const tok = items.map(i => tokens(`${i.title} ${i.text}`))
  const parent = items.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (similarity(tok[i], tok[j]) >= threshold) parent[find(i)] = find(j)
  }
  const groups = new Map<number, Captured[]>()
  items.forEach((it, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), it]) })
  return [...groups.values()].filter(g => g.length > 1)
}

// ---- helpers ----

/** a filename from a title: at most 60 characters, cut at a word boundary (never mid-word) */
export const slug = (s: string) => {
  const full = s.toLowerCase().replace(/[`'"]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (full.length <= 60) return full || 'lesson'
  const cut = full.slice(0, 61)
  const at = cut.lastIndexOf('-')
  return (at > 20 ? cut.slice(0, at) : full.slice(0, 60)).replace(/-+$/, '') || 'lesson'
}
/** house style: no em-dash, no en-dash, no emoji, LF only */
export const house = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s*[—–]\s*/g, ' - ').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim()

/** the shelf a role's shared lessons go to: the first shelf of that dept with a root in a library home
 *  (app/library, the legacy root library/; the derived order decides) */
export function shelfForRole(role: string, shelves: Shelf[]): { shelf: Shelf; root: string } | null {
  for (const s of shelves) {
    if (s.dept !== role) continue
    const root = s.roots.find(r => /(^|\/)library(\/|$)/.test(r.replace(/\\/g, '/')))
    if (root) return { shelf: s, root: root.replace(/\\/g, '/').replace(/\/$/, '') }
  }
  return null
}

const normRoot = (r: string) => r.replace(/\\/g, '/').replace(/\/+$/, '')
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

/**
 * The shelf ONE lesson belongs to, by its own scope: a git lesson whose book already sits on a shelf
 * of this role is that shelf; otherwise the first shelf of the role whose root lies inside what the
 * filing agent writes (app writes app/ -> the app shelf, never platform's). null = no signal.
 */
export function shelfOfLesson(c: Pick<Captured, 'source' | 'ref'>, agent: Pick<Agent, 'writes'> | undefined, role: string, shelves: Shelf[]): { shelf: Shelf; root: string } | null {
  const mine = shelves.filter(s => s.dept === role)
  if (c.source === 'git') {
    const ref = c.ref.replace(/\\/g, '/')
    for (const s of mine) for (const r of s.roots) if (under(ref, normRoot(r))) return { shelf: s, root: normRoot(r) }
  }
  const writes = (agent?.writes ?? []).map(normRoot).filter(Boolean)
  for (const s of mine) for (const r of s.roots) {
    const root = normRoot(r)
    if (writes.some(w => under(root, w))) return { shelf: s, root }
  }
  return null
}

/**
 * The shelf a promoted book goes to: the shelf most of its source lessons belong to (ties -> the
 * shelf that comes first in the derived order, server/shelves.ts), falling back to the role's first library shelf only when
 * no lesson carries a scope. A home the rails refuse (repos/*) still routes there: the proposal then
 * stays advisory instead of landing the book on another agent's shelf.
 */
export function shelfForLessons(items: Captured[], role: string, agents: Agent[], shelves: Shelf[]): { shelf: Shelf; root: string } | null {
  const byId = new Map(agents.map(a => [a.id, a]))
  const votes = new Map<string, { home: { shelf: Shelf; root: string }; n: number }>()
  for (const c of items) {
    const home = shelfOfLesson(c, c.agent ? byId.get(c.agent) : undefined, role, shelves)
    if (!home) continue
    const k = `${home.shelf.id}|${home.root}`
    const v = votes.get(k)
    if (v) v.n++; else votes.set(k, { home, n: 1 })
  }
  if (!votes.size) return shelfForRole(role, shelves)
  const order = (id: string) => shelves.findIndex(s => s.id === id)
  return [...votes.values()].sort((a, b) => b.n - a.n || order(a.home.shelf.id) - order(b.home.shelf.id))[0].home
}

export const SHARED_SERIES = 'the-shared-lessons'

/** a new shared-lessons index: its title only (free tags retired 2026-09-26; a shelf's topics live in its TOP index) */
export function seriesHeader(role: string): string {
  return `---\ntitle: The Shared Lessons\n---\n\n# The Shared Lessons - ${role}\n\nLessons the loop found filed at two or more agents of this role, promoted to one book so the next\nhand of any of them finds it once.\n\n| Book | Read when |\n|---|---|\n`
}

/** append one row to a series index's table (the last table in the file); a missing index gets the header */
export function withSeriesRow(existing: string | null, role: string, row: string): string {
  const base = (existing ?? seriesHeader(role)).replace(/\r\n/g, '\n').replace(/\s+$/, '')
  return `${base}\n${row}\n`
}

// ---- rule 1: promote ----

export type PromoteCtx = { fundRoot: string; agents: Agent[]; shelves: Shelf[]; open: Proposal[] }

export function promoteDrafts(captured: Captured[], ctx: PromoteCtx): Draft[] {
  const byId = new Map(ctx.agents.map(a => [a.id, a]))
  const taken = new Set(ctx.open.flatMap(p => p.source))
  const pool = captured.filter(c => c.state === 'open' && c.agent && byId.has(c.agent) && !taken.has(c.key))
  // cluster inside each role, so a cross-role coincidence never becomes one role's book
  const roles = new Map<string, Captured[]>()
  for (const c of pool) { const r = byId.get(c.agent!)!.dept; roles.set(r, [...(roles.get(r) ?? []), c]) }
  const out: Draft[] = []
  for (const [role, items] of roles) {
    for (const g of cluster(items)) {
      const agents = [...new Set(g.map(c => c.agent!))].sort()
      if (agents.length < 2) continue
      out.push(promoteDraft(role, g, agents, ctx))
    }
  }
  return out
}

/**
 * A promoted book's topics: the union of its SOURCE books' topics (a git lesson's book, read from the
 * tree; an inbox lesson has no book) kept to the target shelf's list, the most carried first (ties in
 * lesson order), at most MAX_TOPICS.
 */
export function promotedTopics(items: Pick<Captured, 'source' | 'ref'>[], list: string[], fundRoot: string): string[] {
  const n = new Map<string, number>()
  for (const c of items) {
    if (c.source !== 'git') continue
    let text: string
    try { text = readFileSync(join(fundRoot, splitRef(c.ref).path), 'utf8') } catch { continue }
    for (const t of new Set(topicsOf(text) ?? [])) if (list.includes(t)) n.set(t, (n.get(t) ?? 0) + 1)
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, MAX_TOPICS)
}

/** the chapter a promote appends: `## Shared: <title>`, its Read when line, then each agent's wording */
function sharedChapter(title: string, readWhen: string, items: Captured[], agents: string[], role: string): string {
  return house([
    `## ${title}`,
    '',
    `Read when: ${readWhen}`,
    '',
    `Filed independently by ${agents.length} agents of ${role} (${agents.join(', ')}) between ${day(items[0].ts)} and ${day(items[items.length - 1].ts)}. Promoted to one shared chapter by the loop.`,
    '',
    ...items.flatMap(i => [`### ${i.agent} - ${day(i.ts)}`, '', `Source: \`${i.source === 'git' ? i.ref : i.key}\``, '', i.text.trim() || i.title, '']),
  ].join('\n')).replace(/\s+$/, '') + '\n'
}

/**
 * Lessons filed as chapters (B-0347) promote as a chapter: appended to the book the earliest one sits
 * in, addressed `<book>.md#<slug>`. The gate is that the book exists and no chapter already has the
 * slug; no new file and no _series.md row.
 */
function promoteChapterDraft(role: string, items: Captured[], agents: string[], ctx: PromoteCtx, bookRel: string): Draft {
  const title = `Shared: ${house(items[0].title).replace(/[.:;]+$/, '')}`
  const slugged = slugOf(title)
  const target = `${bookRel}#${slugged}`
  const readWhen = house(items.find(i => i.readWhen)?.readWhen ?? `about to do the work these lessons came from: ${items[0].title.charAt(0).toLowerCase()}${items[0].title.slice(1)}`)
  const text = sharedChapter(title, readWhen, items, agents, role)
  let current: string | null = null
  try { current = readFileSync(join(ctx.fundRoot, bookRel), 'utf8') } catch { /* the book is gone */ }
  const taken = current !== null && chaptersOf(current).some(c => c.slug === slugged)
  const roots = ctx.shelves.flatMap(s => s.roots)
  const rail = railFor(bookRel, roots)
  const gates: Gate[] = [
    { name: 'rails', ok: rail === null, note: rail ?? '' },
    { name: 'agents', ok: agents.length >= 2, note: `${agents.length} agents of ${role}` },
    { name: 'new', ok: current !== null && !taken, note: current === null ? `${bookRel} is not there` : taken ? `${target} already exists` : '' },
    { name: 'house', ok: !/[—–]/.test(text), note: '' },
  ]
  const cohort = ctx.agents.filter(a => a.dept === role && a.mode === 'active').map(a => a.id)
  return {
    kind: 'promote' as Kind,
    title: `promote: ${title}`,
    target: [target],
    source: items.map(i => i.key),
    why: `the same lesson was filed at ${agents.length} agents of ${role}; one shared chapter is found once instead of re-learned per agent`,
    gates,
    auto: gates.every(x => x.ok),
    watch: emptyWatch([...new Set([...agents, ...cohort])].sort()),
    body: [
      '## Why', '',
      `${agents.join(' and ')} each captured this lesson on their own. The shared chapter goes into \`${bookRel}\`, where the first of them filed it, with one "read when" moment.`,
      '', '## Change', '',
      `Append \`${target}\` to \`${bookRel}\`.`, '',
      '~~~markdown', text.replace(/\n$/, ''), '~~~', '',
    ].join('\n'),
  }
}

function promoteDraft(role: string, g: Captured[], agents: string[], ctx: PromoteCtx): Draft {
  const items = [...g].sort((a, b) => a.ts - b.ts)
  const chapterFirst = items.find(i => i.source === 'git' && splitRef(i.ref).slug)
  if (chapterFirst) return promoteChapterDraft(role, items, agents, ctx, splitRef(chapterFirst.ref).path)
  const title = house(items[0].title).replace(/[.:;]+$/, '')
  const home = shelfForLessons(items, role, ctx.agents, ctx.shelves)
  const list = (home?.shelf.topics ?? []).map(t => t.id)
  const topics = promotedTopics(items, list, ctx.fundRoot)
  const file = `${slug(title)}.md`
  const dir = home ? `${home.root}/${SHARED_SERIES}` : `app/library/?/${SHARED_SERIES}`
  const book = `${dir}/${file}`
  const series = `${dir}/_series.md`
  const readWhen = house(items.find(i => i.readWhen)?.readWhen ?? `about to do the work these lessons came from: ${title.charAt(0).toLowerCase()}${title.slice(1)}`)
  const bare = house([
    `# ${title}`,
    '',
    `Filed independently by ${agents.length} agents of ${role} (${agents.join(', ')}) between ${day(items[0].ts)} and ${day(items[items.length - 1].ts)}. Promoted to one shared book by the loop.`,
    '',
    '## As each agent filed it',
    '',
    ...items.flatMap(i => [`### ${i.agent} - ${day(i.ts)}`, '', `Source: \`${i.source === 'git' ? i.ref : i.key}\``, '', i.text.trim() || i.title, '']),
  ].join('\n')).replace(/\s+$/, '') + '\n'
  const text = topics.length ? setTopics(bare, topics) : bare
  const row = `| \`${file}\` | ${cell(readWhen)} |`
  const roots = ctx.shelves.flatMap(s => s.roots)   // the registered shelf roots: the rails (B-0069)
  const gates: Gate[] = [
    { name: 'rails', ok: [book, series].every(t => railFor(t, roots) === null), note: [book, series].map(t => railFor(t, roots)).filter(Boolean).join('; ') },
    { name: 'shelf', ok: !!home, note: home ? `${home.shelf.id} (${home.root})` : `no shelf for dept ${role} (shelves are the library folders, server/shelves.ts)` },
    { name: 'agents', ok: agents.length >= 2, note: `${agents.length} agents of ${role}` },
    { name: 'new', ok: !existsSync(join(ctx.fundRoot, book)), note: existsSync(join(ctx.fundRoot, book)) ? `${book} already exists` : '' },
    { name: 'house', ok: !/[—–]/.test(text + row), note: '' },
    // a shelf with a topic list asks 1 to 3 of every book on it (the commit guard refuses an agent's book without)
    { name: 'topics', ok: !list.length || topics.length > 0,
      note: !list.length ? '' : topics.length ? topics.join(', ') : `no source book carries a topic on ${home!.shelf.id}'s list (${list.join(', ')}); set 1 to ${MAX_TOPICS} by hand` },
  ]
  const cohort = ctx.agents.filter(a => a.dept === role && a.mode === 'active').map(a => a.id)
  return {
    kind: 'promote' as Kind,
    title: `promote: ${title}`,
    target: [book, series],
    source: items.map(i => i.key),
    why: `the same lesson was filed at ${agents.length} agents of ${role}; one shared book is found once instead of re-learned per agent`,
    gates,
    auto: gates.every(x => x.ok),
    watch: emptyWatch([...new Set([...agents, ...cohort])].sort()),
    body: [
      '## Why', '',
      `${agents.join(' and ')} each captured this lesson on their own. Every agent of ${role} reads ${home?.root ?? 'its shelf'}; the shared book puts it where all of them look, with one "read when" moment.`,
      '', '## Change', '',
      `Add \`${book}\` and its row in \`${series}\`.`, '',
      '~~~markdown', text.replace(/\n$/, ''), '~~~', '',
      '~~~text', row, '~~~', '',
    ].join('\n'),
  }
}

// ---- rule 2: boot-compress ----

export type BookInfo = { tokens: number; readWhen: string; exists: boolean }

export function bookInfoFrom(fundRoot: string, books: Book[]): (path: string) => BookInfo {
  const by = new Map(books.map(b => [b.path, b]))
  return (ref: string) => {
    const { path, slug } = splitRef(ref)   // `<book>#<slug>` (B-0345): the chapter's own tokens and moment; a slug naming no heading is not there
    const b = by.get(path)
    if (b && slug) { const c = b.chapters.find(x => x.slug === slug); return c ? { tokens: c.tokens, readWhen: c.readWhen || b.readWhen, exists: true } : { tokens: 0, readWhen: '', exists: false } }
    if (b) return { tokens: b.tokens, readWhen: b.readWhen, exists: true }
    try { const t = readFileSync(join(fundRoot, path), 'utf8'); return { tokens: Math.round(t.length / 4), readWhen: '', exists: true } } catch { return { tokens: 0, readWhen: '', exists: false } }
  }
}

export function bootDrafts(agents: Agent[], info: (p: string) => BookInfo, open: Proposal[]): Draft[] {
  const out: Draft[] = []
  for (const a of agents) {
    if (a.mode !== 'active') continue
    if (open.some(p => p.kind === 'boot-compress' && p.source.includes(`agent:${a.id}`))) continue
    const boot = (a.boot ?? []).map(p => ({ path: p, ...info(p) }))
    const total = boot.reduce((n, b) => n + b.tokens, 0)
    const budget = bootBudget()
    if (total <= budget) continue
    // drop the books that fire on their own (they carry a read-when row), largest first, until under
    const movable = boot.filter(b => b.exists && b.readWhen).sort((x, y) => y.tokens - x.tokens)
    const drop: typeof boot = []
    let left = total
    for (const b of movable) { if (left <= budget) break; drop.push(b); left -= b.tokens }
    const enough = left <= budget
    out.push({
      kind: 'boot-compress',
      title: `boot: ${a.id} loads ${total.toLocaleString('en-US')} of ${budget.toLocaleString('en-US')} tokens`,
      target: [`${AGENTS_REL}/${agentFileName(a.id)}`],
      source: [`agent:${a.id}`],
      why: `every boot of ${a.id} pays ${(total - budget).toLocaleString('en-US')} tokens over the ${budget.toLocaleString('en-US')}-token boot cap before it says a word`,
      gates: [
        { name: 'rails', ok: false, note: railFor(`${AGENTS_REL}/${agentFileName(a.id)}`) ?? '' },
        { name: 'enough', ok: enough, note: enough ? `${drop.length} book(s) out gets it to ${left.toLocaleString('en-US')}` : `moving every book with a read-when row still leaves ${left.toLocaleString('en-US')}` },
      ],
      auto: false,
      watch: emptyWatch([a.id]),
      body: [
        '## Why', '',
        `Boot books load at EVERY boot. A book with a "read when" row in its series fires at its moment anyway; moving it out of boot keeps it one pull away and stops paying for it on every turn.`,
        '', '## Change', '',
        `In the Library room (Agents, ${a.id}), take these out of boot:`, '',
        ...(drop.length ? drop.map(b => `- \`${b.path}\` (${b.tokens.toLocaleString('en-US')} tokens) - fires when: ${cell(b.readWhen)}`) : ['- none can move: no boot book carries a read-when row']),
        '', '## Boot list now', '',
        '| Book | Tokens | Read when |', '|---|---|---|',
        ...boot.map(b => `| \`${b.path}\` | ${b.exists ? b.tokens.toLocaleString('en-US') : 'missing'} | ${cell(b.readWhen) || '-'} |`),
        '',
      ].join('\n'),
    })
  }
  return out
}

// ---- rule 3: unread ----

export type Ledger = { since: number | null; pulled: Set<string> }

export function unreadDrafts(books: Book[], agents: Agent[], ledger: Ledger, now: number, minDays: number, open: Proposal[], shelves: Shelf[]): { drafts: Draft[]; note: string | null } {
  if (ledger.since === null) return { drafts: [], note: 'unread: no pull has ever been recorded, so "never read" cannot be claimed' }
  const age = (now - ledger.since) / 86_400_000
  if (age < minDays) return { drafts: [], note: `unread: the read ledger is ${age.toFixed(1)} days old; "never read" needs ${minDays}` }
  const booted = new Set(agents.flatMap(a => (a.boot ?? []).map(r => splitRef(r).path)))   // a chapter boot counts the book as booted
  const flagged = new Set(open.filter(p => p.kind === 'unread').flatMap(p => p.target))
  const byShelf = new Map<string, Book[]>()
  for (const b of books) {
    if (!/(^|\/)library\//.test(b.path) || booted.has(b.path) || ledger.pulled.has(b.path) || flagged.has(b.path)) continue
    if (/(^|\/)desk-law\.md$/.test(b.path)) continue
    byShelf.set(b.shelf, [...(byShelf.get(b.shelf) ?? []), b])
  }
  const drafts: Draft[] = []
  for (const [shelf, bs] of byShelf) {
    const title = shelves.find(s => s.id === shelf)?.title ?? shelf
    drafts.push({
      kind: 'unread',
      title: `unread: ${bs.length} book${bs.length === 1 ? '' : 's'} on ${title}`,
      target: bs.map(b => b.path),
      source: [`ledger:${day(ledger.since)}`],
      why: `pulled by no agent and in no boot list since the read ledger began ${day(ledger.since)} (${Math.floor(age)} days)`,
      gates: [{ name: 'advisory', ok: false, note: 'a book nobody reads is either dead or has the wrong read-when; the owner decides' }],
      auto: false,
      watch: emptyWatch(),
      body: ['## Why', '', 'A book that never fires did not exist for the decision it should have shaped. Either its read-when row names a moment nobody hits, or it is dead.', '', '## Books', '', '| Book | Read when |', '|---|---|', ...bs.map(b => `| \`${b.path}\` | ${cell(b.readWhen) || '-'} |`), ''].join('\n'),
    })
  }
  return { drafts, note: null }
}
