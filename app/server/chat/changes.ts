import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { FUND_ROOT, within } from '../paths.ts'
import { config } from '../config.ts'
import { git } from '../git/run.ts'
import { authorRole, causeLine, parsePorcelain, parseTrailers } from '../git/parse.ts'

// A CONVERSATION'S CHANGES: every commit whose `Conversation:` trailer names it, in every repo of
// repos.json, read from git itself (git log --grep, then the trailer parsed exactly - a
// substring hit is not a match), plus the uncommitted tree of the repo the agent stands in.
// The trailer is appended by the guard's commit-msg hook from FUND_CONVERSATION (launch.ts).
// Revert = `git revert` of those commits, newest first, one new commit each. Never a reset.

export type ConvCommit = {
  repo: string
  sha: string
  ts: number
  author: string
  subject: string
  files: string[]
  merge: boolean
  /** a later commit on this branch says "This reverts commit <sha>" */
  reverted: boolean
}
export type WorkFile = { path: string; xy: string; add: number | null; del: number | null }
export type Working = { repo: string | null; cwd: string; files: WorkFile[]; error?: string }
export type Changes = { commits: ConvCommit[]; working: Working; errors: { repo: string; error: string }[] }

// ---- pure

/** the git log format parseConvLog reads: sha, parents, author, time, subject, body, then --name-only */
export const CONV_FORMAT = '%x1e%H%x1f%P%x1f%x1f%at%x1f%s%x1f%b%x1f'

/** does a trailer value name this conversation? (a repeated trailer is joined with ", ") */
export const namesConv = (value: string | null, conv: string) => !!value && value.split(/,\s*/).some(v => v.trim() === conv)

export function parseConvLog(stdout: string, repo: string, conv: string): Omit<ConvCommit, 'reverted'>[] {
  const out: Omit<ConvCommit, 'reverted'>[] = []
  for (const rec of stdout.split('\x1e')) {
    if (!rec.trim()) continue
    const f = rec.split('\x1f')
    if (f.length < 7) continue
    const [sha, parents, , at, subject, body, rest] = f
    const t = parseTrailers(body)
    if (!namesConv(t.conversation, conv)) continue
    out.push({
      repo, sha: sha.trim(), author: authorRole(t.agent), ts: Number(at) * 1000, subject,
      files: rest.split('\n').map(s => s.trim()).filter(Boolean),
      merge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
    })
  }
  return out
}

/** every full sha named by a "This reverts commit <sha>" line */
export function revertedShas(text: string): Set<string> {
  const s = new Set<string>()
  for (const m of text.matchAll(/This reverts commit ([0-9a-f]{40})/g)) s.add(m[1])
  return s
}

/** `git diff --numstat` -> path -> counts (binary files report null) */
export function parseNumstat(stdout: string): Map<string, { add: number | null; del: number | null }> {
  const m = new Map<string, { add: number | null; del: number | null }>()
  for (const line of stdout.split('\n')) {
    const p = line.split('\t')
    if (p.length < 3) continue
    let path = p.slice(2).join('\t').trim()
    // a rename prints "old => new" or "dir/{a => b}/f"
    const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path)
    if (brace) path = `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, '/')
    else if (path.includes(' => ')) path = path.split(' => ')[1]
    m.set(path, { add: p[0] === '-' ? null : Number(p[0]), del: p[1] === '-' ? null : Number(p[1]) })
  }
  return m
}

export function workingFiles(porcelain: string, numstat: string): WorkFile[] {
  const n = parseNumstat(numstat)
  return parsePorcelain(porcelain).files.map(f => {
    const path = f.path.includes(' -> ') ? f.path.split(' -> ')[1] : f.path.replace(/^"|"$/g, '')
    const c = n.get(path)
    return { path, xy: f.xy, add: c?.add ?? null, del: c?.del ?? null }
  })
}

/** the commits a revert would touch, per repo, newest first; skips reverted ones and merges */
export function revertPlan(commits: ConvCommit[]): { repo: string; shas: ConvCommit[]; skipped: ConvCommit[] }[] {
  const byRepo = new Map<string, ConvCommit[]>()
  for (const c of commits) byRepo.set(c.repo, [...(byRepo.get(c.repo) ?? []), c])
  return [...byRepo].map(([repo, cs]) => {
    const sorted = [...cs].sort((a, b) => b.ts - a.ts)
    return { repo, shas: sorted.filter(c => !c.reverted && !c.merge), skipped: sorted.filter(c => c.reverted || c.merge) }
  }).filter(p => p.shas.length || p.skipped.length)
}

/** a repo-relative path that stays inside the repo: no absolute path, no .. */
export function safeRel(p: string): string | null {
  if (!p || isAbsolute(p) || /^[a-zA-Z]:/.test(p)) return null
  const n = normalize(p).replace(/\\/g, '/')
  if (n.startsWith('../') || n === '..' || n.includes('/../')) return null
  return n
}

/** an untracked file rendered as an all-added patch */
export function addedPatch(path: string, text: string): string {
  if (!text) return `new file ${path}, empty`
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  return [`new file ${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => '+' + l)].join('\n')
}

// ---- git

const repoDir = (path: string) => resolve(FUND_ROOT, path)

async function repoCommits(repo: { id: string; path: string }, conv: string): Promise<ConvCommit[]> {
  const dir = repoDir(repo.path)
  if (!existsSync(dir)) return []
  const log = await git(dir, ['log', '-F', `--grep=Conversation: ${conv}`, `--format=${CONV_FORMAT}`, '--name-only'])
  if (log.code !== 0) {
    if (/does not have any commits/.test(log.stderr)) return []
    throw new Error(causeLine(log.stderr))
  }
  const found = parseConvLog(log.stdout, repo.id, conv)
  if (!found.length) return []
  const oldest = Math.min(...found.map(c => c.ts))
  const rv = await git(dir, ['log', '-F', '--grep=This reverts commit', `--since=${Math.floor(oldest / 1000)}`, '--format=%b'])
  const reverted = revertedShas(rv.stdout)
  return found.map(c => ({ ...c, reverted: reverted.has(c.sha) }))
}

/** the repo (from repos.json) whose tree holds `cwd`, deepest first */
export function repoOf(cwd: string): { id: string; path: string } | null {
  const rs = config.repos().map(r => ({ ...r, abs: repoDir(r.path) })).sort((a, b) => b.abs.length - a.abs.length)
  return rs.find(r => within(cwd, r.abs)) ?? null
}

async function working(cwd: string): Promise<Working> {
  const r = repoOf(cwd)
  if (!r) return { repo: null, cwd, files: [], error: 'not in a managed repo' }
  const dir = repoDir(r.path)
  const [st, ns] = await Promise.all([
    git(dir, ['status', '--porcelain', '--untracked-files=all']),
    git(dir, ['diff', 'HEAD', '--numstat']),
  ])
  if (st.code !== 0) return { repo: r.id, cwd, files: [], error: causeLine(st.stderr) }
  // an untracked file is not in `diff HEAD`: its size is its line count (binary or huge stays null)
  const files = workingFiles(st.stdout, ns.stdout).map(f => f.xy === '??' && f.add === null ? { ...f, ...untrackedCount(join(dir, f.path)) } : f)
  return { repo: r.id, cwd, files }
}

const MAX_COUNT = 2_000_000
function untrackedCount(abs: string): { add: number | null; del: number | null } {
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size > MAX_COUNT) return { add: null, del: null }
    return { add: lineCount(readFileSync(abs)), del: 0 }
  } catch { return { add: null, del: null } }
}

/** lines in a text buffer (a last line without a newline counts); null for binary */
export function lineCount(buf: Buffer): number | null {
  if (buf.subarray(0, 8000).includes(0)) return null
  if (!buf.length) return 0
  let n = 0
  for (const b of buf) if (b === 10) n++
  return buf[buf.length - 1] === 10 ? n : n + 1
}

export async function changes(conv: string, cwd: string): Promise<Changes> {
  const errors: { repo: string; error: string }[] = []
  const lists = await Promise.all(config.repos().map(r => repoCommits(r, conv).catch((e: Error) => { errors.push({ repo: r.id, error: e.message }); return [] })))
  const commits = lists.flat().sort((a, b) => b.ts - a.ts)
  return { commits, working: await working(cwd), errors }
}

const MAX_DIFF = 400_000

/** one file's diff: in a conversation commit (sha) or in the working tree (no sha) */
export async function fileDiff(conv: string, cwd: string, o: { repo: string; path: string; sha?: string }): Promise<{ patch: string; truncated: boolean }> {
  const repo = config.repos().find(r => r.id === o.repo)
  if (!repo) throw new Error(`no repo ${o.repo}`)
  const rel = safeRel(o.path)
  if (!rel) throw new Error('bad path')
  const dir = repoDir(repo.path)
  let patch: string
  if (o.sha) {
    if (!/^[0-9a-f]{40}$/.test(o.sha)) throw new Error('bad sha')
    const mine = await repoCommits(repo, conv)
    if (!mine.some(c => c.sha === o.sha)) throw new Error('that commit is not this conversation\'s')
    const r = await git(dir, ['show', '--format=', '--patch', '--no-color', o.sha, '--', rel])
    if (r.code !== 0) throw new Error(causeLine(r.stderr))
    patch = r.stdout
  } else {
    const w = repoOf(cwd)
    if (!w || w.id !== repo.id) throw new Error('the working tree shown is the agent\'s repo only')
    const r = await git(dir, ['diff', 'HEAD', '--no-color', '--', rel])
    patch = r.stdout
    if (!patch.trim()) {
      const abs = join(dir, rel)
      if (existsSync(abs) && statSync(abs).isFile()) {
        const buf = readFileSync(abs)
        patch = buf.subarray(0, 8000).includes(0) ? `binary file ${rel}` : addedPatch(rel, buf.subarray(0, MAX_DIFF).toString('utf8'))
      } else patch = ''
    }
  }
  return { patch: patch.slice(0, MAX_DIFF), truncated: patch.length > MAX_DIFF }
}

// ---- revert

export type RevertResult = { repo: string; reverted: { sha: string; subject: string; revert: string }[]; error?: string; skipped: number }

async function sequencerBusy(dir: string): Promise<boolean> {
  for (const p of ['REVERT_HEAD', 'CHERRY_PICK_HEAD', 'MERGE_HEAD', 'sequencer', 'rebase-merge', 'rebase-apply']) {
    const r = await git(dir, ['rev-parse', '--git-path', p])
    if (r.code === 0 && existsSync(resolve(dir, r.stdout.trim()))) return true
  }
  return false
}

/**
 * Revert every live commit of the conversation, newest first, one `git revert --no-edit` (a new
 * commit) each. Every repo is checked first (nothing staged, no operation stopped mid-way) so a
 * refusal changes nothing anywhere. A conflict or a refused hook stops THAT repo: `git revert
 * --abort` puts back the one in flight, the reverts already made stay (they are commits, and
 * undoing them would be another revert).
 */
export async function revertConversation(conv: string, cwd: string, expect?: string[]): Promise<RevertResult[]> {
  const { commits } = await changes(conv, cwd)
  const plan = revertPlan(commits).filter(p => p.shas.length)
  if (!plan.length) throw new Error('nothing to revert')
  if (expect) {
    const want = new Set(expect)
    const have = plan.flatMap(p => p.shas.map(c => c.sha))
    if (have.length !== want.size || have.some(s => !want.has(s))) throw new Error('the commits changed since you looked - reload and confirm again')
  }
  const repos = config.repos()
  for (const p of plan) {
    const dir = repoDir(repos.find(r => r.id === p.repo)!.path)
    if (await sequencerBusy(dir)) throw new Error(`${p.repo}: a merge, rebase or revert is stopped in that tree`)
    const staged = await git(dir, ['diff', '--cached', '--quiet'])
    if (staged.code !== 0) throw new Error(`${p.repo}: staged changes present - commit or unstage them first`)
  }
  const out: RevertResult[] = []
  for (const p of plan) {
    const dir = repoDir(repos.find(r => r.id === p.repo)!.path)
    const res: RevertResult = { repo: p.repo, reverted: [], skipped: p.skipped.length }
    for (const c of p.shas) {
      const r = await git(dir, ['revert', '--no-edit', c.sha], 120_000)
      if (r.code !== 0) {
        res.error = `${c.sha.slice(0, 7)} ${c.subject}: ${causeLine(r.stderr + '\n' + r.stdout)}`
        if (await sequencerBusy(dir)) await git(dir, ['revert', '--abort'])
        break
      }
      const head = await git(dir, ['rev-parse', 'HEAD'])
      res.reverted.push({ sha: c.sha, subject: c.subject, revert: head.stdout.trim() })
    }
    out.push(res)
  }
  return out
}
