import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// THE SPEND CAP (server/system/cap.ts) + the BURN ALERT (server/system/burn.ts), on a scratch
// database and a scratch fund root whose agents.json carries the ceilings. The runner and auto-pickup
// call sites live in files this room does not own: those two tests run once the one-line call
// sites are in (they skip, and say so, until then).

const TMP = mkdtempSync(join(tmpdir(), 'system-cap-'))
process.env.FUND_DATA_DIR = join(TMP, 'data')
process.env.FUND_ROOT = join(TMP, 'fund')
process.env.USERPROFILE = join(TMP, 'home')
process.env.HOME = join(TMP, 'home')
mkdirSync(join(TMP, 'fund'), { recursive: true })
mkdirSync(join(TMP, 'fund', 'board'), { recursive: true })
writeFileSync(join(TMP, 'fund', 'agents.json'), JSON.stringify({
  agents: [{ id: 'tester', budgetTokensPerDay: 1000 }, { id: 'free' }],
}))

const AGENTS: Record<string, any> = {
  tester: { id: 'tester', name: 'tester', kind: 'standing', mode: 'active', dept: 'Test', role: 'tests', cwd: '.', writes: [], model: 'haiku', effort: 'low', boot: [] },
  free: { id: 'free', name: 'free', kind: 'standing', mode: 'active', dept: 'Test', role: 'tests', cwd: '.', writes: [], model: 'haiku', effort: 'low', boot: [] },
}
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => { throw new Error('no conversation is ever started here') } }))
vi.mock('../server/config.ts', async () => {
  const { readFileSync } = await import('node:fs')
  // the ceilings are read from the scratch roster, exactly as the real agentsDoc() reads the root agents.json
  return { agent: (id: string) => AGENTS[id], agents: () => Object.values(AGENTS), config: { agents: () => Object.values(AGENTS) },
    agentsDoc: () => JSON.parse(readFileSync(join(TMP, 'fund', 'agents.json'), 'utf8')) }
})

const { ops } = await import('../server/db.ts')
const { query } = await import('@fund/db')
const { resetStore } = await import('./pg/reset.ts')
const CAP = await import('../server/system/cap.ts')
const { burnAlerts, checkBurn, recentBurn, BURN_FLOOR } = await import('../server/system/burn.ts')
const { HttpError } = await import('../server/http.ts')

const NOW = new Date(2026, 8, 24, 15, 0, 0).getTime()
const use = (agent: string, ts: number, tokens: number) => ops.addUsage(null, agent, { tokensIn: tokens, ts })

beforeEach(async () => { await resetStore(); CAP.resetLifts() })

describe('the store', () => {
  it('the three alert tables are in the ops schema, and database/ migrated it (the shared ledger)', async () => {
    const t = (await query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'ops'")).map(x => x.name)
    expect(t).toEqual(expect.arrayContaining(['spend_alerts', 'alert_rules', 'alert_log']))
    expect((await query<{ n: number }>("SELECT count(*)::int AS n FROM public.fund_migrations WHERE track = 'ops'"))[0].n).toBeGreaterThan(0)
  })
})

describe('capState', () => {
  it('an agent with no ceiling is never capped and gets no invented limit', async () => {
    await use('free', NOW - 1000, 10_000_000)
    expect(await CAP.capState('free', NOW)).toBeNull()
    expect(await CAP.canSpend('free', NOW)).toBe(true)
    await expect(CAP.spendGate('free', NOW)).resolves.toBeUndefined()
    expect(CAP.capOf(5, null)).toBeNull()
  })

  it('counts billable since LOCAL midnight: yesterday does not count', async () => {
    await use('tester', CAP.localMidnight(NOW) - 1, 5000)
    await use('tester', NOW - 1000, 400)
    expect(await CAP.capState('tester', NOW)).toEqual({ used: 400, ceiling: 1000, capped: false, lifted: false })
  })

  it('at the ceiling is capped, and the gate refuses with 429 "capped: used/ceiling"', async () => {
    await use('tester', NOW - 1000, 1000)
    expect((await CAP.capState('tester', NOW))?.capped).toBe(true)
    expect(await CAP.canSpend('tester', NOW)).toBe(false)
    let err: any = null
    try { await CAP.spendGate('tester', NOW) } catch (e) { err = e }
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(429)
    expect(err.message).toBe('capped: 1000/1000')
  })

  it('the owner lift holds for the rest of the local day only', async () => {
    await use('tester', NOW - 1000, 2000)
    CAP.liftCap('tester', NOW)
    expect(await CAP.capState('tester', NOW)).toMatchObject({ capped: false, lifted: true })
    const tomorrow = CAP.localMidnight(NOW) + 30 * 3_600_000
    await use('tester', tomorrow - 1000, 2000)
    expect((await CAP.capState('tester', tomorrow))?.capped).toBe(true)
  })
})

const runnerSrc = readFileSync(resolve(__dirname, '..', 'server', 'chat', 'runner.ts'), 'utf8')
const autoSrc = readFileSync(resolve(__dirname, '..', 'server', 'board', 'auto.ts'), 'utf8')

describe('enforcement', () => {
  it.skipIf(!/spendGate\(/.test(runnerSrc))('runner start refuses a capped agent with 429 (skips until chat/runner.ts calls spendGate)', async () => {
    await use('tester', Date.now() - 1000, 5000)
    const R = await import('../server/chat/runner.ts')
    let err: any = null
    try { await R.start('tester', 'hello') } catch (e) { err = e }
    expect(err?.status).toBe(429)
    expect(String(err?.message)).toMatch(/^capped: 5000\/1000$/)
  })

  it.skipIf(!/canSpend\(/.test(autoSrc))('auto tick skips a capped owner and leaves the item ready (skips until board/auto.ts takes canSpend)', async () => {
    await use('tester', Date.now() - 1000, 5000)
    const { tick, holdReason, resetAutoState } = await import('../server/board/auto.ts')
    const { createItem, readItem } = await import('../server/board/store.ts')
    resetAutoState()
    const dir = join(TMP, 'fund', 'board')
    const it1 = createItem(dir, { title: 'x', status: 'ready', owner: 'tester', labels: ['auto'] } as any)
    const agents = () => [{ id: 'tester', mode: 'active' }]
    const canSpend = await CAP.spendable(['tester'])           // the snapshot the board room hands auto.ts
    expect((holdReason as any)(readItem(dir, it1.id), [], agents(), () => true, canSpend)).toBe('capped')
    const startChat = vi.fn(async () => 'c1')
    const out = await tick({ dir, agents, stopped: () => false, attested: () => true, startChat, chatState: async () => 'live', canSpend } as any)
    expect(startChat).not.toHaveBeenCalled()
    expect(out.picked).toEqual([])
    expect(readItem(dir, it1.id).status).toBe('ready')
  })
})

describe('burnAlerts', () => {
  const H = 3_600_000
  const week = (agent: string, perHour: number) => Array.from({ length: 168 }, (_, i) => ({ agent, ts: NOW - H - (i + 1) * H + 60_000, billable: perHour }))

  it('stays quiet below the volume floor, even at 100x', () => {
    const rows = [...week('a', 1000), { agent: 'a', ts: NOW - 60_000, billable: 100_000 }]
    expect(BURN_FLOOR).toBe(200_000)
    expect(burnAlerts(rows, NOW)).toEqual([])
  })

  it('fires at 5x the trailing hourly median over the floor, not at 4.9x', () => {
    expect(burnAlerts([...week('a', 50_000), { agent: 'a', ts: NOW - 60_000, billable: 245_000 }], NOW)).toEqual([])
    const [a] = burnAlerts([...week('a', 50_000), { agent: 'a', ts: NOW - 60_000, billable: 250_000 }], NOW)
    expect(a).toMatchObject({ agent: 'a', billable: 250_000, median: 50_000, multiple: 5 })
  })

  it('a quiet week (median 0) has no multiple; the floor alone decides', () => {
    const [a] = burnAlerts([{ agent: 'a', ts: NOW - 60_000, billable: 300_000 }], NOW)
    expect(a.multiple).toBeNull()
  })

  it('fires at most once per agent per hour', () => {
    const rows = [...week('a', 10_000), { agent: 'a', ts: NOW - 60_000, billable: 900_000 }]
    expect(burnAlerts(rows, NOW, { a: NOW - 30 * 60_000 })).toEqual([])
    expect(burnAlerts(rows, NOW, { a: NOW - 61 * 60_000 })).toHaveLength(1)
  })

  it('spendable is canSpend for many agents at one read', async () => {
    await use('tester', NOW - 1000, 1000)
    await use('free', NOW - 1000, 10_000_000)
    const ok = await CAP.spendable(['tester', 'free'], NOW)
    expect([ok('tester'), ok('free'), ok('nobody')]).toEqual([false, true, true])
    expect([await CAP.canSpend('tester', NOW), await CAP.canSpend('free', NOW)]).toEqual([false, true])
  })

  it('checkBurn stores it, and the second pass inside the hour stays quiet', async () => {
    await use('tester', NOW - 60_000, 500_000)
    expect(await checkBurn(NOW)).toHaveLength(1)
    expect(await checkBurn(NOW + 10 * 60_000)).toHaveLength(0)
    expect((await recentBurn()).map(x => x.agent)).toEqual(['tester'])
  })
})
