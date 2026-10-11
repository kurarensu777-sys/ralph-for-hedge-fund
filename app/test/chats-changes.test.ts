import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addedPatch, CONV_FORMAT, lineCount, namesConv, parseConvLog, parseNumstat, revertedShas, revertPlan, safeRel, workingFiles, type ConvCommit } from '../server/chat/changes.ts'

// A CONVERSATION'S CHANGES: the trailer match is exact (a prefix is not a match), the log parse
// reads real git output, reverted/merge commits are left out of a revert plan, paths cannot escape.

describe('trailer matching', () => {
  it('matches the exact id only', () => {
    expect(namesConv('c-abc', 'c-abc')).toBe(true)
    expect(namesConv('c-abc-2', 'c-abc')).toBe(false)
    expect(namesConv('c-x, c-abc', 'c-abc')).toBe(true)
    expect(namesConv(null, 'c-abc')).toBe(false)
  })
})

describe('paths and counts', () => {
  it('refuses escaping paths', () => {
    for (const p of ['../x', '..', 'a/../../x', '/etc/passwd', 'C:/Windows/win.ini', '']) expect(safeRel(p), p).toBeNull()
    expect(safeRel('a/../ok.md')).toBe('ok.md')
    expect(safeRel('board/B-0007.md')).toBe('board/B-0007.md')
  })
  it('numstat handles renames and binaries', () => {
    const m = parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n2\t0\tdir/{old => new}/f.ts\n1\t1\tx.md => y.md\n')
    expect(m.get('src/a.ts')).toEqual({ add: 3, del: 1 })
    expect(m.get('img.png')).toEqual({ add: null, del: null })
    expect(m.get('dir/new/f.ts')).toEqual({ add: 2, del: 0 })
    expect(m.get('y.md')).toEqual({ add: 1, del: 1 })
  })
  it('working files join porcelain with numstat', () => {
    const w = workingFiles(' M src/a.ts\n?? new.md\n', '3\t1\tsrc/a.ts\n')
    expect(w).toEqual([{ path: 'src/a.ts', xy: ' M', add: 3, del: 1 }, { path: 'new.md', xy: '??', add: null, del: null }])
  })
  it('counts lines, null for binary', () => {
    expect(lineCount(Buffer.from('a\nb\n'))).toBe(2)
    expect(lineCount(Buffer.from('a\nb'))).toBe(2)
    expect(lineCount(Buffer.from(''))).toBe(0)
    expect(lineCount(Buffer.from([1, 0, 2]))).toBeNull()
  })
  it('an untracked file renders as an all-added patch', () => {
    expect(addedPatch('n.md', 'x\r\ny\n')).toBe('new file n.md\n@@ -0,0 +1,2 @@\n+x\n+y')
  })
})

const cm = (o: Partial<ConvCommit>): ConvCommit => ({ repo: 'app', sha: 'a'.repeat(40), ts: 0, author: 'x', subject: 's', files: [], merge: false, reverted: false, ...o })

describe('revert plan', () => {
  it('newest first per repo, skips reverted and merges', () => {
    const p = revertPlan([
      cm({ sha: '1'.repeat(40), ts: 1 }), cm({ sha: '2'.repeat(40), ts: 3 }), cm({ sha: '3'.repeat(40), ts: 2, reverted: true }),
      cm({ repo: 'fund', sha: '4'.repeat(40), ts: 5, merge: true }),
    ])
    const app = p.find(x => x.repo === 'app')!
    expect(app.shas.map(c => c.sha[0])).toEqual(['2', '1'])
    expect(app.skipped.map(c => c.sha[0])).toEqual(['3'])
    const fund = p.find(x => x.repo === 'fund')!
    expect(fund.shas).toEqual([])
    expect(fund.skipped).toHaveLength(1)
  })
})

// ---- against real git: the same commands changes.ts runs
let dir = ''
const noHooks = mkdtempSync(join(tmpdir(), 'chats-nohooks-'))
const g = (...args: string[]) => execFileSync('git', ['-c', `core.hooksPath=${noHooks}`, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chats-changes-'))
  g('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.md'), 'one\n'); g('add', 'a.md'); g('commit', '-q', '-m', 'first\n\nConversation: c-me')
  mkdirSync(join(dir, 'd')); writeFileSync(join(dir, 'd', 'b.md'), 'two\n'); g('add', 'd/b.md'); g('commit', '-q', '-m', 'other\n\nConversation: c-me-2')
  writeFileSync(join(dir, 'a.md'), 'one\nmore\n'); g('add', 'a.md'); g('commit', '-q', '-m', 'second\n\nAgent: app\nConversation: c-me')
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }); rmSync(noHooks, { recursive: true, force: true }) })

describe('real git log', () => {
  it('finds exactly this conversation\'s commits with their files', () => {
    const out = g('log', '-F', '--grep=Conversation: c-me', `--format=${CONV_FORMAT}`, '--name-only')
    const found = parseConvLog(out, 'app', 'c-me')
    expect(found.map(c => c.subject)).toEqual(['second', 'first'])   // c-me-2 grep-hits but is not a match
    expect(found[0].files).toEqual(['a.md'])
    expect(found[0].sha).toMatch(/^[0-9a-f]{40}$/)
    expect(found.every(c => !c.merge)).toBe(true)
  })
  it('a git revert marks its commit reverted', () => {
    const out = g('log', '-F', '--grep=Conversation: c-me', `--format=${CONV_FORMAT}`, '--name-only')
    const [second] = parseConvLog(out, 'app', 'c-me')
    g('revert', '--no-edit', second.sha)
    const rv = g('log', '-F', '--grep=This reverts commit', '--format=%b')
    expect(revertedShas(rv).has(second.sha)).toBe(true)
    // the revert commit carries the original message's trailer? it must NOT be counted as the conversation's
    const again = parseConvLog(g('log', '-F', '--grep=Conversation: c-me', `--format=${CONV_FORMAT}`, '--name-only'), 'app', 'c-me')
    expect(again.map(c => c.subject)).toEqual(['second', 'first'])
  })
})
