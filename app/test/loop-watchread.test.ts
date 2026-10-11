import { describe, expect, it } from 'vitest'
import { watchRead } from '../server/loop/watchread.ts'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-26T12:00:00Z')
const cfg = { minEvents: 20, tolerance: 0.05 }
const win = (score: number | null, counts: Record<string, number>) => ({ score, days: 3, counts })
const watch = (o: Record<string, unknown>) => ({ agents: ['app'], from: NOW - 2 * DAY, until: NOW + 5 * DAY, events: 200, before: null, after: null, verdict: null, ...o }) as never

describe('loop watch read (the card draws it)', () => {
  it('a thin watch at 1.00 -> 1.00 is no signal with no delta, never a flat same', () => {
    // the live L-001 shape: 6 turns + 8 board items before, 1 turn after, both scored 1
    const r = watchRead({ state: 'watching', watch: watch({ before: win(1, { turns: 6, board_done: 8 }), after: win(1, { turns: 1 }) }) }, cfg, NOW)
    expect(r.signal).toBe('thin')
    expect(r.verdict).toBe('no-signal')
    expect(r.delta).toBe(null)
    expect(r.n).toEqual({ before: 14, after: 1, min: 20 })
    expect(r.days).toEqual({ elapsed: 2, span: 7 })
  })
  it('reads a delta and a so-far verdict only when both sides hold minEvents', () => {
    const r = watchRead({ state: 'watching', watch: watch({ before: win(0.9, { turns: 30 }), after: win(0.7, { turns: 25, owner_bad: 2 }) }) }, cfg, NOW)
    expect(r.signal).toBe('read')
    expect(r.verdict).toBe('worse')
    expect(r.delta).toBeCloseTo(-0.2)
    expect(r.n.after).toBe(27)
  })
  it('an unscored side is unmeasured; a proposal never applied has no read at all', () => {
    expect(watchRead({ state: 'watching', watch: watch({ before: win(null, {}), after: win(1, { turns: 40 }) }) }, cfg, NOW).signal).toBe('unmeasured')
    const p = watchRead({ state: 'proposed', watch: watch({ from: null, until: null }) }, cfg, NOW)
    expect(p).toEqual({ n: { before: null, after: null, min: 20 }, signal: null, verdict: null, delta: null, days: null })
  })
  it('a closed watch keeps the verdict the file recorded; elapsed stops at the window end', () => {
    const r = watchRead({ state: 'kept', watch: watch({ from: NOW - 20 * DAY, until: NOW - 6 * DAY, extended: 1, before: win(1, { turns: 3 }), after: win(1, { turns: 2 }), verdict: 'no-signal' }) }, cfg, NOW)
    expect(r.verdict).toBe('no-signal')
    expect(r.days).toEqual({ elapsed: 14, span: 14 })
  })
})
