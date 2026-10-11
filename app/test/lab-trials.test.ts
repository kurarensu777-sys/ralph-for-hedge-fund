import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deskTrials, dsrFor, expectedMaxSharpe, parseTrials, pboFor, phi, phiInv, psr, statsFor, type Trial } from '../server/lab/trials.ts'

// a seeded generator so every number here is reproducible
function rng(seed: number) {
  let s = seed >>> 0
  const u = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return () => { let a = 0; while (a === 0) a = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u()) }
}

const trial = (run: string, cell: Record<string, unknown>, sharpe: number, over: Partial<Trial> = {}): Trial =>
  ({ ts: '2026-09-24T00:00:00Z', run, mechanic: 'M1', cell, sharpe, n_obs: 250, skew: 0, kurt: 3, returns: null, status: 'kept', ...over })

describe('normal', () => {
  it('phi and its inverse agree', () => {
    expect(phi(0)).toBeCloseTo(0.5, 7)
    expect(phi(1.959964)).toBeCloseTo(0.975, 6)
    for (const p of [0.001, 0.02, 0.3, 0.5, 0.9, 0.99, 0.999]) expect(phi(phiInv(p))).toBeCloseTo(p, 7)
  })
})

describe('Deflated Sharpe: the paper', () => {
  // Bailey & Lopez de Prado (2014), "The Deflated Sharpe Ratio", numerical example: N = 100
  // trials, V[SR_n] = 1/2 (annualized), T = 1250 daily observations (250 a year), skew -3,
  // kurtosis 10, a selected annualized Sharpe of 2.5. The paper reports DSR = 0.9004.
  it('matches the worked example to 1e-3', () => {
    const ppy = 250
    const sr0Ann = expectedMaxSharpe(100, 0.5)
    expect(sr0Ann).toBeCloseTo(1.7894, 3)
    const v = psr(2.5 / Math.sqrt(ppy), sr0Ann / Math.sqrt(ppy), 1250, -3, 10)!
    expect(Math.abs(v - 0.9004)).toBeLessThan(1e-3)
  })

  it('the same example through the ledger: N and V come from the rows', () => {
    // 100 distinct trials whose per-observation Sharpes have variance exactly 0.5 / 250, the
    // largest of them the selected 2.5 annualized: an affine map of 100 draws fixes both
    const target = 0.5 / 250, sel = 2.5 / Math.sqrt(250)
    const g = rng(7)
    const raw = Array.from({ length: 100 }, () => g()).sort((a, b) => a - b)
    const mu = raw.reduce((a, b) => a + b, 0) / 100
    const v = raw.reduce((a, x) => a + (x - mu) ** 2, 0) / 99
    const k = Math.sqrt(target / v), c = sel - k * raw[99]
    const ledger = raw.map((x, i) => trial('r1', { i }, k * x + c, i === 99 ? { skew: -3, kurt: 10, n_obs: 1250 } : {}))
    const d = dsrFor(ledger, 'r1')!
    expect(d.n).toBe(100)
    expect(d.v).toBeCloseTo(target, 12)
    expect(d.sr).toBeCloseTo(sel, 12)
    expect(Math.abs(d.value! - 0.9004)).toBeLessThan(1e-3)
  })
})

describe('Deflated Sharpe: N is the ledger\'s', () => {
  it('N counts distinct (run, cell) trials of the mechanic, across runs, reruns collapsed', () => {
    const ledger = [
      trial('a', { lev: 1 }, 0.05), trial('a', { lev: 2 }, 0.08), trial('a', { lev: 2 }, 0.081, { status: 'rerun' }),
      trial('b', { lev: 1 }, 0.04), trial('b', { lev: 3 }, 0.02, { status: 'abandoned' }),
      trial('c', { lev: 1 }, 0.9, { mechanic: 'M2' }),
    ]
    expect(dsrFor(ledger, 'a')!.n).toBe(4)
    expect(statsFor(ledger, 'a').n_trials).toBe(4)
    expect(statsFor(ledger, 'c').n_trials).toBe(1)
    expect(statsFor(ledger, 'zzz').n_trials).toBeNull() // no rows: N ?, never a guess
    // the API takes no N: its arity is the ledger and the run, and nothing else
    expect(dsrFor.length).toBe(2)
    expect(statsFor.length).toBe(2)
  })

  it('more trials on the ledger lower the same run\'s DSR', () => {
    const base = [trial('a', { x: 1 }, 0.12), trial('a', { x: 2 }, 0.03), trial('a', { x: 3 }, 0.06)]
    const more = [...base, ...Array.from({ length: 30 }, (_, i) => trial('old', { y: i }, 0.01 * (i % 7) - 0.02))]
    expect(dsrFor(more, 'a')!.value!).toBeLessThan(dsrFor(base, 'a')!.value!)
  })

  it('MUTATION: dropping abandoned rows raises DSR, and the count catches it', () => {
    const g = rng(3)
    const kept = Array.from({ length: 6 }, (_, i) => trial('a', { k: i }, 0.06 + 0.01 * g()))
    const abandoned = Array.from({ length: 40 }, (_, i) => trial('a', { dropped: i }, -0.05 + 0.04 * g(), { status: 'abandoned' }))
    const full = [...kept, ...abandoned]
    const honest = dsrFor(full, 'a')!
    // the mutant: an implementation that filters abandoned rows before counting
    const mutant = dsrFor(full.filter(t => t.status !== 'abandoned'), 'a')!
    expect(mutant.value!).toBeGreaterThan(honest.value!)
    // the honest implementation counts all 46; a mutant counting 6 fails this line
    expect(honest.n).toBe(46)
    expect(mutant.n).not.toBe(46)
    // and the selected trial is the same one: only N and V moved
    expect(mutant.sr).toBe(honest.sr)
  })

  it('a run whose every trial was abandoned selected nothing', () => {
    const d = dsrFor([trial('a', { x: 1 }, 0.1, { status: 'abandoned' })], 'a')!
    expect(d.value).toBeNull()
    expect(d.why).toMatch(/abandoned/)
  })
})

describe('PBO by CSCV', () => {
  const T = 640
  const paths = (seed: number, n: number, edge: (i: number) => number) => {
    const g = rng(seed)
    return Array.from({ length: n }, (_, i) => trial('s', { i }, 0, { returns: Array.from({ length: T }, () => 0.01 * g() + edge(i)) }))
  }

  it('pure noise gives PBO near 50%', () => {
    // one sweep's PBO swings widely (its 12,870 splits share one path), so the claim is about
    // the average over independent noise sweeps
    const vals = Array.from({ length: 12 }, (_, k) => pboFor(paths(100 + k, 12, () => 0), 's')!.value!)
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    expect(mean).toBeGreaterThan(0.4)
    expect(mean).toBeLessThan(0.6)
  })

  it('a planted true edge gives PBO near 0', () => {
    const p = pboFor(paths(21, 16, i => (i === 5 ? 0.004 : 0)), 's')!
    expect(p.combos).toBe(12870)
    expect(p.s).toBe(16)
    expect(p.value!).toBeLessThan(0.05)
  })

  it('reports why when it cannot run', () => {
    expect(pboFor([trial('s', { i: 1 }, 0.1)], 's')).toBeNull()
    expect(pboFor([trial('s', { i: 1 }, 0.1, { returns: [0.1, 0.2, 0.1] })], 's')!.why).toMatch(/two/)
    const short = pboFor([trial('s', { i: 1 }, 0, { returns: [0.1, 0.2, 0.3, 0.1] }), trial('s', { i: 2 }, 0, { returns: [0.2, 0.1, 0.0, 0.3] })], 's')!
    expect(short.value).toBeNull()
    expect(short.why).toMatch(/blocks/)
  })

  it('the scatter carries IS and OOS ranks in (0, 1] and marks each split\'s IS-best', () => {
    const p = pboFor(paths(5, 8, () => 0), 's')!
    expect(p.scatter!.length).toBeGreaterThan(0)
    expect(p.scatter!.every(x => x.is > 0 && x.is <= 1 && x.oos > 0 && x.oos <= 1)).toBe(true)
    expect(p.scatter!.filter(x => x.best).every(x => x.is === 1)).toBe(true)
  })
})

describe('the ledger on disk', () => {
  it('reads trials.jsonl, tolerates junk, and is absent when there is no file', () => {
    const root = mkdtempSync(join(tmpdir(), 'lab-trials-'))
    try {
      const desk = 'lab/x'
      expect(deskTrials(root, desk).exists).toBe(false)
      mkdirSync(join(root, desk, 'data'), { recursive: true })
      const rows = [
        { ts: '2026-09-24T00:00:00Z', run: '001', mechanic: 'M1', cell: { a: 1 }, sharpe: 0.1, n_obs: 200, skew: 0, kurt: 3, returns: null, status: 'kept' },
        { ts: '2026-09-24T00:00:00Z', run: '001', mechanic: 'M1', cell: { a: 2 }, sharpe: 0.02, n_obs: 200, skew: 0, kurt: 3, returns: null, status: 'abandoned' },
      ]
      writeFileSync(join(root, desk, 'data', 'trials.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n{broken\n')
      const t = deskTrials(root, desk)
      expect(t.exists).toBe(true)
      expect(t.ledger).toHaveLength(2)
      const s = t.stats('001')
      expect(s.n_trials).toBe(2)
      expect(s.by_status).toEqual({ kept: 1, abandoned: 1 })
      expect(s.dsr!.value).toBeGreaterThan(0)
      expect(parseTrials('{"run":"1","sharpe":"x","n_obs":3}\n')).toHaveLength(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
