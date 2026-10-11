import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ACTIVITY_FORMAT, agentKey, bucket, dayKey, dayRange, lastDays, parseActivity, repoActivity } from '../server/git/activity.ts'

const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()

describe('activity days', () => {
  it('dayKey is the LOCAL day', () => {
    expect(dayKey(local(2026, 9, 3, 0))).toBe('2026-09-03')
    expect(dayKey(local(2026, 9, 3, 23))).toBe('2026-09-03')
  })
  it('dayRange is inclusive, oldest first, capped to the LAST days', () => {
    expect(dayRange('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'])
    expect(dayRange('2026-09-01', '2026-09-30', 3)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30'])
    expect(dayRange('2026-09-05', '2026-09-05')).toEqual(['2026-09-05'])
  })
  it('dayRange refuses a bad or reversed range with nothing, never a guess', () => {
    expect(dayRange('2026-09-05', '2026-09-04')).toEqual([])
    expect(dayRange('2026-02-30', '2026-03-02')).toEqual([])
  })
  it('lastDays ends today', () => {
    const d = lastDays(3, local(2026, 3, 1))
    expect(d).toEqual(['2026-02-27', '2026-02-28', '2026-03-01'])
  })
})

describe('activity parse + bucket', () => {
  it('the agent is the first word of the first Agent trailer; none is "-"', () => {
    expect(agentKey('fund (fixer round 1), app')).toBe('fund')
    expect(agentKey('dash:carry')).toBe('dash:carry')
    expect(agentKey('')).toBe('-')
    expect(agentKey(null)).toBe('-')
  })
  it('parses records, skipping junk', () => {
    const out = '\x1e1790000000\x1fapp\n\x1e1790000100\x1f\n\x1ejunk\x1fx\n'
    expect(parseActivity(out)).toEqual([{ ts: 1790000000000, agent: 'app' }, { ts: 1790000100000, agent: '-' }])
  })
  it('buckets per day and per agent; a commit outside the days is left out', () => {
    const days = ['2026-09-24', '2026-09-25', '2026-09-26']
    const a = bucket([
      { ts: local(2026, 9, 24), agent: 'app' }, { ts: local(2026, 9, 26, 1), agent: 'app' },
      { ts: local(2026, 9, 26, 22), agent: 'fund' }, { ts: local(2026, 9, 20), agent: 'fund' },
    ], days)
    expect(a.total).toEqual([1, 0, 2])
    expect(a.agents).toEqual({ app: [1, 0, 1], fund: [0, 0, 1] })
  })
})

describe('repoActivity on a real repo', () => {
  let dir = ''
  const g = (args: string[], env: Record<string, string> = {}) => execFileSync('git', args, { cwd: dir, env: { ...process.env, ...env }, stdio: 'pipe' }).toString()
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-activity-'))
    g(['init', '-q'])
    g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']); g(['config', 'commit.gpgsign', 'false'])
    const commit = (n: number, when: number, msg: string) => {
      writeFileSync(join(dir, `f${n}.txt`), String(n))
      g(['add', `f${n}.txt`])
      const iso = new Date(when).toISOString()
      g(['commit', '-q', '-m', msg], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso })
    }
    // committer dates in order: git's --since walk stops at the first commit older than the range
    commit(0, local(2026, 9, 10, 11), 'old\n\nAgent: app')
    commit(1, local(2026, 9, 24, 10), 'one\n\nAgent: app')
    commit(2, local(2026, 9, 26, 9), 'two\n\nAgent: fund (sweep)')
    commit(3, local(2026, 9, 26, 11), 'three')
  })
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('counts HEAD commits per local day and agent', async () => {
    const a = await repoActivity(dir, ['2026-09-24', '2026-09-25', '2026-09-26'])
    expect(a).toEqual({ total: [1, 0, 2], agents: { app: [1, 0, 0], fund: [0, 0, 1], '-': [0, 0, 1] } })
    expect(ACTIVITY_FORMAT).toContain('trailers:key=Agent')
  })
  it('a directory that is not a repo reads null (cannot tell), never zeros', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'git-activity-none-'))
    try { expect(await repoActivity(bare, ['2026-09-26'])).toBeNull() } finally { rmSync(bare, { recursive: true, force: true }) }
  })
})
