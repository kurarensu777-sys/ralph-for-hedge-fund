import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildRepoOf, buildRepos, neverLands, worktreeCwd, worktreePath } from '../server/git/wtpath.ts'
import { branchName, createWorktree, listWorktrees, parseWorktreeList, removeWorktree } from '../server/git/worktree.ts'
import { LandQueue, landBranch, resolveVerify, type LandItem } from '../server/git/land.ts'
import { installGuard } from '../server/git/guard.ts'
import { branchNote } from '../server/chat/launch.ts'
import { serializeAgentFile } from '../shared/agentfile.ts'

// Every land runs against THROWAWAY repos: a bare "origin", a main checkout cloned from it, and
// worktrees under a temp folder - the exact shape of <fund>/app + ~/fund-data/worktrees/app.

let tmp = ''
const env = () => { const e: Record<string, string> = { ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }; delete e.FUND_AGENT; delete e.FUND_CONVERSATION; return e }
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' }).trim()
const put = (dir: string, file: string, text: string) => { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), text) }
const commit = (dir: string, file: string, text: string, msg = `edit ${file}`) => { put(dir, file, text); g(dir, 'add', '--', file); g(dir, 'commit', '-q', '-m', msg) }
const green = async () => ({ code: 0, out: 'ok' })

/** a fresh origin + main checkout (+ a second clone standing in for "someone else pushing") */
function world(name: string) {
  const base = join(tmp, name)
  const origin = join(base, 'origin.git'), main = join(base, 'app'), other = join(base, 'other'), wts = join(base, 'worktrees')
  mkdirSync(base, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, main], { env: env() })
  for (const d of [main]) { g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 'tester'); g(d, 'config', 'commit.gpgsign', 'false') }
  commit(main, 'README.md', 'one\n', 'root')
  commit(main, 'src/a.ts', 'export const a = 1\n', 'a')
  g(main, 'push', '-q', 'origin', 'main')
  g(main, 'branch', '--set-upstream-to=origin/main', 'main')
  execFileSync('git', ['clone', '-q', origin, other], { env: env() })
  g(other, 'config', 'user.email', 'o@o'); g(other, 'config', 'user.name', 'other'); g(other, 'config', 'commit.gpgsign', 'false')
  return { origin, main, other, wts }
}

async function branchIn(w: ReturnType<typeof world>, conv: string, branch = `b/app/${conv}`) {
  const path = join(w.wts, conv)
  await createWorktree(w.main, path, branch)
  g(path, 'config', 'user.email', 't@t'); g(path, 'config', 'user.name', 'tester')
  return { path, branch }
}

beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'fund-land-')) })
afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

describe('paths and names', () => {
  it('a build conversation stands in its worktree at the agent cwd inside the repo', () => {
    const fund = join(tmp, 'fund'), wts = join(tmp, 'wts')
    mkdirSync(join(fund, 'app', 'server'), { recursive: true })
    // the build repos are the repos.json rows marked build (a guarded one never, whatever it says)
    writeFileSync(join(fund, 'repos.json'), JSON.stringify({ repos: [{ id: 'fund', path: '.' }, { id: 'app', path: 'app', build: true }, { id: 'vault', path: 'vault', build: true, guarded: true }] }))
    expect(buildRepos(fund)).toEqual([{ id: 'app', path: 'app' }])
    expect(neverLands(fund)).toEqual(['vault'])
    expect(buildRepoOf(join(fund, 'app', 'server'), fund)).toEqual({ repo: 'app', rel: 'server' })
    expect(buildRepoOf(join(fund, 'vault', 'x'), fund)).toBeNull()
    expect(buildRepoOf(join(fund, 'research'), fund)).toBeNull()
    expect(buildRepoOf(join(fund, 'application'), fund)).toBeNull()
    // no worktree on disk -> not on a branch
    expect(worktreeCwd(join(fund, 'app', 'server'), 'c-1', fund, wts)).toBeNull()
    mkdirSync(join(wts, 'app', 'c-1', 'server'), { recursive: true }); writeFileSync(join(wts, 'app', 'c-1', '.git'), 'gitdir: x')
    expect(worktreeCwd(join(fund, 'app', 'server'), 'c-1', fund, wts)).toBe(join(wts, 'app', 'c-1', 'server'))
    expect(worktreeCwd(join(fund, 'app'), 'c-1', fund, wts)).toBe(join(wts, 'app', 'c-1'))
    expect(worktreeCwd(join(fund, 'app'), '../x', fund, wts)).toBeNull()
  })
  it('a conversation on a branch is told so at boot; one on main is not', () => {
    expect(branchNote('C:/f/app', 'c:/F/app')).toBeNull()
    expect(branchNote('C:/w/app/c-1', 'C:/f/app')).toMatch(/build branch[\s\S]*land queue/)
  })
  it('a repo that is not a build repo never gets a worktree; a bad id is refused', () => {
    const repos = [{ id: 'app', path: 'app' }]
    expect(() => worktreePath('execution', 'c-1', join(tmp, 'wts'), repos)).toThrow(/not a build repo/)
    expect(() => worktreePath('research', 'c-1', join(tmp, 'wts'), repos)).toThrow(/not a build repo/)
    expect(() => worktreePath('app', '../../etc', join(tmp, 'wts'), repos)).toThrow(/not a conversation id/)
    expect(worktreePath('app', 'c-1', join(tmp, 'wts'), repos)).toBe(join(tmp, 'wts', 'app', 'c-1'))
  })
  it('one repo at the fund root: every cwd in the fund is in it, and a worktree is a whole checkout', () => {
    const fund = join(tmp, 'mono'), wts = join(tmp, 'mono-wts')
    mkdirSync(join(fund, 'app', 'server'), { recursive: true })
    const repos = [{ id: 'fund', path: '.' }]
    expect(buildRepoOf(join(fund, 'app', 'server'), fund, repos)).toEqual({ repo: 'fund', rel: join('app', 'server') })
    expect(buildRepoOf(fund, fund, repos)).toEqual({ repo: 'fund', rel: '' })
    expect(buildRepoOf(join(tmp, 'elsewhere'), fund, repos)).toBeNull()
    mkdirSync(join(wts, 'fund', 'c-2', 'app', 'server'), { recursive: true }); writeFileSync(join(wts, 'fund', 'c-2', '.git'), 'gitdir: x')
    expect(worktreeCwd(join(fund, 'app', 'server'), 'c-2', fund, wts, repos)).toBe(join(wts, 'fund', 'c-2', 'app', 'server'))
    // the shipped repos.json is the one-repo layout: the root is the build repo
    expect(buildRepos(join(__dirname, '..', '..')).map(r => r.id)).toEqual(['fund'])
  })
  it('branch names are b/<agent>/<slug>', () => {
    expect(branchName('app', 'History search: faster!', 'c-mfx1-ab12')).toBe('b/app/history-search-faster-ab12')
    expect(branchName('lab:feeds/acme', '', 'c-9')).toBe('b/lab-feeds-acme/build-9')
  })
  it('the porcelain list keeps only worktrees under the build folder', () => {
    const raw = 'worktree C:/dev/fund/app\nHEAD aaa\nbranch refs/heads/main\n\nworktree C:/Users/x/fund-data/worktrees/app/c-1\nHEAD bbb\nbranch refs/heads/b/app/x\n\n'
    const got = parseWorktreeList(raw, 'C:/Users/x/fund-data/worktrees/app')
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ branch: 'b/app/x', head: 'bbb' })
  })
  it('a relative interpreter in a verify resolves against the repo home', () => {
    expect(resolveVerify('npm run typecheck', 'C:/f/app')).toBe('npm run typecheck')
    expect(resolveVerify('../.venv/Scripts/python.exe -m pyflakes api', join('C:', 'f', 'platform'))).toBe(`"${join('C:', 'f', '.venv', 'Scripts', 'python.exe')}" -m pyflakes api`)
  })
})

describe('the land', () => {
  it('green: rebases, verifies in the worktree, fast-forwards main, pushes; cleanup removes worktree and branch', async () => {
    const w = world('green')
    const b = await branchIn(w, 'c-green')
    commit(b.path, 'src/b.ts', 'export const b = 2\n')
    // someone else lands on origin meanwhile: main must pick it up and the branch rebase over it
    commit(w.other, 'docs/x.md', 'x\n'); g(w.other, 'push', '-q', 'origin', 'main')
    let ranIn = ''
    const r = await landBranch({ mainDir: w.main, wtDir: b.path, branch: b.branch, verify: 'npm test', runVerify: async (_c, cwd) => { ranIn = cwd; return { code: 0, out: 'ok' } } })
    expect(r.state).toBe('landed')
    expect(ranIn).toBe(b.path)
    expect(r.steps.map(s => s.name)).toEqual(['clean', 'main', 'commits', 'rebase', 'verify', 'land', 'push'])
    expect(r.steps.every(s => s.ok)).toBe(true)
    expect(g(w.main, 'rev-parse', 'HEAD')).toBe(r.sha)
    expect(g(w.origin, 'rev-parse', 'main')).toBe(r.sha)
    expect(g(w.main, 'log', '--format=%s', '-3')).toBe('edit src/b.ts\nedit docs/x.md\na')
    expect(g(w.main, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0') // linear: never a merge commit
    const rm = await removeWorktree(w.main, b.path, b.branch, 'merged')
    expect(rm).toMatchObject({ removed: true, branch: 'deleted' })
    expect(existsSync(b.path)).toBe(false)
    expect(g(w.main, 'branch', '--list', b.branch)).toBe('')
  })

  it('red verify: nothing lands, the branch and worktree stay, the tail comes back', async () => {
    const w = world('redverify')
    const b = await branchIn(w, 'c-red')
    commit(b.path, 'src/a.ts', 'export const a = "broken"\n')
    const before = g(w.main, 'rev-parse', 'HEAD')
    const r = await landBranch({ mainDir: w.main, wtDir: b.path, branch: b.branch, verify: 'npm run typecheck', runVerify: async () => ({ code: 2, out: 'src/a.ts(1,1): error TS2322: nope\n' }) })
    expect(r.state).toBe('red')
    expect(r.steps.at(-1)).toMatchObject({ name: 'verify', ok: false })
    expect(r.steps.at(-1)!.detail).toMatch(/TS2322/)
    expect(g(w.main, 'rev-parse', 'HEAD')).toBe(before)
    expect(g(w.origin, 'rev-parse', 'main')).toBe(before)
    expect(existsSync(b.path)).toBe(true)
  })

  it('a real verify command runs in the worktree through the shell', async () => {
    const w = world('realverify')
    const b = await branchIn(w, 'c-real')
    commit(b.path, 'ok.txt', 'fine\n')
    const r = await landBranch({ mainDir: w.main, wtDir: b.path, branch: b.branch, verify: 'git ls-files --error-unmatch ok.txt' })
    expect(r.state).toBe('landed')
    const b2 = await branchIn(w, 'c-real2')
    commit(b2.path, 'other.txt', 'x\n')
    const r2 = await landBranch({ mainDir: w.main, wtDir: b2.path, branch: b2.branch, verify: 'git ls-files --error-unmatch missing.txt' })
    expect(r2.state).toBe('red')
  })

  it('a conflict is aborted, never skipped: red, the branch exactly as it was', async () => {
    const w = world('conflict')
    const b = await branchIn(w, 'c-conf')
    commit(b.path, 'README.md', 'branch says two\n')
    const tip = g(b.path, 'rev-parse', 'HEAD')
    commit(w.other, 'README.md', 'origin says three\n'); g(w.other, 'push', '-q', 'origin', 'main')
    const r = await landBranch({ mainDir: w.main, wtDir: b.path, branch: b.branch, runVerify: green })
    expect(r.state).toBe('red')
    expect(r.steps.find(s => s.name === 'rebase')!.detail).toMatch(/conflict in README\.md.*rebase aborted/)
    expect(g(b.path, 'rev-parse', 'HEAD')).toBe(tip)
    expect(g(b.path, 'status', '--porcelain')).toBe('')
  })

  it('a dirty worktree or an empty branch is red before anything moves', async () => {
    const w = world('dirty')
    const b = await branchIn(w, 'c-dirty')
    const r0 = await landBranch({ mainDir: w.main, wtDir: b.path, branch: b.branch, runVerify: green })
    expect(r0.state).toBe('red'); expect(r0.note).toMatch(/nothing to land/)
    put(b.path, 'half.ts', 'x')
    const r = await landBranch({ mainDir: w.main, wtDir: b.path, branch: b.branch, runVerify: green })
    expect(r.state).toBe('red'); expect(r.steps[0]).toMatchObject({ name: 'clean', ok: false })
  })

  it('main is the owner\'s: local edits in the branch\'s files BLOCK, unrelated local edits do not', async () => {
    const w = world('blocked')
    const b = await branchIn(w, 'c-blk')
    commit(b.path, 'src/a.ts', 'export const a = 3\n')
    put(w.main, 'src/a.ts', 'owner is editing this\n')
    const r = await landBranch({ mainDir: w.main, wtDir: b.path, branch: b.branch, runVerify: green })
    expect(r.state).toBe('blocked')
    expect(readFileSync(join(w.main, 'src/a.ts'), 'utf8')).toBe('owner is editing this\n') // never overwritten
    g(w.main, 'checkout', '--', 'src/a.ts')
    put(w.main, 'notes.txt', 'untracked and unrelated\n')
    put(w.main, 'README.md', 'tracked, unrelated edit\n')
    const r2 = await landBranch({ mainDir: w.main, wtDir: b.path, branch: b.branch, runVerify: green })
    expect(r2.state).toBe('landed')
    expect(readFileSync(join(w.main, 'README.md'), 'utf8')).toBe('tracked, unrelated edit\n')
  })

  it('a main that diverged from origin BLOCKS (sync main first)', async () => {
    const w = world('diverged')
    const b = await branchIn(w, 'c-div')
    commit(b.path, 'src/c.ts', 'c\n')
    commit(w.main, 'local.txt', 'unpushed on main\n')
    commit(w.other, 'remote.txt', 'pushed elsewhere\n'); g(w.other, 'push', '-q', 'origin', 'main')
    const r = await landBranch({ mainDir: w.main, wtDir: b.path, branch: b.branch, runVerify: green })
    expect(r.state).toBe('blocked')
    expect(r.steps.at(-1)).toMatchObject({ name: 'main', ok: false })
  })

  it('listWorktrees reads counts against main', async () => {
    const w = world('list')
    const b = await branchIn(w, 'c-list')
    commit(b.path, 'n.txt', '1\n'); commit(b.path, 'n.txt', '2\n')
    put(b.path, 'wip.txt', 'x')
    const [row] = await listWorktrees(w.main, w.wts)
    expect(row).toMatchObject({ conversation: 'c-list', branch: b.branch, ahead: 2, behind: 0, dirty: 1 })
    // a worktree with uncommitted work is never removed
    const rm = await removeWorktree(w.main, b.path, b.branch, 'merged')
    expect(rm.removed).toBe(false)
    expect(existsSync(join(b.path, 'wip.txt'))).toBe(true)
  })

  it('a shared node_modules is linked in and survives the worktree going', async () => {
    const w = world('junction')
    writeFileSync(join(w.main, '.gitignore'), 'node_modules/\n'); g(w.main, 'add', '.gitignore'); g(w.main, 'commit', '-q', '-m', 'ignore'); g(w.main, 'push', '-q')
    put(w.main, 'node_modules/dep/index.js', 'module.exports = 1\n')
    const path = join(w.wts, 'c-nm')
    const made = await createWorktree(w.main, path, 'b/app/nm')
    expect(made.linked).toEqual(['node_modules'])
    expect(readFileSync(join(path, 'node_modules/dep/index.js'), 'utf8')).toMatch(/exports/)
    expect(g(path, 'status', '--porcelain')).toBe('')
    const rm = await removeWorktree(w.main, path, 'b/app/nm', 'merged')
    expect(rm.removed).toBe(true)
    expect(existsSync(join(w.main, 'node_modules/dep/index.js'))).toBe(true)
  })
})

describe('the queue', () => {
  it('runs one at a time, persists, and re-queues a land a restart interrupted', async () => {
    const file = join(tmp, 'q', 'land.json')
    const order: string[] = []
    let active = 0, peak = 0
    const work = async (it: LandItem) => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 20)); order.push(it.branch); it.state = 'landed'; active-- }
    const q = new LandQueue(file, work)
    const a = q.enqueue({ repo: 'app', branch: 'b/x/1', worktree: 'w1', conversation: 'c1', agent: 'app' })
    expect(q.enqueue({ repo: 'app', branch: 'b/x/1', worktree: 'w1', conversation: 'c1', agent: 'app' }).id).toBe(a.id) // no double-queue
    q.enqueue({ repo: 'app', branch: 'b/x/2', worktree: 'w2', conversation: 'c2', agent: 'app' })
    await q.idle()
    expect(order).toEqual(['b/x/1', 'b/x/2'])
    expect(peak).toBe(1)
    const j = JSON.parse(readFileSync(file, 'utf8'))
    j.items[1].state = 'running'
    writeFileSync(file, JSON.stringify(j))
    const q2 = new LandQueue(file, work)
    expect(q2.items[1]).toMatchObject({ state: 'queued', note: 're-queued after a restart' })
  })
  it('a worker that throws leaves the item blocked with the cause, never landed', async () => {
    const q = new LandQueue(null, async () => { throw new Error('disk gone') })
    q.enqueue({ repo: 'app', branch: 'b/x/3', worktree: 'w', conversation: null, agent: null })
    await q.idle()
    expect(q.items[0]).toMatchObject({ state: 'blocked', note: 'land crashed: disk gone' })
  })
})

describe('the guard in a worktree', () => {
  it('scopes a worktree commit from the main checkout: in scope passes, out of scope is refused', async () => {
    const root = join(tmp, 'guardfund')
    mkdirSync(root, { recursive: true })
    const main = join(root, 'app')
    // the roster the guard reads: <fund>/app/agents/<id>.md (untracked in this scratch app repo)
    mkdirSync(join(main, 'agents'), { recursive: true })
    writeFileSync(join(main, 'agents', 'app.md'), serializeAgentFile({ id: 'app', name: 'app', kind: 'standing', mode: 'active', dept: 'Build', role: 'r', cwd: 'app', model: 'opus', effort: 'high', writes: ['app/src/'], boot: [] }, '# app\n'))
    mkdirSync(main, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: main })
    g(main, 'config', 'user.email', 't@t'); g(main, 'config', 'user.name', 'tester'); g(main, 'config', 'commit.gpgsign', 'false')
    g(main, 'commit', '-q', '--allow-empty', '-m', 'root')
    expect((await installGuard(main)).state).toBe('guarded')
    const wt = join(tmp, 'guardwts', 'app', 'c-g')
    await createWorktree(main, wt, 'b/app/g')
    const agentEnv = { ...env(), FUND_ROOT: root, FUND_AGENT: 'app', FUND_CONVERSATION: 'c-g' }
    put(wt, 'src/ok.ts', 'ok\n'); g(wt, 'add', 'src/ok.ts')
    const ok = spawnSync('git', ['commit', '-q', '-m', 'in scope'], { cwd: wt, env: agentEnv, encoding: 'utf8' })
    expect(ok.status, ok.stderr).toBe(0)
    expect(g(wt, 'log', '-1', '--format=%(trailers:key=Agent,valueonly)')).toBe('app')
    put(wt, 'server/no.ts', 'no\n'); g(wt, 'add', 'server/no.ts')
    const no = spawnSync('git', ['commit', '-q', '-m', 'out of scope'], { cwd: wt, env: agentEnv, encoding: 'utf8' })
    expect(no.status).not.toBe(0)
    expect(no.stderr).toMatch(/app\/server\/no\.ts/)
  })
})
