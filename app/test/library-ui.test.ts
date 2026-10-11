import { describe, expect, it } from 'vitest'
import { neverRead } from '../src/rooms/library/state.ts'

describe('never read', () => {
  it('only a book with neither a pull nor a boot load; unknown reads are never "never read"', () => {
    expect(neverRead({ last: null, lastBoot: null })).toBe(true)
    expect(neverRead({ last: null, lastBoot: 1 })).toBe(false)
    expect(neverRead({ last: 1, lastBoot: null })).toBe(false)
    expect(neverRead(undefined)).toBe(false)
  })
})

describe('spine labels', () => {
  it('keep the name half of a title', async () => {
    const { spineLabel } = await import('../src/rooms/library/spine.ts')
    expect(spineLabel('CLAUDE.md - Acme desk engineer (acme)')).toBe('Acme desk engineer')
    expect(spineLabel('CLAUDE.md - Carry quant (carry)')).toBe('Carry quant')
    expect(spineLabel('The loop graph - how the fund improves itself')).toBe('The loop graph')
    expect(spineLabel('The six-step flow: thesis first, sizing last')).toBe('The six-step flow')
    expect(spineLabel('A law the process never loaded is not in force')).toBe('Law the process')
    expect(spineLabel('(x)')).toBe('(x)')
  })
})
