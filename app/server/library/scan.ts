import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { chaptersOf, parentOf, splitRef, topicsOf, typeOf } from '../../shared/bookmeta.ts'
import type { Book, Shelf } from '../../shared/types.ts'
import type { VetRow } from './types.ts'

/** files under a shelf root that are NOT books */
export const EXCLUDED = new Set(['readme.md', 'agents.md', 'claude.md', '_series.md'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.vite'])

export function isBookFile(name: string): boolean {
  return name.toLowerCase().endsWith('.md') && !EXCLUDED.has(name.toLowerCase())
}

/** split one markdown table row into trimmed cells ("| a | b |" -> ["a","b"]) */
function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return t.split('|').map(c => c.trim())
}
const isRule = (line: string) => /^\|?\s*:?-{2,}/.test(line.trim())

/** strip markdown decoration from a cell: backticks, bold, links */
function plain(s: string): string {
  return s.replace(/`/g, '').replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
}

/**
 * A series index (_series.md) holds a table `file | read when`. Returns file basename (lower
 * case) -> the read-when text. Rows whose first cell names no .md file are ignored.
 */
export function parseSeriesIndex(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim().startsWith('|') || isRule(line)) continue
    const c = cells(line)
    if (c.length < 2) continue
    const m = plain(c[0]).match(/([^\s/\\]+\.md)\b/i)
    if (!m) continue
    out.set(m[1].toLowerCase(), plain(c.slice(1).join(' | ')))
  }
  return out
}

/** first `# ` heading after any frontmatter; else frontmatter title; else the file name */
export function bookTitle(text: string, file: string): string {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const body = fm ? text.slice(fm[0].length) : text
  const h = body.match(/^#\s+(.+?)\s*#*\s*$/m)
  if (h) return plain(h[1])
  const t = fm?.[1].match(/^title:\s*(.+)$/m)
  if (t) return t[1].trim().replace(/^['"]|['"]$/g, '')
  return basename(file).replace(/\.md$/i, '').replace(/[-_]+/g, ' ')
}

function walk(dir: string, out: string[]) {
  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out) }
    else if (e.isFile() && isBookFile(e.name)) out.push(join(dir, e.name))
  }
}

const toRel = (root: string, abs: string) => relative(root, abs).split('\\').join('/')

/** every book on every shelf. A path under two shelves' roots belongs to the first. */
export function scanBooks(fundRoot: string, shelves: Shelf[]): Book[] {
  const seen = new Set<string>()
  const books: Book[] = []
  const indexes = new Map<string, Map<string, string>>()
  const indexFor = (dir: string) => {
    let m = indexes.get(dir)
    if (!m) {
      const f = join(dir, '_series.md')
      m = existsSync(f) ? parseSeriesIndex(readFileSync(f, 'utf8')) : new Map()
      indexes.set(dir, m)
    }
    return m
  }
  for (const shelf of shelves) {
    for (const root of shelf.roots) {
      const files: string[] = []
      walk(join(fundRoot, root), files)
      files.sort()
      for (const abs of files) {
        const path = toRel(fundRoot, abs)
        if (seen.has(path)) continue
        seen.add(path)
        let text = '', mtime = 0
        try { text = readFileSync(abs, 'utf8'); mtime = statSync(abs).mtimeMs } catch { continue }
        const dir = dirname(abs)
        const type = typeOf(text), parent = parentOf(text)
        books.push({
          path,
          shelf: shelf.id,
          series: basename(dir),
          title: bookTitle(text, abs),
          readWhen: indexFor(dir).get(basename(abs).toLowerCase()) ?? '',
          topics: topicsOf(text) ?? [],
          type, parent,
          chapters: chaptersOf(text).map(c => ({ slug: c.slug, title: c.title, readWhen: c.readWhen, tokens: Math.round(c.text.length / 4) })),
          tokens: Math.round(text.length / 4),
          updated: Math.round(mtime),
        })
      }
    }
  }
  return books
}

/**
 * A series index an agent may BOOT: a `_series.md` that exists under a shelf root. It is not a book
 * (no shelf lists it, nothing grades it), but a dashboard agent boots its own shelf's index so the
 * moment-lines arrive with it; the boot list, the matrix and the link audit take it as known.
 * Returns the shelf it stands on, or null.
 */
export function bootableIndex(fundRoot: string, shelves: Shelf[], rel: string): { shelf: string; tokens: number; title: string } | null {
  const p = rel.replace(/\\/g, '/')
  if (!/(^|\/)_series\.md$/i.test(p) || p.split('/').includes('..')) return null
  const shelf = shelves.find(s => s.roots.some(r => p.toLowerCase().startsWith(`${r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}/`)))
  if (!shelf) return null
  try {
    const text = readFileSync(join(fundRoot, p), 'utf8')
    return { shelf: shelf.id, tokens: Math.round(text.length / 4), title: `${bookTitle(text, join(fundRoot, p))} (index)` }
  } catch { return null }
}

/**
 * app/library/shelf.md, the owner's vet list: a table `Doc | The vet`. The doc cell carries a bold title and
 * one or more backticked paths; the vet cell opens with a bold tag (LAW, MACHINE...).
 */
export function parseVet(text: string, known: (path: string) => boolean): VetRow[] {
  const rows: VetRow[] = []
  let inTable = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) { inTable = false; continue }
    if (isRule(line)) { inTable = true; continue }
    if (!inTable) continue
    const c = cells(line)
    if (c.length < 2) continue
    const title = c[0].match(/\*\*(.+?)\*\*/)?.[1]?.trim() ?? plain(c[0].split(' - ')[0])
    const paths = [...c[0].matchAll(/`([^`]+)`/g)].map(m => m[1].trim())
    const vetRaw = c.slice(1).join(' | ')
    const tag = vetRaw.match(/^\*\*([A-Z]+)\*\*/)?.[1] ?? ''
    const vet = plain(vetRaw.replace(/^\*\*[A-Z]+\*\*\s*[·-]?\s*/, ''))
    // a path may be a chapter ref (`book.md#slug`): `known` judges the book (the path before the #), and the slug rides along
    const hit = paths.find(p => known(p)) ?? null
    const ref = hit ? splitRef(hit) : null
    rows.push({ title: plain(title), tag, vet, paths, book: ref ? ref.path : null, chapter: ref ? ref.slug : null })
  }
  return rows
}

/** walk up from a fund-relative file to the nearest folder holding .git (dir or file) */
export function repoFor(fundRoot: string, relPath: string): string {
  let dir = dirname(join(fundRoot, relPath))
  const top = fundRoot
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dir.length <= top.length) return top
    const up = dirname(dir)
    if (up === dir) return top
    dir = up
  }
}

export { toRel }
