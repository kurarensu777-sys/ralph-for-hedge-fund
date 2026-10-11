import { describe, expect, it } from 'vitest'
import { handsLine, type HandsView } from '../src/rooms/system/hands.ts'

const GB = 1024 ** 3
const v = (o: Partial<HandsView> = {}): HandsView => ({ open: 48, idle: 46, bytes: 19 * GB, orphans: 0, terminals: { n: 2, bytes: 0.5 * GB }, reapedToday: 3, idleMinutes: 120, freeBytes: 4 * GB, ...o })

describe('the hands line', () => {
  it('reads open, held and reaped today', () => {
    const l = handsLine(v())
    expect(l.text).toBe('48 hands open · 19.0 GB held · 3 reaped today')
    expect(l.title).toContain('closed after 2 h idle')
    expect(l.title).toContain('2 terminal claude sessions (0.5 GB): yours, never closed from here')
  })
  it('a reading it could not take is unknown, never 0 GB or 0 reaped', () => {
    const l = handsLine(v({ bytes: null, orphans: null, terminals: null, reapedToday: null, freeBytes: null }))
    expect(l.text).toBe('48 hands open · memory unknown · reaped unknown')
    expect(l.text).not.toMatch(/0\.0 GB|\b0 reaped/)
    expect(l.title).toContain('the process list could not be read')
  })
  it('a true zero is said as zero; one hand is singular; orphans are named', () => {
    expect(handsLine(v({ open: 1, reapedToday: 0 })).text).toBe('1 hand open · 19.0 GB held · 0 reaped today')
    expect(handsLine(v({ orphans: 2 })).title).toContain('2 orphaned')
  })
})
