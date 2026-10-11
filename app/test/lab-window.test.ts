import { describe, expect, it } from 'vitest'
import { perDay, winShort, winSpan } from '../src/rooms/lab/window.ts'

describe('lab WINDOW cell', () => {
  it('shows the years when a window crosses one, MM-DD inside one year', () => {
    expect(winShort({ from: '2021-03-24T00:00:00Z', to: '2026-09-25T00:00:00Z' })).toBe('2021-03-24 → 2026-09-25')
    expect(winShort({ from: '2025-12-30', to: '2026-01-02' })).toBe('2025-12-30 → 2026-01-02')
    expect(winShort({ from: '2026-07-10T16:00Z', to: '2026-09-21T09:00Z' })).toBe('2026-07-10 → 2026-09-21')
    expect(winShort({ from: '2026-09-25', to: '2026-09-25' })).toBe('2026-09-25')
    expect(winShort(null)).toBe('-')
    expect(winShort({ from: 'soon', to: '2026-09-25' })).toBe('soon → 2026-09-25')
  })
  it('spans: published hours first, else days, else years past one', () => {
    expect(winSpan({ from: '2026-07-10T16:00Z', to: '2026-09-21T09:00Z', hours: 1746 })).toBe('1,746h')
    expect(winSpan({ from: '2026-03-25', to: '2026-09-21' })).toBe('180d')
    expect(winSpan({ from: '2021-03-24T00:00:00Z', to: '2026-09-25T00:00:00Z' })).toBe('5.5y')
    expect(winSpan({ from: '2026-09-25', to: '2026-09-25' })).toBe('')
    expect(winSpan({ from: 'x', to: 'y' })).toBe('')
    expect(winSpan(undefined)).toBe('')
  })
})

describe('lab DESKS sparkbar', () => {
  const now = Date.parse('2026-09-25T15:00:00Z')
  it('counts runs per UTC day, oldest first, today last; skips null and out-of-span', () => {
    const ts = [Date.parse('2026-09-25T01:00Z'), Date.parse('2026-09-25T23:00Z'), Date.parse('2026-09-19T00:00Z'), Date.parse('2026-09-18T23:59Z'), null, Date.parse('2026-09-26T01:00Z')]
    expect(perDay(ts, now)).toEqual([1, 0, 0, 0, 0, 0, 2])
  })
  it('no runs is an all-zero track, never a shorter one', () => {
    expect(perDay([], now)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })
})
