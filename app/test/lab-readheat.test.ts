import { describe, expect, it } from 'vitest'
import { IMPORTED, readHeat, type RunIn } from '../src/rooms/lab/readheat.ts'

const T = Date.parse('2026-09-14T00:00:00Z')
const DAY = 86_400_000
const run = (over: Partial<RunIn> = {}): RunIn => ({
  preregistered: true, stage: 'result', ts: T, void: null,
  reads: { '7d': { due: T + 7 * DAY, state: 'pending' }, '30d': { due: T + 30 * DAY, state: 'pending' } }, ...over,
})

describe('lab READS heat strip', () => {
  it('three cells: at run, +7d, +30d; done ok, not yet due hollow', () => {
    const c = readHeat(run())
    expect(c.map(x => x.cls)).toEqual(['hc-ok', 'hc-unknown', 'hc-unknown'])
    expect(c[0].title).toContain('done 2026-09-14')
    expect(c[1].title).toBe('+7d\ndue 2026-09-21\nnot yet due')
  })
  it('due amber, late and missed red, a done read carries its own date and metrics', () => {
    const c = readHeat(run({ reads: { '7d': { due: T + 7 * DAY, state: 'done', row: { ts: '2026-09-22T01:00:00Z' } }, '30d': { due: T + 30 * DAY, state: 'late' } } }), () => ['ANN % 3'])
    expect(c.map(x => x.cls)).toEqual(['hc-ok', 'hc-ok', 'hc-fail'])
    expect(c[1].title).toBe('+7d\ndone 2026-09-22\ndone\nANN % 3')
    expect(c[2].title).toContain('overdue')
    expect(readHeat(run({ reads: { '7d': { due: 1, state: 'due' }, '30d': { due: 1, state: 'missed' } } })).map(x => x.cls)).toEqual(['hc-ok', 'hc-warn', 'hc-fail'])
  })
  it('a preflight with no result is due at run', () => {
    expect(readHeat(run({ stage: 'preflight', reads: { '7d': { due: null, state: 'none' }, '30d': { due: null, state: 'none' } } })).map(x => x.cls)).toEqual(['hc-warn', 'hc-unknown', 'hc-unknown'])
  })
  it('an import with no reads owed is all hollow and says so', () => {
    const c = readHeat(run({ preregistered: false, reads: { '7d': { due: null, state: 'none' }, '30d': { due: 1, state: 'void' } } }))
    expect(c.every(x => x.cls === 'hc-unknown' && x.title === IMPORTED)).toBe(true)
  })
  it('an import the ledger says owes a read shows it (the READS DUE rail agrees)', () => {
    const c = readHeat(run({ preregistered: false, reads: { '7d': { due: 1, state: 'late' }, '30d': { due: T + 30 * DAY, state: 'pending' } } }))
    expect(c.map(x => x.cls)).toEqual(['hc-unknown', 'hc-fail', 'hc-unknown'])
    expect(c[0].title).toContain('imported 2026-09-14')
  })
})
