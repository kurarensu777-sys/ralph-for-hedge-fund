import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allDesks, entryBlock, groupRuns, linkChains, loadAll, parseJsonl, preflightLine, stripFences } from '../server/lab/runs.ts'
import { chains, fpOf, sameWindow, truncated, type FpInput, type Fingerprint } from '../server/lab/fingerprint.ts'

const DAY = 86_400_000
const T0 = Date.parse('2026-09-14T00:00:00Z')

// shapes copied from the real ledger: an imported result (backfill.py) and the three stages
const IMPORTED = { run: '001', stage: 'result', desk: 'desks/api/lib/carry', ts: '2026-09-14T00:00:00Z', kind: 'import', mechanic: 'M1', preregistered: false, predicted: {}, headline: '+26.1% ann', metrics: { ann_pct: 26.1 }, verify: { passed: 16, suite: 'verify_carry_pro', total: 16 }, window: { from: '2026-02-20', to: '2026-09-13', hours: 4965, regimes: 1 } }
const PRE = { run: '009', stage: 'preflight', desk: 'd', ts: '2026-09-14T00:00:00Z', kind: 'explore', mechanic: 'M2', predicted: { ann_pct: '10..20' }, window: { from: '2026-07-01', to: '2026-09-01' } }
const RES = { run: '009', stage: 'result', desk: 'd', ts: '2026-09-14T00:00:00Z', kind: 'explore', mechanic: 'M2', predicted: { ann_pct: '10..20' }, metrics: { ann_pct: 14 }, verify: { suite: 'v', passed: 3, total: 3 }, headline: 'h', window: { from: '2026-07-01', to: '2026-09-01' } }
const READ7 = { run: '009', stage: 'read', age: '7d', desk: 'd', ts: '2026-09-21T10:00:00Z', state: 'on-time', metrics: { ann_pct: 12 } }

describe('run rows', () => {
  it('tolerates blank and broken lines and counts them', () => {
    const { rows, bad } = parseJsonl(`${JSON.stringify(IMPORTED)}\n\n{broken\n[1,2]\n`)
    expect(rows).toHaveLength(1)
    expect(bad).toBe(2)
  })
  it('an imported row is not preregistered, and keeps its window and verify', () => {
    const [r] = groupRuns('desks/api/lib/carry', [IMPORTED], T0 + DAY)
    expect(r.preregistered).toBe(false)
    expect(r.kind).toBe('import')
    expect(r.window?.hours).toBe(4965)
    expect(r.verify?.passed).toBe(16)
    expect(r.stage).toBe('result')
  })
  it('groups preflight, result and reads under one run', () => {
    const [r] = groupRuns('d', [PRE, RES, READ7], T0 + 8 * DAY)
    expect(r.preregistered).toBe(true)
    expect(r.predicted).toEqual({ ann_pct: '10..20' })
    expect(r.metrics).toEqual({ ann_pct: 14 })
    expect(r.reads['7d'].state).toBe('done')
    expect(r.reads['30d'].state).toBe('pending')
    expect(r.rows).toHaveLength(3)
  })
  it('a preflight alone has no reads due (nothing to re-read yet)', () => {
    const [r] = groupRuns('d', [PRE], T0 + 60 * DAY)
    expect(r.stage).toBe('preflight')
    expect(r.reads['7d'].state).toBe('none')
    expect(r.reads['7d'].due).toBeNull()
  })
})

describe('fixed-age reads', () => {
  const at = (days: number) => groupRuns('d', [RES], T0 + days * DAY)[0].reads
  it('due at result ts + 7d / + 30d', () => {
    expect(at(0)['7d'].due).toBe(T0 + 7 * DAY)
    expect(at(0)['30d'].due).toBe(T0 + 30 * DAY)
  })
  it('pending before, due on the day, late past the 4-day tolerance', () => {
    expect(at(6.9)['7d'].state).toBe('pending')
    expect(at(7)['7d'].state).toBe('due')
    expect(at(11)['7d'].state).toBe('due')
    expect(at(11.01)['7d'].state).toBe('late')
    expect(at(29)['30d'].state).toBe('pending')
    expect(at(31)['30d'].state).toBe('due')
  })
  it('a missed read row stays missed; a void run owes no read', () => {
    const missed = groupRuns('d', [RES, { ...READ7, state: 'missed' }], T0 + 40 * DAY)[0]
    expect(missed.reads['7d'].state).toBe('missed')
    const voided = groupRuns('d', [{ ...RES, void: 'truncated window' }], T0 + 40 * DAY)[0]
    expect(voided.reads['7d'].state).toBe('void')
    expect(voided.void).toBe('truncated window')
  })
})

describe('results-log', () => {
  const LOG = [
    '# log', '', '```', '### 001 - the fenced example', '**Pre-flight:** example', '```', '',
    '## Entries', '', '### 001 - real one - ran today', '', '- **Pre-flight:** mechanic M1 (explore) ·', '  predict: ann_pct 10..20', '- **Window:** a -> b', '',
    '### 002 - next', '- body',
  ].join('\n')
  it('fences blank to the same length', () => {
    expect(stripFences(LOG).length).toBe(LOG.length)
    expect(stripFences(LOG)).not.toContain('fenced example')
  })
  it('entry block skips the fenced example and stops at the next ###', () => {
    const e = entryBlock(LOG, '001')!
    expect(e.startsWith('### 001 - real one')).toBe(true)
    expect(e).not.toContain('### 002')
    expect(entryBlock(LOG, '002')).toContain('- body')
    expect(entryBlock(LOG, '003')).toBeNull()
  })
  it('the pre-flight line joins its wrapped lines', () => {
    expect(preflightLine(entryBlock(LOG, '001'))).toBe('mechanic M1 (explore) · predict: ann_pct 10..20')
    expect(preflightLine(null)).toBeNull()
  })
})

describe('desks on disk', () => {
  it('finds desks under a folder named data (the venue desks), skips a desk\'s own data/', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-lab-'))
    try {
      for (const d of ['lab/platform/data', 'lab/platform/data/hl', 'lab/platform/lib']) {
        mkdirSync(join(root, d, 'data'), { recursive: true })
        writeFileSync(join(root, d, 'cadence.md'), '# c\n')
      }
      mkdirSync(join(root, 'lab/platform/lib/data/nested'), { recursive: true })
      writeFileSync(join(root, 'lab/platform/lib/data/nested/cadence.md'), 'not a desk\n')
      writeFileSync(join(root, 'lab/platform/data/hl/data/runs.jsonl'), JSON.stringify({ ...IMPORTED, desk: 'desks/api/data/venues/hl' }) + '\n')
      expect(allDesks(root)).toEqual(['lab/platform/data', 'lab/platform/data/hl', 'lab/platform/lib'])
      const all = loadAll(root, T0)
      expect(all.find(d => d.desk === 'lab/platform/data/hl')!.runs).toHaveLength(1)
      expect(all.find(d => d.desk === 'lab/platform/lib')!.hasFile).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ---- the window fingerprint (tools/loop/fingerprint.py) ----
const H = 3_600_000
const JUL = Date.parse('2026-07-15T00:00:00Z')
const inp = (over: Partial<FpInput> = {}): FpInput => ({ venue: 'acme', symbol: 'xyz:ABC', dataset: 'candles', interval: '1h', first_ts: JUL, last_ts: JUL + 100 * H, rows: 101, sha256: 'a'.repeat(64), stored_first: JUL - 1000 * H, trunc: false, ...over })
const fp = (digest: string, inputs: FpInput[], from = JUL): Fingerprint => ({ digest, window: { from, to: from + 100 * H }, inputs })

describe('window fingerprint', () => {
  it('equal digest is the same window', () => {
    expect(sameWindow(fp('16e7d7a8', [inp()]), fp('16e7d7a8', [inp({ symbol: 'other' })]))).toBe(true)
  })
  it('same inputs with overlapping ranges are the same window, whatever the digest', () => {
    const a = fp('00000001', [inp()])
    const b = fp('00000002', [inp({ first_ts: JUL + 50 * H, last_ts: JUL + 300 * H, sha256: 'b'.repeat(64) })])
    expect(sameWindow(a, b)).toBe(true)
  })
  it('disjoint ranges, another series or another input set are not', () => {
    const a = fp('00000001', [inp()])
    expect(sameWindow(a, fp('00000002', [inp({ first_ts: JUL + 200 * H, last_ts: JUL + 300 * H })]))).toBe(false)
    expect(sameWindow(a, fp('00000003', [inp({ interval: '4h' })]))).toBe(false)
    expect(sameWindow(a, fp('00000004', [inp(), inp({ dataset: 'funding', interval: '' })]))).toBe(false)
  })
  it('a legacy row (no fingerprint) is never the same, never truncated, and never crashes', () => {
    expect(fpOf({ run: '001' })).toBeNull()
    expect(fpOf({ fingerprint: { digest: 'nothex!!' } })).toBeNull()
    expect(sameWindow(null, fp('00000001', [inp()]))).toBe(false)
    expect(sameWindow(null, null)).toBe(false)
    expect(truncated(null, '2026-07-15')).toBeNull()
    const [r] = groupRuns('d', [RES], T0 + DAY)
    expect(r.fp).toBeNull()
    expect(r.fingerprint).toBeNull()
    expect(r.trunc).toBeNull()
    expect(r.chain).toEqual([])
    expect(r.reads['7d'].match ?? null).toBeNull()
  })
  it('truncation: the first stored stamp later than the window from', () => {
    expect(truncated(fp('00000001', [inp({ stored_first: JUL + 5 * H, first_ts: JUL + 5 * H, trunc: undefined })]))).toBe(true)
    expect(truncated(fp('00000001', [inp({ stored_first: JUL + 22, first_ts: JUL + 22, trunc: undefined })]))).toBe(false) // funding lands ms late
    expect(truncated(fp('00000001', [inp({ trunc: true })]))).toBe(true)
    expect(truncated({ digest: '00000001', window: null, inputs: [inp({ stored_first: JUL + 5 * H, trunc: undefined })] }, '2026-07-15')).toBe(true)
  })
  it('runs carry fp, trunc and a chain of the runs sharing their window; reads match or drift', () => {
    const f1 = { digest: '16e7d7a8', window: { from: JUL, to: JUL + 100 * H }, inputs: [inp()] }
    const f2 = { digest: '9abcdef0', window: { from: JUL + 60 * H, to: JUL + 160 * H }, inputs: [inp({ first_ts: JUL + 60 * H, last_ts: JUL + 160 * H, sha256: 'c'.repeat(64) })] }
    const f3 = { digest: '12345678', window: { from: JUL + 500 * H, to: JUL + 600 * H }, inputs: [inp({ first_ts: JUL + 500 * H, last_ts: JUL + 600 * H })] }
    const read7 = { ...READ7, fingerprint: f1 }
    const read30 = { ...READ7, age: '30d', fingerprint: f3 }
    const runs = [
      ...groupRuns('d', [PRE, { ...RES, fingerprint: f1 }, read7, read30], T0 + 40 * DAY),
      ...groupRuns('e', [{ ...RES, run: '010', fingerprint: f2 }], T0),
      ...groupRuns('e', [{ ...RES, run: '011', fingerprint: f3 }], T0),
    ]
    linkChains(runs)
    const [a, b, c] = runs
    expect(a.fp).toBe('16e7d7a8')
    expect(a.trunc).toBe(false)
    expect(a.chain).toEqual(['e#010'])
    expect(b.chain).toEqual(['d#009'])
    expect(c.chain).toEqual([])
    expect(a.reads['7d'].fp).toBe('16e7d7a8')
    expect(a.reads['7d'].match).toBe(true)
    expect(a.reads['30d'].match).toBe(false)
    expect(chains([{ key: 'x', fp: null }, { key: 'y', fp: null }]).get('x')).toEqual([])
  })
})
