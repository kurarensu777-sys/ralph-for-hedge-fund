import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import type { Agent, Shelf } from '../../shared/types.ts'
import { git } from '../git/run.ts'
import { splitRef, topicFault, vocabFaults } from '../../shared/bookmeta.ts'
import { EXCLUDED, bootableIndex, isBookFile, parseSeriesIndex, repoFor, scanBooks, toRel } from './scan.ts'
import type { LibLinks, LinkFault, LinkRow } from './types.ts'
import { briefOf } from '../paths.ts'

// The link audit: read-only. Seven faults over the library's wiring (see LinkFault in types.ts).

const SKIP = new Set(['.git', 'node_modules', 'dist', '.vite', '.venv', '__pycache__'])
const ORDER: LinkFault[] = ['dead-boot', 'dead-anchor', 'dead-import', 'dead-recall', 'dead-row', 'no-index', 'bad-vocab', 'bad-topic', 'no-topic', 'unlisted', 'unreached']

const norm = (p: string) => posix.normalize(p.split('\\').join('/')).replace(/^\.\//, '')
const lc = (p: string) => p.toLowerCase()
const isTemplate = (p: string) => /[<>*{}]/.test(p)

/** `a` / `b/c.md` / `b/c.md#chapter` / `](d.md)` tokens that name a .md file (its `#slug` kept: a chapter, B-0345)
 *  or a folder (trailing /) */
export function citationRefs(text: string): string[] {
  const out: string[] = []
  const take = (raw: string) => {
    for (const part of raw.split(/\s+\+\s+|\s+/)) {
      const t = part.trim().replace(/^[("'<]+|[)"',;:.]+$/g, '')
      if (!t || /^[a-z]+:\/\//i.test(t)) continue
      if (/\.md(#[^#\s]*)?$/i.test(t)) out.push(t)
      else if (t.replace(/#.*$/, '').endsWith('/') && t.includes('/') && t.length > 1) out.push(t.replace(/#.*$/, ''))
    }
  }
  for (const m of text.matchAll(/`([^`\n]+)`/g)) take(m[1])
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) take(m[1])
  return out
}

/** the same citations as bare paths: a chapter's `#slug` dropped (the file it is in is what is cited) */
export function citations(text: string): string[] {
  return citationRefs(text).map(c => splitRef(c).path)
}

/** the table rows under every `## Recall` heading (to the next heading of the same or a higher level);
 *  `refs` keeps a chapter's `#slug` (the audit's dead-anchor check), else bare paths */
export function recallCitations(text: string, refs = false): string[] {
  const out: string[] = []
  let level = 0
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      if (level && h[1].length <= level) level = 0
      if (/^recall\b/i.test(h[2].trim())) level = h[1].length
      continue
    }
    if (level && line.trim().startsWith('|')) out.push(...(refs ? citationRefs(line) : citations(line)))
  }
  return out
}

/**
 * The `@path` import lines of a CLAUDE.md or a book, as Claude Code reads them: a line that starts
 * with `@`, outside a fenced code block. Returns [line number, target] pairs.
 */
export function importLines(text: string): [number, string][] {
  const out: [number, string][] = []
  let fence = false
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return }
    if (fence) return
    const m = line.match(/^@(\S+)/)
    if (m) out.push([i + 1, m[1]])
  })
  return out
}

/** an import target resolved as Claude Code resolves it: `~/` from the home folder, else from the importing file's folder */
export function importTarget(fundRoot: string, from: string, target: string, home = homedir()): string {
  if (target.startsWith('~/') || target.startsWith('~\\')) return join(home, target.slice(2))
  if (/^[a-z]:[\\/]/i.test(target) || target.startsWith('/')) return target
  return join(fundRoot, dirname(from), target)
}

function walk(dir: string, visit: (abs: string, name: string, isDir: boolean) => void) {
  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP.has(e.name)) { visit(abs, e.name, true); walk(abs, visit) } }
    else if (e.isFile()) visit(abs, e.name, false)
  }
}

/** every CLAUDE.md on disk under the fund (the test default; the route passes the TRACKED list) */
export function claudeFilesOnDisk(fundRoot: string): string[] {
  const out: string[] = []
  walk(fundRoot, (abs, name, isDir) => { if (!isDir && name === 'CLAUDE.md') out.push(toRel(fundRoot, abs)) })
  return out.sort()
}

/** CLAUDE.md files tracked by git in the fund repo and every nested repo at its root (app/, platform/, research/) */
export async function trackedClaudeFiles(fundRoot: string): Promise<string[]> {
  const repos = ['']
  try {
    for (const e of readdirSync(fundRoot, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && existsSync(join(fundRoot, e.name, '.git'))) repos.push(e.name)
    }
  } catch { /* unreadable root */ }
  const out: string[] = []
  for (const r of repos) {
    const res = await git(join(fundRoot, r), ['ls-files', '-z'], 20_000)
    if (res.code !== 0) throw new Error(`git ls-files in ${r || '.'}: ${res.stderr.trim() || `exit ${res.code}`}`)
    for (const f of res.stdout.split('\0')) if (f && posix.basename(f) === 'CLAUDE.md') out.push(r ? `${r}/${f}` : f)
  }
  return out.sort()
}

/** a citation as a regexp over fund-relative paths: `<x>` is one segment, a trailing / is the folder and all below */
function matcher(p: string): RegExp {
  const esc = p.split(/(<[^>]*>)/).map(s => (s.startsWith('<') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')
  return new RegExp(`^${esc}${p.endsWith('/') ? '' : '$'}`, 'i')
}

/**
 * The audit. Pure over the files: reads the shelves' trees, every CLAUDE.md named in `claude`
 * (default: every one on disk) and the agents' boot lists. Returns rows sorted by fault, then path.
 */
export function audit(fundRoot: string, shelves: Shelf[], agents: Pick<Agent, 'id' | 'boot'>[], claude?: string[]): LinkRow[] {
  const books = scanBooks(fundRoot, shelves)
  const bookSet = new Map(books.map(b => [lc(b.path), b]))
  const rows: LinkRow[] = []
  const shelfOf = (rel: string) => shelves.find(s => s.roots.some(r => lc(rel).startsWith(lc(norm(r)) + '/') || lc(rel) === lc(norm(r))))?.id ?? null

  // ---- series folders: no-index, dead-row, unlisted ----
  const dirs = new Set<string>()
  const indexed = new Map<string, Set<string>>()   // series dir (fund-rel, lc) -> listed names
  for (const s of shelves) for (const root of s.roots) {
    const abs = join(fundRoot, root)
    if (!existsSync(abs)) continue
    dirs.add(abs)
    walk(abs, (d, _n, isDir) => { if (isDir) dirs.add(d) })
  }
  for (const abs of [...dirs].sort()) {
    let names: string[] = []
    try { names = readdirSync(abs, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name) } catch { continue }
    const rel = toRel(fundRoot, abs)
    const lower = new Set(names.map(lc))
    const own = names.filter(isBookFile)
    if (!lower.has('_series.md')) {
      if (own.length) rows.push({ fault: 'no-index', path: rel + '/', target: null, shelf: shelfOf(rel + '/x'), book: null })
      continue
    }
    const idxPath = `${rel}/${names.find(n => lc(n) === '_series.md')}`
    let listed: Map<string, string>
    try { listed = parseSeriesIndex(readFileSync(join(abs, '_series.md'), 'utf8')) } catch { continue }
    indexed.set(lc(rel), new Set(listed.keys()))
    for (const name of listed.keys()) {
      if (EXCLUDED.has(name)) continue
      if (!lower.has(name)) rows.push({ fault: 'dead-row', path: idxPath, target: name, shelf: shelfOf(idxPath), book: null })
    }
    for (const n of own) {
      if (listed.has(lc(n))) continue
      const p = `${rel}/${n}`
      const b = bookSet.get(lc(p))
      if (b) rows.push({ fault: 'unlisted', path: b.path, target: null, shelf: b.shelf, book: b.path })
    }
  }

  // ---- reach: what the Recall rows, the boot lists and the books cite ----
  const byBase = new Map<string, string[]>()
  for (const b of books) { const k = lc(posix.basename(b.path)); byBase.set(k, [...(byBase.get(k) ?? []), b.path]) }
  const exists = (rel: string) => { try { return existsSync(join(fundRoot, rel)) } catch { return false } }
  /** fund-relative candidates for a citation made from file `from`: fund root, its folder, its repo root */
  const candidates = (cite: string, from: string): string[] => {
    const repo = toRel(fundRoot, repoFor(fundRoot, from))
    const bases = ['', dirname(from).split('\\').join('/'), repo].filter((x, i, a) => a.indexOf(x) === i)
    return bases.map(b => norm(b && b !== '.' ? `${b}/${cite}` : cite)).filter(p => !p.startsWith('..'))
  }
  const reached = new Set<string>()      // lc book paths
  const reachedDirs: RegExp[] = []       // folders / templates cited
  const reach = (cite: string, from: string, bare: boolean) => {
    const c = cite.split('\\').join('/')
    if (isTemplate(c) || c.endsWith('/')) {
      for (const cand of candidates(c, from)) reachedDirs.push(matcher(cand))
      return true
    }
    for (const cand of candidates(c, from)) {
      if (!exists(cand)) continue
      const k = lc(cand)
      if (bookSet.has(k)) reached.add(k)
      if (posix.basename(k) === '_series.md') reachedDirs.push(matcher(cand.slice(0, -'_series.md'.length)))
      return true
    }
    if (bare && !c.includes('/')) {
      const hits = byBase.get(lc(c)) ?? []
      if (hits.length === 1) { reached.add(lc(hits[0])); return true }
    }
    return false
  }

  const claudeList = claude ?? claudeFilesOnDisk(fundRoot)
  for (const f of claudeList) {
    let text = ''
    try { text = readFileSync(join(fundRoot, f), 'utf8') } catch { continue }
    for (const ref of recallCitations(text, true)) {
      const { path: cite, slug } = splitRef(ref)
      const ok = reach(cite, f, false)
      if (!ok && !isTemplate(cite) && /\.md$/i.test(cite)) rows.push({ fault: 'dead-recall', path: f, target: cite, shelf: null, book: null })
      // a chapter ref must name a heading of the book it resolves to (a CLAUDE.md or other non-book is not judged)
      if (ok && slug && !isTemplate(cite)) {
        const b = candidates(cite, f).filter(exists).map(c => bookSet.get(lc(c))).find(Boolean)
        if (b && !b.chapters.some(c => c.slug === slug)) rows.push({ fault: 'dead-anchor', path: f, target: ref, shelf: b.shelf, book: b.path })
      }
    }
  }
  // ---- dead-import: an `@path` line in a CLAUDE.md or any .md under a shelf that loads nothing ----
  const importers = new Set<string>(claudeList)
  for (const s of shelves) for (const root of s.roots) {
    walk(join(fundRoot, root), (abs, name, isDir) => { if (!isDir && /\.md$/i.test(name)) importers.add(toRel(fundRoot, abs)) })
  }
  for (const f of [...importers].sort()) {
    let text = ''
    try { text = readFileSync(join(fundRoot, f), 'utf8') } catch { continue }
    for (const [, target] of importLines(text)) {
      if (isTemplate(target)) continue
      if (!existsSync(importTarget(fundRoot, f, target))) {
        const b = bookSet.get(lc(f))
        rows.push({ fault: 'dead-import', path: f, target, shelf: b?.shelf ?? shelfOf(f), book: b?.path ?? null })
      }
    }
  }
  for (const a of agents) for (const ref of a.boot ?? []) {
    const { path: p, slug } = splitRef(ref)
    const b = bookSet.get(lc(norm(p)))
    if (b) {
      reached.add(lc(b.path))
      if (slug && !b.chapters.some(c => c.slug === slug)) rows.push({ fault: 'dead-anchor', path: briefOf(a), target: ref, shelf: b.shelf, book: b.path, agent: a.id })
      continue
    }
    // a booted series index reaches its folder, the same as a Recall citation of one (B-0080)
    if (bootableIndex(fundRoot, shelves, norm(p))) reachedDirs.push(matcher(norm(p).slice(0, -'_series.md'.length)))
    else rows.push({ fault: 'dead-boot', path: briefOf(a), target: ref, shelf: null, book: null, agent: a.id })
  }
  for (const b of books) {
    let text = ''
    try { text = readFileSync(join(fundRoot, b.path), 'utf8') } catch { continue }
    const self = lc(b.path)
    const before = reached.has(self)
    for (const cite of citations(text)) reach(cite, b.path, true)
    if (!before) reached.delete(self)   // a book citing itself is not reached
  }
  for (const b of books) {
    const k = lc(b.path)
    if (reached.has(k) || reachedDirs.some(re => re.test(b.path))) continue
    rows.push({ fault: 'unreached', path: b.path, target: null, shelf: b.shelf, book: b.path })
  }

  // ---- topics: only on a shelf whose top index names a list (the rule switches on per shelf) ----
  for (const s of shelves) {
    if (!s.topics) continue
    const index = `${s.roots[0]}/_series.md`
    for (const why of vocabFaults(s.topics, s.id)) rows.push({ fault: 'bad-vocab', path: index, target: why, shelf: s.id, book: null })
    for (const b of books) {
      if (b.shelf !== s.id) continue
      const why = topicFault(b.topics, s.topics)
      if (why) rows.push({ fault: b.topics.length ? 'bad-topic' : 'no-topic', path: b.path, target: why, shelf: s.id, book: b.path })
    }
  }

  return rows.sort((x, y) => ORDER.indexOf(x.fault) - ORDER.indexOf(y.fault) || x.path.localeCompare(y.path) || (x.target ?? '').localeCompare(y.target ?? ''))
}

// ---- the route's cache: cleared by the library watcher (core.invalidate), a configuration change, or 60 s ----
const TTL = 60_000
let cache: { key: string; at: number; out: LibLinks } | null = null

export function clearLinks() { cache = null }

export async function links(fundRoot: string, shelves: Shelf[], agents: Pick<Agent, 'id' | 'boot'>[], now = Date.now()): Promise<LibLinks> {
  const key = JSON.stringify([shelves, agents.map(a => [a.id, a.boot ?? []])])
  if (cache && cache.key === key && now - cache.at < TTL) return cache.out
  const claude = await trackedClaudeFiles(fundRoot)
  const rows = audit(fundRoot, shelves, agents, claude)
  const books = scanBooks(fundRoot, shelves).length
  let series = 0
  for (const s of shelves) for (const r of s.roots) {
    walk(join(fundRoot, r), (_d, n, isDir) => { if (!isDir && n === '_series.md') series++ })
  }
  const out: LibLinks = { rows, books, series, claude: claude.length, scanned: now }
  cache = { key, at: now, out }
  return out
}
