import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// scripts/hooks/pre-push: main on the remote only ever fast-forwards. Driven through real pushes to
// a bare remote with core.hooksPath at the hooks folder, so a refusal is git's own refusal.

const HOOKS = resolve(__dirname, '../scripts/hooks').replace(/\\/g, '/')
let dir = ''
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, FUND_AGENT: '', GIT_TERMINAL_PROMPT: '0' } })
const ok = (cwd: string, ...a: string[]) => { const r = git(cwd, ...a); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim() }

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'prepush-'))
  ok(dir, 'init', '--bare', '-b', 'main', 'remote.git')
  ok(dir, 'init', '-b', 'main', 'work')
  const w = join(dir, 'work')
  ok(w, 'config', 'user.email', 't@t'); ok(w, 'config', 'user.name', 't')
  ok(w, 'config', 'commit.gpgsign', 'false')
  ok(w, 'remote', 'add', 'origin', join(dir, 'remote.git'))
  writeFileSync(join(w, 'a.txt'), '1\n'); ok(w, 'add', 'a.txt'); ok(w, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'one')
  writeFileSync(join(w, 'a.txt'), '2\n'); ok(w, 'add', 'a.txt'); ok(w, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'two')
  // the hook under test (commits above skip the commit guard; only the push runs through HOOKS)
  ok(w, 'config', 'core.hooksPath', HOOKS)
  ok(w, 'push', 'origin', 'main:main')
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('pre-push: main only fast-forwards', () => {
  it('a fast-forward of main goes through', () => {
    const w = join(dir, 'work')
    writeFileSync(join(w, 'a.txt'), '3\n'); ok(w, 'add', 'a.txt'); ok(w, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'three')
    expect(git(w, 'push', 'origin', 'main:main').status).toBe(0)
  })
  it('a rewrite of main is refused, however it is spelled', () => {
    const w = join(dir, 'work')
    const before = ok(w, 'rev-parse', 'origin/main')
    // a commit that is not a descendant of the remote's main
    const alt = ok(w, 'commit-tree', 'HEAD~1^{tree}', '-p', 'HEAD~2', '-m', 'rewrite')
    for (const spec of [`+${alt}:refs/heads/main`]) {
      const r = git(w, 'push', 'origin', spec)
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/fund guard: refused - this push rewrites main/)
    }
    const r = git(w, 'push', '--force', 'origin', `${alt}:refs/heads/main`)
    expect(r.status).not.toBe(0)
    expect(ok(join(dir, 'remote.git'), 'rev-parse', 'main')).toBe(before)
  })
  it('deleting main is refused', () => {
    const w = join(dir, 'work')
    const r = git(w, 'push', 'origin', ':refs/heads/main')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/deletes main/)
  })
  it('another branch is not its business', () => {
    const w = join(dir, 'work')
    expect(git(w, 'push', 'origin', 'HEAD:refs/heads/b/app/x').status).toBe(0)
    expect(git(w, 'push', 'origin', ':refs/heads/b/app/x').status).toBe(0)
  })
})
