import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Shelf } from '../shared/types.ts'
import { addLesson, listInbox } from '../server/loop/capture.ts'
import { DEFAULTS, type LoopConfig, parseConfig, railFor } from '../server/loop/config.ts'
import { type Ctx, apply, pass, pin, revert, verdictOf, veto } from '../server/loop/engine.ts'
import { list, parse, read, serialize } from '../server/loop/proposals.ts'
import { bookInfoFrom, bootDrafts, cluster, slug, similarity, tokens, unreadDrafts, withSeriesRow } from '../server/loop/rules.ts'
import { db, ops } from '../server/db.ts'
import { caps } from '../server/library/caps.ts'
import { resetStore } from './pg/reset.ts'

// The whole state machine on a TEMP git repo and this file's own database, emptied before every
// test (test/pg). Nothing here touches the fund repo, ~/fund-data or the live store.

const DAY = 86_400_000
const BOOT_CAP = caps().boot
const T0 = Date.parse('2026-09-10T12:00:00Z')

const agent = (id: string, dept: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: id, kind: 'dashboard', mode: 'active', dept, role: 'r', cwd: '.', writes: [], model: 'sonnet', effort: 'low', boot: [], ...extra,
})
const AGENTS: Agent[] = [agent('dash:a', 'Dashboards'), agent('dash:b', 'Dashboards'), agent('fund', 'HQ', { kind: 'standing', writes: ['library/'] })]
const SHELVES: Shelf[] = [{ id: 'dashboards', title: 'Dashboards', dept: 'Dashboards', roots: ['library/dashboards'] }, { id: 'fund', title: 'Fund', dept: 'HQ', roots: ['library/fund'] }]

const LESSON_A = 'Acme candle endpoint keeps only the latest 5000 bars; archive the hourly candles daily or the history is lost for good.'
const LESSON_B = 'The Acme candle history is capped at 5000 bars per interval, so archive hourly candles every day or that history is lost for good.'

let dir: string
let clockAt = T0

function sh(args: string[]) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }) }

function ctx(cfg: Partial<LoopConfig> = {}): Ctx {
  return { db, fundRoot: dir, agents: AGENTS, shelves: SHELVES, repos: [{ id: 'fund', path: '.' } as any], config: { ...DEFAULTS, ...cfg }, now: () => clockAt }
}

/** n finished turns (and e errors) for an agent on the day of `at` */
async function turns(agentId: string, at: number, n: number, e = 0) {
  for (let i = 0; i < n; i++) await ops.logEvent('turn', 'turn done - 10 in / 1 out', { agent: agentId, ts: at + i })
  for (let i = 0; i < e; i++) await ops.logEvent('error', 'tool failed', { agent: agentId, ts: at + i })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'loop-engine-'))
  sh(['init', '-q', '-b', 'main'])
  sh(['config', 'user.email', 'loop@test'])
  sh(['config', 'user.name', 'loop test'])
  sh(['config', 'core.hooksPath', join(dir, '.nohooks')])
  sh(['config', 'core.autocrlf', 'false'])
  mkdirSync(join(dir, 'library', 'dashboards', 'app'), { recursive: true })
  mkdirSync(join(dir, 'library', 'fund', 'the-craft'), { recursive: true })
  writeFileSync(join(dir, 'library', 'dashboards', 'app', 'desk-law.md'), '# desk law\n\nbody\n')
  writeFileSync(join(dir, 'library', 'fund', 'the-craft', '_series.md'), '# The Craft\n\n| Book | Read when |\n|---|---|\n| `big.md` | about to write a rule |\n')
  writeFileSync(join(dir, 'library', 'fund', 'the-craft', 'big.md'), '# Big\n\n' + 'x'.repeat((BOOT_CAP + 1000) * 4) + '\n')
  writeFileSync(join(dir, 'README.md'), 'temp fund\n')
  sh(['add', '--', '.'])
  sh(['commit', '-q', '-m', 'init'])
  await resetStore()
  clockAt = T0
})

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows file lock */ }
})

describe('rails', () => {
  it('the loop never writes the law, the roster, sub-repos or execution', () => {
    expect(railFor('app/library/law/the-rails.md')).toMatch(/owner only/)
    expect(railFor('app/library/law/x/money-rails.md')).toMatch(/owner only/)
    expect(railFor('library/fund/the-rails.md')).toMatch(/owner only/)   // the law's home before 2026-09-25
    expect(railFor('app/agents/dash-vol.md')).toMatch(/roster/)
    expect(railFor('agents.json')).toMatch(/roster/)
    expect(railFor('agents.json#dash:trade')).toMatch(/roster/)
    expect(railFor('app/schedule.json')).toMatch(/configuration/)
    expect(railFor('app/loop/config.json')).toMatch(/configuration/)
    expect(railFor('schedule.json')).toMatch(/configuration/)
    expect(railFor('repos.json')).toMatch(/configuration/)
    expect(railFor('platform/dashboards/vol/dashboard.json')).toMatch(/configuration|sub-repos/)
    // configuration is configuration even inside a registered shelf root
    expect(railFor('platform/dashboards/vol/dashboard.json', ['platform/dashboards/vol'])).toBe("platform/dashboards/vol/dashboard.json: the fund's configuration - the loop proposes, the owner edits")
    expect(railFor('Platform/Dashboards/Vol/Dashboard.JSON')).toMatch(/configuration/)
    expect(railFor('platform/library/platform/x.md')).toMatch(/sub-repos/)   // the retired platform/library home: closed unless registered
    expect(railFor('app/server/x.ts')).toMatch(/sub-repos/)
    expect(railFor('database/py/fund_db/x.py')).toMatch(/sub-repos/)
    expect(railFor('library/platform/api/execution/x.md')).toMatch(/execution/)
    expect(railFor('app/library/craft/execution/desk-law.md')).toMatch(/execution/)   // its home since 2026-09-25
    expect(railFor('App/Library/Craft/Execution/x.md')).toMatch(/execution/)
    expect(railFor('app/library/craft/research/x.md')).toBeNull()   // no roots given: the machine's own shelves
    expect(railFor('CLAUDE.md')).toMatch(/owner only/)
    expect(railFor('../outside.md')).toMatch(/escapes/)
    expect(railFor('app/board/B-0001.md')).toMatch(/sub-repos/)
    expect(railFor('board/B-0001.md')).toMatch(/registered shelf root/)
    expect(railFor('app/library/craft/the-shared-lessons/x.md')).toBeNull()
    expect(railFor('app/loop/records/proposals/L-001.md')).toBeNull()
    expect(railFor('lab/loop/proposals/L-001.md')).not.toBeNull()   // the records' home before 2026-09-25 is gone
    expect(railFor('loop/proposals/L-001.md')).not.toBeNull()   // the pre-2026-09-24 root folder is gone
  })
  it('B-0069: any REGISTERED shelf root passes, a sub-repo shelf included; nothing else in a sub-repo does', () => {
    const roots = ['library/craft', 'library/fund', 'platform/research/notes', 'app/library']
    expect(railFor('app/library/the-shared-lessons/x.md', roots)).toBeNull()
    expect(railFor('app/library/the-shared-lessons/_series.md', roots)).toBeNull()
    expect(railFor('platform/research/notes/lessons/x.md', roots)).toBeNull()   // a registered shelf root under platform/
    expect(railFor('library/craft/the-shared-lessons/x.md', roots)).toBeNull()
    expect(railFor('app/loop/records/proposals/L-001.md', roots)).toBeNull()
    // a target outside every registered shelf root is still refused
    expect(railFor('app/server/loop/config.ts', roots)).toMatch(/sub-repos/)
    expect(railFor('app/libraryx/x.md', roots)).toMatch(/sub-repos/)           // a prefix is not a root
    expect(railFor('app/library.md', roots)).toMatch(/sub-repos/)
    expect(railFor('platform/research/check_charts.py', roots)).toMatch(/sub-repos/)
    expect(railFor('platform/research/other/x.md', roots)).toMatch(/sub-repos/) // not registered here
    expect(railFor('platform/library/platform/x.md', roots)).toMatch(/sub-repos/) // the retired home, never registered (B-0202)
    expect(railFor('research/library/x.md', roots)).toMatch(/sub-repos/)
    expect(railFor('library/markets/x.md', roots)).toMatch(/registered shelf root/)  // library/, but not a registered root
    expect(railFor('library/shelf.md', roots)).toMatch(/registered shelf root/)      // a loose file is not a shelf
    expect(railFor('board/B-0001.md', roots)).toMatch(/registered shelf root/)
    // no shelf lets the loop past the other rails
    expect(railFor('app/library/CLAUDE.md', roots)).toMatch(/owner only/)
    expect(railFor('app/library/.claude/settings.json', roots)).toMatch(/owner only/)
    expect(railFor('library/fund/the-rails.md', roots)).toMatch(/owner only/)
    expect(railFor('app/library/execution/x.md', [...roots, 'app/library/execution'])).toMatch(/execution/)
    expect(railFor('platform/research/execution/x.md', [...roots, 'platform/research/execution'])).toMatch(/execution/)
    expect(railFor('execution/library/x.md', [...roots, 'execution/library'])).toMatch(/execution/)
    expect(railFor('app/library/../server/x.ts', roots)).toMatch(/escapes/)
    // no roots given: only the machine's own shelves (app/library/<x>) are open; the rest of every sub-repo stays closed
    expect(railFor('app/library/x/y.md')).toBeNull()
    expect(railFor('app/library/y.md')).toMatch(/sub-repos/)
    expect(railFor('platform/research/notes/y.md')).toMatch(/sub-repos/)
  })
  it('config: autoApply only when literally true, numbers clamped', () => {
    expect(parseConfig({ autoApply: 'yes', watchDays: 400 }, 'agents.json')).toMatchObject({ autoApply: false, watchDays: 90, source: 'agents.json' })
    expect(parseConfig({ autoApply: true, watchDays: 7 }, null)).toMatchObject({ autoApply: true, watchDays: 7 })
  })
})

describe('rules', () => {
  it('the same lesson in other words clusters; a different one does not', () => {
    expect(similarity(tokens(LESSON_A), tokens(LESSON_B))).toBeGreaterThanOrEqual(0.4)
    expect(similarity(tokens(LESSON_A), tokens('An exchange publishes a special funding row for stock dividends a second after the regular one.'))).toBeLessThan(0.2)
    const mk = (key: string, text: string, agentId: string) => ({ key, source: 'inbox' as const, ts: T0, agent: agentId, title: text, text, readWhen: null, ref: '', state: 'open' })
    const g = cluster([mk('1', LESSON_A, 'dash:a'), mk('2', LESSON_B, 'dash:b'), mk('3', 'Never print a zero you did not measure on a dashboard tile.', 'dash:a')])
    expect(g).toHaveLength(1)
    expect(g[0].map(x => x.key).sort()).toEqual(['1', '2'])
  })
  it('series row appends to an existing table, or a new index gets its header', () => {
    expect(withSeriesRow('| Book | Read when |\n|---|---|\n| `a.md` | x |\n', 'R', '| `b.md` | y |')).toBe('| Book | Read when |\n|---|---|\n| `a.md` | x |\n| `b.md` | y |\n')
    expect(withSeriesRow(null, 'Dashboards', '| `b.md` | y |')).toMatch(/^---\ntitle: The Shared Lessons[\s\S]*\|---\|---\|\n\| `b\.md` \| y \|\n$/)
  })
  it('boot-compress names the books that fire on their own; it is never auto', () => {
    const heavy = agent('dash:a', 'Dashboards', { boot: ['library/fund/the-craft/big.md'] })
    const d = bootDrafts([heavy], () => ({ tokens: BOOT_CAP + 12_500, readWhen: 'about to write a rule', exists: true }), [])
    expect(d).toHaveLength(1)
    expect(d[0].auto).toBe(false)
    expect(d[0].target).toEqual(['app/agents/dash-a.md'])   // the agent's own roster file, railed
    expect(d[0].gates.find(g => g.name === 'rails')?.ok).toBe(false)
    expect(d[0].body).toContain('`library/fund/the-craft/big.md` (' + (BOOT_CAP + 12_500).toLocaleString('en-US') + ' tokens)')
    expect(bootDrafts([heavy], () => ({ tokens: 100, readWhen: '', exists: true }), [])).toHaveLength(0)
  })
  it('boot-compress judges the boot list against the boot cap in app/tools/context-caps.json, for every kind of agent', () => {
    const cap = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'context-caps.json'), 'utf8')).boot
    expect(cap).toBe(BOOT_CAP)
    for (const [id, dept] of [['dash:a', 'Dashboards'], ['fund', 'Fund']] as const) {
      const a = agent(id, dept, { boot: ['x.md'] })
      expect(bootDrafts([a], () => ({ tokens: cap, readWhen: 'when', exists: true }), [])).toHaveLength(0)       // at the cap is not over it
      const d = bootDrafts([a], () => ({ tokens: cap + 1, readWhen: 'when', exists: true }), [])
      expect(d).toHaveLength(1)
      expect(d[0].title).toBe(`boot: ${id} loads ${(cap + 1).toLocaleString('en-US')} of ${cap.toLocaleString('en-US')} tokens`)
    }
    // the old 12k / 8k boot budgets are gone: a boot list under the cap is fine, one over it is named
    expect(bootDrafts([agent('fund', 'Fund', { boot: ['x.md'] })], () => ({ tokens: BOOT_CAP + 500, readWhen: 'when', exists: true }), [])).toHaveLength(1)
  })
  it('a boot chapter (<book>#<slug>, B-0345) is priced and timed as the chapter, not the book; a dead slug is not there', () => {
    const books = [{ path: 'lib/a.md', shelf: 'fund', series: 's', title: 'A', readWhen: 'book moment', topics: [], type: null, parent: null, chapters: [{ slug: 'one', title: 'One', readWhen: 'chapter moment', tokens: 40 }, { slug: 'two', title: 'Two', readWhen: '', tokens: 60 }], tokens: 100, updated: 0 }]
    const info = bookInfoFrom('/nowhere', books)
    expect(info('lib/a.md')).toEqual({ tokens: 100, readWhen: 'book moment', exists: true })
    expect(info('lib/a.md#one')).toEqual({ tokens: 40, readWhen: 'chapter moment', exists: true })
    expect(info('lib/a.md#two')).toEqual({ tokens: 60, readWhen: 'book moment', exists: true })
    expect(info('lib/a.md#gone')).toEqual({ tokens: 0, readWhen: '', exists: false })
    // a book booted only by chapter is booted: the unread rule must not call it unread
    const ledger = { since: T0 - 40 * DAY, pulled: new Set<string>() }
    const lib = [{ ...books[0], path: 'app/library/fund/a.md' }]
    expect(unreadDrafts(lib, [{ id: 'x', boot: ['app/library/fund/a.md#one'] } as any], ledger, T0, 30, [], SHELVES).drafts).toHaveLength(0)
    expect(unreadDrafts(lib, [{ id: 'x', boot: [] } as any], ledger, T0, 30, [], SHELVES).drafts.length).toBeGreaterThan(0)
  })
  it('unread is claimed only once the ledger is old enough', () => {
    const books = [{ path: 'library/fund/the-craft/big.md', shelf: 'fund', series: 'the-craft', title: 'Big', readWhen: 'x', topics: [], type: null, parent: null, chapters: [], tokens: 1, updated: 0 }]
    expect(unreadDrafts(books, AGENTS, { since: null, pulled: new Set() }, T0, 30, [], SHELVES).note).toMatch(/no pull/)
    expect(unreadDrafts(books, AGENTS, { since: T0 - 5 * DAY, pulled: new Set() }, T0, 30, [], SHELVES).note).toMatch(/5\.0 days old/)
    const old = unreadDrafts(books, AGENTS, { since: T0 - 40 * DAY, pulled: new Set() }, T0, 30, [], SHELVES)
    expect(old.drafts).toHaveLength(1)
    expect(unreadDrafts(books, AGENTS, { since: T0 - 40 * DAY, pulled: new Set(['library/fund/the-craft/big.md']) }, T0, 30, [], SHELVES).drafts).toHaveLength(0)
  })
  it('verdict: worse beyond tolerance, unmeasured is no-signal', () => {
    expect(verdictOf(0.9, 0.8, 0.05)).toBe('worse')
    expect(verdictOf(0.9, 0.88, 0.05)).toBe('same')
    expect(verdictOf(0.8, 0.9, 0.05)).toBe('better')
    expect(verdictOf(null, 0.9, 0.05)).toBe('no-signal')
  })
  it('verdict: a window thinner than minEvents is no-signal, never a worse on noise', () => {
    // the real 2026-09-24 Build cohort: 3 turns in the baseline, one error after
    expect(verdictOf(1, 0.67, 0.05, { before: 3, after: 3, min: 20 })).toBe('no-signal')
    expect(verdictOf(1, 0.67, 0.05, { before: 70, after: 3, min: 20 })).toBe('no-signal')
    expect(verdictOf(1, 0.67, 0.05, { before: 70, after: 60, min: 20 })).toBe('worse')
    expect(parseConfig({ minEvents: 0 }, null).minEvents).toBe(1)
    expect(DEFAULTS.minEvents).toBe(20)
  })
  it('slug cuts at a word boundary, never mid-word', () => {
    const s = slug('A venue list endpoint that caps its offset needs a keyset pager: past the cap it returns nothing')
    expect(s).toBe('a-venue-list-endpoint-that-caps-its-offset-needs-a-keyset')
    expect(s.length).toBeLessThanOrEqual(60)
    expect(slug('Acme candle endpoint keeps only the latest 5000 bars')).toBe('acme-candle-endpoint-keeps-only-the-latest-5000-bars')
    expect(slug('x'.repeat(80))).toHaveLength(60)
  })
})

describe('proposal files', () => {
  it('round-trips through serialize/parse', () => {
    const p = parse('---\nid: L-007\nkind: promote\ntitle: "promote: a: b"\ntarget: ["library/x.md"]\nsource: ["inbox:1"]\nwhy: w\ngates: [{"name":"rails","ok":true,"note":""}]\nstate: watching\nauto: true\ncommit: abc\nrevert: null\nwatch: {"agents":["dash:a"],"from":1,"until":2,"events":5,"before":null,"after":null,"verdict":null}\npinned: false\ncreated: 2026-09-10T00:00:00Z\nupdated: 2026-09-10T00:00:00Z\n---\n\n## Why\n\nx\n')
    expect(parse(serialize(p))).toEqual(p)
    expect(p.title).toBe('promote: a: b')
    expect(p.watch.agents).toEqual(['dash:a'])
  })
})

describe('the state machine on a temp repo', () => {
  async function proposed(): Promise<string> {
    await addLesson(db, AGENTS, { agent: 'dash:a', text: LESSON_A, readWhen: 'about to fetch Acme candles' }, T0 - 3 * DAY)
    await addLesson(db, AGENTS, { agent: 'dash:b', text: LESSON_B }, T0 - 2 * DAY)
    const r = await pass(ctx(), 'manual')
    expect(r.errors).toEqual([])
    const promote = list(dir).proposals.find(p => p.kind === 'promote')!
    expect(promote).toBeTruthy()
    return promote.id
  }

  it('capture refuses an unknown agent and an empty lesson', async () => {
    await expect(addLesson(db, AGENTS, { agent: 'ghost', text: LESSON_A })).rejects.toThrow(/no agent ghost/)
    await expect(addLesson(db, AGENTS, { agent: 'dash:a', text: 'short' })).rejects.toThrow(/at least a sentence/)
    expect((await addLesson(db, AGENTS, { agent: 'dash:a', text: LESSON_A })).state).toBe('open')
  })

  it('a pass proposes a promote but, with autoApply off, applies nothing and commits nothing', async () => {
    const before = sh(['rev-list', '--count', 'HEAD']).trim()
    const id = await proposed()
    const p = read(dir, id)!
    expect(p.state).toBe('proposed')
    expect(p.auto).toBe(true)
    expect(p.target).toEqual(['library/dashboards/the-shared-lessons/acme-candle-endpoint-keeps-only-the-latest-5000-bars-archive.md', 'library/dashboards/the-shared-lessons/_series.md'])
    expect(p.watch.agents).toEqual(['dash:a', 'dash:b'])
    expect(sh(['rev-list', '--count', 'HEAD']).trim()).toBe(before)
    expect(existsSync(join(dir, p.target[0]))).toBe(false)
    // a second pass does not propose the same cluster again
    await pass(ctx(), 'manual')
    expect(list(dir).proposals.filter(x => x.kind === 'promote')).toHaveLength(1)
  })

  it('apply commits exactly the book + series with the loop trailers, then watches; worse auto-reverts with a NEW commit', async () => {
    // baseline week: clean turns
    for (let d = 7; d >= 1; d--) await turns('dash:a', T0 - d * DAY, 10)
    const id = await proposed()
    const p = await apply(ctx(), id, 'owner')
    expect(p.state).toBe('watching')
    expect(p.watch.before?.score).toBe(1)
    const change = sh(['log', '-1', '--skip=1', '--format=%H%n%B']).trim()
    expect(change).toContain(`Loop-Change: ${id}`)
    expect(change).toContain('Agent: loop')
    expect(sh(['show', '--name-only', '--format=', p.commit!]).trim().split('\n').sort()).toEqual([...p.target].sort())
    expect(sh(['log', '-1', '--format=%s']).trim()).toBe(`loop: ${id} watching`)
    const book = readFileSync(join(dir, p.target[0]), 'utf8')
    expect(book).toContain('### dash:a')
    expect(book).toContain('### dash:b')
    expect(book).not.toMatch(/—/)
    expect(readFileSync(join(dir, p.target[1]), 'utf8')).toContain('| about to fetch Acme candles |')
    expect((await listInbox(db)).every(l => l.state === 'promoted' && l.proposal === id)).toBe(true)

    // the week after: half the turns error
    for (let d = 1; d <= 6; d++) await turns('dash:a', T0 + d * DAY, 10, 5)
    clockAt = T0 + 8 * DAY
    const headBefore = sh(['rev-parse', 'HEAD']).trim()
    const r = await pass(ctx({ autoApply: true }), 'schedule')
    expect(r.closed).toContain(id)
    const q = read(dir, id)!
    expect(q.state).toBe('reverted')
    expect(q.watch.verdict).toBe('worse')
    expect(existsSync(join(dir, p.target[0]))).toBe(false)
    expect(existsSync(join(dir, p.target[1]))).toBe(false)
    // history only grew: the apply commit is still an ancestor, and a Revert commit names it
    expect(sh(['merge-base', '--is-ancestor', p.commit!, 'HEAD'])).toBe('')
    // three commits: the pass's metrics rows, the Revert, the records
    expect(sh(['rev-list', '--count', `${headBefore}..HEAD`]).trim()).toBe('3')
    expect(sh(['log', '-1', '--skip=2', '--format=%s']).trim()).toMatch(/^loop: metrics, \d+ closed day rows?$/)
    const rv = sh(['log', '-1', '--skip=1', '--format=%s%n%B']).trim()
    expect(rv).toMatch(/^Revert "loop: L-\d+ promote/)
    expect(rv).toContain(`This reverts commit ${p.commit}`)
    expect(rv).toContain(`Reverts: ${p.commit}`)
    expect(q.revert).toBe(sh(['rev-parse', 'HEAD~1']).trim())
    expect(readFileSync(join(dir, 'app', 'loop', 'records', 'watch.jsonl'), 'utf8')).toMatch(/"event":"start"[\s\S]*"event":"revert"/)
  })

  it('worse with autoApply off waits on the owner; a pinned change is kept', async () => {
    for (let d = 7; d >= 1; d--) await turns('dash:a', T0 - d * DAY, 10)
    const id = await proposed()
    await apply(ctx(), id, 'owner')
    for (let d = 1; d <= 6; d++) await turns('dash:a', T0 + d * DAY, 10, 6)
    clockAt = T0 + 8 * DAY
    await pass(ctx(), 'schedule')
    let q = read(dir, id)!
    expect(q.state).toBe('watching')
    expect(q.watch.verdict).toBe('worse')
    await pin(ctx(), id, true)
    await pass(ctx({ autoApply: true }), 'schedule')
    q = read(dir, id)!
    expect(q.state).toBe('kept')
    expect(q.pinned).toBe(true)
    expect(existsSync(join(dir, q.target[0]))).toBe(true)
    // the owner can still revert a kept change
    q = await revert(ctx(), id, 'owner changed his mind', 'owner')
    expect(q.state).toBe('reverted')
    expect(existsSync(join(dir, q.target[0]))).toBe(false)
  })

  it('a steady cohort closes the watch as kept after the window', async () => {
    for (let d = 7; d >= 1; d--) await turns('dash:b', T0 - d * DAY, 10, 1)
    const id = await proposed()
    await apply(ctx(), id, 'owner')
    for (let d = 1; d <= 6; d++) await turns('dash:b', T0 + d * DAY, 10, 1)
    clockAt = T0 + 3 * DAY
    await pass(ctx({ autoApply: true }), 'schedule')
    expect(read(dir, id)!.state).toBe('watching')
    clockAt = T0 + 8 * DAY
    await pass(ctx({ autoApply: true }), 'schedule')
    const q = read(dir, id)!
    expect(q.state).toBe('kept')
    expect(q.watch.verdict).toBe('same')
    expect(sh(['log', '-1', '--format=%s']).trim()).toBe(`loop: ${id} kept`)
  })

  it('no data either side is no-signal: extended once, then kept VISIBLY unjudged, never a fake pass or fail', async () => {
    const id = await proposed()
    await apply(ctx(), id, 'owner')
    clockAt = T0 + 8 * DAY
    await pass(ctx({ autoApply: true }), 'schedule')
    let q = read(dir, id)!
    expect(q.state).toBe('watching')
    expect(q.watch.extended).toBe(1)
    expect(q.watch.until).toBe(T0 + 14 * DAY)
    expect(q.body).toMatch(/watch extended 1\/1: no signal \(0 before \/ 0 after scored events, 20 needed a side\)/)
    expect(sh(['log', '-1', '--format=%s']).trim()).toBe(`loop: ${id} extended: no signal`)
    clockAt = T0 + 15 * DAY
    await pass(ctx({ autoApply: true }), 'schedule')
    q = read(dir, id)!
    expect(q.state).toBe('kept')
    expect(q.watch.verdict).toBe('no-signal')
    expect(q.body).toMatch(/kept: no signal, unjudged/)
    expect(sh(['log', '-1', '--format=%s']).trim()).toBe(`loop: ${id} kept: no signal`)
    expect(readFileSync(join(dir, 'app', 'loop', 'records', 'watch.jsonl'), 'utf8')).toMatch(/"event":"extend"[\s\S]*"event":"close"[^\n]*"unjudged":true/)
  })

  it('B-0058 rehearsal: a bad change on a THIN cohort (14 events a week, minEvents 20) is extended, then judged worse and auto-reverted', async () => {
    // two clean turns a day for the fortnight before the apply
    for (let d = 14; d >= 1; d--) await turns('dash:a', T0 - d * DAY, 2)
    const id = await proposed()
    const p = await apply(ctx(), id, 'owner')
    // after: two turns a day, one of them an error (reliability 1 -> 0.5)
    for (let d = 1; d <= 14; d++) await turns('dash:a', T0 + d * DAY, 2, 1)
    clockAt = T0 + 8 * DAY
    await pass(ctx({ autoApply: true }), 'schedule')
    let q = read(dir, id)!
    expect(q.state).toBe('watching')                       // one week = 14 events a side: too thin to judge
    expect(q.watch.extended).toBe(1)
    expect(existsSync(join(dir, p.target[0]))).toBe(true)
    clockAt = T0 + 15 * DAY
    const r = await pass(ctx({ autoApply: true }), 'schedule')
    expect(r.closed).toContain(id)
    q = read(dir, id)!
    expect(q.state).toBe('reverted')
    expect(q.watch.verdict).toBe('worse')
    expect(q.watch.before?.counts.turns).toBe(28)           // the baseline widened with the watch
    expect(q.watch.after?.counts.turns).toBe(28)
    expect(q.watch.before?.score).toBe(1)
    expect(q.watch.after?.score).toBe(0.5)
    expect(existsSync(join(dir, p.target[0]))).toBe(false)
    expect(sh(['log', '-2', '--format=%s']).trim().split('\n')[1]).toMatch(/^Revert "loop: L-\d+ promote/)
  })

  it('noSignalExtends 0 closes unjudged at once', async () => {
    const id = await proposed()
    await apply(ctx(), id, 'owner')
    clockAt = T0 + 8 * DAY
    await pass(ctx({ autoApply: true, noSignalExtends: 0 }), 'schedule')
    expect(read(dir, id)!.state).toBe('kept')
    expect(read(dir, id)!.body).toMatch(/unjudged/)
    expect(parseConfig({ noSignalExtends: 2.6, minEvents: 30 }, 'agents.json')).toMatchObject({ noSignalExtends: 3, minEvents: 30 })
    expect(parseConfig({ noSignalExtends: -1 }, null).noSignalExtends).toBe(0)
  })

  it('a pinned watch is never extended: a due no-signal pinned watch closes kept, not unjudged', async () => {
    const id = await proposed()
    await apply(ctx(), id, 'owner')
    await pin(ctx(), id, true)
    clockAt = T0 + 8 * DAY
    await pass(ctx({ autoApply: true, noSignalExtends: 3 }), 'schedule')
    const q = read(dir, id)!
    expect(q.state).toBe('kept')
    expect(q.body).not.toMatch(/unjudged/)
    expect(q.body).not.toMatch(/extended/)
    expect(q.body).toMatch(/pinned/)
  })

  it('autoApply applies eligible proposals in the pass itself', async () => {
    await addLesson(db, AGENTS, { agent: 'dash:a', text: LESSON_A }, T0 - 3 * DAY)
    await addLesson(db, AGENTS, { agent: 'dash:b', text: LESSON_B }, T0 - 2 * DAY)
    const r = await pass(ctx({ autoApply: true }), 'schedule')
    expect(r.applied).toHaveLength(1)
    expect(read(dir, r.applied[0])!.state).toBe('watching')
  })

  it('veto closes a proposal; a vetoed one cannot be applied', async () => {
    const id = await proposed()
    await veto(ctx(), id, 'not a shared lesson')
    const q = read(dir, id)!
    expect(q.state).toBe('vetoed')
    expect(q.body).toContain('vetoed by owner: not a shared lesson')
    await expect(apply(ctx(), id, 'owner')).rejects.toThrow(/vetoed; apply needs proposed/)
    await expect(pin(ctx(), id, true)).rejects.toThrow(/pin needs/)
  })

  it('advisory proposals are never applied, and a revert refuses to clobber a later edit', async () => {
    const id = await proposed()
    const p = await apply(ctx(), id, 'owner')
    writeFileSync(join(dir, p.target[0]), readFileSync(join(dir, p.target[0]), 'utf8') + '\nan owner edit\n')
    sh(['add', '--', p.target[0]]); sh(['commit', '-q', '-m', 'owner edit'])
    await expect(revert(ctx(), id, 'x', 'owner')).rejects.toThrow(/changed since the loop applied it/)
    expect(read(dir, id)!.state).toBe('watching')
    expect(readFileSync(join(dir, p.target[0]), 'utf8')).toContain('an owner edit')
    const heavy: Agent = agent('dash:heavy', 'Dashboards', { boot: ['library/fund/the-craft/big.md'] })
    const c2 = { ...ctx(), agents: [...AGENTS, heavy] }
    const r = await pass(c2, 'manual')
    const boot = r.created.map(x => read(dir, x)!).find(x => x.kind === 'boot-compress')!
    expect(boot.title).toMatch(/dash:heavy/)
    await expect(apply(c2, boot.id, 'owner')).rejects.toThrow(/advisory/)
  })

  it('a forged proposal file cannot make the loop revert a commit that is not its own', async () => {
    // an ordinary commit that edits the law, and a second change of the loop's own
    writeFileSync(join(dir, 'CLAUDE.md'), 'the law\n')
    sh(['add', '--', 'CLAUDE.md']); sh(['commit', '-q', '-m', 'owner law'])
    const lawSha = sh(['rev-parse', 'HEAD']).trim()
    const id = await proposed()
    const real = await apply(ctx(), id, 'owner')
    const forge = (commit: string, extra: Partial<typeof real['watch']> = {}) => {
      const p = read(dir, id)!
      writeFileSync(join(dir, 'app', 'loop', 'records', 'proposals', `${id}.md`), serialize({ ...p, commit, watch: { ...p.watch, ...extra } }))
    }
    // not a sha: never reaches git as a flag
    forge('--output=INJECTED.txt')
    await expect(revert(ctx(), id, 'x', 'owner')).rejects.toThrow(/not a commit sha/)
    expect(existsSync(join(dir, 'INJECTED.txt'))).toBe(false)
    // a real commit without the loop's trailers
    forge(lawSha)
    await expect(revert(ctx(), id, 'x', 'owner')).rejects.toThrow(/not the loop's commit/)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('the law\n')
    // a commit that carries the trailers of ANOTHER change id
    writeFileSync(join(dir, 'CLAUDE.md'), 'the law, v2\n')
    sh(['add', '--', 'CLAUDE.md']); sh(['commit', '-q', '-m', 'x', '-m', 'Agent: loop\nLoop-Change: L-999'])
    forge(sh(['rev-parse', 'HEAD']).trim())
    await expect(revert(ctx(), id, 'x', 'owner')).rejects.toThrow(/not the loop's commit for L-/)
    // a commit with this id's trailers that touched a railed path
    writeFileSync(join(dir, 'CLAUDE.md'), 'the law, v3\n')
    sh(['add', '--', 'CLAUDE.md']); sh(['commit', '-q', '-m', 'x', '-m', `Agent: loop\nLoop-Change: ${id}`])
    forge(sh(['rev-parse', 'HEAD']).trim())
    await expect(revert(ctx(), id, 'x', 'owner')).rejects.toThrow(/may not revert: CLAUDE.md/)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('the law, v3\n')
    // a forged high baseline does not force a "worse" verdict: the baseline comes from the database
    forge(real.commit!, { before: { counts: {} as any, score: 1, days: 7 } })
    for (let d = 1; d <= 6; d++) await turns('dash:a', T0 + d * DAY, 10, 3)
    clockAt = T0 + 8 * DAY
    await pass(ctx({ autoApply: true }), 'schedule')
    const q = read(dir, id)!
    // the real baseline is empty, so the watch is no-signal: extended, never a forged "worse" revert
    expect(q.state).toBe('watching')
    expect(q.watch.extended).toBe(1)
    expect(q.body).toMatch(/watch extended 1\/1: no signal \(0 before/)
  })

  it('B-0069: a promote into a sub-repo shelf root (app/library) auto-applies INSIDE that repo; a non-shelf target there is refused', async () => {
    // the app sub-repo: its own git, its own history, with its app/library shelf
    const app = join(dir, 'app')
    mkdirSync(join(app, 'library'), { recursive: true })
    mkdirSync(join(app, 'server'), { recursive: true })
    writeFileSync(join(app, 'library', 'three-honest-states.md'), '# Three honest states\n')
    const ash = (args: string[]) => execFileSync('git', args, { cwd: app, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    ash(['init', '-q', '-b', 'main']); ash(['config', 'user.email', 'app@test']); ash(['config', 'user.name', 'app test'])
    ash(['config', 'core.hooksPath', join(app, '.nohooks')]); ash(['config', 'core.autocrlf', 'false'])
    ash(['add', '--', 'library']); ash(['commit', '-q', '-m', 'app init'])
    const appShelf: Shelf = { id: 'app', title: 'App', dept: 'Build', roots: ['app/library'] }
    const withApp = (cfg: Partial<LoopConfig> = {}): Ctx => ({ ...ctx(cfg), shelves: [...SHELVES, appShelf] })
    const id = await proposed()
    const retarget = (target: string[]) => { const p = read(dir, id)!; writeFileSync(join(dir, 'app', 'loop', 'records', 'proposals', `${id}.md`), serialize({ ...p, target })) }

    // a target in the sub-repo but outside its shelf root: refused, nothing written or committed
    retarget(['app/server/the-shared-lessons/x.md', 'app/server/the-shared-lessons/_series.md'])
    const appHead = ash(['rev-parse', 'HEAD']).trim()
    await expect(apply(withApp(), id, 'loop')).rejects.toThrow(/sub-repos are their agents' code/)
    expect(existsSync(join(app, 'server', 'the-shared-lessons'))).toBe(false)
    expect(ash(['rev-parse', 'HEAD']).trim()).toBe(appHead)
    // the shelf root itself, but when app/library is NOT among the registered shelves: refused
    retarget(['app/library/the-shared-lessons/x.md', 'app/library/the-shared-lessons/_series.md'])
    await expect(apply(ctx(), id, 'loop')).rejects.toThrow(/sub-repos/)
    expect(ash(['rev-parse', 'HEAD']).trim()).toBe(appHead)

    // registered: applies, and the change commit lands in the APP repo with the loop trailers
    const fundHead = sh(['rev-parse', 'HEAD']).trim()
    const p = await apply(withApp(), id, 'loop')
    expect(p.state).toBe('watching')
    // two commits in the app repo: the change (the book + its row), then the loop's own records
    expect(ash(['log', '-2', '--format=%H']).trim().split('\n')[1]).toBe(p.commit)
    expect(ash(['log', '-1', '--format=%B', p.commit!])).toContain(`Loop-Change: ${id}`)
    expect(ash(['show', '--name-only', '--format=', p.commit!]).trim().split('\n').sort()).toEqual(['library/the-shared-lessons/_series.md', 'library/the-shared-lessons/x.md'])
    expect(existsSync(join(app, 'library', 'the-shared-lessons', 'x.md'))).toBe(true)
    // the loop's own records live in the app repo too (app/loop/records, since 2026-09-25): the fund repo got nothing
    expect(sh(['rev-parse', 'HEAD']).trim()).toBe(fundHead)
    expect(ash(['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').every(f => f.startsWith('loop/records/'))).toBe(true)

    // the revert runs in the app repo too, as a new commit
    const q = await revert(withApp(), id, 'owner changed their mind', 'owner')
    expect(q.state).toBe('reverted')
    expect(ash(['log', '-2', '--format=%H']).trim().split('\n')[1]).toBe(q.revert)   // then the records commit
    expect(ash(['log', '-1', '--format=%B', q.revert!])).toContain(`Reverts: ${p.commit}`)
    expect(existsSync(join(app, 'library', 'the-shared-lessons', 'x.md'))).toBe(false)
  })

  it('writes one metrics row per closed day to app/loop/records/metrics.jsonl, once', async () => {
    await turns('dash:a', T0 - 2 * DAY, 4, 1)
    await pass(ctx(), 'manual')
    await pass(ctx(), 'manual')
    const lines = readFileSync(join(dir, 'app', 'loop', 'records', 'metrics.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toEqual([{ day: '2026-09-08', agent: 'dash:a', score: 0.75, turns: 4, errors: 1 }])
    const stored = (await ops.select('loop_metrics', { where: { agent_id: 'dash:a', metric: 'score' } }))[0]
    expect(stored.value).toBe(0.75)
    // committed by the loop in the pass that appended it, and only that file; the second pass appended nothing
    expect(sh(['status', '--porcelain', '--', 'app/loop/records/metrics.jsonl']).trim()).toBe('')
    expect(sh(['log', '--format=%s', '--', 'app/loop/records/metrics.jsonl']).trim().split('\n')).toEqual(['loop: metrics, 1 closed day row'])
    expect(sh(['log', '-1', '--format=%B', '--', 'app/loop/records/metrics.jsonl'])).toMatch(/Agent: loop\nLoop-Pass: /)
    expect(sh(['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('app/loop/records/metrics.jsonl')
  })
})
