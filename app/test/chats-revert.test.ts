import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// REVERT CONVERSATION end to end on a throwaway repo: the config's repo list is pointed at it, so
// the real changes() / fileDiff() / revertConversation() run real git. New commits, never a reset.

const t = vi.hoisted(() => ({ dir: '' }))
vi.mock('../server/config.ts', () => ({ config: { repos: () => [{ id: 'tmp', path: t.dir }] } }))
const { changes, fileDiff, revertConversation } = await import('../server/chat/changes.ts')

const noHooks = mkdtempSync(join(tmpdir(), 'chats-nohooks-'))
const g = (...args: string[]) => execFileSync('git', ['-c', `core.hooksPath=${noHooks}`, ...args], { cwd: t.dir, encoding: 'utf8' })

beforeAll(() => {
  t.dir = mkdtempSync(join(tmpdir(), 'chats-revert-'))
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', 't'); g('config', 'user.email', 't@t'); g('config', 'commit.gpgsign', 'false'); g('config', 'core.autocrlf', 'false')
  writeFileSync(join(t.dir, 'a.md'), 'base\n'); g('add', 'a.md'); g('commit', '-q', '-m', 'base')
  writeFileSync(join(t.dir, 'a.md'), 'base\none\n'); g('add', 'a.md'); g('commit', '-q', '-m', 'one\n\nConversation: c-r')
  writeFileSync(join(t.dir, 'b.md'), 'bee\n'); g('add', 'b.md'); g('commit', '-q', '-m', 'two\n\nConversation: c-r')
  writeFileSync(join(t.dir, 'c.md'), 'someone else\n'); g('add', 'c.md'); g('commit', '-q', '-m', 'other')
  writeFileSync(join(t.dir, 'w.md'), 'draft\nx\n')
})
afterAll(() => { rmSync(t.dir, { recursive: true, force: true }); rmSync(noHooks, { recursive: true, force: true }) })

describe('a conversation\'s changes on a real repo', () => {
  it('lists its commits and the working tree', async () => {
    const ch = await changes('c-r', t.dir)
    expect(ch.commits.map(c => c.subject).sort()).toEqual(['one', 'two'])
    expect(ch.working.repo).toBe('tmp')
    expect(ch.working.files).toEqual([{ path: 'w.md', xy: '??', add: 2, del: 0 }])
    expect(ch.errors).toEqual([])
  })
  it('serves a commit file diff and a working file diff', async () => {
    const ch = await changes('c-r', t.dir)
    const one = ch.commits.find(c => c.subject === 'one')!
    expect((await fileDiff('c-r', t.dir, { repo: 'tmp', path: 'a.md', sha: one.sha })).patch).toContain('+one')
    expect((await fileDiff('c-r', t.dir, { repo: 'tmp', path: 'w.md' })).patch).toContain('+draft')
  })
  it('refuses a stale confirmation', async () => {
    await expect(revertConversation('c-r', t.dir, ['f'.repeat(40)])).rejects.toThrow(/changed since/)
  })
  it('reverts newest first as new commits, leaves the rest of history alone', async () => {
    const before = g('rev-list', '--count', 'HEAD').trim()
    const ch = await changes('c-r', t.dir)
    const res = await revertConversation('c-r', t.dir, ch.commits.map(c => c.sha))
    expect(res).toHaveLength(1)
    expect(res[0].error).toBeUndefined()
    expect(res[0].reverted.map(r => r.subject)).toEqual(['two', 'one'])
    expect(Number(g('rev-list', '--count', 'HEAD'))).toBe(Number(before) + 2)
    expect(readFileSync(join(t.dir, 'a.md'), 'utf8')).toBe('base\n')
    expect(readFileSync(join(t.dir, 'c.md'), 'utf8')).toBe('someone else\n')
    const after = await changes('c-r', t.dir)
    expect(after.commits.every(c => c.reverted)).toBe(true)
    await expect(revertConversation('c-r', t.dir)).rejects.toThrow(/nothing to revert/)
  })
})
