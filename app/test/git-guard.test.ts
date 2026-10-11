import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// plain ESM (the hooks run outside the TypeScript build); typed by guard-lib.d.mts
import * as lib from '../scripts/hooks/guard-lib.mjs'
import { guardState, installGuard, HOOKS_DIR } from '../server/git/guard.ts'
import { serializeAgentFile } from '../shared/agentfile.ts'

// Fake credentials are assembled at runtime so this file itself never carries one.
const AWS = 'AKIA' + 'Q'.repeat(4) + '7'.repeat(12)
const GH = 'ghp_' + 'a1B2'.repeat(9)
const SK = 'sk-' + 'ant-' + 'x9Y8'.repeat(8)
// built from parts so this file's own added lines never trip the guard it tests
const KEYLIKE = 'q8ZrT2mVx41' + 'LpN0cWd7kHs'

describe('scope rules', () => {
  it('a folder entry covers what is under it, a file entry only itself (or its folder)', () => {
    expect(lib.covers('app/', 'app/src/x.ts')).toBe(true)
    expect(lib.covers('app/', 'repos/application/x')).toBe(false)
    expect(lib.covers('CLAUDE.md', 'CLAUDE.md')).toBe(true)
    expect(lib.covers('CLAUDE.md', 'CLAUDE.md.bak')).toBe(false)
    expect(lib.covers('lab/platform', 'lab/platform/x.md')).toBe(true)
    expect(lib.outOfScope(['agents.json', 'board/'], ['agents.json', 'library/b.md'])).toEqual(['library/b.md'])
  })
  it('a writes entry is a PATH PREFIX, never a glob: a folder covers what is under it, a * entry covers nothing', () => {
    // a review folder: the folder entry covers a review in it
    expect(lib.covers('platform/feeds/_reviews/', 'platform/feeds/_reviews/acme.md')).toBe(true)
    expect(lib.covers('platform/feeds/_reviews', 'platform/feeds/_reviews/acme.md')).toBe(true)
    expect(lib.covers('platform/feeds/_reviews/', 'platform/feeds/_reviewsx/acme.md')).toBe(false)
    expect(lib.covers('platform/feeds/_reviews/', 'platform/feeds/acme/feed.json')).toBe(false)
    // no glob is expanded: a * or ** entry matches nothing but a file literally named so
    for (const glob of ['*', '**', 'platform/feeds/*', 'platform/feeds/*/docs/', 'platform/feeds/**/feed.json', '*.md']) {
      for (const p of ['platform/feeds/acme/feed.json', 'platform/feeds/acme/docs/x.md', 'x.md', 'platform/feeds/_reviews/acme.md']) {
        expect(lib.covers(glob, p), `${glob} must not cover ${p}`).toBe(false)
      }
    }
    expect(lib.outOfScope(['platform/feeds/*'], ['platform/feeds/acme/feed.json'])).toEqual(['platform/feeds/acme/feed.json'])
  })
  it('api/execution is recognised at any depth', () => {
    expect(lib.isExecution('platform/api/execution/brokers/broker.py')).toBe(true)
    expect(lib.isExecution('api/execution')).toBe(true)
    expect(lib.isExecution('platform/api/executions.md')).toBe(false)
  })
  it('the execution repo is recognised at the fund root; a shelf ABOUT execution is not (B-0077)', () => {
    expect(lib.isExecution('execution/fundexec/oms.py')).toBe(true)
    expect(lib.isExecution('execution')).toBe(true)
    expect(lib.isExecution('./execution/CLAUDE.md')).toBe(true)
    expect(lib.isExecution('app/library/craft/execution/desk-law.md')).toBe(false)
    expect(lib.isExecution('platform/lab/execution/beliefs.md')).toBe(false)
    expect(lib.isExecution('executions/x.md')).toBe(false)
  })
  it('only the old api/execution shim is still refused outright; the execution repo is not (B-0427)', () => {
    expect(lib.isLegacyExecution('platform/api/execution/brokers/broker.py')).toBe(true)
    expect(lib.isLegacyExecution('api/execution')).toBe(true)
    expect(lib.isLegacyExecution('execution/fundexec/oms.py')).toBe(false)
    expect(lib.isLegacyExecution('execution/api/execution/x.py')).toBe(true) // a shim spelling is a shim wherever it sits
    expect(lib.isLegacyExecution('platform/api/executions.md')).toBe(false)
  })
})

describe('secret rules', () => {
  it('names', () => {
    expect(lib.secretFileReason('x/.env')).toBe('env file')
    expect(lib.secretFileReason('.env.local')).toBe('env file')
    expect(lib.secretFileReason('.env.example')).toBeNull()
    expect(lib.secretFileReason('certs/server.pem')).toBe('key file')
    expect(lib.secretFileReason('a/deploy.key')).toBe('key file')
    expect(lib.secretFileReason('keyboard.ts')).toBeNull()
  })
  it('lines', () => {
    expect(lib.secretLineReason(`aws = "${AWS}"`)).toBe('aws access key id')
    expect(lib.secretLineReason(`token: ${GH}`)).toBe('github token')
    expect(lib.secretLineReason(`ANTHROPIC=${SK}`)).toBe('sk- api key')
    expect(lib.secretLineReason('-----BEGIN RSA PRIVATE ' + 'KEY-----')).toBe('private key block')
    expect(lib.secretLineReason(`api_key = "${KEYLIKE}"`)).toBe('key-like assignment')
    expect(lib.secretLineReason(`api_key = "your_api_key_goes_here_1"`)).toBeNull()
    expect(lib.secretLineReason('const token = process.env.DATA_API_KEY')).toBeNull()
    expect(lib.secretLineReason('password: "abcdefghijklmnopqrstuvwxyz"')).toBeNull() // no digit: not key-shaped
  })
  it('an sk- slug is not a key; a real sk- shape is', () => {
    expect(lib.secretLineReason('https://example.com/news/sk-hynix-suffer-a-flash-crash-2026')).toBeNull()
    expect(lib.secretLineReason('studies/sk-semis-pair-thesis-notebook.ipynb')).toBeNull()
    expect(lib.secretLineReason('sk-' + 'hynix'.repeat(8))).toBeNull() // letters only: not key-shaped
    expect(lib.secretLineReason('k=' + 'sk-' + 'proj-' + 'ab12'.repeat(10))).toBe('sk- api key')
    expect(lib.secretLineReason('k=' + 'sk-' + 'A1b2C3d4'.repeat(6))).toBe('sk- api key')
  })
  it('only ADDED lines are judged', () => {
    const diff = `diff --git a/c.py b/c.py\n--- a/c.py\n+++ b/c.py\n@@ -1,1 +1,2 @@\n-old = "${AWS}"\n+ok = 1\n+k = "${AWS}"\n`
    const added = lib.addedLines(diff)
    expect(added.get('c.py')).toEqual([{ n: 1, text: 'ok = 1' }, { n: 2, text: `k = "${AWS}"` }])
    expect(lib.secretFindings(['c.py'], added)).toEqual([{ path: 'c.py', line: 2, why: 'aws access key id' }])
  })
})

// control bytes built from char codes, so this file's own added lines hold none
const BS = String.fromCharCode(8), FF = String.fromCharCode(12), ESC = String.fromCharCode(27), DEL = String.fromCharCode(127)

describe('control-character rules', () => {
  it('names the first control character and its column; tab and form feed pass', () => {
    expect(lib.controlLineReason(`/^output${BS}/i.test(alt)`)).toBe('control character U+0008 (backspace) at column 9')
    expect(lib.controlLineReason(`x${ESC}[31m`)).toBe('control character U+001B (escape) at column 2')
    expect(lib.controlLineReason(`a${DEL}`)).toBe('control character U+007F (DEL) at column 2')
    expect(lib.controlLineReason(String.fromCharCode(1))).toBe('control character U+0001 at column 1')
    expect(lib.controlLineReason('\tindented = 1')).toBeNull()
    expect(lib.controlLineReason(`page one${FF}page two`)).toBeNull()
    expect(lib.controlLineReason('/^output\\b/i  the two characters, backslash and b')).toBeNull()
  })
  it('judges only ADDED lines, one finding per file, and never a snapshot', () => {
    const diff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,3 @@\n-old${BS}\n+ok\n+x${BS}\n+y${BS}\n`
      + `diff --git a/feeds/acme/snapshots/s.md b/feeds/acme/snapshots/s.md\n--- /dev/null\n+++ b/feeds/acme/snapshots/s.md\n@@ -0,0 +1,1 @@\n+pdf${BS}text\n`
    expect(lib.controlFindings(lib.addedLines(diff))).toEqual([{ path: 'a.ts', line: 2, why: 'control character U+0008 (backspace) at column 2' }])
    expect(lib.isSnapshot('platform/feeds/acme/snapshots/x/y.md')).toBe(true)
    expect(lib.isSnapshot('app/src/snapshot.ts')).toBe(false)
  })
  it('blocks an agent and warns the owner', () => {
    const controls = [{ path: 'a.ts', line: 2, why: 'control character U+0008 (backspace) at column 2' }]
    const a = lib.verdict({ agentId: 'app', agent: { writes: ['app/'] }, fundPaths: ['app/a.ts'], secrets: [], outsideFund: false, controls })
    expect(a.ok).toBe(false)
    expect(a.errors.join('\n')).toMatch(/a\.ts:2 +\(control character U\+0008/)
    const o = lib.verdict({ agentId: null, agent: null, fundPaths: ['app/a.ts'], secrets: [], outsideFund: false, controls })
    expect(o.ok).toBe(true)
    expect(o.warnings.join('\n')).toMatch(/a\.ts:2 control character U\+0008.*the owner: a warning/)
  })
})

describe('write-back warning (B-0347: the chapter\'s Read when line, not a _series.md row)', () => {
  const chaptered = '# Book\n\n## One\nRead when: about to do one\n\nbody\n'
  it('a chapter added without its Read when line warns; with it, or in a plain book, nothing', () => {
    const add = (before: string | null, after: string) => lib.chaptersWithoutReadWhen([{ path: 'library/fund/craft/a.md', before, after }])
    expect(add(chaptered, chaptered + '\n## Two\n\nbody only\n')).toEqual([{ book: 'library/fund/craft/a.md', heading: 'Two' }])
    expect(add(chaptered, chaptered + '\n## Two\nRead when: about to do two\n\nbody\n')).toEqual([])
    expect(add('# Book\n\n## One\n\nplain\n', '# Book\n\n## One\n\nplain\n\n## Two\n\nplain\n')).toEqual([])   // a plain book asks nothing
    expect(add(chaptered, chaptered.replace('body', 'edited'))).toEqual([])   // an edit to a chapter that was there is not an added one
    expect(lib.chaptersWithoutReadWhen([{ path: 'library/fund/craft/_series.md', before: null, after: '## A\n' }, { path: 'lab/x.md', before: null, after: chaptered + '## B\n' }])).toEqual([])
  })
  it('is a warning: the verdict stays ok', () => {
    const chapters = [{ book: 'library/s/a.md', heading: 'Two' }]
    const v = lib.verdict({ agentId: 'fund', agent: { writes: ['library/'] }, fundPaths: ['library/s/a.md'], secrets: [], outsideFund: false, chapters })
    expect(v.ok).toBe(true)
    expect(v.warnings.join('\n')).toMatch(/chapter "Two" of library\/s\/a\.md has no Read when: line/)
    expect(v.warnings[0]).toMatch(/warning only, not a block/)
  })
})

describe('verdict', () => {
  const agent = { writes: ['app/'] }
  it('any agent may commit a board item; the rest of app/board/ keeps its scope', () => {
    const research = { writes: ['platform/research/'] }
    const v = (...fundPaths: string[]) => lib.verdict({ agentId: 'research', agent: research, fundPaths, secrets: [], outsideFund: false })
    expect(v('app/board/B-0388.md', 'platform/research/x.md').ok).toBe(true)
    for (const p of ['app/board/config.json', 'app/board/done/B-0001.md', 'app/board/notes/B-0388.md', 'app/board/B-0388.md.bak', 'app/agents/app.md']) {
      const r = v('app/board/B-0388.md', p)
      expect(r.ok, p).toBe(false)
      expect(r.errors.join('\n')).toContain(p)
    }
  })
  it('owner (no agent): only secrets block', () => {
    expect(lib.verdict({ agentId: null, agent: null, fundPaths: ['platform/api/execution/x.py', 'agents.json'], secrets: [], outsideFund: false }).ok).toBe(true)
    expect(lib.verdict({ agentId: null, agent: null, fundPaths: ['.env'], secrets: [{ path: '.env', line: null, why: 'env file' }], outsideFund: false }).ok).toBe(false)
  })
  it('agent: scope, the api/execution shim and unknown agents block', () => {
    expect(lib.verdict({ agentId: 'app', agent, fundPaths: ['app/a.ts'], secrets: [], outsideFund: false }).ok).toBe(true)
    const v = lib.verdict({ agentId: 'app', agent, fundPaths: ['app/a.ts', 'repos.json'], secrets: [], outsideFund: false })
    expect(v.ok).toBe(false)
    expect(v.errors.join('\n')).toMatch(/repos\.json/)
    const ex = lib.verdict({ agentId: 'p', agent: { writes: ['platform/'] }, fundPaths: ['platform/api/execution/oms.py'], secrets: [], outsideFund: false })
    expect(ex.ok).toBe(false)
    expect(ex.errors[0]).toMatch(/execution is guarded/)
    // B-0427: the execution repo follows writes like any other. An agent whose writes name it commits there ...
    const ex2 = lib.verdict({ agentId: 'execution', agent: { writes: ['execution/'] }, fundPaths: ['execution/fundexec/oms.py'], secrets: [], outsideFund: false })
    expect(ex2.ok).toBe(true)
    // ... an agent whose writes do not is refused as out of scope, not as "guarded" ...
    const ex3 = lib.verdict({ agentId: 'fund', agent: { writes: ['library/'] }, fundPaths: ['execution/fundexec/oms.py'], secrets: [], outsideFund: false })
    expect(ex3.ok).toBe(false)
    expect(ex3.errors.join('\n')).toMatch(/outside fund's writes \(library\/\):\n  execution\/fundexec\/oms\.py/)
    expect(ex3.errors.join('\n')).not.toMatch(/guarded/)
    // ... even the execution agent cannot take the old shim with it, nor secrets
    const ex4 = lib.verdict({ agentId: 'execution', agent: { writes: ['execution/', 'platform/'] }, fundPaths: ['execution/fundexec/oms.py', 'platform/api/execution/oms.py'], secrets: [], outsideFund: false })
    expect(ex4.ok).toBe(false)
    expect(ex4.errors.join('\n')).toMatch(/execution is guarded; only the owner commits there:\n  platform\/api\/execution\/oms\.py/)
    expect(ex4.errors.join('\n')).not.toMatch(/fundexec/)
    const ex5 = lib.verdict({ agentId: 'execution', agent: { writes: ['execution/'] }, fundPaths: ['execution/.env'], secrets: [{ path: 'execution/.env', line: null, why: 'env file' }], outsideFund: false })
    expect(ex5.ok).toBe(false)
    expect(lib.verdict({ agentId: 'ghost', agent: null, fundPaths: ['a'], secrets: [], outsideFund: false }).ok).toBe(false)
    expect(lib.verdict({ agentId: 'app', agent, fundPaths: ['a'], secrets: [], outsideFund: true }).ok).toBe(false)
  })
  it('trailers: only missing ones, only for set vars', () => {
    expect(lib.missingTrailers('s\n\nAgent: app', { FUND_AGENT: 'app', FUND_CONVERSATION: 'c1' })).toEqual([['Conversation', 'c1']])
    expect(lib.missingTrailers('s', {})).toEqual([])
  })
})

// ---- the real hooks, against throwaway repos: a fake fund root with a sub-repo inside it ----

let root = ''
let sub = ''
let exe = ''
const baseEnv = (): Record<string, string> => {
  const e: Record<string, string> = { ...process.env as Record<string, string>, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
  delete e.FUND_AGENT; delete e.FUND_CONVERSATION
  return { ...e, FUND_ROOT: root }
}
const g = (cwd: string, args: string[], env = baseEnv()) => spawnSync('git', args, { cwd, env, encoding: 'utf8' })

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'root'], { cwd: dir })
}

function commit(dir: string, files: Record<string, string>, env: Record<string, string>, msg = 'change') {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), c)
    execFileSync('git', ['add', '--', p], { cwd: dir })
  }
  const r = g(dir, ['commit', '-q', '-m', msg], env)
  if (r.status !== 0) execFileSync('git', ['reset', '-q'], { cwd: dir }) // unstage what was refused
  return r
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'fund-guard-'))
  initRepo(root)
  // the roster: one app/agents/<id>.md per agent, its header the row the guard reads
  const agent = (id: string, writes: string[]) => serializeAgentFile({ id, name: id, kind: 'standing', mode: 'active', dept: 'd', role: 'r', cwd: '.', model: 'm', effort: 'e', writes, boot: [] }, `# ${id}\n`)
  mkdirSync(join(root, 'app', 'agents'), { recursive: true })
  writeFileSync(join(root, 'repos.json'), '{"repos": []}\n')
  writeFileSync(join(root, 'app', 'agents', 'fund.md'), agent('fund', ['repos.json', 'config/', 'library/', 'app/library/', 'CLAUDE.md']))
  writeFileSync(join(root, 'app', 'agents', 'plat.md'), agent('plat', ['repos/plat/']))
  writeFileSync(join(root, 'app', 'agents', 'execution.md'), agent('execution', ['execution/']))
  sub = join(root, 'repos', 'plat')
  initRepo(sub)
  exe = join(root, 'execution')
  initRepo(exe)
  for (const d of [root, sub, exe]) expect((await installGuard(d)).state).toBe('guarded')
}, 60_000)

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

describe('installer', () => {
  it('is idempotent and reads back guarded', async () => {
    const again = await installGuard(sub)
    expect(again).toMatchObject({ state: 'guarded', changed: false })
    expect(execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: sub, encoding: 'utf8' }).trim()).toBe(HOOKS_DIR)
  })
  it('leaves a foreign hooksPath alone', async () => {
    const d = join(root, 'repos', 'other')
    initRepo(d)
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: d })
    expect(await installGuard(d)).toMatchObject({ state: 'foreign', changed: false })
    expect(execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: d, encoding: 'utf8' }).trim()).toBe('.husky')
    const e = join(root, 'repos', 'handhooks')
    initRepo(e)
    writeFileSync(join(e, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n')
    expect(await installGuard(e)).toMatchObject({ state: 'foreign', changed: false })
  })
  it('reports a missing path as unknown', async () => {
    expect((await guardState(join(root, 'nope'))).state).toBe('unknown')
  })
})

describe('hooks in a real commit', { timeout: 30000 }, () => {
  it('commit-msg appends Agent + Conversation for an agent, nothing for the owner', () => {
    const r = commit(sub, { 'a.txt': '1' }, { ...baseEnv(), FUND_AGENT: 'plat', FUND_CONVERSATION: 'c_42' }, 'first\n\nCo-Authored-By: X <x@y>')
    expect(r.status, r.stderr).toBe(0)
    const body = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: sub, encoding: 'utf8' })
    expect(body).toMatch(/^Agent: plat$/m)
    expect(body).toMatch(/^Conversation: c_42$/m)
    expect(body).toMatch(/^Co-Authored-By: X <x@y>$/m)
    const r2 = commit(sub, { 'b.txt': '1' }, { ...baseEnv(), FUND_AGENT: 'plat', FUND_CONVERSATION: 'c_42' }, 'second\n\nAgent: plat')
    expect(r2.status).toBe(0)
    const b2 = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: sub, encoding: 'utf8' })
    expect(b2.match(/^Agent:/gm)).toHaveLength(1)
    commit(sub, { 'c.txt': '1' }, baseEnv(), 'owner')
    expect(execFileSync('git', ['log', '-1', '--format=%B'], { cwd: sub, encoding: 'utf8' })).not.toMatch(/Agent:/)
  })
  it('refuses paths outside the agent writes, fund-relative from a sub-repo', () => {
    const r = commit(root, { 'board/x.md': 'x' }, { ...baseEnv(), FUND_AGENT: 'plat' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/outside plat's writes/)
    expect(r.stderr).toMatch(/board\/x\.md/)
    expect(commit(root, { 'config/y.json': '{}' }, { ...baseEnv(), FUND_AGENT: 'fund' }).status).toBe(0)
    expect(commit(root, { 'board/x.md': 'x' }, baseEnv()).status).toBe(0) // the owner: scope does not apply
  })
  it('refuses api/execution for any agent, allows the owner', () => {
    const r = commit(sub, { 'api/execution/oms.py': 'pass\n' }, { ...baseEnv(), FUND_AGENT: 'plat' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/execution is guarded/)
    expect(commit(sub, { 'api/execution/oms.py': 'pass\n' }, baseEnv()).status).toBe(0)
  })
  it('the execution repo follows writes: its own agent commits, another agent is out of scope, secrets still block (B-0427)', () => {
    const own = commit(exe, { 'fundexec/x.py': 'pass\n' }, { ...baseEnv(), FUND_AGENT: 'execution' })
    expect(own.status, own.stderr).toBe(0)
    const other = commit(exe, { 'fundexec/y.py': 'pass\n' }, { ...baseEnv(), FUND_AGENT: 'fund' })
    expect(other.status).not.toBe(0)
    expect(other.stderr).toMatch(/outside fund's writes/)
    expect(other.stderr).toMatch(/execution\/fundexec\/y\.py/)
    expect(other.stderr).not.toMatch(/execution is guarded/)
    const key = commit(exe, { 'fundexec/cfg.py': `KEY = "${AWS}"\n` }, { ...baseEnv(), FUND_AGENT: 'execution' })
    expect(key.status).not.toBe(0)
    expect(key.stderr).toMatch(/cfg\.py:1 +\(aws access key id\)/)
    expect(commit(exe, { 'fundexec/y.py': 'pass\n' }, baseEnv()).status).toBe(0) // the owner still commits
  })
  it('refuses secrets for everyone', () => {
    const a = commit(sub, { 'cfg.py': `KEY = "${AWS}"\n` }, baseEnv())
    expect(a.status).not.toBe(0)
    expect(a.stderr).toMatch(/cfg\.py:1 +\(aws access key id\)/)
    const b = commit(sub, { '.env': 'X=1\n' }, { ...baseEnv(), FUND_AGENT: 'plat' })
    expect(b.status).not.toBe(0)
    expect(b.stderr).toMatch(/\.env +\(env file\)/)
  })
  it('refuses an agent a line with a control character, and lets the same file through clean', () => {
    const r = commit(sub, { 'fig.ts': `const re = /^output${BS}/i\n` }, { ...baseEnv(), FUND_AGENT: 'plat' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/fig\.ts:1 +\(control character U\+0008 \(backspace\) at column 20\)/)
    expect(commit(sub, { 'fig.ts': 'const re = /^output\\b/i\n' }, { ...baseEnv(), FUND_AGENT: 'plat' }).status).toBe(0)
  })
  it('never refuses DELETING a committed env file', () => {
    writeFileSync(join(sub, '.env'), 'X=1\n')
    execFileSync('git', ['add', '--', '.env'], { cwd: sub })
    expect(g(sub, ['commit', '-q', '--no-verify', '-m', 'leak']).status).toBe(0) // the leak, past the hook
    execFileSync('git', ['rm', '-q', '--', '.env'], { cwd: sub })
    const r = g(sub, ['commit', '-q', '-m', 'remove the leak'], baseEnv())
    expect(r.stderr).not.toMatch(/env file/)
    expect(r.status).toBe(0)
  })
  it('warns (does not block) a chapter added without its Read when line (B-0347)', () => {
    const env = { ...baseEnv(), FUND_AGENT: 'fund' }
    const first = '# b\n\n## One\nRead when: about to do one\n\nx\n'
    const r = commit(root, { 'library/s/book.md': first }, env)
    expect(r.status).toBe(0)
    expect(r.stderr).not.toMatch(/Read when/)   // no _series.md row is asked of a new book any more
    const r2 = commit(root, { 'library/s/book.md': first + '\n## Two\n\ny\n' }, env)
    expect(r2.status).toBe(0)
    expect(r2.stderr).toMatch(/chapter "Two" of library\/s\/book\.md has no Read when: line \(.*warning only, not a block\)/)
    const r3 = commit(root, { 'library/s/book.md': first + '\n## Two\n\ny\n\n## Three\nRead when: about to do three\n\nz\n' }, env)
    expect(r3.status).toBe(0)
    expect(r3.stderr).not.toMatch(/chapter "Three"/)
    // a sub-repo home (app/library/<shelf>/...) is held to the same law
    const r4 = commit(root, { 'app/library/law/s/book.md': first + '\n## Two\n\ny\n' }, env)
    expect(r4.status).toBe(0)
    expect(r4.stderr).toMatch(/chapter "Two" of app\/library\/law\/s\/book\.md/)
  })
  it('an unknown agent is refused (fail closed)', () => {
    const r = commit(sub, { 'z.txt': '1' }, { ...baseEnv(), FUND_AGENT: 'ghost' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/not in the roster \(app\/agents\/\)/)
    expect(readFileSync(join(sub, 'z.txt'), 'utf8')).toBe('1')
  })
})

// ---- the book shrink warning (guard-lib), the hook that prints it, and the indexer that reads it back ----

const book = (n: number, heads: string[] = []) => [...heads.map(h => `## ${h}`), ...Array.from({ length: n - heads.length }, (_, i) => `line ${i}`)].join('\n') + '\n'

describe('bookShrink', () => {
  it('the line threshold: 29% lost passes, 31% lost is flagged', () => {
    expect(lib.bookShrink(book(100), book(71))).toMatchObject({ linesPct: -29, flagged: false })
    expect(lib.bookShrink(book(100), book(69))).toMatchObject({ linesPct: -31, flagged: true })
    expect(lib.bookShrink(book(100), book(70)).flagged).toBe(false) // exactly 30% is not "more than"
  })
  it('a deleted book is -100%, a new book is never flagged', () => {
    expect(lib.bookShrink(book(10, ['A']), null)).toMatchObject({ linesPct: -100, deleted: true, flagged: true, lostHeadings: ['A'] })
    expect(lib.bookShrink(null, book(10))).toMatchObject({ flagged: false, added: true })
    expect(lib.bookShrink(undefined, '')).toMatchObject({ flagged: false })
  })
  it('heading loss with the line count unchanged', () => {
    const before = book(20, ['One', 'Two', 'Three'])
    const after = before.replace('## Two', 'plain line')
    const s = lib.bookShrink(before, after)
    expect(s.linesPct).toBe(0)
    expect(s.lostHeadings).toEqual(['Two'])
    expect(s.sectionsPct).toBe(-33)
    expect(s.flagged).toBe(true)
    // a reworded heading is a rename, not a loss
    expect(lib.bookShrink(book(20, ['A', 'B', 'C', 'D']), book(20, ['A', 'B', 'C', 'E'])).flagged).toBe(false)
  })
  it('any lost ## heading is flagged, not only a 30% loss (B-0347: a heading is a learning)', () => {
    const heads = ['Alpha one', 'Bravo two', 'Charlie three', 'Delta four', 'Echo five', 'Foxtrot six', 'Golf seven', 'Hotel eight', 'India nine', 'Juliet ten']
    const before = book(40, heads)
    const after = before.replace('## Echo five', 'plain line')
    const s = lib.bookShrink(before, after)
    expect(s).toMatchObject({ linesPct: 0, sectionsPct: -10, lostHeadings: ['Echo five'], flagged: true })
    expect(lib.shrinkWarnings(lib.shrinkReport([{ path: 'library/s/a.md', before, after }], 'edit'))[0]).toMatch(/lost: ## Echo five/)
    expect(lib.bookShrink(before, before.replace('## Echo five', '## Echo five and more')).flagged).toBe(false)
  })
  it('only ## counts: ### and fenced code are not sections', () => {
    expect(lib.headings('## A\n### B\n```\n## C\n```\n## D ##\n')).toEqual(['A', 'D'])
  })
  it('the Consolidation trailer marks the report ok and silences the warning lines', () => {
    const pairs = [{ path: 'library/s/a.md', before: book(100, ['X', 'Y']), after: book(10, ['X']) }, { path: 'library/s/new.md', before: null, after: 'x' }]
    const bare = lib.shrinkReport(pairs, 'trim\n\nAgent: fund')
    expect(bare).toMatchObject({ ok: false, worst: -90, reason: null })
    expect(bare.files.map((f: { path: string }) => f.path)).toEqual(['library/s/a.md'])
    expect(lib.shrinkWarnings(bare).join('\n')).toMatch(/library\/s\/a\.md shrank \(-90% lines, -50% sections\); lost: ## Y/)
    const declared = lib.shrinkReport(pairs, 'trim\n\nConsolidation: merged into b.md\nAgent: fund')
    expect(declared).toMatchObject({ ok: true, reason: 'merged into b.md', worst: -90 })
    expect(lib.shrinkWarnings(declared)).toEqual([])
  })
  it('name-status -z, renames included', () => {
    expect(lib.parseNameStatusZ('M\0library/a.md\0R087\0library/b.md\0library/c.md\0D\0x.md\0')).toEqual([
      { status: 'M', from: 'library/a.md', to: 'library/a.md' },
      { status: 'R', from: 'library/b.md', to: 'library/c.md' },
      { status: 'D', from: 'x.md', to: 'x.md' },
    ])
    expect(lib.isLibraryBook('library/s/_series.md')).toBe(true)
    expect(lib.isLibraryBook('app/library/x.md')).toBe(true)
    expect(lib.isLibraryBook('lab/x.md')).toBe(false)
  })
})

describe('shrink in a real commit', { timeout: 30000 }, () => {
  const env = () => ({ ...baseEnv(), FUND_AGENT: 'fund' })
  it('warns on stderr and still commits; a Consolidation trailer silences it; a new book is quiet', () => {
    expect(commit(root, { 'library/sh/big.md': book(100, ['A', 'B']), 'library/sh/_series.md': '| big |\n' }, env(), 'add big').stderr).not.toMatch(/shrank/)
    const r = commit(root, { 'library/sh/big.md': book(40, ['A']), 'library/sh/_series.md': '| big | x |\n' }, env(), 'cut big')
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/fund guard: book library\/sh\/big\.md shrank \(-60% lines, -50% sections\); lost: ## B/)
    expect(r.stderr).toMatch(/Consolidation: <reason>/)
    const q = commit(root, { 'library/sh/big.md': book(10, ['A']), 'library/sh/_series.md': '| big | y |\n' }, env(), 'cut again\n\nConsolidation: folded into another book')
    expect(q.status).toBe(0)
    expect(q.stderr).not.toMatch(/shrank/)
  })
  it('a deleted book warns -100% and is not blocked', () => {
    commit(root, { 'library/sh/gone.md': book(12, ['G']), 'library/sh/_series.md': '| gone |\n' }, env(), 'add gone')
    execFileSync('git', ['rm', '-q', '--', 'library/sh/gone.md'], { cwd: root })
    const r = g(root, ['commit', '-q', '-m', 'drop gone'], env())
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/library\/sh\/gone\.md shrank \(deleted\); lost: ## G/)
  })
})

describe('shrink indexer', { timeout: 30000 }, () => {
  it('reads sha^:path vs sha:path through the same helper', async () => {
    const { commitShrink } = await import('../server/git/shrink.ts')
    const sha = (ref: string) => execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim()
    const msg = (ref: string) => execFileSync('git', ['log', '-1', '--format=%B', ref], { cwd: root, encoding: 'utf8' })
    // HEAD = drop gone, HEAD~1 = add gone, HEAD~2 = cut again (declared), HEAD~3 = cut big, HEAD~4 = add big
    const drop = await commitShrink(root, sha('HEAD'), msg('HEAD'))
    expect(drop).toMatchObject({ ok: false, worst: -100, files: [{ path: 'library/sh/gone.md', deleted: true, lostHeadings: ['G'] }] })
    expect(await commitShrink(root, sha('HEAD~1'), msg('HEAD~1'))).toMatchObject({ files: [], worst: null })
    expect(await commitShrink(root, sha('HEAD~2'), msg('HEAD~2'))).toMatchObject({ ok: true, reason: 'folded into another book', worst: -75 })
    expect(await commitShrink(root, sha('HEAD~3'), msg('HEAD~3'))).toMatchObject({ ok: false, worst: -60, files: [{ path: 'library/sh/big.md', linesPct: -60, sectionsPct: -50, lostHeadings: ['B'] }] })
    expect(await commitShrink(root, sha('HEAD~4'), msg('HEAD~4'))).toMatchObject({ files: [] })
    // a commit touching no book: null
    commit(root, { 'config/z.json': '{}' }, { ...baseEnv(), FUND_AGENT: 'fund' }, 'config only')
    expect(await commitShrink(root, sha('HEAD'), msg('HEAD'))).toBeNull()
  })
})

// ---- book topics: a shelf's closed list (its top _series.md), 1 to 3 per book (shared/bookmeta.ts) ----

const TOPIC_INDEX = '---\ntitle: P - the shelf\ntopics:\n  data: data I/O, the row contract\n  engines: the backtest engines\n  quant: the math\n---\n\n# P\n'
const withTopics = (t: string) => `---\ntitle: B\ntopics: ${t}\n---\n\n# B\n`

describe('book topics (guard-lib)', () => {
  const indexes = (text: string | null) => (p: string) => (p === 'app/library/pl/_series.md' ? text : null)
  const check = (path: string, text: string, index: string | null = TOPIC_INDEX) => lib.topicFindings([{ path, text }], indexes(index))
  it('a book carrying 1 to 3 of its shelf\'s topics passes', () => {
    expect(check('app/library/pl/carry/x.md', withTopics('[engines]'))).toEqual([])
    expect(check('app/library/pl/carry/x.md', withTopics('[data, engines, quant]'))).toEqual([])
    expect(check('app/library/pl/x.md', '---\ntopics:\n  - data\n---\n# x\n')).toEqual([])
  })
  it('no topics: named, with the shelf\'s list', () => {
    expect(check('app/library/pl/carry/x.md', '# no frontmatter\n')).toEqual([{ path: 'app/library/pl/carry/x.md', why: "no topics (this shelf's: data, engines, quant); set topics: [...] in its frontmatter" }])
    expect(check('app/library/pl/carry/x.md', withTopics('[]'))[0].why).toMatch(/^no topics/)
  })
  it('a topic off the list: named, with the list', () => {
    expect(check('app/library/pl/carry/x.md', withTopics('[enignes]'))).toEqual([{ path: 'app/library/pl/carry/x.md', why: 'topic "enignes" not on this shelf (data, engines, quant); set topics: [...] in its frontmatter' }])
    expect(check('app/library/pl/carry/x.md', withTopics('[data, a, b]'))[0].why).toMatch(/^topics "a", "b" not on this shelf/)
  })
  it('type: guide or strategy passes; anything else is named (B-0345), on a shelf that names topics or not', () => {
    const typed = (t: string) => `---\ntopics: [engines]\ntype: ${t}\n---\n\n# B\n`
    for (const t of ['guide', 'strategy']) expect(check('app/library/pl/x.md', typed(t)), t).toEqual([])
    expect(check('app/library/pl/x.md', withTopics('[engines]'))).toEqual([])   // no type: line is fine
    expect(check('app/library/pl/x.md', typed('essay'))).toEqual([{ path: 'app/library/pl/x.md', why: 'type "essay" is not one of guide, strategy; set type: guide or strategy in its frontmatter (or drop the line)' }])
    expect(check('app/library/pl/x.md', '---\ntype: essay\n---\n# x\n', '---\ntitle: P\n---\n# P\n').map((f: { why: string }) => f.why)).toEqual([expect.stringMatching(/^type "essay"/)])
    expect(check('app/library/pl/_series.md', '---\ntype: essay\n---\n')).toEqual([])   // an index is not a book
    const v = lib.verdict({ agentId: 'app', agent: { writes: ['app/'] }, fundPaths: ['app/library/pl/x.md', 'app/library/pl/_series.md'], secrets: [], outsideFund: false, topics: check('app/library/pl/x.md', typed('essay')) })
    expect(v.ok).toBe(false)
    expect(v.errors.join('\n')).toMatch(/type "essay" is not one of/)
  })
  it('4 topics is one too many', () => {
    expect(check('app/library/pl/x.md', withTopics('[data, engines, quant, data]'))[0].why).toMatch(/^4 topics \(at most 3\); set topics/)
  })
  it('a shelf whose index names no list asks nothing of its books', () => {
    expect(check('app/library/pl/x.md', '# x\n', '---\ntitle: P\n---\n# P\n')).toEqual([])
    expect(check('app/library/pl/x.md', '# x\n', null)).toEqual([])
    expect(check('app/library/pl/x.md', '# x\n', '---\ntopics:\n---\n')).toEqual([])   // names none: the index's fault, not the book's
  })
  it('not books: series indexes, README / CLAUDE.md, a loose file at app/library\'s top, anything off a shelf', () => {
    for (const p of ['app/library/pl/carry/_series.md', 'app/library/pl/README.md', 'app/library/pl/CLAUDE.md', 'app/library/shelf.md', 'app/board/B-0001.md', 'platform/feeds/acme/snapshots/x.md', 'library/pl/x.md']) {
      expect(check(p, '# x\n'), p).toEqual([])
    }
  })
  it('a staged top index must name a sound list', () => {
    const f = check('app/library/pl/_series.md', '---\ntopics:\n  Bad: x\n  pl: the shelf again\n---\n')
    expect(f.map((x: { why: string }) => x.why)).toEqual([
      'topics list: "Bad" is not a topic id (a-z, 0-9, -); fix the topics: map in its frontmatter',
      'topics list: "pl" repeats the shelf\'s own name; fix the topics: map in its frontmatter',
    ])
    expect(check('app/library/pl/_series.md', TOPIC_INDEX)).toEqual([])
    expect(check('app/library/pl/_series.md', '---\ntopics:\n---\n')[0].why).toMatch(/names none/)
  })
  it('verdict: an agent is blocked, the owner is warned; neither is told to unstage', () => {
    const topics = [{ path: 'app/library/pl/x.md', why: 'topic "enignes" not on this shelf (data); set topics: [...] in its frontmatter' }]
    const a = lib.verdict({ agentId: 'app', agent: { writes: ['app/'] }, fundPaths: ['app/library/pl/x.md', 'app/library/pl/_series.md'], secrets: [], outsideFund: false, topics })
    expect(a.ok).toBe(false)
    expect(a.unstage).toBe(false)
    expect(a.errors.join('\n')).toMatch(/app\/library\/pl\/x\.md: topic "enignes" not on this shelf/)
    const o = lib.verdict({ agentId: null, agent: null, fundPaths: ['app/library/pl/x.md', 'app/library/pl/_series.md'], secrets: [], outsideFund: false, topics })
    expect(o.ok).toBe(true)
    expect(o.warnings).toEqual(['app/library/pl/x.md: topic "enignes" not on this shelf (data); set topics: [...] in its frontmatter (the owner: a warning, not a block)'])
  })
})

describe('book topics in a real commit', { timeout: 30000 }, () => {
  const fund = () => ({ ...baseEnv(), FUND_AGENT: 'fund' })
  it('an agent is refused a book off its shelf\'s list; the owner is warned and commits; a good book lands', () => {
    expect(commit(root, { 'app/library/tp/_series.md': TOPIC_INDEX }, fund(), 'the list').status).toBe(0)
    const files = { 'app/library/tp/s/x.md': withTopics('[enignes]'), 'app/library/tp/s/_series.md': '| x |\n' }
    const bad = commit(root, files, fund(), 'bad')
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toMatch(/app\/library\/tp\/s\/x\.md: topic "enignes" not on this shelf \(data, engines, quant\); set topics: \[\.\.\.\] in its frontmatter/)
    expect(bad.stderr).not.toMatch(/unstage the paths above/)
    const owner = commit(root, files, baseEnv(), 'owner')
    expect(owner.status, owner.stderr).toBe(0)
    expect(owner.stderr).toMatch(/fund guard: app\/library\/tp\/s\/x\.md: topic "enignes" not on this shelf .*\(the owner: a warning, not a block\)/)
    const good = commit(root, { 'app/library/tp/s/y.md': withTopics('[data, quant]'), 'app/library/tp/s/_series.md': '| x |\n| y |\n' }, fund(), 'good')
    expect(good.status, good.stderr).toBe(0)
    expect(good.stderr).not.toMatch(/topic/)
  })
  it('the list staged in the same commit binds its books; a shelf with no list asks nothing', () => {
    const r = commit(root, { 'app/library/tq/_series.md': TOPIC_INDEX, 'app/library/tq/s/a.md': '# a\n', 'app/library/tq/s/_series.md': '| a |\n' }, fund(), 'x')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/app\/library\/tq\/s\/a\.md: no topics \(this shelf's: data, engines, quant\)/)
    const n = commit(root, { 'app/library/tn/_series.md': '---\ntitle: N\n---\n', 'app/library/tn/s/a.md': '# a\n', 'app/library/tn/s/_series.md': '| a |\n' }, fund(), 'no list')
    expect(n.status, n.stderr).toBe(0)
    expect(n.stderr).not.toMatch(/topic/)
  })
})
