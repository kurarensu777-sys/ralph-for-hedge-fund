import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Shelf } from '../shared/types.ts'
import { DEFAULTS, type LoopConfig, ownerRail, railFor, setAutoApply } from '../server/loop/config.ts'
import { MAX_SENDS, STALE_MS, reviewerOf } from '../server/loop/dispatch.ts'
import { type Ctx, pass, report, revert, send } from '../server/loop/engine.ts'
import { type Proposal, emptyWatch, read, write } from '../server/loop/proposals.ts'
import { db } from '../server/db.ts'
import { resetStore } from './pg/reset.ts'

// The send: what the loop may not write goes to the agent whose writes cover it, who lands it or
// declines it and reports back. On a TEMP git repo and this file's own database; the agent runner
// is a stub that records what it was asked, so no conversation is ever booted.

const T0 = Date.parse('2026-09-10T12:00:00Z')

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: id, kind: 'standing', mode: 'active', dept: 'HQ', role: 'r', cwd: '.', writes: [], model: 'sonnet', effort: 'low', boot: [], ...extra,
})
const AGENTS: Agent[] = [
  agent('fund', { writes: ['app/agents/', 'app/library/'] }),
  agent('app', { writes: ['app/'], dept: 'Build' }),
  agent('dash:a', { kind: 'dashboard', dept: 'Dashboards' }),
  agent('execution', { writes: ['execution/'], mode: 'dormant' }),
]
const SHELVES: Shelf[] = [{ id: 'dashboards', title: 'Dashboards', dept: 'Dashboards', roots: ['app/library/dashboards'] }]

let dir: string
let clockAt = T0
let started: { agent: string; prompt: string; title: string }[] = []

function sh(args: string[]) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }) }

function ctx(cfg: Partial<LoopConfig> = {}, runner = true): Ctx {
  return {
    db, fundRoot: dir, agents: AGENTS, shelves: SHELVES, repos: [{ id: 'fund', path: '.' } as any], config: { ...DEFAULTS, ...cfg }, now: () => clockAt, port: 4999,
    ...(runner ? { startAgent: async (a: string, prompt: string, title: string) => { started.push({ agent: a, prompt, title }); return `conv-${started.length}` } } : {}),
  }
}

/** a boot-compress proposal on a roster file, as rules.ts writes one */
function propose(id: string, target: string[] = ['app/agents/dash-a.md'], kind: Proposal['kind'] = 'boot-compress'): string {
  const iso = new Date(clockAt).toISOString()
  write(dir, {
    id, kind, title: `boot: ${id}`, target, source: ['agent:dash:a'], why: 'over budget', gates: [{ name: 'rails', ok: false, note: 'roster' }],
    state: 'proposed', auto: false, commit: null, revert: null, watch: emptyWatch(['dash:a']), pinned: false, review: null, created: iso, updated: iso,
    body: '## Why\n\nover budget\n',
  })
  return id
}

/** the agent's own commit on a target (what it would land) */
function agentCommit(path = 'app/agents/dash-a.md', text = 'boot: []\n'): string {
  writeFileSync(join(dir, ...path.split('/')), text)
  sh(['add', '--', path]); sh(['commit', '-q', '-m', 'roster: trim dash:a boot'])
  return sh(['rev-parse', 'HEAD']).trim()
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'loop-dispatch-'))
  sh(['init', '-q', '-b', 'main'])
  sh(['config', 'user.email', 'loop@test']); sh(['config', 'user.name', 'loop test'])
  sh(['config', 'core.hooksPath', join(dir, '.nohooks')]); sh(['config', 'core.autocrlf', 'false'])
  mkdirSync(join(dir, 'app', 'agents'), { recursive: true })
  writeFileSync(join(dir, 'app', 'agents', 'dash-a.md'), 'boot: [a.md, b.md]\n')
  writeFileSync(join(dir, 'README.md'), 'temp fund\n')
  sh(['add', '--', '.']); sh(['commit', '-q', '-m', 'init'])
  await resetStore()
  clockAt = T0
  started = []
})

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows file lock */ }
})

describe('who a proposal goes to', () => {
  it('the agent whose writes cover every target; never an owner-only target, a split, or a dormant agent', () => {
    expect(reviewerOf({ target: ['app/agents/dash-a.md'] }, AGENTS)).toEqual({ agent: 'fund', why: null })
    expect(reviewerOf({ target: ['app/server/x.ts'] }, AGENTS)).toEqual({ agent: 'app', why: null })
    expect(reviewerOf({ target: ['app/schedule.json'] }, AGENTS).why).toMatch(/configuration/)
    expect(reviewerOf({ target: ['CLAUDE.md'] }, AGENTS).why).toMatch(/owner only/)
    expect(reviewerOf({ target: ['app/library/law/the-rails.md'] }, AGENTS).why).toMatch(/owner only/)
    expect(reviewerOf({ target: ['platform/api/execution/x.py'] }, AGENTS).why).toMatch(/guarded/)   // the old shim stays refused
    expect(reviewerOf({ target: ['execution/x.py'] }, AGENTS).why).toMatch(/dormant/)   // the roster decides now: execution owns it, and sleeps
    expect(reviewerOf({ target: ['execution/x.py'] }, AGENTS.map(a => (a.id === 'execution' ? { ...a, mode: 'active' as const } : a)))).toEqual({ agent: 'execution', why: null })
    expect(reviewerOf({ target: ['app/agents/x.md', 'app/server/y.ts'] }, AGENTS).why).toMatch(/span fund, app/)
    expect(reviewerOf({ target: [] }, AGENTS).why).toMatch(/no targets/)
  })

  it('the split of the rails leaves railFor exactly as strict as before', () => {
    for (const p of ['app/agents/dash-vol.md', 'app/schedule.json', 'CLAUDE.md', '.claude/settings.json', 'execution/x', 'platform/api/execution/x', 'app/library/law/the-rails.md', '../x']) expect(railFor(p)).not.toBeNull()
    expect(ownerRail('app/agents/dash-vol.md')).toBeNull()   // the roster has an owner on the roster
    expect(ownerRail('execution/x.py')).toBeNull()   // so has execution/ (B-0453); only the old shim is an owner rail
    expect(ownerRail('platform/api/execution/x.py')).toMatch(/guarded/)
    expect(railFor('app/loop/records/proposals/L-001.md')).toBeNull()
  })
})

describe('the send', () => {
  it('auto mode: a pass sends what the loop may not write to its owner, once, with the report line', async () => {
    propose('L-001')
    const r = await pass(ctx({ autoApply: true }), 'schedule')
    expect(r.sent).toEqual(['L-001'])
    expect(started).toHaveLength(1)
    expect(started[0].agent).toBe('fund')
    expect(started[0].prompt).toContain('http://127.0.0.1:4999/api/loop/proposals/L-001/review')
    expect(started[0].prompt).toContain('"agent":"fund","verdict":"applied"')
    const p = read(dir, 'L-001')!
    expect(p.state).toBe('proposed')
    expect(p.review).toMatchObject({ agent: 'fund', conversation: 'conv-1', ask: 'apply', tries: 1, verdict: null })
    expect(p.body).toMatch(/sent to fund by loop to check and land: conversation conv-1/)
    // the next pass does not send it again while it is out
    await pass(ctx({ autoApply: true }), 'schedule')
    expect(started).toHaveLength(1)
    // unanswered past STALE_MS: sent once more, then it stays out (MAX_TRIES)
    clockAt += STALE_MS
    await pass(ctx({ autoApply: true }), 'schedule')
    expect(started).toHaveLength(2)
    expect(read(dir, 'L-001')!.review!.tries).toBe(2)
    clockAt += STALE_MS
    await pass(ctx({ autoApply: true }), 'schedule')
    expect(started).toHaveLength(2)
  })

  it('manual mode sends nothing; an owner-only target is never sent; a pass sends at most MAX_SENDS', async () => {
    propose('L-001')
    await pass(ctx({ autoApply: false }), 'schedule')
    expect(started).toHaveLength(0)
    propose('L-002', ['app/schedule.json'])
    for (let i = 3; i < 4 + MAX_SENDS; i++) propose(`L-00${i}`)
    const r = await pass(ctx({ autoApply: true }), 'schedule')
    expect(r.sent).toHaveLength(MAX_SENDS)
    expect(r.sent).not.toContain('L-002')
    // auto mode parks nothing on the owner: what nobody may land is closed, and stays closed
    expect(r.notes.join('\n')).toMatch(/L-002 closed: nobody may land it \(app\/schedule.json/)
    expect(r.closed).toContain('L-002')
    expect(read(dir, 'L-002')!.state).toBe('vetoed')
    expect(r.notes.join('\n')).toMatch(/send cap/)
    // with no agent runner the pass sends nothing and breaks nothing
    started = []
    propose('L-009')
    const q = await pass(ctx({ autoApply: true }, false), 'schedule')
    expect(q.sent).toEqual([])
    expect(q.ok).toBe(true)
  })

  it('the owner can send by hand in manual mode', async () => {
    propose('L-001')
    const p = await send(ctx(), 'L-001', 'apply', 'owner')
    expect(p.review?.agent).toBe('fund')
    expect(p.body).toMatch(/sent to fund by owner/)
  })
})

describe('the report', () => {
  it('applied: the commit must exist and touch a target; then the watch opens as for the loop\'s own', async () => {
    propose('L-001')
    await send(ctx(), 'L-001', 'apply', 'loop')
    await expect(report(ctx(), 'L-001', { agent: 'app', verdict: 'applied' })).rejects.toThrow(/sent to fund, not app/)
    await expect(report(ctx(), 'L-001', { agent: 'fund', verdict: 'kept' })).rejects.toThrow(/verdict is applied or declined/)
    await expect(report(ctx(), 'L-001', { agent: 'fund', verdict: 'applied', commit: '--all' })).rejects.toThrow(/hex sha/)
    await expect(report(ctx(), 'L-001', { agent: 'fund', verdict: 'applied', commit: 'deadbeef' })).rejects.toThrow(/no commit/)
    // a real commit that touches none of the targets: refused, state untouched
    writeFileSync(join(dir, 'README.md'), 'other\n'); sh(['add', '--', 'README.md']); sh(['commit', '-q', '-m', 'other'])
    await expect(report(ctx(), 'L-001', { agent: 'fund', verdict: 'applied', commit: sh(['rev-parse', 'HEAD']).trim() })).rejects.toThrow(/touches none of the targets/)
    expect(read(dir, 'L-001')!.state).toBe('proposed')
    const sha = agentCommit()
    const p = await report(ctx(), 'L-001', { agent: 'fund', verdict: 'applied', commit: sha.slice(0, 10), note: 'dropped a.md' })
    expect(p.state).toBe('watching')
    expect(p.commit).toBe(sha)
    expect(p.review).toMatchObject({ verdict: 'applied', commit: sha, note: 'dropped a.md' })
    expect(p.body).toMatch(/applied by fund: commit/)
    await expect(report(ctx(), 'L-001', { agent: 'fund', verdict: 'declined' })).rejects.toThrow(/already reported applied/)
  })

  it('declined: vetoed, nothing changed', async () => {
    propose('L-001')
    await send(ctx(), 'L-001', 'apply', 'loop')
    const p = await report(ctx(), 'L-001', { agent: 'fund', verdict: 'declined', note: 'the book is load-bearing' })
    expect(p.state).toBe('vetoed')
    expect(p.body).toMatch(/declined by fund: the book is load-bearing/)
    expect(readFileSync(join(dir, 'app', 'agents', 'dash-a.md'), 'utf8')).toBe('boot: [a.md, b.md]\n')
  })

  it('a revert of an agent-landed change goes back to that agent (the loop\'s rails cannot), who reports it', async () => {
    propose('L-001')
    await send(ctx(), 'L-001', 'apply', 'loop')
    await report(ctx(), 'L-001', { agent: 'fund', verdict: 'applied', commit: agentCommit() })
    const q = await revert(ctx(), 'L-001', 'the owner wants it back', 'owner')
    expect(q.state).toBe('watching')
    expect(q.review).toMatchObject({ agent: 'fund', ask: 'revert', verdict: null })
    expect(started.at(-1)!.prompt).toContain('"verdict":"reverted"')
    await expect(revert(ctx(), 'L-001', 'again', 'owner')).rejects.toThrow(/already with fund to revert/)
    const back = agentCommit('app/agents/dash-a.md', 'boot: [a.md, b.md]\n')
    const r = await report(ctx(), 'L-001', { agent: 'fund', verdict: 'reverted', commit: back })
    expect(r.state).toBe('reverted')
    expect(r.revert).toBe(back)
  })
})

describe('the switch', () => {
  it('setAutoApply flips loop.autoApply and keeps every other key', () => {
    const f = join(dir, 'config.json')
    writeFileSync(f, JSON.stringify({ $comment: 'c', loop: { autoApply: false, watchDays: 9 } }))
    setAutoApply(f, true)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ $comment: 'c', loop: { autoApply: true, watchDays: 9 } })
    writeFileSync(f, '{broken')
    expect(() => setAutoApply(f, true)).toThrow(/not JSON/)
  })
})
