import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git } from '../git/run.ts'

/**
 * The loop's only git verbs, on the fund repo (or a temp repo in tests):
 *   commitPaths   stage EXACTLY these paths and `commit --only` them, so whatever another hand
 *                 staged is never swept in. Trailers: Agent: loop, Loop-Change: L-NNN.
 *   revertChange  a NEW commit that puts the change's paths back as they were before it (git's
 *                 own revert, limited to the loop's paths). Never reset, never amend, never force.
 *                 A path somebody edited after the apply is refused: their edit is not the loop's
 *                 to throw away.
 */

/**
 * The repo that owns a fund-relative path: the DEEPEST folder on its way (under the fund root)
 * carrying its own `.git`, else the fund repo itself. A promote into a sub-repo's shelf root
 * (app/library; B-0069) commits in THAT repo, from inside it, as the sync law
 * says: never staged from the fund root. `prefix` is what turns a repo-relative path back into a
 * fund-relative one ('' for the fund repo, 'app/' for the app repo).
 */
export function repoOf(fundRoot: string, rel: string): { repo: string; prefix: string } {
  const segs = rel.replace(/\\/g, '/').split('/').filter(Boolean).slice(0, -1)
  let out = { repo: fundRoot, prefix: '' }
  for (let i = 1; i <= segs.length; i++) {
    const sub = segs.slice(0, i).join('/')
    if (existsSync(join(fundRoot, sub, '.git'))) out = { repo: join(fundRoot, sub), prefix: `${sub}/` }
  }
  return out
}

export class GitOpError extends Error { constructor(msg: string) { super(msg) } }

export const trailers = (id: string, extra: Record<string, string> = {}) =>
  ['Agent: loop', `Loop-Change: ${id}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)].join('\n')

export async function head(repo: string): Promise<string | null> {
  const r = await git(repo, ['rev-parse', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() : null
}

/** in-progress merge/rebase/cherry-pick/revert: the loop does not commit into the middle of one */
async function midOp(repo: string): Promise<string | null> {
  const r = await git(repo, ['rev-parse', '--git-dir'])
  if (r.code !== 0) return 'not a git repo'
  const gd = join(repo, r.stdout.trim())
  for (const [f, what] of [['MERGE_HEAD', 'a merge'], ['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']] as const) {
    if (existsSync(join(gd, f))) return `the repo is in the middle of ${what}`
  }
  return null
}

export async function commitPaths(repo: string, paths: string[], subject: string, body: string): Promise<string> {
  const bad = await midOp(repo)
  if (bad) throw new GitOpError(bad)
  const uniq = [...new Set(paths)]
  const add = await git(repo, ['add', '--', ...uniq])
  if (add.code !== 0) throw new GitOpError(`git add: ${add.stderr.trim()}`)
  const c = await git(repo, ['commit', '--only', '-m', subject.replace(/[\r\n]+/g, ' ').slice(0, 120), '-m', body, '--', ...uniq])
  if (c.code !== 0) throw new GitOpError(`git commit: ${(c.stderr || c.stdout).trim()}`)
  const sha = await head(repo)
  if (!sha) throw new GitOpError('committed, but HEAD does not resolve')
  return sha
}

const SHA = /^[0-9a-f]{40}$/

/** the paths a commit touched (repo-relative). `sha` must be a full hex sha: never a flag */
export async function pathsOf(repo: string, sha: string): Promise<string[]> {
  if (!SHA.test(sha)) throw new GitOpError(`not a commit sha: ${JSON.stringify(String(sha).slice(0, 60))}`)
  const r = await git(repo, ['show', '--no-renames', '--name-only', '--format=', '--end-of-options', sha])
  if (r.code !== 0) throw new GitOpError(`git show ${sha}: ${r.stderr.trim()}`)
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
}

async function blob(repo: string, rev: string, path: string): Promise<string | null> {
  const r = await git(repo, ['show', '--end-of-options', `${rev}:${path}`])
  return r.code === 0 ? r.stdout : null
}

/**
 * Is `sha` the loop's own apply commit for change `id`? The proposal FILE names the sha, and the
 * file is writable by more than the loop, so the commit itself must prove it: a full hex sha, and
 * trailers `Agent: loop` + `Loop-Change: <id>` in its own message. Returns its subject.
 */
export async function loopCommit(repo: string, sha: string, id: string): Promise<string> {
  if (!SHA.test(sha)) throw new GitOpError(`not a commit sha: ${JSON.stringify(String(sha).slice(0, 60))}`)
  const r = await git(repo, ['log', '-1', '--format=%s%x00%(trailers:only,unfold)', '--end-of-options', sha])
  if (r.code !== 0 || !r.stdout.trim()) throw new GitOpError(`no commit ${sha}`)
  const [subj, tr = ''] = r.stdout.split('\0')
  const lines = tr.split('\n').map(l => l.trim())
  if (!lines.includes('Agent: loop') || !lines.includes(`Loop-Change: ${id}`)) {
    throw new GitOpError(`${sha.slice(0, 10)} is not the loop's commit for ${id} (needs trailers Agent: loop and Loop-Change: ${id})`)
  }
  return subj.trim()
}

/**
 * Put every path the change touched back as it stood in `sha^`, and commit that as
 * `Revert "<subject>"`. Refuses: a sha that is not the loop's own commit for `id` (loopCommit), a
 * path the rails forbid (`rail(path)` returns why), and a path that differs on disk from what
 * `sha` wrote.
 */
export async function revertChange(repo: string, sha: string, id: string, reason: string, rail: (path: string) => string | null, extraPaths: string[] = []): Promise<string> {
  const subj = await loopCommit(repo, sha, id)
  const paths = await pathsOf(repo, sha)
  const railed = paths.map(p => [p, rail(p)] as const).filter(([, why]) => why)
  if (railed.length) throw new GitOpError(`the loop may not revert: ${railed.map(([p, why]) => `${p} (${why})`).join('; ')}`)
  const diverged: string[] = []
  for (const p of paths) {
    const applied = await blob(repo, sha, p)
    const abs = join(repo, p)
    const now = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    if ((applied ?? null) !== now && (applied === null || now === null || applied.replace(/\r\n/g, '\n') !== now.replace(/\r\n/g, '\n'))) diverged.push(p)
  }
  if (diverged.length) throw new GitOpError(`changed since the loop applied it, not reverting: ${diverged.join(', ')}`)
  for (const p of paths) {
    const before = await blob(repo, `${sha}^`, p)
    const abs = join(repo, p)
    if (before === null) rmSync(abs, { force: true })
    else { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, before) }
  }
  return commitPaths(repo, [...paths, ...extraPaths], `Revert "${subj}"`, `This reverts commit ${sha}.\n\n${reason}\n\n${trailers(id, { Reverts: sha })}`)
}
