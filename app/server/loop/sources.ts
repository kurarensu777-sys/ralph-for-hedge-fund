import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RENAME_WORDS, headingSimilarity } from '../../scripts/hooks/guard-lib.mjs'
import { authorRole } from '../git/parse.ts'
import { git } from '../git/run.ts'
import { canonicalDesk, deskDir, deskOfLibraryBook } from '../paths.ts'
import type { Raw } from '../lab/runs.ts'
import { parseJsonl } from '../lab/runs.ts'

// ---- lessons filed: commits that added or changed a book ----

/** `chapters`: the `## ` headings a commit ADDED to a book that already existed (status M), set by lessons() */
export type BookChange = { path: string; status: 'A' | 'M' | 'D' | 'R'; index: boolean; chapters?: string[] }
export type Lesson = { repo: string; sha: string; ts: number; author: string; subject: string; books: BookChange[]; desk: string; agent: string | null }

// the Agent: trailer rides as a sixth field; a five-field record (older callers, tests) has none
const REC = '%x1e%H%x1f%x1f%at%x1f%s%x1f%(trailers:key=Agent,valueonly,separator=%x2C)%x1f'

/** `git log --format=REC --name-status` -> commits with their changed .md books (fund-relative paths) */
export function parseBookLog(stdout: string, repo: string, prefix: string): Lesson[] {
  const out: Lesson[] = []
  for (const rec of stdout.split('\x1e')) {
    if (!rec.trim()) continue
    const f = rec.split('\x1f')
    if (f.length < 5) continue
    const [sha, , at, subject] = f
    const agent = f.length >= 6 ? (f[4].trim().split(',')[0].trim() || null) : null
    const rest = f[f.length - 1]
    const books: BookChange[] = []
    for (const line of rest.split('\n')) {
      const cols = line.trim().split('\t')
      if (cols.length < 2) continue
      const code = cols[0][0] as BookChange['status']
      const p = cols[cols.length - 1]
      if (!p.toLowerCase().endsWith('.md') || !'AMDR'.includes(code)) continue
      const path = prefix && prefix !== '.' ? `${prefix.replace(/\/$/, '')}/${p}` : p
      books.push({ path, status: code, index: /(^|\/)_series\.md$/.test(p) })
    }
    if (!books.length) continue
    out.push({ repo, sha: sha.trim(), ts: Number(at) * 1000, author: authorRole(agent), subject, books, desk: deskOfBook(books.find(b => !b.index)?.path ?? books[0].path), agent })
  }
  return out
}

/** the desk a book is filed at (the map in paths.ts); a pre-cut-over `desks/<desk>/memory/...` -> its
 *  current lab desk; anything else -> the fund root */
export function deskOfBook(path: string): string {
  const m = /^desks\/(.+?)\/memory\//.exec(path)
  if (m) return canonicalDesk(m[1])
  return deskOfLibraryBook(path)
}

/**
 * `git log -p -U0 --diff-filter=M --format=%x1e%H` -> per commit, per book (fund-relative), the `## `
 * headings the commit added. A heading that only rewords one the same commit removed is a rename, not a
 * chapter. A line inside a code fence cannot be told apart in a zero-context diff: capture checks every
 * heading against the book as it stands (chaptersOf skips fences).
 */
export function parseChapterLog(stdout: string, prefix: string): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>()
  for (const rec of stdout.split('\x1e')) {
    const lines = rec.split('\n')
    const sha = lines[0].trim()
    if (!/^[0-9a-f]{7,64}$/.test(sha)) continue
    const files = new Map<string, string[]>()
    let path: string | null = null, added: string[] = [], removed: string[] = []
    const close = () => {
      if (path && added.length) {
        const fresh = added.filter(h => !removed.some(r => headingSimilarity(r, h) >= RENAME_WORDS))
        if (fresh.length) files.set(path, fresh)
      }
      added = []; removed = []
    }
    for (const ln of lines.slice(1)) {
      if (ln.startsWith('diff --git ')) { close(); path = null; continue }
      if (ln.startsWith('+++ ')) {
        const p = ln.slice(4).replace(/^b\//, '')
        path = p === '/dev/null' || !p.toLowerCase().endsWith('.md') ? null : (prefix && prefix !== '.' ? `${prefix.replace(/\/$/, '')}/${p}` : p)
        continue
      }
      if (!path || ln.startsWith('---')) continue
      const m = /^([+-])##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(ln.replace(/\r$/, ''))
      if (m && !ln.startsWith('+###') && !ln.startsWith('-###')) (m[1] === '+' ? added : removed).push(m[2])
    }
    close()
    if (files.size) out.set(sha, files)
  }
  return out
}

export type Root = { repo: string; repoPath: string; pathspecs: string[] }

/**
 * Where books live: library/ (since the 2026-09-24 cut-over) and every shelf root (the derived
 * shelves: library/<x>, app/library/<x>), each assigned to the repo (repos.json)
 * whose path holds it. The fund repo also keeps the PRE-cut-over homes (memory/ and every desk
 * memory/ folder) as pathspecs, so lessons filed before the move still show in history.
 */
export function bookRoots(repos: { id: string; path: string }[], shelfRoots: string[]): Root[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/$/, '')
  // a shelf root counts only when it IS or lies INSIDE a library (memory/ or library/): a shelf
  // rooted at a whole desk folder would pull in the desk's machine files (results-log, beliefs),
  // which are not lessons. A root under another counted root adds nothing (app/library/law under library).
  const bookish = (r: string) => /(^|\/)(memory|library)(\/|$)/.test(r)
  const counted = [...shelfRoots.map(norm).filter(bookish), 'library']
  const roots = new Set(counted.filter(r => !counted.some(o => o !== r && r.startsWith(o + '/'))))
  const byRepo = new Map<string, Root>()
  const sorted = [...repos].sort((a, b) => norm(b.path).length - norm(a.path).length)
  for (const r of roots) {
    const repo = sorted.find(x => norm(x.path) === '' || r === norm(x.path) || r.startsWith(norm(x.path) + '/'))
    if (!repo) continue
    const rp = norm(repo.path)
    const rel = rp ? r.slice(rp.length).replace(/^\//, '') : r
    if (!byRepo.has(repo.id)) byRepo.set(repo.id, { repo: repo.id, repoPath: rp, pathspecs: [] })
    byRepo.get(repo.id)!.pathspecs.push(rel || '.')
  }
  const fund = [...byRepo.values()].find(x => x.repoPath === '')
  if (fund) fund.pathspecs.push('memory', ':(glob)desks/**/memory/**')
  for (const v of byRepo.values()) v.pathspecs = [...new Set(v.pathspecs)].sort()
  return [...byRepo.values()]
}

export async function lessons(fundRoot: string, roots: Root[], sinceMs: number | null): Promise<{ lessons: Lesson[]; errors: string[] }> {
  const errors: string[] = []
  const lists = await Promise.all(roots.map(async r => {
    const args = ['log', `--format=${REC}`, '--name-status', '--no-renames', '-n', '400']
    if (sinceMs) args.push(`--since=${Math.floor(sinceMs / 1000)}`)
    args.push('--', ...r.pathspecs)
    const out = await git(join(fundRoot, r.repoPath), args)
    if (out.code !== 0) { errors.push(`${r.repo}: ${out.stderr.trim().split('\n')[0]}`); return [] }
    const found = parseBookLog(out.stdout, r.repo, r.repoPath)
    // a commit that APPENDS chapters to a book is a lesson too (B-0347): read what each commit added
    const pargs = ['log', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--diff-filter=M', '--format=%x1e%H', '-n', '400']
    if (sinceMs) pargs.push(`--since=${Math.floor(sinceMs / 1000)}`)
    const patch = await git(join(fundRoot, r.repoPath), [...pargs, '--', ...r.pathspecs], 60_000)
    if (patch.code !== 0) { errors.push(`${r.repo}: chapters: ${patch.stderr.trim().split('\n')[0]}`); return found }
    const added = parseChapterLog(patch.stdout, r.repoPath)
    for (const l of found) {
      const files = added.get(l.sha)
      if (files) for (const b of l.books) if (b.status === 'M' && !b.index && files.has(b.path)) b.chapters = files.get(b.path)
    }
    return found
  }))
  return { lessons: dedupeMoved(lists.flat()).sort((a, b) => b.ts - a.ts), errors }
}

/**
 * The 2026-09-25 relayout carried the fund repo's library history into the sub-repos WITH its
 * commits (git format-patch | git am: same author time, same subject, a new sha), so one lesson can
 * sit in two repos' logs. It is ONE lesson: the copy in the repo the book lives in now (a sub-repo,
 * not the fund root) is kept, the fund root's dropped.
 */
export function dedupeMoved(list: Lesson[]): Lesson[] {
  const key = (l: Lesson) => `${l.ts}\x1f${l.subject}`
  const moved = new Set(list.filter(l => l.repo !== 'fund').map(key))
  return list.filter(l => l.repo !== 'fund' || !moved.has(key(l)))
}

// ---- stand-downs with no lesson: the ops store's no_lesson table (was <floor>/no-lesson.jsonl,
// imported 2026-09-26 and retired to ~/fund-data/db/_retired/) ----

export type NoLesson = { ts: number | null; desk: string; hand: string | null; operator: string | null; subject: string; reason: string; touched: string[] }

export function parseNoLesson(text: string): { rows: NoLesson[]; bad: number } {
  const { rows, bad } = parseJsonl(text)
  return {
    rows: rows.map((r: Raw) => ({
      ts: typeof r.ts === 'string' && Number.isFinite(Date.parse(r.ts)) ? Date.parse(r.ts) : null,
      desk: String(r.desk ?? '.'),
      hand: r.hand ?? null,
      operator: r.operator ?? null,
      subject: String(r.subject ?? ''),
      reason: String(r.reason ?? ''),
      touched: Array.isArray(r.touched) ? r.touched.map(String) : [],
    })).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)),
    bad,
  }
}

/** the store's rows (ops.no_lesson, epoch-ms ts) -> the same shape, newest first. Pure */
export function noLessonRows(rows: { ts: number | string | null; desk: string | null; hand: string | null; operator: string | null; subject: string | null; reason: string | null; touched: unknown }[]): NoLesson[] {
  return rows.map(r => ({
    ts: Number.isFinite(Number(r.ts)) && r.ts !== null ? Number(r.ts) : null,
    desk: String(r.desk ?? '.'),
    hand: r.hand ?? null,
    operator: r.operator ?? null,
    subject: String(r.subject ?? ''),
    reason: String(r.reason ?? ''),
    touched: Array.isArray(r.touched) ? r.touched.map(String) : [],
  })).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
}

// ---- retro state: a port of app/loop/tools/retro_due.py `status` (7 days or 5 runs) ----

const STAMP_RE = /Last retro:\s*(?<date>[0-9]{4}-[0-9]{2}-[0-9]{2}|none[^·\n]*)(?:\s*·\s*through run\s*(?<run>[^\s·]+))?(?:\s*·\s*next bet:\s*(?<bet>[^\n`]*))?/i

export type Stamp = { found: boolean; date: string | null; raw: string | null; run: string | null; bet: string | null }

export function parseStamp(beliefs: string): Stamp {
  const m = STAMP_RE.exec(beliefs)
  if (!m?.groups) return { found: false, date: null, raw: null, run: null, bet: null }
  const raw = (m.groups.date ?? '').trim()
  return {
    found: true,
    date: /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null,
    raw,
    run: (m.groups.run ?? '').trim() || null,
    bet: (m.groups.bet ?? '').trim() || null,
  }
}

export type Retro = {
  desk: string
  stamp: Stamp
  graded: number          // pre-registered results (imports carry no prediction to grade)
  imported: number
  since: number
  ageDays: number | null
  due: boolean
  dueAt: number | null    // when the 7-day clock runs out (null: no stamp to age)
  reasons: string[]
  digest?: Digest | null  // the newest lab/<desk>/retros/*.md (attached by the room; null = none on record)
}

export function retroStatus(desk: string, beliefs: string | null, rows: Raw[], now: number, maxDays = 7, maxRuns = 5): Retro {
  const stamp = beliefs === null ? { found: false, date: null, raw: null, run: null, bet: null } : parseStamp(beliefs)
  const results = rows.filter(r => r.stage === 'result' && r.preregistered !== false)
  const imported = rows.filter(r => r.stage === 'result' && r.preregistered === false).length
  const n = results.length
  let since = n
  if (stamp.run) {
    let seen = false, count = 0
    for (const r of results) {
      if (seen) count++
      const id = String(r.run ?? '')
      if (id === stamp.run || id.endsWith(stamp.run)) seen = true
    }
    since = seen ? count : n
  }
  const dateMs = stamp.date ? Date.parse(stamp.date + 'T00:00:00Z') : null
  const ageDays = dateMs === null ? null : (now - dateMs) / 86_400_000
  const reasons: string[] = []
  let due = false
  if (n === 0 && !stamp.date) {
    reasons.push('no runs and no retro' + (imported ? ` (${imported} imported, nothing to grade)` : ''))
  } else if (!stamp.date) {
    due = true
    reasons.push(`never retro'd, ${n} run(s) recorded`)
  } else {
    if (ageDays !== null && ageDays > maxDays) { due = true; reasons.push(`stamp ${ageDays.toFixed(1)}d old (> ${maxDays})`) }
    if (since > maxRuns) { due = true; reasons.push(`${since} run(s) since the stamp (> ${maxRuns})`) }
    if (!due) reasons.push(`stamp ${ageDays?.toFixed(1)}d old, ${since} run(s) since`)
  }
  return { desk, stamp, graded: n, imported, since, ageDays, due, dueAt: dateMs === null ? null : dateMs + maxDays * 86_400_000, reasons }
}

// ---- retro digests: lab/<desk>/retros/<YYYY-MM-DD>.md, written by app/loop/tools/digest.py --write ----

export type Digest = {
  path: string            // fund-relative
  date: string
  through: string | null
  source: string | null
  lines: string[]         // the digest, one entry per `- ` line
  fills: number           // <FILL: ...> slots the retro has not yet replaced
  count: number           // retro files on record for this desk
}

/** parse one retro file: frontmatter keys, then the `- ` lines under the title */
export function parseDigest(text: string, path: string, count = 1): Digest {
  const t = text.replace(/\r\n/g, '\n')
  const fm: Record<string, string> = {}
  let body = t
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t)
  if (m) {
    for (const ln of m[1].split('\n')) { const k = /^([a-z_]+):\s*(.*)$/i.exec(ln); if (k) fm[k[1].toLowerCase()] = k[2].trim() }
    body = t.slice(m[0].length)
  }
  const lines = body.split('\n').filter(l => /^\s*-\s+/.test(l)).map(l => l.replace(/^\s*-\s+/, '').trim())
  const file = path.split('/').pop() ?? ''
  const through = fm.through && fm.through !== 'none' ? fm.through : null
  return { path, date: fm.date || file.replace(/\.md$/, ''), through, source: fm.source || null, lines, fills: (body.match(/<FILL:/g) ?? []).length, count }
}

/** the newest retro digest of a desk; null = none on record (an honest empty, not a failure) */
export function latestDigest(fundRoot: string, desk: string): Digest | null {
  let files: string[]
  try { files = readdirSync(join(deskDir(desk, fundRoot), 'retros')).filter(f => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f)).sort() } catch { return null }
  if (!files.length) return null
  const rel = `${desk}/retros/${files[files.length - 1]}`.replace(/\\/g, '/')
  const text = readOr(join(fundRoot, rel))
  return text === null ? null : parseDigest(text, rel, files.length)
}

export function readOr(p: string): string | null {
  try { return readFileSync(p, 'utf8') } catch { return null }
}
