import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { APP_ROOT, FUND_ROOT } from '../paths.ts'
import { git } from './run.ts'

// The git guardrails' installer. The rules themselves live in scripts/hooks/guard.mjs (run by
// git through two sh shims); this file only points a repo's core.hooksPath at that folder and
// reads back whether it still does.

/** the hooks folder every managed repo points at, forward slashes (git config on Windows) */
export const HOOKS_DIR = resolve(APP_ROOT, 'scripts', 'hooks').replace(/\\/g, '/')
export const HOOKS = ['pre-commit', 'commit-msg'] as const
/** where the hooks lived before the sub-repos moved to the fund root (2026-09-25): a repo still
 *  pointing there is OURS, just stale, and is repointed rather than reported foreign */
export const RETIRED_HOOKS_DIRS = [resolve(FUND_ROOT, 'repos', 'app', 'scripts', 'hooks')]

export type GuardState = {
  /** guarded: hooksPath is ours and the shims exist · open: nothing set · foreign: another hook
   *  setup is in place and was left alone · missing: ours, but the shim files are gone ·
   *  unknown: git could not be read */
  state: 'guarded' | 'open' | 'foreign' | 'missing' | 'unknown'
  detail: string
}

const same = (a: string, b: string) => {
  const n = (s: string) => resolve(s).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

/** hooks under .git/hooks that are not git's own *.sample files (setting hooksPath would silence them) */
async function localHooks(dir: string): Promise<string[]> {
  const r = await git(dir, ['rev-parse', '--git-path', 'hooks'])
  if (r.code !== 0) return []
  const p = resolve(dir, r.stdout.trim())
  if (!existsSync(p)) return []
  try { return readdirSync(p).filter(f => !f.endsWith('.sample')) } catch { return [] }
}

export async function guardState(dir: string, hooksDir = HOOKS_DIR): Promise<GuardState> {
  if (!existsSync(dir)) return { state: 'unknown', detail: 'path missing' }
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return { state: 'unknown', detail: 'not a git repo' }
  const cur = await git(dir, ['config', '--local', '--get', 'core.hooksPath'])
  const val = cur.stdout.trim()
  if (!val) {
    const local = await localHooks(dir)
    return { state: 'open', detail: local.length ? `no guard; .git/hooks holds ${local.join(', ')}` : 'no guard hooks installed' }
  }
  if (!same(resolve(dir, val), hooksDir)) {
    if (RETIRED_HOOKS_DIRS.some(d => !same(d, hooksDir) && same(resolve(dir, val), d))) return { state: 'open', detail: `hooksPath points at the retired ${val}` }
    return { state: 'foreign', detail: `core.hooksPath is ${val}` }
  }
  const gone = [...HOOKS, 'guard.mjs', 'guard-lib.mjs'].filter(h => !existsSync(join(hooksDir, h)))
  if (gone.length) return { state: 'missing', detail: `hooksPath set, missing ${gone.join(', ')}` }
  return { state: 'guarded', detail: `pre-commit + commit-msg from ${hooksDir}` }
}

/**
 * Point one repo at the guard hooks. Idempotent: an already-guarded repo is not touched. A repo
 * with another hooksPath, or with real hooks in .git/hooks, is LEFT ALONE and reported foreign:
 * the installer never silences a hook it did not write.
 */
export async function installGuard(dir: string, hooksDir = HOOKS_DIR): Promise<GuardState & { changed: boolean }> {
  const s = await guardState(dir, hooksDir)
  if (s.state === 'guarded' || s.state === 'foreign' || s.state === 'unknown') return { ...s, changed: false }
  if (s.state === 'open') {
    const local = await localHooks(dir)
    if (local.length) return { state: 'foreign', detail: `.git/hooks holds ${local.join(', ')}; left alone`, changed: false }
  }
  if (!HOOKS.every(h => existsSync(join(hooksDir, h)))) return { ...s, changed: false }
  const r = await git(dir, ['config', '--local', 'core.hooksPath', hooksDir])
  if (r.code !== 0) return { state: 'unknown', detail: `git config failed: ${r.stderr.trim()}`, changed: false }
  return { ...(await guardState(dir, hooksDir)), changed: true }
}
