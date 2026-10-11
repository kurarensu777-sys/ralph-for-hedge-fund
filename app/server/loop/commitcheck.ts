import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Repo } from '../../shared/types.ts'

/**
 * THE COMMIT'S OWN CHECK (B-0646). A board item that a reviewer calls done is judged by what its
 * commit touched, on the committed tree, never by the whole repo area going green in the shared
 * working copy: with several agents writing to one repo, that red is somebody else's half-written file
 * and it bounced two finished items.
 *
 *   1. `git archive <sha>` into a scratch fund root (the shared checkout, its dirty and untracked
 *      files, are never read); the other repos, the venv and node_modules are junctions to the real ones.
 *   2. lint the commit's files (pyflakes; tsc for TypeScript, keeping only the diagnostics in the
 *      commit's files) and run the tests that cover them (vitest related; the python test files
 *      the commit changed or that are named for a file it changed).
 *   3. red in the commit's files, or in a test that covers them, returns the item and names the file.
 *
 * The full-area run (check.py) stays, as a second signal the loop writes on the item: it never decides.
 */

export type Scope = { repo: Repo; area: string; sha: string; files: string[] }
export type CommitVerdict = {
  ok: boolean
  /** what ran, one label each ("pyflakes 2 files", "vitest related 3 files"); empty = nothing covers the commit's files */
  ran: string[]
  /** the files that are red and are the commit's own, or whose test is red: named on the return */
  failing: string[]
  /** red diagnostics in files the commit did not touch (tsc only: a lint run is scoped to the commit's files) */
  elsewhere: string[]
  tail: string
}
export type Step = { label: string; cmd: 'py' | 'node'; args: string[]; cwd: string; kind: 'lint' | 'tsc' | 'test'; timeoutMs: number; tests?: string[]; env?: Record<string, string>; pyPath?: string }

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')
const stemOf = (p: string) => basename(p).replace(/\.[^.]+$/, '')

/** a test file a runner below can start by itself */
const isPyTest = (p: string) => /(^|\/)test_[\w-]+\.py$/.test(p)

/** the python test files that cover `files`: the ones the commit changed, and `test_<stem>.py` beside or above a changed source */
export function pyTestsFor(files: string[], exists: (p: string) => boolean): string[] {
  const out = new Set<string>()
  for (const f of files.filter(x => x.endsWith('.py'))) {
    if (isPyTest(f)) { out.add(f); continue }
    const dir = dirname(f), stem = stemOf(f)
    for (const c of [`${dir}/tests/test_${stem}.py`, `${dir}/test_${stem}.py`, `${dirname(dir)}/tests/test_${stem}.py`, `tests/test_${stem}.py`, `tools/tests/test_${stem}.py`]) {
      if (exists(norm(c))) out.add(norm(c))
    }
  }
  return [...out].sort()
}

/** what to run for the commit's files (pure: `exists` reads the committed tree) */
export function plan(repoId: string, filesIn: string[], exists: (p: string) => boolean): Step[] {
  const files = filesIn.map(norm)
  const steps: Step[] = []
  const py = files.filter(f => f.endsWith('.py'))
  const ts = files.filter(f => /\.(ts|tsx)$/.test(f))
  // python: pyflakes on the commit's files, then the tests that cover them
  if (py.length) steps.push({ label: `pyflakes ${py.length} file${py.length > 1 ? 's' : ''}`, cmd: 'py', args: ['-m', 'pyflakes', ...py], cwd: '', kind: 'lint', timeoutMs: 5 * 60_000 })
  const tests = pyTestsFor(py, exists)
  if (repoId === 'platform') {
    for (const t of tests.filter(x => x.startsWith('fundplat/'))) steps.push({ label: `python -m ${t.replace(/\.py$/, '').split('/').join('.')}`, cmd: 'py', args: ['-m', t.replace(/\.py$/, '').split('/').join('.')], cwd: '', kind: 'test', timeoutMs: 15 * 60_000, tests: [t] })
  } else if (repoId === 'database') {
    const t = tests.filter(x => x.startsWith('tests/'))
    if (t.length) steps.push({ label: `pytest ${t.length} file${t.length > 1 ? 's' : ''}`, cmd: 'py', args: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...t], cwd: '', kind: 'test', timeoutMs: 15 * 60_000, tests: t })
  } else if (repoId === 'app') {
    for (const t of tests.filter(x => /(^|\/)tools\//.test(x))) steps.push({ label: `python app/${t}`, cmd: 'py', args: [`app/${t}`], cwd: '@root', kind: 'test', timeoutMs: 10 * 60_000, tests: [t] })
  }
  // TypeScript: the app's server/shared/src/test, and @fund/db
  if (repoId === 'app' && ts.length) {
    const unit = ts.filter(f => /^(server|shared|src|test)\//.test(f))
    if (unit.length) {
      steps.push({ label: 'tsc', cmd: 'node', args: ['node_modules/typescript/bin/tsc', '--noEmit'], cwd: '', kind: 'tsc', timeoutMs: 10 * 60_000 })
      steps.push({ label: `vitest related ${unit.length} file${unit.length > 1 ? 's' : ''}`, cmd: 'node', args: ['node_modules/vitest/vitest.mjs', 'related', ...unit, '--run', '--maxWorkers=2', '--passWithNoTests'], cwd: '', kind: 'test', timeoutMs: 20 * 60_000, tests: unit.filter(f => /\.test\.tsx?$/.test(f)) })
    }
  }
  if (repoId === 'database') {
    const node = ts.filter(f => f.startsWith('node/'))
    if (node.length) {
      steps.push({ label: 'tsc (node)', cmd: 'node', args: ['node_modules/typescript/bin/tsc', '--noEmit'], cwd: 'node', kind: 'tsc', timeoutMs: 5 * 60_000 })
      const nt = node.filter(f => /^node\/test\/[\w-]+\.test\.ts$/.test(f)).map(f => f.slice('node/'.length))
      if (nt.length) steps.push({ label: `node --test ${nt.length} file${nt.length > 1 ? 's' : ''}`, cmd: 'node', args: ['--test', '--test-concurrency=1', ...nt], cwd: 'node', kind: 'test', timeoutMs: 10 * 60_000, tests: nt.map(f => `node/${f}`) })
    }
  }
  return steps
}

/** the folders of a one-repo fund that plan like their own repo did (app/, database/, platform/) */
export const AREAS = ['app', 'database', 'platform'] as const

/**
 * what to run for a commit of `repo`: a sub-repo plans by its id; the fund root (path '.') holds the
 * areas as plain folders, so each area's files plan as that area did when it was its own repo, with
 * every step moved under the area (its cwd, its test names) and the root's own files linted alone
 */
export function planRepo(repo: Pick<Repo, 'id' | 'path'>, filesIn: string[], exists: (p: string) => boolean): Step[] {
  if (repo.path !== '.') return plan(repo.id, filesIn, exists)
  const files = filesIn.map(norm)
  const steps: Step[] = []
  const rest = files.filter(f => !AREAS.some(a => f.startsWith(`${a}/`)))
  if (rest.length) steps.push(...plan(repo.id, rest, exists))
  for (const area of AREAS) {
    const mine = files.filter(f => f.startsWith(`${area}/`)).map(f => f.slice(area.length + 1))
    if (!mine.length) continue
    for (const s of plan(area, mine, p => exists(`${area}/${p}`))) {
      steps.push({
        ...s,
        cwd: s.cwd === '@root' ? '@root' : s.cwd ? `${area}/${s.cwd}` : area,
        tests: s.tests?.map(t => `${area}/${t}`),
        ...(area === 'database' && s.cmd === 'py' ? { pyPath: 'database/py' } : {}),
      })
    }
  }
  return steps
}

// ---- reading a step's output ----

/** the files a lint or tsc output names: `path:line:col: msg` (pyflakes), `path(line,col): error` (tsc) */
export function filesIn(out: string): string[] {
  const set = new Set<string>()
  for (const l of out.split(/\r?\n/)) {
    const m = /^(\S[^:()]*?\.(?:py|tsx?|mjs)):\d+/.exec(l) ?? /^(\S[^()]*?\.(?:tsx?|mjs))\(\d+,\d+\): error/.exec(l)
    if (m) set.add(norm(m[1]))
  }
  return [...set]
}

/** `a` is the same file as `b`, allowing one to carry a repo prefix the other lacks (check.py prints from the suite's cwd) */
export const sameFile = (a: string, b: string) => { const x = norm(a), y = norm(b); return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`) }

/** failing test files named in a vitest / pytest / node --test output */
function failedTests(out: string, candidates: string[]): string[] {
  const named = new Set<string>()
  for (const l of out.split(/\r?\n/)) {
    const m = /^\s*(?:FAIL|FAILED|❯|not ok \d+ -)\s+(?:\[[^\]]*\]\s*)?(\S+\.(?:test\.)?(?:tsx?|py))/.exec(l)
    if (m) named.add(norm(m[1]))
  }
  const hit = candidates.filter(c => [...named].some(n => sameFile(n, c)))
  return hit.length ? hit : [...named]
}

// ---- the scratch tree ----

type Run = { code: number; out: string }
const sh = (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Run> => new Promise(resolve => {
  execFile(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
    resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}${err && typeof (err as any).code !== 'number' ? `\n${(err as Error).message}` : ''}` })
  })
})

/** the commit's files, repo-relative, added or changed (a deleted file has nothing to lint) */
export async function commitFiles(repoDir: string, sha: string): Promise<string[]> {
  const r = await sh('git', ['show', '--no-renames', '--diff-filter=d', '--name-only', '--format=', '--end-of-options', sha], { cwd: repoDir, timeoutMs: 60_000 })
  return r.out.split('\n').map(x => x.trim()).filter(Boolean).map(norm)
}

type Tree = { root: string; links: string[]; dispose: () => void }

/**
 * `sha` of `repo` as a scratch fund root: the repo's committed files at their fund-relative place,
 * every other top-level entry of the real fund (the other repos, .venv, repos.json) a junction or a copy,
 * and the repo's own untracked tool dirs (node_modules) junctioned back in. dispose() unlinks the
 * junctions BEFORE it removes the tree, so a recursive remove can never reach the real folders.
 */
export async function materialize(fundRoot: string, repo: Repo, sha: string): Promise<Tree> {
  const root = mkdtempSync(join(tmpdir(), 'fund-review-'))
  const links: string[] = []
  const dispose = () => {
    for (const l of links) { try { unlinkSync(l) } catch { try { rmdirSync(l) } catch { /* gone */ } } }
    try { rmSync(root, { recursive: true, force: true }) } catch { /* a windows file lock: the temp dir is swept later */ }
  }
  try {
    const at = repo.path === '.' ? root : join(root, ...repo.path.split('/'))
    mkdirSync(at, { recursive: true })
    const tar = join(root, '.commit.tar')   // unpacked with relative paths: GNU tar reads `C:` as a host
    const repoDir = join(fundRoot, ...repo.path.split('/'))
    const a = await sh('git', ['archive', '--format=tar', '-o', tar, '--end-of-options', sha], { cwd: repoDir, timeoutMs: 5 * 60_000 })
    if (a.code !== 0) throw new Error(`git archive ${sha.slice(0, 10)} failed: ${a.out.trim().slice(-200)}`)
    const x = await sh('tar', ['-xf', '.commit.tar', '-C', repo.path === '.' ? '.' : repo.path], { cwd: root, timeoutMs: 5 * 60_000 })
    if (x.code !== 0) throw new Error(`could not unpack the commit: ${x.out.trim().slice(-200)}`)
    rmSync(tar, { force: true })
    const link = (target: string, path: string) => { symlinkSync(target, path, 'junction'); links.push(path) }
    for (const name of readdirSync(fundRoot)) {
      if (name === '.git' || existsSync(join(root, name))) continue
      const src = join(fundRoot, name)
      if (statSync(src).isDirectory()) link(src, join(root, name)); else copyFileSync(src, join(root, name))
    }
    // the repo's own untracked tool dirs (in a one-repo fund, each area's)
    for (const rel of ['node_modules', 'node/node_modules', 'app/node_modules', 'database/node/node_modules']) {
      const src = join(repoDir, ...rel.split('/'))
      const dst = join(at, ...rel.split('/'))
      if (existsSync(src) && !existsSync(dst) && existsSync(dirname(dst))) link(src, dst)
    }
    return { root, links, dispose }
  } catch (e) { dispose(); throw e }
}

/** the machine's own paths out of anything written on a board item (B-0645) */
function scrub(text: string, root: string): string {
  let t = text
  for (const [dir, to] of [[root, '<tree>'], [tmpdir(), '%TEMP%'], [homedir(), '~']] as const) {
    for (const form of new Set([dir, dir.replace(/\\/g, '/')])) t = t.split(form).join(to)
  }
  return t
}

const trimTail = (text: string, n = 6) => text.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean).slice(-n).join(' | ')

/**
 * Judge a commit by itself. `python` is the fund venv's interpreter; `node` the node binary.
 * Returns ok with `ran: []` when nothing lints or tests the commit's files (a chapter, a board item).
 */
export async function checkCommit(scope: Scope, env: { fundRoot: string; python: string; node?: string }): Promise<CommitVerdict> {
  const repoDir = join(env.fundRoot, ...scope.repo.path.split('/'))
  const files = scope.files.length ? scope.files.map(norm) : await commitFiles(repoDir, scope.sha)
  const tree = await materialize(env.fundRoot, scope.repo, scope.sha)
  try {
    const at = scope.repo.path === '.' ? tree.root : join(tree.root, ...scope.repo.path.split('/'))
    const steps = planRepo(scope.repo, files, p => existsSync(join(at, ...p.split('/'))))
    const floor = join(tree.root, '.floor'); mkdirSync(floor, { recursive: true })
    const penv: NodeJS.ProcessEnv = { ...process.env, FUND_ROOT: tree.root, FUND_FLOOR: floor, PYTHONDONTWRITEBYTECODE: '1', ...(scope.repo.id === 'database' ? { PYTHONPATH: join(at, 'py') } : {}) }
    const v: CommitVerdict = { ok: true, ran: [], failing: [], elsewhere: [], tail: '' }
    for (const s of steps) {
      const cwd = s.cwd === '@root' ? tree.root : s.cwd ? join(at, ...s.cwd.split('/')) : at
      const senv = s.pyPath ? { ...penv, PYTHONPATH: join(tree.root, ...s.pyPath.split('/')) } : penv
      const r = await sh(s.cmd === 'py' ? env.python : (env.node ?? process.execPath), s.args, { cwd, env: senv, timeoutMs: s.timeoutMs })
      v.ran.push(s.label)
      if (r.code === 0) continue
      const out = scrub(r.out, tree.root)
      const prefix = s.cwd && s.cwd !== '@root' ? `${s.cwd}/` : ''
      const named = s.kind === 'test' ? failedTests(out, s.tests ?? []) : filesIn(out).map(f => prefix + f)
      const own = s.kind === 'test' ? (named.length ? named : s.tests?.length ? s.tests : [s.label]) : named.filter(f => files.some(c => sameFile(c, f)))
      const other = s.kind === 'test' ? [] : named.filter(f => !files.some(c => sameFile(c, f)))
      if (s.kind !== 'test' && !named.length) { v.ok = false; v.failing.push(s.label); v.tail ||= trimTail(out); continue }   // a lint that crashed names nothing: it cannot be ruled out
      v.elsewhere.push(...other.filter(f => !v.elsewhere.includes(f)))
      if (own.length) { v.ok = false; for (const f of own) if (!v.failing.includes(f)) v.failing.push(f); v.tail ||= trimTail(out) }
    }
    return v
  } finally { tree.dispose() }
}
