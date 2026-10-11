import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { git } from '../git/run.ts'
import { HttpError } from '../http.ts'
import type { SaveResult } from './types.ts'

// EDIT IN PLACE. The drawer's editor writes the book and commits exactly that one path to the
// fund repo: `git add -- <path>` then `git commit --only -- <path>`, so whatever another hand has
// staged is never swept into the owner's edit. Trailer `Agent: you` (the owner).

export const hashOf = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16)

/** pure: the commit message for an edit (subject + trailer block) */
export function commitMessage(path: string, subject?: string): string[] {
  const s = (subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120) || `library: edit ${path}`
  return ['-m', s, '-m', 'Agent: you']
}

/** pure: keep a file's line ending (a textarea hands back LF) */
export function withEol(original: string, next: string): string {
  const lf = next.replace(/\r\n/g, '\n')
  return original.includes('\r\n') ? lf.replace(/\n/g, '\r\n') : lf
}

/**
 * write `content` over the book at `abs` (inside `repoAbs`) and commit it. `base` = the hash of
 * the text the editor opened; a file that moved since is refused (409), never overwritten.
 */
export async function saveBook(opts: { repoAbs: string; abs: string; path: string; content: unknown; base: unknown; subject?: unknown }): Promise<SaveResult> {
  const { repoAbs, abs, path } = opts
  if (typeof opts.content !== 'string') throw new HttpError(400, 'need content')
  if (typeof opts.base !== 'string') throw new HttpError(400, 'need base (the hash the editor opened)')
  if (opts.content.length > 2_000_000) throw new HttpError(413, 'book too large')
  let current: string
  try { current = readFileSync(abs, 'utf8') } catch (e: any) { throw new HttpError(404, `cannot read ${path}: ${e?.message ?? e}`) }
  if (hashOf(current) !== opts.base) throw new HttpError(409, 'the book changed on disk since you opened it; reload')
  const next = withEol(current, opts.content)
  if (next === current) return { written: false, committed: false, hash: opts.base, note: 'no change' }
  writeFileSync(abs, next, 'utf8')
  const hash = hashOf(next)
  const inRepo = relative(resolve(repoAbs), resolve(abs)).split('\\').join('/')
  const add = await git(repoAbs, ['add', '--', inRepo], 15_000)
  if (add.code !== 0) return { written: true, committed: false, hash, error: `git add: ${add.stderr.trim() || add.code}` }
  const msg = commitMessage(path, typeof opts.subject === 'string' ? opts.subject : undefined)
  const c = await git(repoAbs, ['commit', '--only', ...msg, '--', inRepo], 30_000)
  if (c.code !== 0) return { written: true, committed: false, hash, error: `git commit: ${(c.stderr || c.stdout).trim() || c.code}` }
  const sha = (await git(repoAbs, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
  return { written: true, committed: true, hash, sha }
}

export type NewFile = { abs: string; path: string; content: string; base: string | null }

/**
 * TWO EDITS, ONE COMMIT (the write-back law): write several files inside one repo and commit
 * exactly those paths. `base` = the hash of the text the caller built on, or null for a file that
 * must not exist yet. Every file is checked before any is written; a failed add/commit puts every
 * file back as it was and unstages them, so nothing half-landed is left for the next hand.
 */
export async function saveFiles(o: { repoAbs: string; files: NewFile[]; subject: string; trailers?: string[] }): Promise<SaveResult & { paths: string[] }> {
  const before: (string | null)[] = []
  for (const f of o.files) {
    let cur: string | null = null
    try { cur = readFileSync(f.abs, 'utf8') } catch { cur = null }
    if (f.base === null && cur !== null) throw new HttpError(409, `${f.path} already exists`)
    if (f.base !== null && (cur === null || hashOf(cur) !== f.base)) throw new HttpError(409, `${f.path} changed on disk; reload`)
    before.push(cur)
  }
  const inRepo = o.files.map(f => relative(resolve(o.repoAbs), resolve(f.abs)).split('\\').join('/'))
  if (inRepo.some(p => p.startsWith('..'))) throw new HttpError(400, 'a path escapes the repo')
  const restore = async () => {
    o.files.forEach((f, i) => { try { if (before[i] === null) rmSync(f.abs, { force: true }); else writeFileSync(f.abs, before[i]!, 'utf8') } catch { /* best effort */ } })
    await git(o.repoAbs, ['restore', '--staged', '--', ...inRepo])
  }
  o.files.forEach((f, i) => {
    mkdirSync(dirname(f.abs), { recursive: true })
    writeFileSync(f.abs, before[i] === null ? f.content.replace(/\r\n/g, '\n') : withEol(before[i]!, f.content), 'utf8')
  })
  const add = await git(o.repoAbs, ['add', '--', ...inRepo], 15_000)
  if (add.code !== 0) { await restore(); throw new HttpError(409, `git add: ${add.stderr.trim() || add.code}; nothing written`) }
  const s = o.subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 120)
  const c = await git(o.repoAbs, ['commit', '--only', '-m', s, '-m', ['Agent: you', ...(o.trailers ?? [])].join('\n'), '--', ...inRepo], 30_000)
  if (c.code !== 0) { await restore(); throw new HttpError(409, `git commit: ${(c.stderr || c.stdout).trim() || c.code}; nothing written`) }
  const sha = (await git(o.repoAbs, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
  return { written: true, committed: true, hash: hashOf(o.files[0].content), sha, paths: o.files.map(f => f.path) }
}
