import { exec } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { git, gitEnv } from './run.ts'
import { causeLine, parsePorcelain } from './parse.ts'
import { midOperation } from './repo.ts'
import { MAIN } from './worktree.ts'

// THE LAND QUEUE: a build branch reaches main only through here, one branch at a time.
//
//   1 the worktree is clean and the branch has commits main does not
//   2 main is current with origin (fast-forwarded if it is only behind; anything else BLOCKS)
//   3 rebase the branch onto main          (a conflict is aborted and goes back to the agent)
//   4 run the repo's verify in the worktree (repos.json `verify`; red goes back to the agent)
//   5 fast-forward main to the branch       (never a merge commit, never a force)
//   6 push main
//   7 the caller removes the worktree and the branch
//
// RED = the branch's fault (the agent fixes it). BLOCKED = main's state (the owner's to clear):
// a main checkout on another branch, a stopped rebase, a diverged main, or local edits in the
// files the branch changes. Nothing here resets, forces, skips or cleans.

export type StepName = 'clean' | 'main' | 'commits' | 'rebase' | 'verify' | 'land' | 'push' | 'cleanup'
export type Step = { name: StepName; ok: boolean; detail: string; ms?: number }
export type LandOutcome = { state: 'landed' | 'red' | 'blocked'; steps: Step[]; note: string; sha: string | null; commits: number }

export type LandCtx = {
  /** the repo's main checkout (on main) */
  mainDir: string
  /** the branch's worktree */
  wtDir: string
  branch: string
  /** the repo's verify command (repos.json), run in the worktree; absent = no verify step */
  verify?: string | null
  /** where a relative interpreter in `verify` resolves (the repo's home, e.g. <fund>/platform) */
  verifyHome?: string
  /** run a verify command (injectable for tests) */
  runVerify?: (cmd: string, cwd: string) => Promise<{ code: number; out: string }>
  verifyTimeoutMs?: number
}

/**
 * A verify command's leading interpreter, when it is a RELATIVE path ("../.venv/Scripts/python.exe"),
 * is written from the repo's home checkout; in a worktree it would point nowhere, so it is
 * resolved against the home and quoted. Everything after it is left exactly as written.
 */
export function resolveVerify(cmd: string, home: string): string {
  const m = /^\s*("([^"]+)"|(\S+))(.*)$/s.exec(cmd)
  if (!m) return cmd
  const exe = m[2] ?? m[3]
  if (isAbsolute(exe) || !/[\\/]/.test(exe)) return cmd
  const abs = resolve(home, exe)
  return `"${abs}"${m[4]}`
}

export function runShell(cmd: string, cwd: string, timeoutMs = 600_000): Promise<{ code: number; out: string }> {
  return new Promise(res => {
    const env = gitEnv()
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
      const killed = err && (err as any).killed ? `\n(killed after ${Math.round(timeoutMs / 1000)} s)` : ''
      res({ code, out: `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}${killed}` })
    })
  })
}

/** the last `n` non-empty lines of a command's output: what a red verify sends back */
export const tail = (s: string, n = 30) => s.split(/\r?\n/).filter(l => l.trim()).slice(-n).join('\n')

async function upstreamOf(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${MAIN}@{u}`])
  return r.code === 0 ? r.stdout.trim() : null
}

export async function landBranch(ctx: LandCtx): Promise<LandOutcome> {
  const steps: Step[] = []
  const at = () => Date.now()
  const out = (state: LandOutcome['state'], note: string, sha: string | null = null, commits = 0): LandOutcome => ({ state, steps, note, sha, commits })
  const step = (name: StepName, ok: boolean, detail: string, t0?: number) => { steps.push({ name, ok, detail, ...(t0 ? { ms: at() - t0 } : {}) }); return ok }
  const { mainDir, wtDir, branch } = ctx

  // 1 clean
  if (!existsSync(wtDir)) { step('clean', false, `worktree missing: ${wtDir}`); return out('red', 'the worktree is gone') }
  const cur = await git(wtDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (cur.stdout.trim() !== branch) { step('clean', false, `the worktree is on ${cur.stdout.trim() || 'nothing'}, not ${branch}`); return out('red', 'the worktree left its branch') }
  if (await midOperation(wtDir)) { step('clean', false, 'a rebase or merge is stopped in the worktree'); return out('red', 'finish or abort the stopped operation in the worktree') }
  const st = parsePorcelain((await git(wtDir, ['status', '--porcelain'])).stdout)
  if (st.dirty) {
    step('clean', false, `${st.dirty} uncommitted: ${st.files.slice(0, 8).map(f => f.path).join(', ')}${st.files.length > 8 ? ' ...' : ''}`)
    return out('red', 'commit (or remove) the uncommitted files in the worktree first')
  }
  step('clean', true, 'worktree clean')

  // 2 main: on main, not mid-operation, current with origin
  const t2 = at()
  const mb = (await git(mainDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (mb !== MAIN) { step('main', false, `the main checkout is on ${mb || 'nothing'}`, t2); return out('blocked', `the ${MAIN} checkout is not on ${MAIN}`) }
  const mo = await midOperation(mainDir)
  if (mo) { step('main', false, `a ${mo} is stopped in the main checkout`, t2); return out('blocked', `a ${mo} is stopped in the main checkout`) }
  const up = await upstreamOf(mainDir)
  if (up) {
    const f = await git(mainDir, ['fetch', '--quiet'], 120_000)
    if (f.code !== 0) { step('main', false, `fetch failed: ${causeLine(f.stderr)}`, t2); return out('blocked', 'could not fetch origin') }
    const cur = await git(mainDir, ['merge-base', '--is-ancestor', up, MAIN])
    if (cur.code !== 0) {
      const ff = await git(mainDir, ['merge', '--ff-only', '--quiet', up], 120_000)
      if (ff.code !== 0) { step('main', false, `${MAIN} cannot fast-forward to ${up}: ${causeLine(ff.stderr + '\n' + ff.stdout)}`, t2); return out('blocked', `${MAIN} diverged from ${up} or local edits are in the way; sync ${MAIN} first`) }
      step('main', true, `fast-forwarded ${MAIN} to ${up}`, t2)
    } else step('main', true, `${MAIN} current with ${up}`, t2)
  } else step('main', true, `${MAIN} tracks no remote (local land, no push)`, t2)

  // two passes at most: a commit landing on main between the rebase and the fast-forward re-runs 3-5 once
  for (let pass = 1; pass <= 2; pass++) {
    // commits
    const n = Number((await git(mainDir, ['rev-list', '--count', `${MAIN}..${branch}`])).stdout.trim())
    if (!Number.isFinite(n) || n <= 0) { step('commits', false, 'the branch has no commits main does not have'); return out('red', 'nothing to land: commit on the branch first') }
    if (pass === 1) step('commits', true, `${n} commit${n === 1 ? '' : 's'}`)

    // 3 rebase onto main (in the worktree, where the branch is checked out)
    const t3 = at()
    const base = (await git(mainDir, ['rev-parse', MAIN])).stdout.trim()
    const already = (await git(wtDir, ['merge-base', '--is-ancestor', base, 'HEAD'])).code === 0
    if (!already) {
      const rb = await git(wtDir, ['rebase', '--quiet', base], 180_000)
      if (rb.code !== 0) {
        const conflicted = (await git(wtDir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split(/\r?\n/).filter(Boolean)
        const ab = await git(wtDir, ['rebase', '--abort'])
        step('rebase', false, `${conflicted.length ? `conflict in ${conflicted.join(', ')}` : causeLine(rb.stderr + '\n' + rb.stdout)}${ab.code === 0 ? ' (rebase aborted, branch as it was)' : ` (rebase --abort failed: ${causeLine(ab.stderr)})`}`, t3)
        return out('red', `the branch does not rebase onto ${MAIN}: settle the conflict in the worktree by the conflict ladder, commit, and land again`)
      }
      step('rebase', true, `rebased onto ${MAIN} ${base.slice(0, 7)}`, t3)
    } else step('rebase', true, `already on ${MAIN} ${base.slice(0, 7)}`, t3)

    // 4 verify
    if (ctx.verify) {
      const t4 = at()
      const cmd = resolveVerify(ctx.verify, ctx.verifyHome ?? mainDir)
      const v = await (ctx.runVerify ?? ((c, cwd) => runShell(c, cwd, ctx.verifyTimeoutMs)))(cmd, wtDir)
      if (v.code !== 0) { step('verify', false, `${ctx.verify} exited ${v.code}\n${tail(v.out)}`, t4); return out('red', `the verify is red: ${ctx.verify}`) }
      step('verify', true, `${ctx.verify} green`, t4)
    } else step('verify', true, 'no verify command for this repo')

    // 5 fast-forward main (a moved main re-runs the rebase once; local edits in the way BLOCK)
    const t5 = at()
    const tip = (await git(wtDir, ['rev-parse', 'HEAD'])).stdout.trim()
    const ff = await git(mainDir, ['merge', '--ff-only', '--quiet', tip], 120_000)
    if (ff.code !== 0) {
      const moved = (await git(mainDir, ['merge-base', '--is-ancestor', MAIN, tip])).code !== 0
      if (moved && pass === 1) { step('land', false, `${MAIN} moved during the verify; rebasing again`, t5); continue }
      step('land', false, `${MAIN} did not fast-forward: ${causeLine(ff.stderr + '\n' + ff.stdout)}`, t5)
      return out('blocked', moved ? `${MAIN} kept moving; land again` : `local edits in the ${MAIN} checkout touch the branch's files; commit or stash them, then land again`)
    }
    step('land', true, `${MAIN} fast-forwarded to ${tip.slice(0, 7)}`, t5)

    // 6 push
    if (up) {
      const t6 = at()
      const p = await git(mainDir, ['push', '--quiet', 'origin', `${MAIN}:${MAIN}`], 120_000)
      if (p.code !== 0) { step('push', false, `landed locally, push failed: ${causeLine(p.stderr)}; the next sync pushes it`, t6); return out('landed', 'landed on main; the push failed, sync will retry', tip, n) }
      step('push', true, `pushed ${MAIN}`, t6)
    }
    return out('landed', `${n} commit${n === 1 ? '' : 's'} on ${MAIN}`, tip, n)
  }
  return out('blocked', `${MAIN} kept moving; land again`)
}

// ---- the queue: persisted, one land at a time -------------------------------------------------

export type LandItem = {
  id: string
  repo: string
  branch: string
  worktree: string
  conversation: string | null
  agent: string | null
  state: 'queued' | 'running' | 'landed' | 'red' | 'blocked'
  steps: Step[]
  note: string
  sha: string | null
  commits: number
  queuedAt: number
  doneAt: number | null
  /** red only: was the failure sent back to the conversation */
  told?: 'sent' | 'failed' | 'no conversation' | null
}

const KEEP = 60

export class LandQueue {
  items: LandItem[] = []
  private running: Promise<void> | null = null
  constructor(private file: string | null, private work: (it: LandItem) => Promise<void>, private changed: () => void = () => {}) {
    if (file && existsSync(file)) {
      try {
        const j = JSON.parse(readFileSync(file, 'utf8'))
        if (Array.isArray(j.items)) this.items = j.items
      } catch { /* a bad file starts an empty queue; the branches are still on disk */ }
      // a daemon that stopped mid-land leaves a running item: it is re-queued, never guessed landed
      for (const it of this.items) if (it.state === 'running') { it.state = 'queued'; it.note = 're-queued after a restart' }
    }
  }

  save() {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ items: this.items.slice(-KEEP) }, null, 1))
    renameSync(tmp, this.file)
  }

  /** the pending item for a branch, if one is queued or running */
  pending(repo: string, branch: string) { return this.items.find(x => x.repo === repo && x.branch === branch && (x.state === 'queued' || x.state === 'running')) ?? null }

  enqueue(it: Omit<LandItem, 'id' | 'state' | 'steps' | 'note' | 'sha' | 'commits' | 'queuedAt' | 'doneAt'>): LandItem {
    const have = this.pending(it.repo, it.branch)
    if (have) return have
    const item: LandItem = { ...it, id: `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, state: 'queued', steps: [], note: '', sha: null, commits: 0, queuedAt: Date.now(), doneAt: null }
    this.items.push(item)
    this.save(); this.changed()
    this.kick()
    return item
  }

  /** process queued items one at a time; resolves when the queue is empty */
  kick(): Promise<void> {
    if (this.running) return this.running
    this.running = (async () => {
      for (;;) {
        const it = this.items.find(x => x.state === 'queued')
        if (!it) break
        it.state = 'running'; it.steps = []; it.note = ''
        this.save(); this.changed()
        try { await this.work(it) } catch (e) { it.state = 'blocked'; it.note = `land crashed: ${(e as Error)?.message ?? e}` }
        if (it.state === 'running') { it.state = 'blocked'; it.note ||= 'land ended without a verdict' }
        it.doneAt = Date.now()
        this.save(); this.changed()
      }
    })().finally(() => { this.running = null })
    return this.running
  }

  idle() { return this.running ?? Promise.resolve() }
}
