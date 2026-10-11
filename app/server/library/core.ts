import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { Agent, Book } from '../../shared/types.ts'
import { publish } from '../events.ts'
import { git } from '../git/run.ts'
import { HttpError } from '../http.ts'
import { briefBody } from '../../shared/agentfile.ts'
import { splitRef } from '../../shared/bookmeta.ts'
import { AGENTS_REL, CONFIG_FILES, FUND_ROOT, VET_FILE_REL, briefOf, inFund, labRel, within } from '../paths.ts'
import { saveAgents, config } from '../config.ts'
import { db } from '../db.ts'
import { markCold, marks, outcomes, unmark, withBoot, withoutBoot } from './outcomes.ts'
import { hashOf, saveBook } from './edit.ts'
import { agentPulls, bookUse, recentReads, tracking } from './reads.ts'
import { bookTitle, bootableIndex, parseVet, repoFor, scanBooks, toRel } from './scan.ts'
import { docsOf, search, type Doc } from './search.ts'
import { caps, type Caps } from './caps.ts'
import { layersOf, readerAt } from './layers.ts'
import { claudeFilesOnDisk, clearLinks, trackedClaudeFiles } from './links.ts'
import { loadsByAgent, recallIndex } from './need.ts'
import type { AgentPull, BookMark, BookUse, LibOutcomes, HistoryRow, LibAgent, LibBook, LibBookDetail, LibBooks, LibSearch, ReadTracking, SaveResult, VetRow } from './types.ts'

/** the caps (app/tools/context-caps.json) as the Library shows them; null = the file could not be read: no mark is drawn, no cap invented */
function tryCaps(): Caps | null { try { return caps() } catch { return null } }

// ---- the scan, cached; invalidated by fs.watch on the roots or a change in the derived shelves ----
let cache: { key: string; books: Book[]; at: number } | null = null
let watchers: FSWatcher[] = []
let watchedKey = ''
let pending: ReturnType<typeof setTimeout> | null = null

function shelvesKey() { return JSON.stringify(config.shelves()) }

function invalidate() {
  cache = null
  clearLinks()
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => { pending = null; publish('library') }, 250)
}

function arm(key: string) {
  if (key === watchedKey) return
  for (const w of watchers) { try { w.close() } catch { /* already gone */ } }
  watchers = []
  watchedKey = key
  for (const shelf of config.shelves()) {
    for (const root of shelf.roots) {
      const abs = join(FUND_ROOT, root)
      if (!existsSync(abs)) continue
      try {
        const w = watch(abs, { recursive: true }, (_e, name) => { if (!name || /\.md$/i.test(String(name))) invalidate() })
        w.on('error', () => { /* root removed: the next scan re-arms */ })
        watchers.push(w)
      } catch { /* recursive watch unsupported: the cache still refreshes on shelves change */ }
    }
  }
}

export function books(): Book[] {
  const key = shelvesKey()
  if (!cache || cache.key !== key) {
    cache = { key, books: scanBooks(FUND_ROOT, config.shelves()), at: Date.now() }
    arm(key)
  }
  return cache.books
}

/** close every root watcher (tests; a shelves change re-arms on the next scan) */
export function stopLibrary() {
  for (const w of watchers) { try { w.close() } catch { /* gone */ } }
  watchers = []; watchedKey = ''; cache = null
}

/** called once at boot so edits publish before anyone asks */
export function startLibrary() { try { books() } catch { /* first request will retry */ } }

/** boot ref -> the agents that boot it, counted per ref: `<book>#<slug>` is its own key (that chapter's readers),
 *  and the bare `<book>` key holds everyone who boots the book whole or any chapter of it, each agent once */
export function readersOf(agents: Agent[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  const add = (k: string, id: string) => { const l = m.get(k) ?? []; if (!l.includes(id)) l.push(id); m.set(k, l) }
  for (const a of agents) for (const p of a.boot ?? []) { add(p, a.id); const { path, slug } = splitRef(p); if (slug) add(path, a.id) }
  return m
}

/** a boot ref's book, chapter and tokens: the whole book, or the one chapter's slice; null = names no book, or no such chapter */
export function bootRef(all: Book[], ref: string): { book: Book; chapter: Book['chapters'][number] | null; tokens: number } | null {
  const { path, slug } = splitRef(ref)
  const book = all.find(b => b.path === path)
  if (!book) return null
  if (!slug) return { book, chapter: null, tokens: book.tokens }
  const chapter = book.chapters.find(c => c.slug === slug)
  return chapter ? { book, chapter, tokens: chapter.tokens } : null
}

/** a store read that may fail (the store down, a table missing): the page shows "unknown", never a zero */
async function tryDb<T>(f: () => Promise<T>): Promise<{ v: T | null; err?: string }> {
  try { return { v: await f() } } catch (e: any) { return { v: null, err: String(e?.message ?? e) } }
}

/** the CLAUDE.md files git tracks in the fund and every repo at its root (the link audit's list), cached
 *  a minute; git failing falls back to the files on disk, and both failing is an error, never an empty list */
let claudeCache: { at: number; files: string[] } | null = null
async function claudeFiles(): Promise<string[]> {
  if (claudeCache && Date.now() - claudeCache.at < 60_000) return claudeCache.files
  let files: string[]
  try { files = await trackedClaudeFiles(FUND_ROOT) } catch { files = claudeFilesOnDisk(FUND_ROOT) }
  claudeCache = { at: Date.now(), files }
  return files
}

export async function listBooks(): Promise<LibBooks> {
  const all = books()
  const readers = readersOf(config.agents())
  const use = await tryDb(() => bookUse())
  const tr = await tryDb<ReadTracking>(() => tracking())
  const blank: BookUse = { n30: 0, last: null, who: [], boots30: 0, lastBoot: null }
  const cold = (await tryDb(() => marks(db))).v
  const markOf = (p: string): BookMark | undefined => { const m = cold?.get(p); return m ? { state: 'cold', n: m.n, ts: m.ts, note: m.note } : undefined }
  const cf = await tryDb(claudeFiles)
  const paths = new Set(all.map(b => b.path))
  const recall = cf.v ? recallIndex(FUND_ROOT, cf.v, p => paths.has(p)) : new Map()
  const out: LibBook[] = all.map(b => ({ ...b, chapters: b.chapters.map(c => ({ ...c, readers: readers.get(`${b.path}#${c.slug}`) ?? [] })), readers: readers.get(b.path) ?? [], recall: recall.get(b.path) ?? [], use: use.v ? (use.v.get(b.path) ?? blank) : undefined, mark: markOf(b.path) }))
  const shelves = config.shelves().map(s => {
    const mine = all.filter(b => b.shelf === s.id)
    return { ...s, count: mine.length, tokens: mine.reduce((n, b) => n + b.tokens, 0) }
  })
  const err = use.err ?? tr.err
  const c = tryCaps()
  return {
    caps: c ? { chapter: c.chapter, chapterTarget: c.chapterTarget, book: c.book, boot: c.boot } : null,
    shelves, books: out, scanned: cache?.at ?? Date.now(), tracking: use.v ? tr.v : null, ...(err ? { trackingError: err } : {}),
    agents: config.agents().map(a => a.id), loads: cf.v ? loadsByAgent(config.agents(), cf.v) : null, ...(cf.err ? { loadsError: cf.err } : {}),
  }
}

export async function listAgents(): Promise<LibAgent[]> {
  const all = books()
  const c = tryCaps()
  const read = readerAt(FUND_ROOT)
  const byPath = new Map(all.map(b => [b.path, b]))
  const pulls = (await tryDb<Map<string, AgentPull[]>>(() => agentPulls())).v
  return config.agents().map(a => {
    const boot = (a.boot ?? []).map(p => {
      const r = bootRef(all, p)
      if (r) return { path: p, known: true, title: r.chapter ? `${r.book.title} - ${r.chapter.title}` : r.book.title, shelf: r.book.shelf, tokens: r.tokens }
      const b = splitRef(p).slug ? null : bootableIndex(FUND_ROOT, config.shelves(), p)
      return { path: p, known: !!b, title: b?.title ?? p, shelf: b?.shelf ?? '', tokens: b?.tokens ?? 0 }
    })
    const brief = briefOfAgent(a)
    const bootTokens = boot.reduce((n, b) => n + b.tokens, 0)
    return {
      id: a.id, name: a.name, kind: a.kind, mode: a.mode, dept: a.dept, role: a.role, cwd: a.cwd,
      boot,
      bootTokens,
      missing: boot.filter(b => !b.known).length,
      budget: c ? c.boot : null,
      layers: c ? layersOf(a, bootTokens, brief.text === null ? null : brief.tokens, read, c) : null,
      brief,
      pulled: pulls ? (pulls.get(a.id) ?? [])
        .filter(p => !(a.boot ?? []).includes(p.path))
        .map(p => { const b = byPath.get(p.path); return { ...p, known: !!b, title: b?.title ?? p.path, shelf: b?.shelf ?? '' } }) : undefined,
    }
  })
}

/** the agent's brief: the body of its roster file under the YAML header (exactly what the launch
 *  contract appends, shared/agentfile.ts briefBody); null text = missing */
export function briefOfAgent(a: Agent): LibAgent['brief'] {
  const path = briefOf(a)
  const abs = inFund(path)
  let text: string | null = null
  try { text = abs ? briefBody(readFileSync(abs, 'utf8')) : null } catch { text = null }
  return { path, text, tokens: text ? Math.round(text.length / 4) : 0 }
}

// ---- one book ----

/**
 * `git log --format=LOG_FORMAT` -> rows. WHO is the commit's Agent: trailer, else "you" (the
 * owner). The git author name is never read, so no real name can reach the UI.
 */
export const LOG_FORMAT = '%h|%at|%(trailers:key=Agent,valueonly,separator=%x2C)|%s'
export function parseLog(out: string): HistoryRow[] {
  return out.split(/\r?\n/).filter(Boolean).map(line => {
    const [sha, at, agent, ...rest] = line.split('|')
    return { sha, ts: Number(at) * 1000, who: agent?.trim() || 'you', subject: rest.join('|') }
  })
}

/**
 * A desk's machine file (lab/<desk>/beliefs.md, lab/<desk>/retros/<date>.md ...): not a book on any
 * shelf, but the Loop and Lab rooms link to them, so the Library serves them READ-ONLY. The path is
 * the LOGICAL one (`lab/...`, the desk id's own spelling); the file is read from wherever the lab
 * is (paths.ts labRel: platform/lab since 2026-09-25). Only a .md that resolves inside the lab (the
 * inFund guard, then within the lab folder) and exists as a file.
 */
export function labAbs(path: string): string | null {
  if (!/^lab\/.+\.md$/i.test(path)) return null
  const home = inFund(labRel())
  const abs = inFund(`${labRel()}/${path.slice(4)}`)
  if (!abs || !home || !within(abs, home) || abs === home) return null
  return abs
}

export function labBook(path: string): Book | null {
  const abs = labAbs(path)
  if (!abs) return null
  let text: string, mtime: number
  try {
    const st = statSync(abs)
    if (!st.isFile()) return null
    text = readFileSync(abs, 'utf8'); mtime = st.mtimeMs
  } catch { return null }
  // the id is the logical path, normalised (lab/vol/../vol/x.md reads as lab/vol/x.md)
  const logical = `lab/${toRel(inFund(labRel())!, abs)}`
  return { path: logical, shelf: 'lab', series: basename(dirname(abs)), title: bookTitle(text, abs), readWhen: '', topics: [], type: null, parent: null, chapters: [], tokens: Math.round(text.length / 4), updated: Math.round(mtime) }
}

/** the old platform shim `api/execution`, at any depth: refused to every hand whatever the roster says (B-0077) */
const LEGACY_EXECUTION = /(^|\/)api\/execution(\/|$)/

/**
 * Is this book read-only here? A guarded repo (repos.json `guarded`: execution) follows the roster
 * like the commit guard does (B-0427, B-0453): a book in it is editable when a live agent's `writes`
 * cover its path, read-only when none does. The old api/execution shim is read-only always.
 * Pure: `repos` and `agents` are passed in.
 */
export function bookLocked(path: string, repoRel: string, repos: { path: string; guarded?: boolean }[], agents: { mode?: string; writes?: string[] }[]): boolean {
  if (LEGACY_EXECUTION.test(path)) return true
  if (!repos.some(r => r.guarded && (r.path === repoRel || repoRel.startsWith(`${r.path}/`)))) return false
  return !agents.some(a => a.mode !== 'dormant' && (a.writes ?? []).some(w => {
    const x = w.replace(/\\/g, '/').replace(/^\.?\//, '')
    return !!x && (x.endsWith('/') ? `${path}/`.startsWith(x) : path === x || path.startsWith(`${x}/`))
  }))
}

export async function bookDetail(path: string): Promise<LibBookDetail> {
  const shelved = books().find(x => x.path === path)
  const b = shelved ?? labBook(path)
  if (!b) throw new HttpError(404, `no book ${path}`)
  const abs = shelved ? inFund(b.path) : labAbs(b.path)
  if (!abs) throw new HttpError(400, 'path escapes the fund')
  const content = readFileSync(abs, 'utf8')
  const repoAbs = repoFor(FUND_ROOT, toRel(FUND_ROOT, abs))
  const repo = toRel(FUND_ROOT, repoAbs) || '.'
  let history: HistoryRow[] | null = null
  let historyError: string | undefined
  const inRepo = relative(repoAbs, abs).split('\\').join('/')
  const out = await git(repoAbs, ['log', `--format=${LOG_FORMAT}`, '-n', '30', '--', inRepo], 10_000)
  if (out.code === 0) history = parseLog(out.stdout)
  else historyError = out.stderr.trim() || `git log exited ${out.code}`
  const allReaders = readersOf(config.agents())
  const readers = allReaders.get(b.path) ?? []
  const reads = (await tryDb(() => recentReads(b.path))).v
  const use = (await tryDb(async () => (await bookUse()).get(b.path))).v
  const blank: BookUse = { n30: 0, last: null, who: [], boots30: 0, lastBoot: null }
  const cf = (await tryDb(claudeFiles)).v
  const recall = cf ? (recallIndex(FUND_ROOT, cf, p => p === b.path).get(b.path) ?? []) : []
  return {
    book: { ...b, chapters: b.chapters.map(c => ({ ...c, readers: allReaders.get(`${b.path}#${c.slug}`) ?? [] })), readers, recall, use: reads === null ? undefined : (use ?? blank) },
    content, history, historyError, repo, hash: hashOf(content), editable: !!shelved && !bookLocked(path, repo, config.repos(), config.agents()), reads,
  }
}

// ---- full-text search: one lower-cased copy per search unit (a chapter, or a book without chapters), refreshed when its file's mtime moves ----
const texts = new Map<string, { updated: number; docs: (Doc & { lower: string })[] }>()

export function searchBooks(q: string, limit = 50): LibSearch {
  const t0 = Date.now()
  const all = books()
  const live = new Set<string>()
  const docs: (Doc & { lower: string })[] = []
  for (const b of all) {
    live.add(b.path)
    let e = texts.get(b.path)
    if (!e || e.updated !== b.updated) {
      const abs = inFund(b.path)
      let text = ''
      try { text = abs ? readFileSync(abs, 'utf8') : '' } catch { text = '' }
      e = { updated: b.updated, docs: docsOf(b, text).map(d => ({ ...d, lower: d.text.toLowerCase() })) }
      texts.set(b.path, e)
    }
    docs.push(...e.docs)
  }
  for (const k of texts.keys()) if (!live.has(k)) texts.delete(k)
  const r = search(q, docs, limit)
  return { q, terms: r.terms, hits: r.hits, total: r.total, indexed: all.length, ms: Date.now() - t0 }
}

// ---- edit in place ----
export async function editBook(b: any): Promise<SaveResult> {
  const path = b?.path
  if (typeof path !== 'string') throw new HttpError(400, 'need path')
  const book = books().find(x => x.path === path)
  if (!book) throw new HttpError(404, `no book ${path}`)
  const abs = inFund(path)
  if (!abs) throw new HttpError(400, 'path escapes the fund')
  const repoAbs = repoFor(FUND_ROOT, path)
  const repo = toRel(FUND_ROOT, repoAbs) || '.'
  if (bookLocked(path, repo, config.repos(), config.agents())) throw new HttpError(403, `${path} lives in ${repo}, a guarded repo, and no live agent's writes cover it`)
  const r = await saveBook({ repoAbs, abs, path, content: b.content, base: b.base, subject: b.subject })
  if (r.written) { invalidate(); publish('git') }
  return r
}

// ---- the boot toggle ----
/** pure: the agents list with `path` added to / removed from one agent's boot list */
export function toggleBoot(agents: Agent[], agentId: string, path: string, on: boolean, known: (p: string) => boolean): { agents: Agent[]; changed: boolean } {
  const a = agents.find(x => x.id === agentId)
  if (!a) throw new HttpError(404, `no agent ${agentId}`)
  if (on && !known(path)) throw new HttpError(400, `not a book: ${path}`)
  const boot = a.boot ?? []
  const has = boot.includes(path)
  if (on === has) return { agents, changed: false }
  const next = on ? [...boot, path] : boot.filter(p => p !== path)
  return { agents: agents.map(x => (x.id === agentId ? { ...x, boot: next } : x)), changed: true }
}

/** toggle and persist through saveAgents; publishes library + config (the configuration topic) */
export function setBoot(agentId: string, path: string, on: boolean): { changed: boolean; boot: string[] } {
  if (typeof agentId !== 'string' || typeof path !== 'string' || typeof on !== 'boolean') throw new HttpError(400, 'need {agent, path, on:boolean}')
  const all = books()
  const shelves = config.shelves()
  // removal of a stale (unknown) entry is allowed; adding one is not. A shelf's series index boots too, and
  // so does one chapter of a book (`<book>#<slug>`, B-0345): its slug must name a heading.
  const { agents, changed } = toggleBoot(config.agents(), agentId, path, on, p => !!bootRef(all, p) || (!splitRef(p).slug && !!bootableIndex(FUND_ROOT, shelves, p)))
  if (changed) {
    saveAgents(agents)
    publish('library')
    publish('config', { file: AGENTS_REL })
  }
  return { changed, boot: agents.find(a => a.id === agentId)?.boot ?? [] }
}

export function vetList(): VetRow[] {
  const f = join(FUND_ROOT, VET_FILE_REL)
  if (!existsSync(f)) return []
  const all = books()
  const known = new Set(all.map(b => b.path))
  // a row may cite `book.md#chapter`: the book is the ref's path, the chapter only when that heading exists
  return parseVet(readFileSync(f, 'utf8'), p => known.has(splitRef(p).path)).map(r => {
    const slug = r.chapter
    const has = slug && r.book ? all.find(b => b.path === r.book)?.chapters.some(c => c.slug === slug) : false
    return { ...r, chapter: has ? slug : null }
  })
}

// ---- helpful / harmful + the retire queue (server/library/outcomes.ts) ----
export function bookOutcomesPayload(): Promise<LibOutcomes> {
  return outcomes({ db, books: books(), agents: config.agents(), shelves: config.shelves(), configFiles: CONFIG_FILES, now: Date.now() })
}

/** retire: out of every boot list (through toggleBoot + saveAgents, the boot PATCH's own path); the file is never touched */
export async function retireBook(path: unknown, note: unknown): Promise<{ path: string; from: string[] }> {
  if (typeof path !== 'string') throw new HttpError(400, 'need {path}')
  if (!books().some(b => b.path === path)) throw new HttpError(404, `no book ${path}`)
  const n = (await bookOutcomesPayload()).books[path]?.n ?? 0
  const known = new Set(books().map(b => b.path))
  const { agents, from, entries } = withoutBoot(config.agents(), path, (a, id, p, on) => toggleBoot(a, id, p, on, x => known.has(splitRef(x).path)))
  await markCold(db, path, n, typeof note === 'string' && note.trim() ? note.trim().slice(0, 300) : null, entries, Date.now())
  if (from.length) { saveAgents(agents); publish('config', { file: AGENTS_REL }) }
  publish('library')
  return { path, from }
}

/** unretire: drop the mark and put it back in the boot lists it was taken out of */
export async function unretireBook(path: unknown): Promise<{ path: string; to: string[] }> {
  if (typeof path !== 'string') throw new HttpError(400, 'need {path}')
  const ids = await unmark(db, path)
  const known = new Set(books().map(b => b.path))
  let to: string[] = []
  if (known.has(path) && ids.length) {
    const r = withBoot(config.agents(), path, ids, (a, id, p, on) => toggleBoot(a, id, p, on, x => known.has(splitRef(x).path)))
    to = r.to
    if (to.length) { saveAgents(r.agents); publish('config', { file: AGENTS_REL }) }
  }
  publish('library')
  return { path, to }
}
