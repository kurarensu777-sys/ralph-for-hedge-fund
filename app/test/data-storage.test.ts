import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import * as S from '../server/data/storage.ts'
import { budgetTone } from '../src/rooms/data/storage.tsx'

// THE STORAGE VIEW (B-0327): the cache and pins shapes read honestly, the evict phrase from the plan's
// own totals, and evict to budget against a FAKE store door (test/fixtures/store-fake.mjs) - never
// the real cache.

const H = 'a'.repeat(64)

describe('the cache and pins as the package serves them', () => {
  it('a cache reply with no budget is not a cache (NOT AVAILABLE upstream, never a zero)', () => {
    expect(S.shapeCache(null)).toBeNull()
    expect(S.shapeCache({ bytes: 5 })).toBeNull()
    const c = S.shapeCache({ root: 'r', max_bytes: 100, bytes: 120, datasets: [{ dataset: 'funding', bytes: 20 }, { dataset: 'candles', bytes: 100 }, { nope: 1 }] })!
    expect(c.over_budget).toBe(true)                                     // over the budget even when the flag is absent
    expect(c.datasets.map(d => d.dataset)).toEqual(['candles', 'funding'])
  })
  it('pins newest first; a row without a 64-hex hash is dropped', () => {
    const p = S.shapePins([{ hash: H, created_ms: 1, dataset: 'funding', venue: 'example_a', symbol: 'BTC', refs: [{ ref: 'lab/example:example-004', reason: 'result' }] },
      { hash: 'b'.repeat(64), created_ms: 5, dataset: 'candles', venue: 'example_b', symbol: 'xyz:ABC', interval: '1h' }, { hash: 'short' }])
    expect(p.map(r => r.created_ms)).toEqual([5, 1])
    expect(p[1].refs).toEqual([{ ref: 'lab/example:example-004', reason: 'result' }])
    expect(S.shapePins('nope')).toEqual([])
  })
  it('the budget tone: ok, amber from 90%, red over', () => {
    expect(budgetTone({ bytes: 50, max_bytes: 100 }).tone).toBe('ok')
    expect(budgetTone({ bytes: 90, max_bytes: 100 }).tone).toBe('warn')
    expect(budgetTone({ bytes: 101, max_bytes: 100 }).tone).toBe('fail')
    expect(budgetTone({ bytes: 1, max_bytes: 0 }).tone).toBe('warn')     // no budget read is never green
  })
  it('the package without the functions yet reads NOT AVAILABLE with the item that builds them', async () => {
    const s = await S.storage()
    if (!s.cache.available) expect(s.cache.reason).toMatch(/B-0324|did not answer/)
    if (!s.pins.available) expect(s.pins.reason).toMatch(/B-0324|did not answer/)
  })
})

describe('the evict phrase and the plan signature', () => {
  const e = (month: string, bytes: number) => ({ dataset: 'funding', venue: 'example_a', interval: null, month, bytes, last_read_ms: null })
  it('is built from the plan totals', () => {
    expect(S.evictPhrase({ evicted: [e('2026-03', 40_000_000), e('2026-04', 60_100_000)] })).toBe('evict 2 partitions 100.1 MB')
  })
  it('the signature ignores order and sees a moved partition', () => {
    expect(S.evictSig({ evicted: [e('2026-03', 1), e('2026-04', 1)] })).toBe(S.evictSig({ evicted: [e('2026-04', 9), e('2026-03', 9)] }))
    expect(S.evictSig({ evicted: [e('2026-03', 1)] })).not.toBe(S.evictSig({ evicted: [e('2026-05', 1)] }))
  })
  it('to_bytes is a whole number of bytes or none', () => {
    expect(S.parseTo({})).toBeNull()
    expect(S.parseTo({ to_bytes: 1024 })).toBe(1024)
    expect(() => S.parseTo({ to_bytes: -1 })).toThrow(/whole number/)
    expect(() => S.parseTo({ to_bytes: '5' })).toThrow(/whole number/)
  })
})

describe('evict to budget against the fake store door', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-storage-'))
  const log = join(dir, 'calls.jsonl')
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  process.env.FUND_STORE_CMD = JSON.stringify([process.execPath, resolve(__dirname, 'fixtures', 'store-fake.mjs')])
  process.env.FAKE_LOG = log
  beforeEach(() => { writeFileSync(log, ''); delete process.env.FAKE_EVICT_MONTH })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.FUND_STORE_CMD; delete process.env.FAKE_LOG })

  it('plans with a dry run: a key and the phrase, nothing evicted', async () => {
    const p: any = await S.evictPlan({})
    expect(p).toMatchObject({ available: true, phrase: 'evict 2 partitions 100.0 MB', max_bytes: 2_147_483_648 })
    expect(typeof p.key).toBe('string')
    expect(calls().map(c => c.args)).toEqual([['--evict', '--dry-run', '--json']])
  })
  it('refuses a wrong phrase without a child, then evicts ONCE after a matching second dry run', async () => {
    const p: any = await S.evictPlan({ to_bytes: 1_000 })
    writeFileSync(log, '')
    await expect(S.evictApply({ key: p.key, phrase: 'evict 9 partitions 1.0 MB' })).rejects.toMatchObject({ status: 400 })
    expect(calls()).toEqual([])
    const r: any = await S.evictApply({ key: p.key, phrase: p.phrase.toUpperCase() })
    expect(r).toMatchObject({ ok: true, partitions: 2, bytes: 100_000_000 })
    expect(calls().map(c => c.args)).toEqual([['--evict', '--to', '1000', '--dry-run', '--json'], ['--evict', '--to', '1000', '--json']])
    await expect(S.evictApply({ key: p.key, phrase: p.phrase })).rejects.toMatchObject({ status: 409 })   // one apply per plan
  })
  it('refuses when the cache moved since the plan (the second dry run differs): nothing evicted', async () => {
    const p: any = await S.evictPlan({})
    writeFileSync(log, '')
    process.env.FAKE_EVICT_MONTH = '2026-05'
    await expect(S.evictApply({ key: p.key, phrase: p.phrase })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/moved/) })
    expect(calls().map(c => c.args)).toEqual([['--evict', '--dry-run', '--json']])
  })
  it('a forged or unknown key is refused', async () => {
    await expect(S.evictApply({ key: 'forged', phrase: 'evict 2 partitions 100.0 MB' })).rejects.toMatchObject({ status: 409 })
  })
})
