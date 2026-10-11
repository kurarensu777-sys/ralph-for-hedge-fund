import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PYTHON } from '../server/paths.ts'
import { checkCommit, filesIn, plan, pyTestsFor, sameFile } from '../server/loop/commitcheck.ts'

// The commit's own check (B-0646): a board item is judged by what its commit touched, on the committed
// tree. Run on a TEMP repo with the fund venv's pyflakes: a red file outside the commit does not return
// it, a red file inside does, and a dirty or untracked file in the shared checkout is never read.

let dir: string
const sh = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
const repo = { id: 'fund', path: '.', holds: '' }
const env = () => ({ fundRoot: dir, python: PYTHON })
const scratch = () => readdirSync(tmpdir()).filter(n => n.startsWith('fund-review-'))

function commit(files: Record<string, string>, msg: string): string {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, ...p.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(dir, ...p.split('/')), body)
  }
  sh(['add', '--', ...Object.keys(files)]); sh(['commit', '-q', '-m', msg])
  return sh(['rev-parse', 'HEAD']).trim()
}
const verdict = (sha: string) => checkCommit({ repo, area: 'tools', sha, files: [] }, env())

const CLEAN = 'import os\nprint(os.sep)\n'
const RED = 'import os\n'                     // pyflakes: imported but unused

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commit-check-'))
  sh(['init', '-q', '-b', 'main'])
  for (const kv of [['user.email', 't@t'], ['user.name', 't'], ['core.hooksPath', join(dir, '.nohooks')], ['core.autocrlf', 'false']]) sh(['config', kv[0], kv[1]])
  writeFileSync(join(dir, 'README.md'), 'x\n'); sh(['add', '--', 'README.md']); sh(['commit', '-q', '-m', 'init'])
})
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows file lock */ } })

describe('judged by its own commit', () => {
  it('a red file OUTSIDE the commit does not return it; a red file INSIDE does, and is named', async () => {
    commit({ 'pkg/theirs.py': RED }, 'someone else, already red (B-0643)')
    const mine = commit({ 'pkg/mine.py': CLEAN }, 'mine (B-1)')
    const ok = await verdict(mine)
    expect(ok).toMatchObject({ ok: true, failing: [] })
    expect(ok.ran).toEqual(['pyflakes 1 file'])          // it did look: this is not a vacuous pass

    const broken = commit({ 'pkg/broken.py': RED }, 'mine, broken (B-2)')
    const bad = await verdict(broken)
    expect(bad.ok).toBe(false)
    expect(bad.failing).toEqual(['pkg/broken.py'])        // the return can name the file
    expect(bad.tail).toMatch(/pkg\/broken\.py:1/)
    expect(bad.tail).not.toMatch(/theirs\.py/)
  })

  it('a dirty or untracked file in the shared checkout is never read', async () => {
    const mine = commit({ 'pkg/mine.py': CLEAN }, 'mine (B-1)')
    writeFileSync(join(dir, 'pkg', 'untracked_bad.py'), RED)           // another session's new file
    writeFileSync(join(dir, 'pkg', 'mine.py'), `${CLEAN}import sys\n`)  // another session's edit to the same file
    expect(await verdict(mine)).toMatchObject({ ok: true, failing: [] })
    // and the reverse: a clean working copy does not hide a red commit
    const broken = commit({ 'pkg/broken.py': RED }, 'mine, broken (B-2)')
    writeFileSync(join(dir, 'pkg', 'broken.py'), CLEAN)
    expect((await verdict(broken)).failing).toEqual(['pkg/broken.py'])
  })

  it('a lint run that crashes names nothing and still returns the item (it cannot be ruled out)', async () => {
    const sha = commit({ 'pkg/syntax.py': 'def (:\n' }, 'syntax (B-3)')
    const v = await verdict(sha)
    expect(v.ok).toBe(false)
    expect(v.failing.length).toBeGreaterThan(0)
  })

  it('a commit nothing lints or tests is ok and says nothing ran', async () => {
    const sha = commit({ 'notes/chapter.md': '# a chapter\n' }, 'a chapter (B-4)')
    expect(await verdict(sha)).toMatchObject({ ok: true, ran: [], failing: [] })
  })

  it('the scratch tree is gone afterwards and the real folders its junctions pointed at are intact', async () => {
    mkdirSync(join(dir, 'keepdir')); writeFileSync(join(dir, 'keepdir', 'sentinel.txt'), 'real')   // an untracked top-level dir: it is junctioned in
    const before = scratch().length
    await verdict(commit({ 'pkg/mine.py': CLEAN }, 'mine (B-1)'))
    expect(scratch().length).toBe(before)
    expect(existsSync(join(dir, 'keepdir', 'sentinel.txt'))).toBe(true)
  })
})

describe('what runs for a commit', () => {
  const none = () => false
  it('python: pyflakes on the commit\'s files, and the tests that cover them', () => {
    const exists = (p: string) => p === 'fundplat/quant/tests/test_cash_rv.py'
    const steps = plan('platform', ['fundplat/quant/tradfi/cash_rv.py', 'fundplat/quant/tests/test_swap_rv.py', 'README.md'], p => exists(p) || p === 'fundplat/quant/tests/test_swap_rv.py')
    expect(steps.map(s => s.label)).toEqual(['pyflakes 2 files', 'python -m fundplat.quant.tests.test_cash_rv', 'python -m fundplat.quant.tests.test_swap_rv'])
    expect(steps[0].args.slice(2)).toEqual(['fundplat/quant/tradfi/cash_rv.py', 'fundplat/quant/tests/test_swap_rv.py'])
    expect(pyTestsFor(['fundplat/quant/tradfi/cash_rv.py'], exists)).toEqual(['fundplat/quant/tests/test_cash_rv.py'])
  })

  it('the app: tsc for the project and vitest related for the commit\'s files; a chapter runs nothing', () => {
    const steps = plan('app', ['server/loop/boardreview.ts', 'test/loop-boardreview.test.ts', 'library/app/cockpit-server.md'], none)
    expect(steps.map(s => s.label)).toEqual(['tsc', 'vitest related 2 files'])
    expect(steps[1].args).toEqual(expect.arrayContaining(['related', 'server/loop/boardreview.ts', 'test/loop-boardreview.test.ts', '--run']))
    expect(steps[1].tests).toEqual(['test/loop-boardreview.test.ts'])
    expect(plan('app', ['library/app/cockpit-server.md', 'board/B-0001.md'], none)).toEqual([])
  })

  it('reads the files a lint or tsc output names, and matches a path with or without the repo prefix', () => {
    expect(filesIn(['a/b.py:3:1: x', 'server/x.ts(3,5): error TS2322: y', 'noise', 'C:\\x'].join('\n'))).toEqual(['a/b.py', 'server/x.ts'])
    expect(sameFile('tools/check.py', 'app/tools/check.py')).toBe(true)
    expect(sameFile('tools/check.py', 'tools/other.py')).toBe(false)
  })
})
