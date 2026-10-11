import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DATA_DIR, FUND_ROOT } from '../paths.ts'

// WHERE A BUILD CONVERSATION STANDS. Pure path rules, no git and no database, so the launch
// contract (chat/launch.ts) can ask "is this conversation on a branch?" without importing the
// Git room. The worktree of a build conversation is ~/fund-data/worktrees/<repo>/<conversation>:
// it exists on disk exactly while the branch is unlanded, so the disk IS the registry.

/** FUND_WORKTREES overrides (tests); else <DATA_DIR>/worktrees */
export const WORKTREES_DIR = process.env.FUND_WORKTREES ? resolve(process.env.FUND_WORKTREES) : join(DATA_DIR, 'worktrees')

export type BuildRepo = { id: string; path: string }
type Row = { id?: unknown; path?: unknown; build?: unknown; guarded?: unknown }

function rows(fundRoot: string): Row[] {
  try {
    const doc = JSON.parse(readFileSync(join(fundRoot, 'repos.json'), 'utf8'))
    const list = Array.isArray(doc) ? doc : doc?.repos
    return Array.isArray(list) ? list.filter((r: unknown) => !!r && typeof r === 'object') : []
  } catch { return [] }
}

/**
 * The repos a build conversation may branch in: every repos.json row marked `"build": true`. A
 * guarded row is NEVER one, whatever it says: money lands only by the owner's hand. In the one-repo
 * layout the fund root itself (path ".") is the build repo, and a worktree is a whole checkout.
 */
export function buildRepos(fundRoot = FUND_ROOT): BuildRepo[] {
  return rows(fundRoot)
    .filter(r => r.build === true && r.guarded !== true && typeof r.id === 'string' && typeof r.path === 'string')
    .map(r => ({ id: r.id as string, path: r.path as string }))
}

/** the repos that never land from the cockpit: every guarded repos.json row */
export function neverLands(fundRoot = FUND_ROOT): string[] {
  return rows(fundRoot).filter(r => r.guarded === true && typeof r.id === 'string').map(r => r.id as string)
}

export const SAFE_CONV = /^[A-Za-z0-9_-]{1,64}$/

export function worktreePath(repo: string, conversation: string, root = WORKTREES_DIR, repos: BuildRepo[] = buildRepos()): string {
  if (!SAFE_CONV.test(conversation)) throw new Error(`not a conversation id: ${conversation}`)
  if (!repos.some(r => r.id === repo)) throw new Error(`${repo} is not a build repo (${repos.map(r => r.id).join(', ') || 'none in repos.json'})`)
  return join(root, repo, conversation)
}

const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s)
const depth = (p: string) => (p === '.' || p === '' ? 0 : p.split('/').length)

/** the build repo an absolute cwd sits in (the deepest that holds it), and its path inside that repo; null = in none */
export function buildRepoOf(cwdAbs: string, fundRoot = FUND_ROOT, repos: BuildRepo[] = buildRepos(fundRoot)): { repo: string; rel: string } | null {
  for (const r of [...repos].sort((a, b) => depth(b.path) - depth(a.path))) {
    const home = r.path === '.' || r.path === '' ? fundRoot : join(fundRoot, r.path)
    const rel = relative(home, cwdAbs)
    if (rel === '' || (!rel.startsWith('..') && !/^[a-z]:/i.test(rel) && fold(resolve(home, rel)) === fold(resolve(cwdAbs)))) return { repo: r.id, rel }
  }
  return null
}

/**
 * The cwd a conversation launches in when it is on a branch: its worktree, at the same place
 * inside the repo as the agent's own cwd. null = not on a branch (no worktree on disk), and the
 * agent's own cwd stands.
 */
export function worktreeCwd(cwdAbs: string, conversation: string, fundRoot = FUND_ROOT, root = WORKTREES_DIR, repos: BuildRepo[] = buildRepos(fundRoot)): string | null {
  if (!SAFE_CONV.test(conversation)) return null
  const at = buildRepoOf(cwdAbs, fundRoot, repos)
  if (!at) return null
  const wt = join(root, at.repo, conversation)
  if (!existsSync(join(wt, '.git'))) return null
  const cwd = at.rel ? join(wt, at.rel) : wt
  return existsSync(cwd) ? cwd : wt
}
