import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './run.ts'
import { authorRole, causeLine, parseCounts, parsePorcelain } from './parse.ts'

export type RepoState = {
  branch: string | null
  upstream: string | null
  dirty: number
  conflicts: number
  /** a rebase or merge is stopped in this tree (someone else's to land, never ours to resolve) */
  midOp: 'rebase' | 'merge' | 'cherry-pick' | null
  ahead: number | null      // null = cannot tell (no upstream)
  behind: number | null
  head: { sha: string; subject: string; ts: number; author: string } | null
  error?: string
}

async function gitDir(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--absolute-git-dir'])
  return r.code === 0 ? r.stdout.trim() : null
}

export async function midOperation(dir: string): Promise<RepoState['midOp']> {
  const gd = await gitDir(dir)
  if (!gd) return null
  if (existsSync(join(gd, 'rebase-merge')) || existsSync(join(gd, 'rebase-apply'))) return 'rebase'
  if (existsSync(join(gd, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(join(gd, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  return null
}

/** read-only status of one working tree (no fetch here; see fetchIfStale) */
export async function readState(dir: string): Promise<RepoState> {
  if (!existsSync(dir)) return { branch: null, upstream: null, dirty: 0, conflicts: 0, midOp: null, ahead: null, behind: null, head: null, error: 'path missing' }
  const [br, up, st, head, mid] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    git(dir, ['status', '--porcelain']),
    git(dir, ['log', '-1', '--format=%H%x1f%s%x1f%at%x1f%(trailers:key=Agent,valueonly,separator=%x2C)']),
    midOperation(dir),
  ])
  if (br.code !== 0) return { branch: null, upstream: null, dirty: 0, conflicts: 0, midOp: null, ahead: null, behind: null, head: null, error: causeLine(br.stderr) }
  const p = parsePorcelain(st.stdout)
  const upstream = up.code === 0 ? up.stdout.trim() : null
  let ahead: number | null = null, behind: number | null = null
  if (upstream) {
    const c = parseCounts((await git(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])).stdout)
    if (c) { ahead = c.ahead; behind = c.behind }
  }
  const h = head.stdout.trim().split('\x1f')
  return {
    branch: br.stdout.trim(),
    upstream,
    dirty: p.dirty,
    conflicts: p.conflicts,
    midOp: mid,
    ahead, behind,
    head: h.length >= 4 ? { sha: h[0], subject: h[1], ts: Number(h[2]) * 1000, author: authorRole(h[3]) } : null,
  }
}

/** ok / warn / fail for a card dot: conflict = fail; dirty or behind = warn; clean = ok */
export function repoTone(s: RepoState): 'ok' | 'warn' | 'fail' | 'unknown' {
  if (s.error) return 'unknown'
  if (s.conflicts > 0 || s.midOp) return 'fail'
  if (s.dirty > 0 || (s.behind ?? 0) > 0) return 'warn'
  return 'ok'
}

/** "3 dirty - 1 ahead" ; "clean" ; "local" when the branch tracks no remote (ahead/behind cannot be told) */
export function repoReading(s: RepoState): string {
  if (s.error) return s.error
  const parts: string[] = []
  if (s.midOp) parts.push(`${s.midOp} stopped`)
  if (s.conflicts) parts.push(`${s.conflicts} conflict`)
  if (s.dirty) parts.push(`${s.dirty} dirty`)
  if (s.ahead) parts.push(`${s.ahead} ahead`)
  if (s.behind) parts.push(`${s.behind} behind`)
  if (!s.upstream) parts.push('local')
  return parts.length ? parts.join(' - ') : 'clean'
}

const FETCH_EVERY_MS = 5 * 60_000
const lastFetch = new Map<string, number>()
const fetching = new Map<string, Promise<boolean>>()

/** `git fetch --quiet` at most once per 5 minutes per tree; true when it actually fetched */
export function fetchIfStale(dir: string, force = false): Promise<boolean> {
  const at = lastFetch.get(dir) ?? 0
  if (!force && Date.now() - at < FETCH_EVERY_MS) return Promise.resolve(false)
  const inflight = fetching.get(dir)
  if (inflight) return inflight
  const p = git(dir, ['fetch', '--quiet'], 60_000).then(r => {
    lastFetch.set(dir, Date.now())
    fetching.delete(dir)
    return r.code === 0
  })
  fetching.set(dir, p)
  return p
}

export function lastFetchedAt(dir: string): number | null { return lastFetch.get(dir) ?? null }

export type SyncResult = {
  action: 'pulled' | 'pushed' | 'pulled+pushed' | 'up to date' | 'skipped' | 'failed'
  note: string
  before: RepoState
  after: RepoState | null
}

/**
 * THE SYNC LAW for one tree. fetch; a stopped rebase/merge is never touched; a dirty tree is
 * never pulled (and never pushed); clean + behind -> `pull --rebase`; clean + ahead -> `push`.
 * A rebase that stops is ABORTED and its cause line reported - a conflict is the owning
 * hand's to settle by the ladder, never this button's. No branch, reset, force or add.
 */
export async function syncTree(dir: string, opts: { guarded?: boolean } = {}): Promise<SyncResult> {
  const f = await git(dir, ['fetch', '--quiet'], 90_000)
  lastFetch.set(dir, Date.now())
  const before = await readState(dir)
  if (before.error) return { action: 'failed', note: before.error, before, after: null }
  if (f.code !== 0) return { action: 'failed', note: `fetch failed: ${causeLine(f.stderr)}`, before, after: null }
  if (before.midOp || before.conflicts) return { action: 'skipped', note: `${before.midOp ?? 'conflict'} in progress, left alone`, before, after: null }
  if (!before.upstream) return { action: 'skipped', note: 'local, nothing to sync', before, after: null }
  const ahead = before.ahead ?? 0, behind = before.behind ?? 0
  if (before.dirty) {
    const tail = ahead ? `, ${ahead} ahead unpushed` : ''
    return { action: 'skipped', note: behind ? `dirty, pull skipped${tail}` : `dirty${ahead ? `, push skipped${tail}` : ', nothing to pull'}`, before, after: null }
  }
  if (opts.guarded) return { action: 'skipped', note: 'guarded, fetch only', before, after: null }
  if (!ahead && !behind) return { action: 'up to date', note: 'up to date', before, after: before }
  let pulled = false
  if (behind) {
    const p = await git(dir, ['pull', '--rebase', '--quiet'], 120_000)
    if (p.code !== 0) {
      const cause = causeLine(p.stderr + '\n' + p.stdout)
      let aborted = ''
      if (await midOperation(dir) === 'rebase') {
        const a = await git(dir, ['rebase', '--abort'])
        aborted = a.code === 0 ? ' (rebase aborted)' : ` (rebase --abort failed: ${causeLine(a.stderr)})`
      }
      return { action: 'failed', note: `pull stopped: ${cause}${aborted}`, before, after: await readState(dir) }
    }
    pulled = true
  }
  const mid = await readState(dir)
  if ((mid.ahead ?? 0) > 0) {
    const p = await git(dir, ['push', '--quiet'], 120_000)
    if (p.code !== 0) return { action: 'failed', note: `${pulled ? 'pulled, ' : ''}push failed: ${causeLine(p.stderr)}`, before, after: await readState(dir) }
    return { action: pulled ? 'pulled+pushed' : 'pushed', note: pulled ? `pulled ${behind}, pushed ${mid.ahead}` : `pushed ${mid.ahead}`, before, after: await readState(dir) }
  }
  return { action: 'pulled', note: `pulled ${behind}`, before, after: mid }
}

/** the one short line the activity bar toasts */
export function syncSummary(rows: { id: string; result: SyncResult }[]): string {
  if (!rows.length) return 'no repos in repos.json'
  const count = (pred: (r: SyncResult) => boolean) => rows.filter(x => pred(x.result)).length
  const pulled = count(r => r.action === 'pulled' || r.action === 'pulled+pushed')
  const pushed = count(r => r.action === 'pushed' || r.action === 'pulled+pushed')
  const failed = rows.filter(x => x.result.action === 'failed').map(x => x.id)
  const dirty = rows.filter(x => x.result.action === 'skipped' && x.result.note.startsWith('dirty')).map(x => x.id)
  const parts: string[] = []
  if (pulled) parts.push(`${pulled} pulled`)
  if (pushed) parts.push(`${pushed} pushed`)
  if (dirty.length) parts.push(`dirty: ${dirty.join(', ')}`)
  if (failed.length) parts.push(`failed: ${failed.join(', ')}`)
  const other = rows.filter(x => x.result.action === 'skipped' && !x.result.note.startsWith('dirty')).map(x => `${x.id} ${x.result.note}`)
  if (other.length) parts.push(other.join('; '))
  return `${rows.length} repos: ${parts.length ? parts.join(' - ') : 'all up to date'}`
}
