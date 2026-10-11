import { describe, expect, it } from 'vitest'
import { groupHeat } from '../src/rooms/dash/groupHeat.ts'

describe('dash explorer index: a group\'s last 6h', () => {
  it('takes the last 6 hours, worst across the group', () => {
    const a = { cells: [...Array(18).fill('ok'), 'ok', 'ok', 'warn', 'ok', 'ok', 'ok'] as any }
    const b = { cells: [...Array(18).fill(null), 'off', 'fail', 'ok', null, 'part', 'ok'] as any }
    expect(groupHeat([a, b])).toEqual(['ok', 'fail', 'warn', 'ok', 'ok', 'ok'])
  })
  it('an hour nobody measured stays null, never ok', () => {
    expect(groupHeat([{ cells: [null, null, null, null, null, 'ok'] }])).toEqual([null, null, null, null, null, 'ok'])
    expect(groupHeat([])).toEqual([null, null, null, null, null, null])
  })
  it('unknown outranks ok, so a gap in the record never reads green', () => {
    expect(groupHeat([{ cells: ['ok'] }, { cells: ['unknown'] }], 1)).toEqual(['unknown'])
  })
  it('a short history is aligned on the hour in progress', () => {
    expect(groupHeat([{ cells: ['fail', 'ok'] }], 4)).toEqual([null, null, 'fail', 'ok'])
  })
})
