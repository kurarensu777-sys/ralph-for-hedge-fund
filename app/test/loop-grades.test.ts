import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '../shared/types.ts'
import { Router } from '../server/http.ts'
import { clip, fnv1a, inSample, isLedger, isMachineLedger, nodash, reasonsFor, runChecks, tagged, windowed } from '../server/loop/grades.ts'
import * as M from '../server/loop/metrics.ts'
import { registerReview } from '../server/loop/review.ts'
import { db as store, ops, type Queryable } from '../server/db.ts'
import { resetStore } from './pg/reset.ts'
import { grade, gradesOf, queue, sweep, turns } from '../server/loop/turns.ts'
import { porcelainPaths } from '../server/loop/worktree.ts'

// Everything on this file's own database (test/pg), emptied where a suite wants a fresh one.
// Nothing here touches ~/fund-data or the live store.

const DASH = String.fromCharCode(0x2014), EN = String.fromCharCode(0x2013)
const T0 = Date.parse('2026-09-20T10:00:00Z')

/** a fresh (emptied) store; the handle every call below takes */
async function fresh(): Promise<Queryable> {
  await resetStore()
  return store
}

/** one turn: the owner's message, the assistant text, optional Edit/Write tools, then 'turn done' */
async function addTurn(db: Queryable, conv: string, at: number, text: string, o: { agent?: string; tools?: string[] } = {}) {
  const agent = o.agent ?? 'dash:a'
  await ops.indexMessage(conv, 'user', 'go', { ts: at }, db)
  await ops.indexMessage(conv, 'assistant', text, { ts: at + 10 }, db)
  for (const t of o.tools ?? []) await ops.logEvent('tool', t, { agent, conversation: conv, ts: at + 5 }, db)
  await ops.logEvent('turn', 'turn done - 10 in / 1 out', { agent, conversation: conv, ts: at + 20 }, db)
}

/** a conversation id whose turn 0 is (or is not) in the 5% sample */
function convSampled(want: boolean): string {
  for (let i = 0; i < 10_000; i++) if (inSample(`c-${i}`, 0) === want) return `c-${i}`
  throw new Error('no id')
}

describe('checks', () => {
  it('nodash flags em and en dashes, not hyphens', () => {
    expect(nodash(`a ${DASH} b`)).toHaveLength(1)
    expect(nodash(`2026-09-01${EN}2026-09-20`)).toHaveLength(1)
    expect(nodash('a - b, 2026-09-01..2026-09-20')).toHaveLength(0)
    const s = nodash(`x${DASH}y`)[0]
    expect([s.start, s.end]).toEqual([1, 2])
  })

  it('nodash reads prose only: dashes inside code are not flagged, like tagged and windowed', () => {
    expect(nodash(`see \`a ${DASH} b\` here`)).toHaveLength(0)
    expect(nodash(`\`\`\`\nx = "${EN}"\n\`\`\`\nok`)).toHaveLength(0)
    const r = nodash(`\`${DASH}\` then ${DASH}`)
    expect(r).toHaveLength(1)
    expect(r[0].start).toBe(9)
  })

  it('tagged needs a provenance tag near a %, $ or bp figure', () => {
    expect(tagged('funding was 12.4% on the day')).toHaveLength(1)
    expect(tagged('it cost $1,200 in fees')).toHaveLength(1)
    expect(tagged('fees are 4.5 bp per side')).toHaveLength(1)
    expect(tagged('funding was 12.4% [V] on the day')).toHaveLength(0)
    expect(tagged('it cost $1,200 [API] in fees')).toHaveLength(0)
    expect(tagged('[1] fees are 4.5bp per side')).toHaveLength(0)
    expect(tagged('[U] 12 bps')).toHaveLength(0)
    // the tag must be on the same line
    expect(tagged('fees 4.5bp\n[V]')).toHaveLength(1)
    // a number with no unit, and numbers in code, are not figures
    expect(tagged('ran 3 books and 12 turns')).toHaveLength(0)
    expect(tagged('see `x = 12%`')).toHaveLength(0)
  })

  it('windowed needs a date or window near a return figure', () => {
    expect(windowed('the book returned +8.3% ann')).toHaveLength(1)
    expect(windowed('APR 14.7%')).toHaveLength(1)
    expect(windowed('+26.4%/yr on the carry')).toHaveLength(1)
    expect(windowed('the book returned +8.3% ann over 70 d')).toHaveLength(0)
    expect(windowed('APR 14.7% from 2026-07-15 to 2026-09-22')).toHaveLength(0)
    expect(windowed('+26.4%/yr on the 30d window')).toHaveLength(0)
    // a % that is not a return is not this check's business
    expect(windowed('the fee is 0.05% per fill')).toHaveLength(0)
  })

  it('runChecks returns every check, spans point at the text', () => {
    const text = `made 12% ann ${DASH} good`
    const r = runChecks(text)
    expect(r.nodash).toHaveLength(1)
    expect(r.tagged).toHaveLength(1)
    expect(r.windowed).toHaveLength(1)
    expect(text.slice(r.tagged[0].start, r.tagged[0].end)).toBe('12%')
  })

  it('clip keeps spans aligned to the excerpt', () => {
    const text = 'a'.repeat(5000) + 'X 5%' + 'b'.repeat(100)
    const r = runChecks(text)
    const c = clip(text, r.tagged, 1000)
    expect(c.excerpt.length).toBeLessThanOrEqual(1003)
    expect(c.spans).toHaveLength(1)
    expect(c.excerpt.slice(c.spans[0].start, c.spans[0].end)).toBe('5%')
  })
})

describe('sample and reasons', () => {
  it('the sample is deterministic and about 5%', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'))
    expect(inSample('c-x', 3)).toBe(inSample('c-x', 3))
    let n = 0
    for (let i = 0; i < 4000; i++) if (inSample(`conv-${i}`, i % 7)) n++
    expect(n / 4000).toBeGreaterThan(0.03)
    expect(n / 4000).toBeLessThan(0.07)
  })

  it('ledger paths', () => {
    for (const p of ['lab/x/results-log.md', 'beliefs.md', 'lab\\y\\mechanics.md', 'menu.md', 'lab/x/data/runs.jsonl']) expect(isLedger(p)).toBe(true)
    for (const p of ['runs.jsonl', 'lab/x/notes.md', 'lab/x/data/runs.json', 'board/B-0001.md']) expect(isLedger(p)).toBe(false)
  })

  it('reasons: failed, ledger, sample', () => {
    const clean = runChecks('all good here')
    const c = convSampled(false)
    expect(reasonsFor(c, 0, clean, [])).toEqual([])
    expect(reasonsFor(c, 0, runChecks(`x ${DASH} y`), [])).toEqual(['failed'])
    expect(reasonsFor(c, 0, clean, ['lab/d/results-log.md'])).toEqual(['ledger'])
    expect(reasonsFor(convSampled(true), 0, clean, [])).toEqual(['sample'])
  })
})

describe('sweep and queue', () => {
  let db: Queryable
  beforeEach(async () => { db = await fresh() })

  it('turn index counts turn done events, a rewind is a boundary only', async () => {
    const c = convSampled(false)
    await addTurn(db, c, T0, 'one')
    await ops.logEvent('turn', 'rewound', { agent: 'dash:a', conversation: c, ts: T0 + 100 }, db)
    await addTurn(db, c, T0 + 200, 'two')
    const ts = await turns(db, c)
    expect(ts.map(t => t.ix)).toEqual([0, 1])
    expect(ts[1].from).toBe(T0 + 100)
  })

  it('a clean, unsampled turn is checked but not queued; a failing one is queued once', async () => {
    const c = convSampled(false)
    await addTurn(db, c, T0, 'all good here')
    await addTurn(db, c, T0 + 1000, `made 12% ann ${DASH} fine`)
    const r = await sweep(db)
    expect(r.checked).toBe(2)
    const q = await queue(db)
    const mine = q.items.filter(i => i.conv === c)
    expect(mine.map(i => i.turn)).toEqual(inSample(c, 1) ? [1] : [1])
    expect(mine[0].reasons).toContain('failed')
    expect(mine[0].failed.sort()).toEqual(['nodash', 'tagged', 'windowed'])
    expect(mine[0].excerpt.slice(mine[0].spans[0].start, mine[0].spans[0].end)).toMatch(new RegExp(`12%|${DASH}`))
    // a second sweep does nothing new
    expect((await sweep(db)).checked).toBe(0)
  })

  it('a turn that wrote a ledger is queued: from tool rows and from git commits', async () => {
    const c = convSampled(false)
    await addTurn(db, c, T0, 'all good here', { tools: ['Edit results-log.md'] })
    await addTurn(db, c, T0 + 5000, 'all good here')
    await addTurn(db, c, T0 + 10_000, 'all good here', { tools: ['Write notes.md'] })
    const r = await sweep(db, { changesFor: async () => [{ ts: T0 + 5000, files: ['lab/d/data/runs.jsonl'] }] })
    expect(r.checked).toBe(3)
    const mine = (await queue(db)).items.filter(i => i.conv === c && !(i.reasons.length === 1 && i.reasons[0] === 'sample'))
    expect(mine.map(i => i.turn).sort()).toEqual([0, 1])
    expect(mine.every(i => i.reasons.includes('ledger'))).toBe(true)
  })
})

describe('B-0022: clipped turns, shell ledgers', () => {
  let db: Queryable
  beforeEach(async () => { db = await fresh() })

  it('failed chips come from the check rows: a long turn clipped past its failures keeps them', async () => {
    const c = convSampled(false)
    // a dash at the very start, an untagged figure 6,000 chars later: the 4,000-char excerpt cannot hold both
    await addTurn(db, c, T0, `a ${DASH} b ` + 'x '.repeat(3000) + ' fees 12bp')
    await sweep(db)
    const it = (await queue(db)).items.find(i => i.conv === c)!
    expect(new Set(it.spans.map(s => s.check)).size).toBeLessThan(2)
    expect(it.failed).toEqual(['nodash', 'tagged'])
  })

  it('an uncommitted ledger write inside a turn queues it; outside the window or not a ledger, no', async () => {
    const c = convSampled(false)
    await addTurn(db, c, T0, 'all good here')
    await addTurn(db, c, T0 + 5000, 'all good here')
    await addTurn(db, c, T0 + 10_000, 'all good here')
    const r = await sweep(db, { dirty: async () => [
      { path: 'lab/d/data/runs.jsonl', mtime: T0 + 5010 },        // turn 1: its window is (T0+20, T0+5020]
      { path: 'lab/d/notes.md', mtime: T0 + 10_010 },             // not a ledger
      { path: 'floor/no-lesson.jsonl', mtime: T0 + 10_010 },      // a .jsonl, but not a desk ledger
    ] })
    expect(r.checked).toBe(3)
    const led = (await queue(db)).items.filter(i => i.conv === c && i.reasons.includes('ledger'))
    expect(led.map(i => i.turn)).toEqual([1])
    expect(led[0].detail.ledger).toBe('lab/d/data/runs.jsonl')
  })

  it('a probe append to another desk\'s snapshots.jsonl inside a turn does not queue it', async () => {
    const c = convSampled(false)
    await addTurn(db, c, T0, 'ok', { agent: 'research' })
    const scopes = [
      { id: 'research', writes: ['research/', 'lab/research/', 'lab/predmkts/'] },
      { id: 'platform', writes: ['lab/platform/'] },
    ]
    const r = await sweep(db, { scopes, dirty: async () => [
      { path: 'lab/platform/store/data/snapshots.jsonl', mtime: T0 + 15 },   // the probe tick, inside the turn
      { path: 'lab/research/data/snapshots.jsonl', mtime: T0 + 15 },         // own desk, but still machine-written
      { path: 'lab/platform/data/runs.jsonl', mtime: T0 + 15 },              // another desk's ledger: not this agent's write
    ] })
    expect(r.checked).toBe(1)
    expect((await queue(db)).items.filter(i => i.conv === c && i.reasons.includes('ledger'))).toEqual([])
  })

  it('an uncommitted ledger inside the turn agent\'s own scope still queues it', async () => {
    const c = convSampled(false)
    await addTurn(db, c, T0, 'ok', { agent: 'research' })
    await sweep(db, { scopes: [{ id: 'research', writes: ['lab/research/'] }], dirty: async () => [{ path: 'lab/research/data/runs.jsonl', mtime: T0 + 15 }] })
    const led = (await queue(db)).items.filter(i => i.conv === c && i.reasons.includes('ledger'))
    expect(led.map(i => i.detail.ledger)).toEqual(['lab/research/data/runs.jsonl'])
  })

  it('isMachineLedger: data/snapshots.jsonl only', () => {
    expect(isMachineLedger('lab/platform/store/data/snapshots.jsonl')).toBe(true)
    expect(isMachineLedger('lab\\d\\data\\snapshots.jsonl')).toBe(true)
    expect(isMachineLedger('lab/d/data/runs.jsonl')).toBe(false)
  })

  it('a failing worktree read is an error, not a crash', async () => {
    const c = convSampled(false)
    await addTurn(db, c, T0, 'all good here')
    const r = await sweep(db, { dirty: async () => { throw new Error('no git') } })
    expect(r.checked).toBe(1)
    expect(r.errors[0]).toMatch(/worktree: no git/)
  })

  it('porcelain -z paths, renames skip their old path', () => {
    expect(porcelainPaths(' M lab/d/data/runs.jsonl\0?? lab/e/results-log.md\0R  new.md\0old.md\0')).toEqual(['lab/d/data/runs.jsonl', 'lab/e/results-log.md', 'new.md'])
  })
})

describe('owner grades and the taste component', () => {
  let db: Queryable
  beforeEach(async () => { db = await fresh() })
  const agents = [{ id: 'dash:a', writes: [] }] as unknown as Agent[]

  it('taste is absent, not zero, on a day with no owner grades', async () => {
    const c = convSampled(false)
    await addTurn(db, c, T0, 'fine')
    const acc = await M.collect({ db, fundRoot: join(__dirname, 'no-such-fund'), agents }, T0 - 86_400_000, T0 + 86_400_000)
    const row = M.toRows(acc)[0]
    expect(row.counts.turns).toBe(1)
    expect(M.components(row.counts).taste).toBeNull()
    expect(M.components(row.counts).reliability).toBe(1)
  })

  it('owner good / bad become counts on the turn day and move the score', async () => {
    const c = convSampled(false)
    await addTurn(db, c, T0, 'a')
    await addTurn(db, c, T0 + 1000, 'b')
    await grade(db, { conv: c, turn: 0, value: 'good' })
    await grade(db, { conv: c, turn: 1, value: 'bad', label: 'no window' })
    const row = M.toRows(await M.collect({ db, fundRoot: join(__dirname, 'no-such-fund'), agents }, T0 - 86_400_000, T0 + 86_400_000))[0]
    expect(row.counts.owner_good).toBe(1)
    expect(row.counts.owner_bad).toBe(1)
    expect(M.components(row.counts).taste).toBe(0.5)
    expect(row.score).toBeCloseTo((1 + 0.5) / 2)
    const g = await gradesOf(db, c)
    expect(g.map(x => x.owner)).toEqual([1, 0])
    expect(g[1].label).toBe('no window')
  })

  it('refuses a bad label, a bad value and a turn that does not exist', async () => {
    const c = convSampled(false)
    await addTurn(db, c, T0, 'a')
    await expect(grade(db, { conv: c, turn: 0, value: 'good', label: 'nice' })).rejects.toThrow(/label/)
    await expect(grade(db, { conv: c, turn: 0, value: 'meh' })).rejects.toThrow(/value/)
    await expect(grade(db, { conv: c, turn: 9, value: 'good' })).rejects.toThrow(/no turn/)
  })
})

describe('API round trip: grade and undo', () => {
  let server: Server
  let base = ''
  let db: Queryable
  const published: string[] = []
  const c = convSampled(false)
  beforeAll(async () => {
    db = await fresh()
    await addTurn(db, c, T0, `returned 9% ann ${DASH} ok`)
    const r = new Router()
    registerReview(r, { db, sweep: () => sweep(db), publish: t => { published.push(t) } })
    server = createServer((req, res) => { r.handle(req, res).then(hit => { if (!hit) { res.statusCode = 404; res.end() } }) })
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
    base = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(() => server.close())
  const post = (body: unknown) => fetch(`${base}/api/loop/grade`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('queue -> grade -> done -> undo -> open', async () => {
    let q = await (await fetch(`${base}/api/loop/queue`)).json()
    expect(q.open).toBe(1)
    expect(q.items[0]).toMatchObject({ conv: c, turn: 0, state: 'open', grade: null })

    const g = await post({ conv: c, turn: 0, value: 'bad', label: 'style' })
    expect(g.status).toBe(200)
    expect(await g.json()).toEqual({ conv: c, turn: 0, value: 0, label: 'style' })
    expect(published).toContain('loop')
    q = await (await fetch(`${base}/api/loop/queue`)).json()
    expect(q.open).toBe(0)
    expect(q.items[0]).toMatchObject({ state: 'done', grade: { value: 0, label: 'style' } })
    let dots = await (await fetch(`${base}/api/loop/grades?conv=${c}`)).json()
    expect(dots.turns[0]).toMatchObject({ turn: 0, owner: 0, label: 'style', checked: true })

    const u = await post({ conv: c, turn: 0, value: null })
    expect(u.status).toBe(200)
    q = await (await fetch(`${base}/api/loop/queue`)).json()
    expect(q.open).toBe(1)
    expect(q.items[0].grade).toBeNull()
    dots = await (await fetch(`${base}/api/loop/grades?conv=${c}`)).json()
    expect(dots.turns[0].owner).toBeNull()
  })

  it('400 on a bad body, 404 on a missing turn', async () => {
    expect((await post({ conv: c, turn: 'x', value: 'good' })).status).toBe(400)
    expect((await post({ conv: c, turn: 5, value: 'good' })).status).toBe(404)
    expect((await fetch(`${base}/api/loop/grades`)).status).toBe(400)
  })
})
