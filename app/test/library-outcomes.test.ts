import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseAgentFile, serializeAgentFile } from '../shared/agentfile.ts'

// A fixture fund + database: conversations, pulls, events and commits written by hand, so every
// grade below is a reading of a known history.
const ROOT = mkdtempSync(join(tmpdir(), 'liboutcomes-'))
process.env.FUND_ROOT = ROOT
process.env.FUND_DATA_DIR = join(ROOT, '.data')

const w = (rel: string, text: string) => { mkdirSync(join(ROOT, rel, '..'), { recursive: true }); writeFileSync(join(ROOT, rel), text) }
const DAY = 86_400_000
const boots = (id: string) => parseAgentFile(readFileSync(join(ROOT, 'app', 'agents', `${id}.md`), 'utf8')).header.boot
const NOW = Date.now()

let db: typeof import('../server/db.ts')
let O: typeof import('../server/library/outcomes.ts')
let core: typeof import('../server/library/core.ts')

const AGENTS = [
  { id: 'a1', name: 'a1', kind: 'standing', mode: 'active', dept: 'HQ', role: 'r', cwd: '.', writes: ['app/library/'], model: 'haiku', effort: 'low', boot: ['app/library/law/s/bad.md', 'app/library/law/s/good.md'] },
  { id: 'a2', name: 'a2', kind: 'standing', mode: 'active', dept: 'HQ', role: 'r', cwd: '.', writes: ['app/library/'], model: 'haiku', effort: 'low', boot: ['app/library/law/s/bad.md'] },
]

beforeAll(async () => {
  // the roster, one app/agents/<id>.md each; the one shelf, law, is DERIVED from app/library/law
  for (const a of AGENTS) w(`app/agents/${a.id}.md`, serializeAgentFile(a, `# ${a.id}\n`))
  for (const b of ['bad', 'good', 'thin', 'lone']) w(`app/library/law/s/${b}.md`, `# ${b}\n\nbody of ${b}\n`)
  execFileSync('git', ['init', '-q'], { cwd: ROOT })
  db = await import('../server/db.ts')
  O = await import('../server/library/outcomes.ts')
  core = await import('../server/library/core.ts')
  const { ops } = db
  const conv = (id: string) => ops.insert('conversations', { id, agent_id: 'a1', title: id, state: 'closed', started_at: NOW - 20 * DAY, last_at: NOW - 10 * DAY })
  const pull = (c: string, book: string, ts: number) => ops.recordRead('a1', `app/library/law/s/${book}.md`, { conversationId: c, atBoot: false, ts })
  const commit = (sha: string, c: string | null, subject: string, ts: number, loop: string | null = null) =>
    ops.insert('commits', { repo: 'fund', sha, ts, subject, conversation_id: c, loop_change: loop })
  // ten conversations: h1..h3 harmful three different ways, g1..g3 helpful, n1..n4 neutral
  for (const c of ['h1', 'h2', 'h3', 'g1', 'g2', 'g3', 'n1', 'n2', 'n3', 'n4']) await conv(c)
  await ops.logEvent('turn', 'reverted 2 commits of h1', { conversation: 'h1', ts: NOW - 9 * DAY })
  await ops.logEvent('error', 'boom', { conversation: 'h2', ts: NOW - 9 * DAY })
  await commit('s-h3', 'h3', 'library: a change', NOW - 12 * DAY)
  await commit('s-rv', null, 'Revert "library: a change"', NOW - 11 * DAY, 'L-001')
  for (const c of ['g1', 'g2', 'g3']) await commit(`s-${c}`, c, `work ${c}`, NOW - 9 * DAY)
  await commit('s-n1', 'n1', 'too young to judge', NOW - 1 * DAY)
  // bad.md: pulled by h1 h2 h3 g1 (+ a paged re-read by h1 inside 60 s, and a real second pull by h1 later)
  for (const c of ['h1', 'h2', 'h3', 'g1']) await pull(c, 'bad', NOW - 10 * DAY)
  await pull('h1', 'bad', NOW - 10 * DAY + 20_000)
  await pull('h1', 'bad', NOW - 10 * DAY + 3_600_000)
  // good.md: g1 g2 g3 h1
  for (const c of ['g1', 'g2', 'g3', 'h1']) await pull(c, 'good', NOW - 10 * DAY)
  // thin.md: harmful but n = 2 (below the threshold)
  for (const c of ['h1', 'h2']) await pull(c, 'thin', NOW - 10 * DAY)
  // a boot load never counts
  await ops.recordRead('a1', 'app/library/law/s/good.md', { conversationId: 'n2', atBoot: true, ts: NOW - 10 * DAY })
})

afterAll(() => { core?.stopLibrary(); rmSync(ROOT, { recursive: true, force: true }) })

describe('grading', () => {
  it('grades each conversation by what happened in it', async () => {
    const g = await O.gradeConversations(db.db, NOW)
    expect(g.get('h1')?.outcome).toBe('harmful')
    expect(g.get('h2')?.outcome).toBe('harmful')
    expect(g.get('h3')?.outcome).toBe('harmful')   // loop-reverted commit
    expect(g.get('g1')?.outcome).toBe('helpful')
    expect(g.get('n1')?.outcome).toBe('neutral')   // its commit is younger than 7 days
    expect(g.get('n4')?.outcome).toBe('neutral')
  })
  it('the base rate is the harmful share of every conversation', async () => {
    expect(O.baseRate(await O.gradeConversations(db.db, NOW))).toBeCloseTo(3 / 10)
    expect(O.baseRate(new Map())).toBeNull()
  })
  it('joins pulls to sessions, collapsing paged reads', async () => {
    const per = await O.bookOutcomes(db.db, await O.gradeConversations(db.db, NOW))
    expect(per.get('app/library/law/s/bad.md')).toEqual({ pulls: 5, n: 4, helpful: 1, harmful: 3, net: (1 - 3) / 4 })
    expect(per.get('app/library/law/s/good.md')).toEqual({ pulls: 4, n: 4, helpful: 3, harmful: 1, net: 0.5 })
    expect(per.get('app/library/law/s/thin.md')?.n).toBe(2)
    expect(per.has('app/library/law/s/lone.md')).toBe(false)
  })
  it('queues only net < 0 at n >= 3 with a harmful rate above base', async () => {
    const per = await O.bookOutcomes(db.db, await O.gradeConversations(db.db, NOW))
    expect(O.harmCandidates(per, 0.3)).toEqual(['app/library/law/s/bad.md'])
    expect(O.harmCandidates(per, 0.8)).toEqual([])        // 3/4 is not above an 80% base
    expect(O.harmCandidates(per, null)).toEqual([])
  })
  it('the payload: harm row first, the unread half honest about its ledger', async () => {
    const p = await core.bookOutcomesPayload()
    expect(p.sessions).toBe(10)
    expect(p.queue.filter(q => q.reason === 'harm').map(q => q.path)).toEqual(['app/library/law/s/bad.md'])
    expect(p.unreadNote).toMatch(/ledger is .* days old/)
  })
})

describe('retire', () => {
  const bad = 'app/library/law/s/bad.md'
  it('removes the book from every boot list and never touches the file', async () => {
    const before = readFileSync(join(ROOT, bad), 'utf8')
    const r = await core.retireBook(bad, 'hurts more than it helps')
    expect(r.from.sort()).toEqual(['a1', 'a2'])
    expect(boots('a1')).toEqual(['app/library/law/s/good.md'])
    expect(boots('a2')).toEqual([])
    expect(readFileSync(join(ROOT, bad), 'utf8')).toBe(before)
    const p = await core.bookOutcomesPayload()
    expect(p.queue.some(q => q.path === bad)).toBe(false)
    expect(p.cold).toEqual([expect.objectContaining({ path: bad, n: 4, note: 'hurts more than it helps' })])
    expect((await core.listBooks()).books.find(b => b.path === bad)?.mark).toEqual(expect.objectContaining({ state: 'cold', n: 4 }))
  })
  it('unretire drops the mark and puts it back where it was', async () => {
    const r = await core.unretireBook(bad)
    expect(r.to.sort()).toEqual(['a1', 'a2'])
    expect(boots('a2')).toEqual([bad])
    expect((await core.listBooks()).books.find(b => b.path === bad)?.mark).toBeUndefined()
    await expect(core.unretireBook(bad)).rejects.toThrow(/not retired/)
  })
  it('refuses a path that is not a book', async () => {
    await expect(core.retireBook('app/library/law/s/nope.md', '')).rejects.toThrow(/no book/)
  })
})
