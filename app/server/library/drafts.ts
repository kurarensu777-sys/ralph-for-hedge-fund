import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { LibraryDraftsRow } from '@fund/db'
import { MAX_TOPICS, chaptersOf, setTopics, splitRef, TOPIC_RE } from '../../shared/bookmeta.ts'
import type { Agent, Shelf } from '../../shared/types.ts'
import { ops, type Queryable } from '../db.ts'
import { transcriptTexts } from '../chat/transcripts.ts'
import { HttpError } from '../http.ts'
import { addLesson, setLessonState } from '../loop/capture.ts'
import { house, slug, withSeriesRow } from '../loop/rules.ts'
import { hashOf, saveFiles } from './edit.ts'
import { repoFor } from './scan.ts'
import type { DraftLevel, LibDraft, LibDrafts } from './types.ts'

// DRAFTED BOOKS FROM OWNER CORRECTIONS. A conversation that went idle or closed without a Wrap
// (the debrief skill) leaks whatever the owner corrected in it. This job reads the OWNER's turns
// only, keeps the ones that look like a lasting correction ("no, always...", "never...", "from now
// on..."), asks one bounded Haiku call per conversation to turn them into books, files each draft
// at the deepest shelf it holds at, and WRITES NOTHING to the tree: a draft is a row until the
// owner saves it (one commit: the book + its _series.md row) or dismisses it (nothing written).

export const IDLE_MS = 20 * 60_000            // a conversation quiet this long counts as idle
export const LOOKBACK_MS = 14 * 86_400_000    // older conversations are history, not leaks
export const MAX_CONVS = 8                    // per pass
export const MAX_TURNS = 12                   // owner turns sent to the model, per conversation
export const MAX_DRAFTS = 3                   // books drafted per conversation
export const CALL_USD = 0.05                  // maxBudgetUsd per model call
export const PASS_USD = 0.3                   // a pass stops calling the model past this
export const DEFAULT_SERIES = 'the-owners-corrections'

/** the cheap prefilter: phrasing that states a standing rule, not a one-off instruction */
export const CORRECTION = /(^|[\s"'(])(no[,.!]\s|always\b|never\b|from now on\b|going forward\b|stop (doing|using|writing|adding)\b|do not\b|don'?t\b|instead of\b|i (want|prefer|told you|said)\b|next time\b|every time\b|remember (to|that)\b|make sure\b|not like that\b)/i
/** anything credential-shaped: such a turn is never read by the model and never drafted from */
export const SECRET = /(sk-ant-|\bsk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY|\b(api[_ -]?key|secret|password|passphrase|private[_ -]?key|seed phrase|mnemonic|token)\b\s*(is\s*)?[:=]|\bghp_[A-Za-z0-9]{20,}|\bxox[abp]-|\bAKIA[0-9A-Z]{16}\b|\b[0-9a-f]{40,}\b|\b[A-Za-z0-9+/]{48,}={0,2})/i
/** the owner closing the conversation with a Wrap: the debrief already swept it */
export const WRAP = /\b(wrap (it|this)( up)?|that'?s a wrap|debrief)\b/i
/** never drafted into, whatever a shelf root says */
export const RAILED = /(^|\/)(crypto|api\/execution)(\/|$)/i
/** a draft lands only under a library folder (every shelf home has one: app/library - the one library,
 *  the legacy root library/) */
const LIBRARY_ROOT = /(^|\/)library(\/|$)/
/** the guarded execution repo and its craft shelf: owner only */
const GUARDED = /(^|\/)execution(\/|$)/i

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** pure: the owner turns worth one model call - correction-shaped, no secrets, the most recent MAX_TURNS */
export function prefilter(turns: string[]): string[] {
  return turns
    .map(t => t.replace(/\r\n/g, '\n').trim())
    .filter(t => t.length >= 8 && CORRECTION.test(t) && !SECRET.test(t))
    .map(t => (t.length > 1500 ? t.slice(0, 1500) : t))
    .slice(-MAX_TURNS)
}

export type Proposed = { quote: string; title: string; level: DraftLevel; series: string | null; readWhen: string; body: string; topics: string[] }

/** the topic ids of the shelf a draft of this level (and series) lands on; null = no shelf, [] = it names none */
export type TopicsFor = (level: DraftLevel, series: string | null) => string[] | null

/**
 * pure: the model's JSON -> drafts, keeping only lessons whose quote is the owner's own words. A
 * draft's topics are the ones on its TARGET shelf's list (`topicsFor`), at most MAX_TOPICS, in the
 * model's order; with no `topicsFor`, or a target shelf that names none, it carries none.
 */
export function parseProposals(text: string, turns: string[], topicsFor?: TopicsFor): Proposed[] {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return []
  let raw: any
  try { raw = JSON.parse(m[0]) } catch { return [] }
  const list: any[] = Array.isArray(raw?.lessons) ? raw.lessons : []
  const hay = turns.map(norm)
  const out: Proposed[] = []
  const seen = new Set<string>()
  for (const l of list) {
    const quote = String(l?.quote ?? '').trim()
    const title = house(String(l?.title ?? '')).replace(/\s+/g, ' ').trim().replace(/[.:;]+$/, '')
    const body = house(String(l?.body ?? '')).trim()
    const readWhen = house(String(l?.readWhen ?? l?.read_when ?? '')).replace(/\s+/g, ' ').trim()
    const level: DraftLevel = ['agent', 'role', 'fund'].includes(l?.level) ? l.level : 'agent'
    const series = typeof l?.series === 'string' && /^[a-z0-9-]{3,60}$/.test(l.series) ? l.series : null
    if (quote.length < 8 || !hay.some(h => h.includes(norm(quote)))) continue      // not the owner's own words
    if (title.length < 4 || title.length > 100 || body.length < 20 || body.length > 4000 || readWhen.length < 8 || readWhen.length > 300) continue
    if ([quote, title, body, readWhen].some(s => SECRET.test(s))) continue
    const k = norm(quote)
    if (seen.has(k)) continue
    seen.add(k)
    const allowed = topicsFor?.(level, series) ?? []
    const asked: string[] = Array.isArray(l?.topics) ? l.topics.map((t: unknown) => String(t ?? '').trim().toLowerCase()) : []
    const topics = [...new Set(asked)].filter(t => TOPIC_RE.test(t) && allowed.includes(t)).slice(0, MAX_TOPICS)
    out.push({ quote: quote.slice(0, 600), title, level, series, readWhen, body, topics })
    if (out.length >= MAX_DRAFTS) break
  }
  return out
}

export type Placed = { shelf: Shelf; root: string; level: DraftLevel; series: string }

const slash = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
/** does an agent's `writes` list cover a folder (a prefix either way round, file entries ignored) */
export function covers(writes: string[], root: string): boolean {
  const r = `${slash(root)}/`
  return writes.some(w => { const x = slash(w); return !!x && !/\.[a-z]+$/i.test(x) && r.startsWith(`${x}/`) })
}

/**
 * The deepest shelf the lesson holds at: the agent's own shelf (a library shelf of its department
 * that its writes cover) first, then its role (any shelf of its department), then the fund (the law
 * shelf). Any registered shelf root under a library/ folder qualifies (app/library/<x>, the legacy root
 * library/<x>), committed in the repo that holds it; never a railed
 * path and never the guarded execution repo.
 */
export function place(level: DraftLevel, agent: Pick<Agent, 'dept' | 'writes'>, shelves: Shelf[], fundRoot: string, series: string | null = null): Placed | null {
  const lib = shelves.flatMap(s => s.roots.map(r => ({ shelf: s, root: slash(r) })))
    .filter(x => LIBRARY_ROOT.test(x.root) && !RAILED.test(x.root) && !GUARDED.test(x.root))
  const own = lib.find(x => x.shelf.dept === agent.dept && covers(agent.writes ?? [], x.root))
  const role = lib.find(x => x.shelf.dept === agent.dept)
  const fund = lib.find(x => x.shelf.id === 'law') ?? lib.find(x => x.shelf.id === 'fund') ?? lib.find(x => x.shelf.dept === 'HQ')
  const ladder: [DraftLevel, typeof own][] =
    level === 'agent' ? [['agent', own], ['role', role], ['fund', fund]]
      : level === 'role' ? [['role', role], ['fund', fund]]
        : [['fund', fund]]
  for (const [lv, hit] of ladder) {
    if (!hit) continue
    const want = series && existsSync(join(fundRoot, hit.root, series)) ? series : DEFAULT_SERIES
    return { shelf: hit.shelf, root: hit.root, level: lv, series: want }
  }
  return null
}

const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** the topic ids a shelf names, [] when it names none */
const topicIds = (s: Shelf): string[] => (s.topics ?? []).map(t => t.id)

/** pure: the book text (its topics - those on the shelf's list - set in its frontmatter), its series
 *  row and a path no file or open draft already holds */
export function draftFiles(p: Proposed, at: Placed, conv: string, ts: number, taken: (path: string) => boolean): { path: string; book: string; seriesRow: string } {
  const base = slug(p.title)
  let file = `${base}.md`
  for (let i = 2; taken(`${at.root}/${at.series}/${file}`); i++) file = `${base}-${i}.md`
  const topics = (p.topics ?? []).filter(t => topicIds(at.shelf).includes(t)).slice(0, MAX_TOPICS)
  const text = house([
    `# ${p.title}`, '',
    p.body.trim(), '',
    '## Where it came from', '',
    `A correction the owner gave in conversation \`${conv}\` on ${day(ts)}, drafted from the owner's own words and filed at the ${at.level === 'agent' ? "agent's own" : at.level === 'role' ? "role's" : "fund's"} shelf.`, '',
  ].join('\n'))
  const book = topics.length ? setTopics(text, topics) : text
  return { path: `${at.root}/${at.series}/${file}`, book, seriesRow: `| \`${file}\` | ${cell(p.readWhen)} |` }
}

/** a new series' index: its title only (free tags retired 2026-09-26; a shelf's topics live in its TOP index) */
export function seriesHeader(series: string): string {
  const title = series.split('-').map(w => w[0]?.toUpperCase() + w.slice(1)).join(' ')
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\nStanding corrections the owner gave in conversation, filed so no hand needs telling twice.\n\n| Book | Read when |\n|---|---|\n`
}

// ---- the model call ----

export type Llm = (prompt: string) => Promise<{ text: string; cost: number }>

/** a shelf a draft may land on, at the level place() lands it, with the topic list it names */
export type Candidate = { level: DraftLevel; shelf: Shelf }

/** the shelves this agent's drafts can land on: its own, its role's, the fund's (place()), each once */
export function candidateShelves(agent: Pick<Agent, 'dept' | 'writes'>, shelves: Shelf[], fundRoot: string): Candidate[] {
  const out: Candidate[] = []
  for (const level of ['agent', 'role', 'fund'] as DraftLevel[]) {
    const at = place(level, agent, shelves, fundRoot)
    if (at && !out.some(c => c.shelf.id === at.shelf.id)) out.push({ level: at.level, shelf: at.shelf })
  }
  return out
}

export function promptFor(agent: Pick<Agent, 'id' | 'dept' | 'role'>, turns: string[], seriesNames: string[], shelves: Candidate[] = []): string {
  const listed = shelves.filter(c => topicIds(c.shelf).length)
  return [
    'You read what the OWNER of an agent-run fund said to one of its agents, and find LASTING corrections or preferences:',
    'rules that should bind future sessions ("no, always...", "never...", "from now on..."). Ignore one-off task instructions,',
    'questions, and anything about a single file or number. Most conversations have none: then return {"lessons": []}.',
    '',
    `The agent: ${agent.id} (department ${agent.dept}): ${agent.role}`,
    `Existing series you may file into: ${seriesNames.join(', ') || 'none'}`,
    '',
    'For each lasting correction (at most 3) return:',
    '  quote    - the owner\'s exact words, copied verbatim from one message below (a sentence or two)',
    '  title    - the rule as a short imperative title, under 70 characters',
    '  level    - "agent" (true for this agent only), "role" (for every agent of its department) or "fund" (for everyone)',
    '  series   - one of the existing series above if it clearly fits, else null',
    '  readWhen - the MOMENT the next hand must read it, starting "about to ..." (not a description of the book)',
    '  body     - the book: the rule, why the owner wants it, and what doing it right looks like. 2-5 short paragraphs,',
    '             plain markdown, no headings, no em-dashes, no emojis, never a person\'s real name (say "the owner").',
    `  topics   - 1 to ${MAX_TOPICS} ids from the list of the shelf the lesson lands on (by its level), copied exactly; [] when that shelf names none`,
    ...(listed.length
      ? ['', 'The shelves a lesson can land on, and the topics each names (id: what it holds):',
        ...listed.flatMap(c => [`  level "${c.level}" -> shelf ${c.shelf.id}:`, ...(c.shelf.topics ?? []).map(t => `    ${t.id}: ${t.holds}`)])]
      : []),
    '',
    'Answer with JSON only: {"lessons": [{"quote": "", "title": "", "level": "agent", "series": null, "readWhen": "", "body": "", "topics": []}]}',
    '',
    'The owner\'s messages:',
    ...turns.map((t, i) => `--- message ${i + 1} ---\n${t}`),
  ].join('\n')
}

/** one bounded Agent SDK call: Haiku, no tools, one turn, no session file, a scrubbed env, capped cost */
export const haiku: Llm = async (prompt) => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const { agentEnv } = await import('../chat/env.ts')
  const { tmpdir } = await import('node:os')
  let text = '', cost = 0, err: string | null = null
  for await (const m of query({
    prompt,
    options: {
      model: 'claude-haiku-4-5-20251001', maxTurns: 1, maxBudgetUsd: CALL_USD, tools: [], persistSession: false,
      settingSources: [], cwd: tmpdir(), env: agentEnv(process.env),
      systemPrompt: 'You extract lasting rules from what a person said. You answer with one JSON object and nothing else.',
    } as any,
  }) as AsyncIterable<any>) {
    if (m?.type === 'result') {
      cost = Number(m.total_cost_usd) || 0
      if (m.subtype === 'success') text = String(m.result ?? '')
      else err = String(m.subtype)
    }
  }
  if (err && !text) throw new Error(`model call ended: ${err}`)
  return { text, cost }
}

// ---- the pass ----

export type ScanDeps = {
  db: Queryable
  agents: Agent[]
  shelves: Shelf[]
  fundRoot: string
  llm: Llm
  now: number
  fileOf: (conv: string) => string | null | Promise<string | null>     // the conversation's transcript on disk
}

type ConvRow = { id: string; agent_id: string; last_at: number; state: string }

/** conversations due a read: idle or closed, quiet IDLE_MS, inside LOOKBACK_MS, not read since they last moved */
export async function candidates(d: Queryable, now: number): Promise<ConvRow[]> {
  return ops.conversationsDueForDraftScan(now - IDLE_MS, now - LOOKBACK_MS, { limit: MAX_CONVS }, d)
}

function seriesUnder(fundRoot: string, shelves: Shelf[]): string[] {
  const out = new Set<string>()
  for (const s of shelves) for (const r of s.roots) {
    try { for (const e of readdirSync(join(fundRoot, r), { withFileTypes: true })) if (e.isDirectory()) out.add(e.name) } catch { /* no root */ }
  }
  return [...out].sort()
}

/** did the conversation end in a Wrap: the owner said so, the debrief skill ran, or it filed its own lessons */
export async function wrapped(d: Queryable, conv: string, file: string, owner: string[]): Promise<boolean> {
  if (owner.some(t => WRAP.test(t))) return true
  try {
    if (statSync(file).size <= 40_000_000) {
      const raw = readFileSync(file, 'utf8')
      if (raw.includes('"skill":"debrief"') || raw.includes('<command-name>/debrief')) return true
    }
  } catch { /* unreadable: the owner turns decided */ }
  return ops.conversationHasUndraftedLesson(conv, d)
}

export type ConvScan = { conv: string; found: number; cost: number; note: string }

export async function scanConversation(c: ConvRow, deps: ScanDeps, budgetLeft: number): Promise<ConvScan> {
  const { db: d } = deps
  // a rescan ADDS to what earlier scans of the conversation found and spent (not ops.setDraftScan, which replaces)
  const done = async (found: number, cost: number, note: string): Promise<ConvScan> => {
    await ops.bumpDraftScan(c.id, c.last_at, { found, costUsd: cost, note, ts: deps.now }, d)
    return { conv: c.id, found, cost, note }
  }
  const agent = deps.agents.find(a => a.id === c.agent_id)
  if (!agent) return done(0, 0, `no agent ${c.agent_id} in the roster`)
  const file = await deps.fileOf(c.id)
  if (!file) return done(0, 0, 'no transcript on disk')
  let owner: string[]
  try { owner = transcriptTexts(file).filter(t => t.role === 'user').map(t => t.text) } catch (e) { return done(0, 0, `transcript unreadable: ${(e as Error).message}`) }
  if (await wrapped(d, c.id, file, owner)) return done(0, 0, 'wrapped')
  const turns = prefilter(owner)
  if (!turns.length) return done(0, 0, 'no correction-shaped owner turn')
  if (budgetLeft < CALL_USD) return { conv: c.id, found: 0, cost: 0, note: 'pass budget spent; next pass' }   // not recorded: read again next pass
  let text: string, cost: number
  const cands = candidateShelves(agent, deps.shelves, deps.fundRoot)
  try { ({ text, cost } = await deps.llm(promptFor(agent, turns, seriesUnder(deps.fundRoot, deps.shelves), cands))) } catch (e) { return done(0, 0, `model call failed: ${(e as Error).message}`) }
  // a draft's topics come from its TARGET shelf's list: the shelf place() files it on (insertDraft places it the same way)
  const props = parseProposals(text, turns, (level, series) => {
    const at = place(level, agent, deps.shelves, deps.fundRoot, series)
    return at ? topicIds(at.shelf) : null
  })
  let found = 0
  for (const p of props) if (await insertDraft(deps, agent, c.id, p)) found++
  return done(found, cost, props.length ? `${found} drafted` : 'no lasting correction')
}

/** one draft row (+ its loop_lessons mirror); false when this correction was drafted before */
export async function insertDraft(deps: Pick<ScanDeps, 'db' | 'shelves' | 'fundRoot' | 'agents' | 'now'>, agent: Agent, conv: string, p: Proposed): Promise<boolean> {
  const d = deps.db
  const key = `${conv}:${hashOf(norm(p.quote))}`
  if (await ops.libraryDraftExists(key, d)) return false
  const at = place(p.level, agent, deps.shelves, deps.fundRoot, p.series)
  if (!at) return false
  const open = new Set((await ops.listLibraryDrafts({ state: 'open', limit: 10_000 }, d)).map(r => r.path))
  const f = draftFiles(p, at, conv, deps.now, path => open.has(path) || existsSync(join(deps.fundRoot, path)))
  if (RAILED.test(f.path)) return false
  const id = await ops.addLibraryDraft({ conv, agent: agent.id, shelf: at.shelf.id, level: at.level, path: f.path, title: p.title, book: f.book, series_row: f.seriesRow,
    quote: p.quote, key, state: 'open', ts: deps.now }, d)
  if (id === null) return false
  try {
    const l = await addLesson(d, deps.agents, { agent: agent.id, conversation: conv, text: `${p.title}\n\n${p.body}`, scope: at.level, readWhen: p.readWhen }, deps.now)
    await ops.update('library_drafts', id, { lesson_id: l.id }, d)
  } catch { /* the mirror is a convenience for the Loop; the draft stands without it */ }
  return true
}

export type PassResult = { ts: number; scanned: number; found: number; cost: number; notes: ConvScan[] }
let lastPass: PassResult | null = null
let running: Promise<PassResult> | null = null

/** the scheduler's job: every due conversation, one model call each at most, capped per pass */
export function scan(deps: ScanDeps): Promise<PassResult> {
  if (running) return running
  running = (async () => {
    let spent = 0, found = 0
    const notes: ConvScan[] = []
    for (const c of await candidates(deps.db, deps.now)) {
      const r = await scanConversation(c, deps, PASS_USD - spent)
      spent += r.cost; found += r.found
      notes.push(r)
    }
    lastPass = { ts: deps.now, scanned: notes.length, found, cost: spent, notes }
    return lastPass
  })().finally(() => { running = null })
  return running
}

// ---- the queue ----

type DraftRow = LibraryDraftsRow
const toDraft = (r: DraftRow): LibDraft => ({
  id: r.id, conv: r.conv, agent: r.agent, shelf: r.shelf, level: r.level as DraftLevel, path: r.path, title: r.title,
  book: r.book, seriesRow: r.series_row, quote: r.quote, state: r.state as LibDraft['state'], sha: r.sha, error: r.error, ts: r.ts, updated: r.updated,
})

export async function listDrafts(d: Queryable): Promise<LibDrafts> {
  const rows = await ops.listLibraryDrafts({ state: 'open', limit: 200 }, d)
  const t = await ops.libraryDraftTally(d)
  const tally = { s: t.saved, x: t.dismissed }
  const sc = { ts: t.last_scan_ts }
  const lp = lastPass
  const lastScan = lp ? { ts: lp.ts, scanned: lp.scanned, found: lp.found, cost: lp.cost, note: lp.scanned ? null : 'nothing due' }
    : sc.ts ? { ts: sc.ts, scanned: -1, found: -1, cost: -1, note: 'before this fundd started' } : null
  return { drafts: rows.map(toDraft), saved: tally.s ?? 0, dismissed: tally.x ?? 0, lastScan }
}

async function getOpen(d: Queryable, id: number): Promise<DraftRow> {
  const r = Number.isSafeInteger(id) ? await ops.get('library_drafts', id, d) : null
  if (!r) throw new HttpError(404, `no draft ${id}`)
  if (r.state !== 'open') throw new HttpError(409, `draft ${id} is ${r.state}`)
  return r
}

/**
 * pure: a draft path the owner may keep or type - a new .md under a library shelf root, never railed;
 * or `<book>.md#<slug>` (B-0347): a chapter to APPEND to that book, the slug not yet in it
 */
export function validPath(path: string, shelves: Shelf[]): string | null {
  const ref = splitRef(slash(path))
  if (ref.slug) return validBook(ref.path, shelves) ? `${ref.path}#${ref.slug}` : null
  if (/#/.test(path)) return null
  return validBook(path, shelves)
}

function validBook(path: string, shelves: Shelf[]): string | null {
  const p = slash(path)
  if (!/\.md$/i.test(p) || !LIBRARY_ROOT.test(p) || p.split('/').some(x => x === '..' || !x) || RAILED.test(p) || GUARDED.test(p)) return null
  if (/^(readme|agents|claude|_series)\.md$/i.test(basename(p))) return null
  return shelves.some(s => s.roots.some(r => p.startsWith(`${slash(r)}/`))) ? p : null
}

export async function editDraft(d: Queryable, id: number, b: any, shelves: Shelf[]): Promise<LibDraft> {
  const r = await getOpen(d, id)
  const book = typeof b?.book === 'string' ? b.book : r.book
  const row = typeof b?.seriesRow === 'string' ? b.seriesRow.replace(/[\r\n]+/g, ' ').trim() : r.series_row
  const path = typeof b?.path === 'string' ? validPath(b.path, shelves) : r.path
  if (!path) throw new HttpError(400, 'path must be a new .md under a library shelf root, or <book>.md#<new-slug> to append a chapter')
  const chapter = !!splitRef(path).slug
  if (book.length < 20 || book.length > 200_000) throw new HttpError(400, 'book text is empty or too large')
  if (!chapter && !/^\|.*\|$/.test(row)) throw new HttpError(400, 'the series row is one markdown table row: | `file.md` | read when |')
  if (SECRET.test(book) || SECRET.test(row)) throw new HttpError(400, 'looks like a credential; not kept')
  const title = (chapter ? book.match(/^##\s+(.+)$/m)?.[1] : book.match(/^#\s+(.+)$/m)?.[1])?.trim() ?? r.title
  await ops.updateLibraryDraft(id, { book, series_row: row, path, title, updated: Date.now() }, d)
  return toDraft({ ...r, book, series_row: row, path, title })
}

/**
 * The one write, one commit to the repo that holds the shelf: a new book and its _series.md row, or
 * (path `<book>.md#<slug>`, B-0347) one chapter appended to a book that is there, with the book's hash
 * as read now as the base, refused when the slug already exists. No series row for a chapter.
 */
export async function saveDraft(d: Queryable, id: number, fundRoot: string, shelves: Shelf[]): Promise<LibDraft & { sha: string }> {
  const r = await getOpen(d, id)
  const path = validPath(r.path, shelves)
  if (!path) throw new HttpError(400, `${r.path} is not a library path this draft may write`)
  const at = splitRef(path)
  if (at.slug) return saveChapterDraft(d, r, at.path, at.slug, fundRoot)
  const repoAbs = repoFor(fundRoot, path)
  const series = `${dirname(path)}/_series.md`
  if (repoFor(fundRoot, series) !== repoAbs) throw new HttpError(403, `${path} and its _series.md sit in two repos`)
  const seriesAbs = join(fundRoot, series)
  const cur = existsSync(seriesAbs) ? readFileSync(seriesAbs, 'utf8') : null
  const file = basename(path)
  const row = r.series_row.includes(file) ? r.series_row : `| \`${file}\` | ${cell(r.series_row.replace(/^\||\|$/g, '').split('|').pop() ?? '')} |`
  const nextSeries = withSeriesRow(cur ?? seriesHeader(basename(dirname(path))), '', row)
  let out
  try {
    out = await saveFiles({
      repoAbs,
      files: [
        { abs: join(fundRoot, path), path, content: r.book.replace(/\s+$/, '') + '\n', base: null },
        { abs: seriesAbs, path: series, content: nextSeries, base: cur === null ? null : hashOf(cur) },
      ],
      subject: `library: ${r.title} (owner correction)`.slice(0, 120),
    })
  } catch (e) {
    await ops.updateLibraryDraft(id, { error: String((e as Error).message).slice(0, 300), updated: Date.now() }, d)
    throw e
  }
  await ops.updateLibraryDraft(id, { state: 'saved', sha: out.sha ?? null, error: null, updated: Date.now() }, d)
  if (r.lesson_id) { try { await setLessonState(d, r.lesson_id, 'promoted', `draft:${id}`) } catch { /* mirror gone */ } }
  return { ...toDraft({ ...r, state: 'saved', sha: out.sha ?? null }), sha: out.sha ?? '' }
}

async function saveChapterDraft(d: Queryable, r: DraftRow, bookRel: string, slug: string, fundRoot: string): Promise<LibDraft & { sha: string }> {
  const abs = join(fundRoot, bookRel)
  let cur: string
  try { cur = readFileSync(abs, 'utf8') } catch { throw new HttpError(409, `${bookRel} is not there; a chapter is appended to a book that exists`) }
  const mine = chaptersOf(r.book)
  if (mine.length !== 1 || mine[0].slug !== slug) throw new HttpError(400, `the draft text must be one \`## \` chapter whose slug is ${slug}`)
  if (!mine[0].readWhen) throw new HttpError(400, 'a chapter opens with its `Read when:` line')
  if (chaptersOf(cur).some(c => c.slug === slug)) throw new HttpError(409, `${bookRel}#${slug} already exists`)
  let out
  try {
    out = await saveFiles({
      repoAbs: repoFor(fundRoot, bookRel),
      files: [{ abs, path: bookRel, content: cur.replace(/\s+$/, '') + '\n\n' + r.book.replace(/\s+$/, '') + '\n', base: hashOf(cur) }],
      subject: `library: ${r.title} (owner correction)`.slice(0, 120),
    })
  } catch (e) {
    await ops.updateLibraryDraft(r.id, { error: String((e as Error).message).slice(0, 300), updated: Date.now() }, d)
    throw e
  }
  await ops.updateLibraryDraft(r.id, { state: 'saved', sha: out.sha ?? null, error: null, updated: Date.now() }, d)
  if (r.lesson_id) { try { await setLessonState(d, r.lesson_id, 'promoted', `draft:${r.id}`) } catch { /* mirror gone */ } }
  return { ...toDraft({ ...r, state: 'saved', sha: out.sha ?? null }), sha: out.sha ?? '' }
}

/** dismiss: the row changes state; nothing is written anywhere */
export async function dismissDraft(d: Queryable, id: number): Promise<LibDraft> {
  const r = await getOpen(d, id)
  await ops.updateLibraryDraft(id, { state: 'dismissed', updated: Date.now() }, d)
  if (r.lesson_id) { try { await setLessonState(d, r.lesson_id, 'dismissed') } catch { /* mirror gone */ } }
  return toDraft({ ...r, state: 'dismissed' })
}
