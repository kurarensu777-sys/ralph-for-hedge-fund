import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { causeLine, parseCounts, parseLog, parsePorcelain, parseTrailers, LOG_FORMAT } from '../server/git/parse.ts'
import { readState, repoReading, repoTone, syncSummary, syncTree } from '../server/git/repo.ts'
import { git, gitEnv } from '../server/git/run.ts'

describe('trailers', () => {
  it('reads the four keys from the last paragraph', () => {
    const t = parseTrailers('did a thing\n\nlong why\n\nAgent: platform\nConversation: c_123\nWhy: the owner asked\nChange-Id: I0abc\nCo-Authored-By: Claude <x@y>')
    expect(t.agent).toBe('platform')
    expect(t.conversation).toBe('c_123')
    expect(t.why).toBe('the owner asked')
    expect(t.changeId).toBe('I0abc')
    expect(Object.keys(t.all)).toContain('Co-Authored-By')
  })
  it('is case-insensitive on keys and folds continuation lines', () => {
    const t = parseTrailers('agent: fund\nwhy: first line\n  second line')
    expect(t.agent).toBe('fund')
    expect(t.why).toBe('first line second line')
  })
  it('refuses a last paragraph that holds prose', () => {
    const t = parseTrailers('body\n\nNote: this is prose\nand this line is not a trailer')
    expect(t.agent).toBeNull()
    expect(t.all).toEqual({})
  })
  it('an empty body has no trailers', () => {
    expect(parseTrailers('').agent).toBeNull()
  })
})

describe('log, porcelain, counts', () => {
  it('parses the log format with files', () => {
    const raw = `\x1eabc123\x1fOwner\x1f1790000000\x1fsubject one\x1fbody\n\nAgent: app\x1f\nfile/a.ts\nfile/b.ts\n\x1edef456\x1fOwner\x1f1790000100\x1fsubject two\x1f\x1f\n`
    const e = parseLog(raw)
    expect(e).toHaveLength(2)
    expect(e[0].sha).toBe('abc123')
    expect(e[0].ts).toBe(1790000000_000)
    expect(e[0].files).toEqual(['file/a.ts', 'file/b.ts'])
    expect(e[0].trailers.agent).toBe('app')
    expect(e[1].files).toEqual([])
    // the git author name is never shown: the role is the Agent: trailer, else the owner as "you"
    expect(e[0].author).toBe('app')
    expect(e[1].author).toBe('you')
    expect(LOG_FORMAT).not.toContain('%an')
    expect(LOG_FORMAT).toContain('%x1e')
  })
  it('counts dirty and unmerged paths', () => {
    const p = parsePorcelain(' M a.ts\n?? new/\nUU both.txt\nAA added.txt\n')
    expect(p.dirty).toBe(4)
    expect(p.conflicts).toBe(2)
    expect(p.files[0]).toEqual({ xy: ' M', path: 'a.ts' })
  })
  it('left is behind, right is ahead', () => {
    expect(parseCounts('3\t1\n')).toEqual({ behind: 3, ahead: 1 })
    expect(parseCounts('fatal: no upstream')).toBeNull()
  })
  it('the cause line prefers CONFLICT, then error/fatal', () => {
    expect(causeLine('Auto-merging f\nCONFLICT (content): Merge conflict in f\nerror: could not apply')).toMatch(/^CONFLICT/)
    expect(causeLine('hint: x\nfatal: no remote')).toBe('fatal: no remote')
  })
  it('tone and reading', () => {
    const base = { branch: 'main', upstream: 'origin/main', dirty: 0, conflicts: 0, midOp: null, ahead: 0, behind: 0, head: null } as const
    expect(repoTone({ ...base })).toBe('ok')
    expect(repoReading({ ...base })).toBe('clean')
    expect(repoTone({ ...base, dirty: 3, ahead: 1 })).toBe('warn')
    expect(repoReading({ ...base, dirty: 3, ahead: 1 })).toBe('3 dirty - 1 ahead')
    expect(repoTone({ ...base, behind: 2 })).toBe('warn')
    expect(repoTone({ ...base, midOp: 'rebase' })).toBe('fail')
    expect(repoReading({ ...base, upstream: null, ahead: null, behind: null })).toBe('local')
  })
})

// ---- the sync law, on throwaway repos: a bare "remote" and two clones ----
describe('sync on temp repos', () => {
  let root = ''
  let A = '', B = '', remote = ''
  const g = async (dir: string, ...args: string[]) => {
    const r = await git(dir, args)
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const commit = async (dir: string, file: string, text: string, msg: string) => {
    writeFileSync(join(dir, file), text)
    await g(dir, 'add', file)
    await g(dir, 'commit', '-q', '-m', msg)
  }
  const ident = async (dir: string) => {
    await g(dir, 'config', 'user.name', 'test')
    await g(dir, 'config', 'user.email', 'test@example.invalid')
    await g(dir, 'config', 'commit.gpgsign', 'false')
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cockpit-git-'))
    remote = join(root, 'remote.git'); A = join(root, 'a'); B = join(root, 'b')
    await g(root, 'init', '-q', '--bare', '-b', 'main', remote)
    await g(root, 'init', '-q', '-b', 'main', A)
    await ident(A)
    await commit(A, 'f.txt', 'one\n', 'first')
    await g(A, 'remote', 'add', 'origin', remote)
    await g(A, 'push', '-q', '-u', 'origin', 'main')
    await g(root, 'clone', '-q', remote, B)
    await ident(B)
  }, 60_000)
  afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* windows lock */ } })

  it('clean and even -> up to date', async () => {
    const r = await syncTree(A)
    expect(r.action).toBe('up to date')
  }, 30_000)

  it('clean and behind -> pull --rebase', async () => {
    await commit(B, 'g.txt', 'from b\n', 'b adds g')
    await g(B, 'push', '-q')
    const r = await syncTree(A)
    expect(r.action).toBe('pulled')
    expect(existsSync(join(A, 'g.txt'))).toBe(true)
    const s = await readState(A)
    expect(s.behind).toBe(0)
  }, 30_000)

  it('clean and ahead -> push', async () => {
    await commit(A, 'h.txt', 'from a\n', 'a adds h')
    const r = await syncTree(A)
    expect(r.action).toBe('pushed')
    expect(await g(B, 'ls-remote', 'origin', 'main')).toContain(await g(A, 'rev-parse', 'HEAD'))
  }, 30_000)

  it('dirty -> never pulled, never pushed', async () => {
    await g(B, 'pull', '-q', '--rebase')
    await commit(B, 'i.txt', 'b again\n', 'b adds i')
    await g(B, 'push', '-q')
    writeFileSync(join(A, 'f.txt'), 'local edit\n')
    const head = await g(A, 'rev-parse', 'HEAD')
    const r = await syncTree(A)
    expect(r.action).toBe('skipped')
    expect(r.note).toBe('dirty, pull skipped')
    expect(await g(A, 'rev-parse', 'HEAD')).toBe(head)
    await g(A, 'checkout', '--', 'f.txt')
    expect((await syncTree(A)).action).toBe('pulled')
  }, 30_000)

  it('a conflicting rebase is aborted and its cause reported', async () => {
    await g(B, 'pull', '-q', '--rebase')
    await commit(B, 'f.txt', 'b wins\n', 'b edits f')
    await g(B, 'push', '-q')
    await commit(A, 'f.txt', 'a wins\n', 'a edits f')
    const head = await g(A, 'rev-parse', 'HEAD')
    const r = await syncTree(A)
    expect(r.action).toBe('failed')
    expect(r.note).toMatch(/CONFLICT/)
    expect(r.note).toMatch(/rebase aborted/)
    const s = await readState(A)
    expect(s.midOp).toBeNull()
    expect(s.dirty).toBe(0)
    expect(await g(A, 'rev-parse', 'HEAD')).toBe(head)
    expect(s.ahead).toBe(1)
    expect(s.behind).toBe(1)
  }, 30_000)

  it('local (no upstream) -> skipped; summary line', async () => {
    const C = join(root, 'c')
    await g(root, 'init', '-q', '-b', 'main', C)
    await ident(C)
    await commit(C, 'x.txt', 'x\n', 'x')
    const r = await syncTree(C)
    expect(r.action).toBe('skipped')
    expect(r.note).toBe('local, nothing to sync')
    const line = syncSummary([{ id: 'a', result: { action: 'pulled', note: '', before: null as any, after: null } }, { id: 'c', result: r }, { id: 'd', result: { action: 'skipped', note: 'dirty, pull skipped', before: null as any, after: null } }])
    expect(line).toBe('3 repos: 1 pulled - dirty: d - c local, nothing to sync')
  }, 30_000)
})

describe('git env', () => {
  it('fundd commits as the owner: the agent and conversation of whoever launched it are dropped', () => {
    const e = gitEnv({ FUND_AGENT: 'app', FUND_CONVERSATION: 'c-1', FUND_ROOT: '/f', PATH: '/bin' })
    expect(e.FUND_AGENT).toBeUndefined()
    expect(e.FUND_CONVERSATION).toBeUndefined()
    expect(e.FUND_ROOT).toBe('/f')
    expect(e.GIT_TERMINAL_PROMPT).toBe('0')
  })
})
