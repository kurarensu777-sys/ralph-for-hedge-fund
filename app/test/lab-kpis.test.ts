import { describe, expect, it } from 'vitest'
import { daysOver, kpis, type KSnap } from '../src/rooms/lab/kpis.ts'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-26T12:00:00Z')
const retro = (due: boolean) => ({ due, date: due ? null : '2026-09-24', since: 0, why: due ? 'never' : 'fresh' })

const snap = (over: Partial<KSnap> = {}): KSnap => ({
  now: NOW,
  runs: [
    { desk: 'lab/a', ts: NOW - DAY, verify: { total: 10, passed: 10 } },
    { desk: 'lab/a', ts: NOW - 20 * DAY, verify: { total: 5, passed: 4 } },
    { desk: 'lab/b', ts: NOW, verify: null },
    { desk: 'lab/b', ts: null, verify: { total: 3, passed: null } },
  ],
  desks: [{ desk: 'lab/a', runs: 2, retro: retro(true) }, { desk: 'lab/b', runs: 2, retro: retro(false) }, { desk: 'lab/c', runs: 0, retro: retro(false) }],
  readsDue: [{ desk: 'lab/a', due: NOW - 6 * DAY, state: 'late' }, { desk: 'lab/a', due: NOW - DAY, state: 'due' }, { desk: 'lab/b', due: NOW + DAY, state: 'due' }],
  ...over,
})

describe('lab kpis', () => {
  it('counts the lab: runs in 7 days, verify over runs that carry a count, reads over and ahead, retros per desk with runs', () => {
    const k = kpis(snap(), '')
    expect(k.runs7).toBe(2)
    expect(k.perDay).toHaveLength(7)
    expect(k.verify).toEqual({ pass: 1, of: 2 })
    expect(k.reads).toEqual({ over: 2, late: 1, ahead: 1 })
    expect(k.retro?.map(r => [r.desk, r.due])).toEqual([['lab/a', true], ['lab/b', false]])
  })

  it('scopes to one desk', () => {
    const k = kpis(snap(), 'lab/b')
    expect(k.runs7).toBe(1)
    expect(k.verify).toBeNull()
    expect(k.reads).toEqual({ over: 0, late: 0, ahead: 1 })
    expect(k.retro).toEqual([{ desk: 'lab/b', due: false, date: '2026-09-24', why: 'fresh' }])
  })

  it('unknown is null, never zero: no verify count anywhere, no retro clock from an older server', () => {
    const s = snap({ runs: [{ desk: 'lab/a', ts: NOW, verify: { total: 0, passed: 0 } }], desks: [{ desk: 'lab/a', runs: 1 }] })
    const k = kpis(s, '')
    expect(k.verify).toBeNull()
    expect(k.retro).toBeNull()
  })

  it('days over floors and never goes negative', () => {
    expect(daysOver(NOW - 6.9 * DAY, NOW)).toBe(6)
    expect(daysOver(NOW + DAY, NOW)).toBe(0)
  })
})
