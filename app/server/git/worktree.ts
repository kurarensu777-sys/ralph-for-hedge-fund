import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { git } from './run.ts'
import { causeLine, parsePorcelain } from './parse.ts'

// BUILD WORKTREES: one checkout per build conversation, on its own branch, created and removed
// by the cockpit only. The main checkout stays on main; nothing here resets, forces or cleans.

export const MAIN = 'main'
/** folders shared into a worktree as a junction instead of reinstalled (never tracked, never copied):
 *  a repo's own node_modules, and in the one-repo layout each area's (app/, database/node/) */
export const SHARED_DIRS = ['node_modules', 'app/node_modules', 'database/node/node_modules'] as const

export const slugOf = (s: string, max = 32) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '')

/** b/<agent>/<slug>: the agent id and the title folded to [a-z0-9-]; the conversation tail keeps it unique */
export function branchName(agentId: string, title: string, conversation: string): string {
  const who = slugOf(agentId, 24) || 'agent'
  const what = slugOf(title) || 'build'
  const tail = slugOf(conversation.split('-').pop() ?? '', 6)
  return `b/${who}/${what}${tail ? `-${tail}` : ''}`
}

export type Worktree = {
  path: string
  conversation: string
  branch: string | null
  head: string | null
  /** commits on the branch that main does not have; null = cannot tell */
  ahead: number | null
  /** commits on main the branch does not have yet (a land rebases over them) */
  behind: number | null
  dirty: number | null
  /** the branch head's commit time (ms): the last work on it; null = cannot tell */
  headTs?: number | null
  error?: string
}

/** `git worktree list --porcelain` -> the build worktrees under `under` (the main checkout is never one) */
export function parseWorktreeList(raw: string, under: string): { path: string; branch: string | null; head: string | null }[] {
  const fold = (s: string) => resolve(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const root = fold(under) + '/'
  const out: { path: string; branch: string | null; head: string | null }[] = []
  for (const block of raw.split(/\r?\n\r?\n/)) {
    let path: string | null = null, branch: string | null = null, head: string | null = null
    for (const l of block.split(/\r?\n/)) {
      if (l.startsWith('worktree ')) path = l.slice(9).trim()
      else if (l.startsWith('HEAD ')) head = l.slice(5).trim()
      else if (l.startsWith('branch ')) branch = l.slice(7).trim().replace(/^refs\/heads\//, '')
    }
    if (path && fold(path).startsWith(root)) out.push({ path: resolve(path), branch, head })
  }
  return out
}

/** every build worktree of one repo, with its counts against main */
export async function listWorktrees(repoDir: string, under: string): Promise<Worktree[]> {
  const r = await git(repoDir, ['worktree', 'list', '--porcelain'])
  if (r.code !== 0) throw new Error(causeLine(r.stderr) || 'git worktree list failed')
  return Promise.all(parseWorktreeList(r.stdout, under).map(async w => {
    const base: Worktree = { ...w, conversation: basename(w.path), ahead: null, behind: null, dirty: null, headTs: null }
    if (!existsSync(w.path)) return { ...base, error: 'path missing (prunable)' }
    const [c, st, at] = await Promise.all([
      w.branch ? git(repoDir, ['rev-list', '--left-right', '--count', `${MAIN}...${w.branch}`]) : Promise.resolve(null),
      git(w.path, ['status', '--porcelain']),
      git(w.path, ['log', '-1', '--format=%ct']),
    ])
    const m = c && c.code === 0 ? /^(\d+)\s+(\d+)/.exec(c.stdout.trim()) : null
    const sec = at.code === 0 ? Number(at.stdout.trim()) : NaN
    return { ...base, behind: m ? Number(m[1]) : null, ahead: m ? Number(m[2]) : null, dirty: st.code === 0 ? parsePorcelain(st.stdout).dirty : null, headTs: Number.isFinite(sec) && sec > 0 ? sec * 1000 : null }
  }))
}

/** is `p` a junction/symlink we made (never a real folder: those are never unlinked) */
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }

/**
 * A new worktree at `path` on a new `branch` cut from main. SHARED_DIRS present in the main
 * checkout are linked in (a junction on Windows) so the repo's verify runs without a reinstall.
 */
export async function createWorktree(repoDir: string, path: string, branch: string): Promise<{ path: string; branch: string; linked: string[] }> {
  if (existsSync(path)) throw new Error(`${path} already exists`)
  const ok = await git(repoDir, ['check-ref-format', '--branch', branch])
  if (ok.code !== 0) throw new Error(`not a valid branch name: ${branch}`)
  const exists = await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (exists.code === 0) throw new Error(`branch ${branch} already exists`)
  mkdirSync(dirname(path), { recursive: true })
  const r = await git(repoDir, ['worktree', 'add', '-b', branch, path, MAIN], 120_000)
  if (r.code !== 0) throw new Error(`git worktree add failed: ${causeLine(r.stderr)}`)
  const linked: string[] = []
  for (const d of SHARED_DIRS) {
    const from = join(repoDir, d), to = join(path, d)
    if (!existsSync(from) || existsSync(to) || !existsSync(dirname(to))) continue
    try { symlinkSync(from, to, 'junction'); linked.push(d) } catch { /* the verify will say what is missing */ }
  }
  return { path, branch, linked }
}

/**
 * Remove a landed (or abandoned) worktree and its branch. The junctions go first (unlink only:
 * the main checkout's node_modules is never touched), then `git worktree remove` WITHOUT force,
 * so a worktree holding uncommitted work is refused, then `git branch -d` (merged only) unless
 * `dropBranch` is 'force-unmerged', which the caller passes only for an owner's explicit discard.
 */
export async function removeWorktree(repoDir: string, path: string, branch: string | null, dropBranch: 'merged' | 'force-unmerged' | 'keep' = 'merged'): Promise<{ removed: boolean; branch: 'deleted' | 'kept' | 'failed'; note: string }> {
  for (const d of SHARED_DIRS) { const p = join(path, d); if (isLink(p)) try { unlinkSync(p) } catch { /* reported by remove */ } }
  let removed = !existsSync(path)
  let note = ''
  if (!removed) {
    const r = await git(repoDir, ['worktree', 'remove', path], 60_000)
    removed = r.code === 0
    if (!removed) {
      note = `worktree kept: ${causeLine(r.stderr)}`
      // put the links back so the kept worktree still runs its verify
      for (const d of SHARED_DIRS) { const from = join(repoDir, d), to = join(path, d); if (existsSync(from) && !existsSync(to)) try { symlinkSync(from, to, 'junction') } catch { /* */ } }
    }
  } else await git(repoDir, ['worktree', 'prune'])
  if (!branch || dropBranch === 'keep' || !removed) return { removed, branch: 'kept', note }
  const b = await git(repoDir, ['branch', dropBranch === 'force-unmerged' ? '-D' : '-d', branch])
  return { removed, branch: b.code === 0 ? 'deleted' : 'failed', note: b.code === 0 ? note : [note, `branch kept: ${causeLine(b.stderr)}`].filter(Boolean).join('; ') }
}
