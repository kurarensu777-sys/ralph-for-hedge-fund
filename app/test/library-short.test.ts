import { describe, expect, it } from 'vitest'
import { shortTitle, vetLabel } from '../src/rooms/library/spine.ts'

describe('short titles', () => {
  it('keeps the name half, at most about three words', () => {
    expect(shortTitle('The loop graph - how the fund improves itself')).toBe('The loop graph')
    expect(shortTitle('CLAUDE.md - Acme desk engineer (acme)')).toBe('Acme desk engineer')
    expect(shortTitle('A rule is a mechanism, not a doctrine line')).toBe('Rule is a mechanism')
    expect(shortTitle('Acme cadence is the desk\'s two stamps, or the row does not exist')).toBe('Acme cadence')
    expect(shortTitle('One event stream per tab')).toBe('One event stream')
    expect(shortTitle('Distance to liquidation is measured where the rule fires')).toBe('Distance to liquidation')
    expect(shortTitle('Empty, failed and unknown are three states')).toBe('Empty, failed, unknown')
    expect(shortTitle('An example is DATA until it is fenced')).toBe('Example is DATA')
    expect(shortTitle('The generator and the three reviews')).toBe('Generator and the three reviews')
    expect(shortTitle('The gap, both ways - what 44 public backtests do')).toBe('The gap, both ways')
    expect(shortTitle('What the two studies concluded, as of 2026-09-22')).toBe('What the two studies concluded')
    expect(shortTitle('(x)')).toBe('(x)')
  })
  it('vet titles in two or three words', () => {
    expect(vetLabel("The Carry Desk's Beliefs")).toBe('Carry Beliefs')
    expect(vetLabel("The Carry Desk's Beliefs")).toBe('Carry Beliefs')
    expect(vetLabel('The Evidence Bar')).toBe('Evidence Bar')
  })
})
