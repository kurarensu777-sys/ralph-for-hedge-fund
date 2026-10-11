import { describe, expect, it } from 'vitest'
import { FILES_WIRE, PAGE_MAX, agentIs, agentOf, filterLog, pageOf, rangeMs, textIs } from '../server/git/logq.ts'
import { agentOfBranch, queueView } from '../server/git/build.ts'
import { landIn } from '../src/rooms/git/Branches.tsx'

// The Git room's log query and land-queue view, pure: the filters run over the whole history in
// scope (not over a page a cap already cut), and a land whose branch is gone says so.

const c = (sha: string, ts: number, agent: string | null, subject = 's', files: string[] = [], body = '') =>
  ({ sha, ts, subject, body, files, trailers: { agent } })
const ROSTER = new Set(['fund', 'app', 'dash:carry'])

describe('the log query', () => {
  it('an agent is the trailer\'s first word; "-" none; "~" a trailer no roster agent answers to', () => {
    expect(agentOf('fund (fixer round 1)')).toBe('fund')
    expect(agentOf('app, fund')).toBe('app')
    expect(agentIs('fund', 'fund (fixer round 1)', ROSTER)).toBe(true)
    expect(agentIs('fund', 'fundplat', ROSTER)).toBe(false)
    expect(agentIs('-', null, ROSTER)).toBe(true)
    expect(agentIs('-', 'fund', ROSTER)).toBe(false)
    expect(agentIs('~', 'ghost', ROSTER)).toBe(true)
    expect(agentIs('~', 'dash:carry', ROSTER)).toBe(false)
    expect(agentIs('', null, ROSTER)).toBe(true)
  })

  it('text: every word, in the subject, the body, a file path or the start of the sha', () => {
    const x = c('abc1234def', 1, 'fund', 'land queue docs', ['server/git/land.ts'], 'why: faster')
    expect(textIs('land QUEUE', x)).toBe(true)
    expect(textIs('faster', x)).toBe(true)
    expect(textIs('git/land.ts', x)).toBe(true)
    expect(textIs('abc12', x)).toBe(true)
    expect(textIs('bc12', x)).toBe(false)   // the sha matches from its start only
    expect(textIs('land nowhere', x)).toBe(false)
    expect(textIs('   ', x)).toBe(true)
  })

  it('a range is whole local days, until inclusive', () => {
    const [from, to] = rangeMs({ since: '2026-09-20', until: '2026-09-21' })
    expect(from).toBe(new Date('2026-09-20T00:00:00').getTime())
    expect(to).toBe(new Date('2026-09-22T00:00:00').getTime())
    expect(rangeMs({ since: '2026-09-20', until: null })[1]).toBe(Infinity)
  })

  it('filters the WHOLE history: an agent\'s old commits are found past any page', () => {
    const all = Array.from({ length: 300 }, (_, i) => c(`s${i}`, 1000 - i, i % 100 === 99 ? 'app' : 'fund'))
    expect(filterLog(all, { agent: 'app', text: '', range: null }, ROSTER).map(x => x.sha)).toEqual(['s99', 's199', 's299'])
  })

  it('a page: offset and limit clamped, file lists cut on the wire with the true count kept', () => {
    const rows = Array.from({ length: 5 }, (_, i) => c(`s${i}`, i, null, 's', Array.from({ length: FILES_WIRE + 3 }, (_, j) => `f${j}`)))
    const p = pageOf(rows, 1, 2)
    expect(p.map(x => x.sha)).toEqual(['s1', 's2'])
    expect(p[0].files).toHaveLength(FILES_WIRE)
    expect(p[0].nfiles).toBe(FILES_WIRE + 3)
    expect(pageOf(rows, -3, 0).map(x => x.sha)).toEqual(['s0', 's1', 's2', 's3', 's4'])   // bad numbers fall back to the defaults
    expect(pageOf(rows, 0, PAGE_MAX * 10)).toHaveLength(5)
  })
})

describe('the land queue view', () => {
  const item = (id: string, branch: string, state: string) => ({ id, repo: 'app', branch, state }) as any

  it('newest first, limited, and a land whose branch has no worktree is gone', () => {
    const items = [item('l1', 'b/app/a', 'red'), item('l2', 'b/app/b', 'blocked'), item('l3', 'b/app/a', 'landed')]
    const v = queueView(items, [{ repo: 'app', branch: 'b/app/b' }], 10)
    expect(v.map(x => [x.id, x.gone])).toEqual([['l3', true], ['l2', false], ['l1', true]])
    expect(queueView(items, [], 2).map(x => x.id)).toEqual(['l3', 'l2'])
  })

  it('the filter: open leaves out landed and gone; gone never claims a landed one', () => {
    expect(landIn('open', { state: 'red', gone: false })).toBe(true)
    expect(landIn('open', { state: 'red', gone: true })).toBe(false)
    expect(landIn('open', { state: 'landed', gone: false })).toBe(false)
    expect(landIn('gone', { state: 'blocked', gone: true })).toBe(true)
    expect(landIn('gone', { state: 'landed', gone: true })).toBe(false)
    expect(landIn('red', { state: 'red', gone: true })).toBe(false)
    expect(landIn('landed', { state: 'landed', gone: true })).toBe(true)
    expect(landIn('all', { state: 'queued', gone: false })).toBe(true)
  })

  it('a branch\'s agent read off its name only when a roster slug matches, never a guess', () => {
    const agents = [{ id: 'dash:carry' }, { id: 'platform' }]
    expect(agentOfBranch('b/dash-carry/w1-x', agents)).toBe('dash:carry')
    expect(agentOfBranch('b/platform/w40-refdata-close', agents)).toBe('platform')
    expect(agentOfBranch('b/nobody/x', agents)).toBeNull()
    expect(agentOfBranch('c1-faster', agents)).toBeNull()
    expect(agentOfBranch(null, agents)).toBeNull()
  })
})
