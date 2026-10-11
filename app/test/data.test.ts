import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Unavailable, readReply } from '../server/data/job.ts'
import { PlanBook, normPhrase, retentionId, retentionPhrase } from '../server/data/plans.ts'
import * as A from '../server/data/archive.ts'
import { refuseRequest } from '../server/gate.ts'
import { fmtBytes } from '../src/rooms/data/model.ts'

// THE DATA ROOM (B-0290): the typed phrases, the plan book, the door's reply reading, and the
// server path against a FAKE store door (test/fixtures/store-fake.mjs) - never the real lake.

describe('the typed phrases', () => {
  it('compares a phrase typed with other spacing and case', () => {
    expect(normPhrase(' a  B\tc ')).toBe('a b c')
  })
  it('keeps the retention phrase and plan id stable whatever the item order', () => {
    const a = [{ from: 'b', to: 'y', bytes: 1_500_000 }, { from: 'a', to: 'x', bytes: 500_000 }]
    expect(retentionPhrase('tier', null, a)).toBe('tier 2 partitions 2.0 MB all')
    expect(retentionId('tier', 'candles', a)).toBe(retentionId('tier', 'candles', [...a].reverse()))
    expect(retentionId('tier', 'candles', a)).not.toBe(retentionId('tier', 'candles', [{ ...a[0], bytes: 1 }, a[1]]))
  })
})

describe('the plan book', () => {
  it('holds a plan until it expires, and forgets an unknown key', () => {
    let t = 1000
    const b = new PlanBook<string>(2, () => t)
    const k = b.put('p', 2000)
    expect(b.get(k)).toBe('p')
    expect(b.get('nope')).toBeNull()
    expect(b.get(42)).toBeNull()
    t = 2001
    expect(b.get(k)).toBeNull()
  })
  it('keeps only the newest plans', () => {
    const b = new PlanBook<number>(2)
    const k1 = b.put(1, Infinity); b.put(2, Infinity); b.put(3, Infinity)
    expect(b.get(k1)).toBeNull()
  })
})

describe("reading a door's reply", () => {
  const d = { cmd: 'x', args: [], cwd: '.', name: 'fund_db' }
  it('passes {ok:true} and a legacy object on exit 0; maps a refusal to its status', () => {
    expect(readReply(d, 0, 'log line\n{"ok":true,"n":1}\n', '')).toEqual({ ok: true, n: 1 })
    expect(readReply(d, 0, '{\n  "lake": {}\n}\n', '')).toEqual({ lake: {} })
    expect(() => readReply(d, 1, '{"ok":false,"status":409,"error":"stale plan"}', '')).toThrow(expect.objectContaining({ status: 409, message: 'stale plan' }))
    expect(() => readReply(d, 1, '{"ok":false,"status":200,"error":"odd"}', '')).toThrow(expect.objectContaining({ status: 500 }))
  })
  it('says NOT AVAILABLE for a missing module, and a 502 for a child that printed no JSON', () => {
    expect(() => readReply(d, 1, '', 'python.exe: No module named fund_db\n')).toThrow(Unavailable)
    expect(() => readReply(d, 2, '', 'fund_db: error: unrecognized arguments: --json\n')).toThrow(Unavailable)
    expect(() => readReply(d, 3, 'Traceback\nKeyError: x\n', '')).toThrow(expect.objectContaining({ status: 502 }))
  })
})

describe('every data route stays behind the one gate', () => {
  const req = (h: Record<string, string>) => ({ method: 'POST', url: '/api/data/retention/apply', headers: { host: '127.0.0.1:4689', 'content-length': '2', 'content-type': 'application/json', ...h } }) as any
  it('refuses a foreign origin, a foreign host and a form body', () => {
    expect(refuseRequest(req({ origin: 'https://evil.example' }), [4689])).toMatch(/origin/)
    expect(refuseRequest(req({ host: 'evil.example:4689' }), [4689])).toMatch(/host/)
    expect(refuseRequest(req({ 'content-type': 'text/plain' }), [4689])).toMatch(/content-type/)
    expect(refuseRequest(req({ origin: 'http://127.0.0.1:4688' }), [4688, 4689])).toBeNull()
  })
})

describe('the server path against the fake store door', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-data-'))
  const log = join(dir, 'calls.jsonl')
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  process.env.FUND_STORE_CMD = JSON.stringify([process.execPath, resolve(__dirname, 'fixtures', 'store-fake.mjs')])
  process.env.FAKE_LOG = log
  beforeEach(() => { writeFileSync(log, ''); delete process.env.FAKE_MISSING })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.FUND_STORE_CMD; delete process.env.FAKE_LOG })

  it('a retention plan is held: the page gets the key and the phrase from a dry run', async () => {
    const p: any = await A.retentionPlan({ kind: 'tier', dataset: 'candles' })
    expect(p).toMatchObject({ available: true, phrase: 'tier 2 partitions 3.0 MB candles', totals: { partitions: 2, bytes: 3_000_000 } })
    expect(typeof p.key).toBe('string')
    expect(calls().map(c => [c.cmd, ...c.args])).toEqual([['tier', '--dataset', 'candles', '--json']])
  })
  it('apply refuses a wrong phrase and an unknown key WITHOUT running the child', async () => {
    const p: any = await A.retentionPlan({ kind: 'prune', dataset: 'candles' })
    writeFileSync(log, '')
    await expect(A.retentionApply({ key: p.key, phrase: 'prune 9 partitions 1.0 MB candles' })).rejects.toMatchObject({ status: 400 })
    await expect(A.retentionApply({ key: 'forged', phrase: p.phrase })).rejects.toMatchObject({ status: 409 })
    expect(calls()).toEqual([])
  })
  it('refuses a kind or a dataset it does not know before any child runs', async () => {
    await expect(A.retentionPlan({ kind: 'delete' })).rejects.toMatchObject({ status: 400 })
    await expect(A.retentionPlan({ kind: 'tier', dataset: '--apply' })).rejects.toMatchObject({ status: 400 })
    expect(calls()).toEqual([])
  })
  it('a retention apply that stops part-way names what already moved', async () => {
    const p: any = await A.retentionPlan({ kind: 'tier', dataset: 'partial' })
    expect(p).toMatchObject({ available: true, phrase: 'tier 2 partitions 3.0 MB partial' })
    await expect(A.retentionApply({ key: p.key, phrase: p.phrase })).rejects.toMatchObject({
      status: 500, message: expect.stringMatching(/destination differs - 1 partition\(s\) \(1\.0 MB\) had already moved: market\/candles\/venue=x\/month=2026-01/) })
    const ok: any = await A.retentionPlan({ kind: 'tier', dataset: 'candles' })
    expect(await A.retentionApply({ key: ok.key, phrase: ok.phrase })).toMatchObject({ partitions: 2, bytes: 3_000_000 })
  })
  it('a missing module reads NOT AVAILABLE, never an empty list', async () => {
    process.env.FAKE_MISSING = '1'
    expect(await A.usage(true)).toMatchObject({ available: false, reason: expect.stringMatching(/not there yet/) })
    await expect(A.retentionPlan({ kind: 'tier' })).resolves.toMatchObject({ available: false })
  })
})

describe('bytes read as the CLI prints them (B-0335)', () => {
  it('is decimal: the 500 MB cache budget reads 500 MB, not 477', () => {
    expect(fmtBytes(500_000_000)).toBe('500 MB')
    expect(fmtBytes(18_665_550)).toBe('18.7 MB')
    expect(fmtBytes(2_147_483_648)).toBe('2.1 GB')
    expect(fmtBytes(999)).toBe('999 B')
    expect(fmtBytes(null)).toBe('-')
  })
  it('the check can fail: a 1024-based reading of the same budget is not 500 MB', () => {
    const binary = (n: number) => { let v = n, i = 0; while (v >= 1024 && i < 3) { v /= 1024; i++ } return `${v.toFixed(v >= 100 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB'][i]}` }
    expect(binary(500_000_000)).toBe('477 MB')
    expect(binary(500_000_000)).not.toBe(fmtBytes(500_000_000))
  })
})
