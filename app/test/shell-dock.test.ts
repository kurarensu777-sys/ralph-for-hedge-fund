import { describe, expect, it } from 'vitest'
import { barTone, fmtDollars, fmtResets, fmtTok, topAgents } from '../src/shell/dock.ts'
import { chatStateOf, stateWord } from '../src/lib/ceo.ts'

describe('dock: usage', () => {
  it('formats tokens as every other screen does', () => {
    expect([fmtTok(312), fmtTok(840_000), fmtTok(12_700_000)]).toEqual(['312', '840k', '12.7M'])
    expect(fmtDollars(41.2)).toBe('$41.20')
  })
  it('colours a window by how full it is, with the state colours', () => {
    expect([barTone(0.2), barTone(0.7), barTone(0.89), barTone(0.9), barTone(1)]).toEqual(['ok', 'warn', 'warn', 'fail', 'fail'])
  })
  it('words a reset as a clock time within a day and a weekday beyond, and a past one as ago', () => {
    const now = new Date(2026, 9, 5, 12, 0).getTime()
    expect(fmtResets(new Date(2026, 9, 5, 16, 20).getTime(), false, now)).toBe('16:20')
    expect(fmtResets(new Date(2026, 9, 12, 9, 0).getTime(), false, now)).toMatch(/^Mon 09:00$/)
    expect(fmtResets(now - 30 * 60_000, true, now)).toBe('30 min ago')
    expect(fmtResets(null)).toBe('unknown')
  })
  it('names the agents with the most tokens, never one with none', () => {
    const s = { agents: ['a', 'b', 'c'], cells: [[10, 0, 5], [20, 0, 1]] }
    expect(topAgents(s, 2)).toEqual([{ agent: 'a', tokens: 30 }, { agent: 'c', tokens: 6 }])
  })
})

describe('dock: an issue\'s chat state', () => {
  const list = [{ id: 'c-1', state: 'waiting' as const }, { id: 'c-2', state: 'live' as const }]
  it('is the chat\'s own state, and null (unknown) when there is no chat or the list has not named it', () => {
    expect(chatStateOf({ conversation: 'c-1' }, list)).toBe('waiting')
    expect(chatStateOf({ conversation: 'c-2' }, list)).toBe('live')
    expect(chatStateOf({ conversation: '' }, list)).toBeNull()
    expect(chatStateOf({ conversation: 'c-9' }, list)).toBeNull()      // not in the list: unknown, never idle
    expect(chatStateOf({ conversation: 'c-1' }, null)).toBeNull()      // list not loaded
  })
  it('has a word for each state', () => {
    expect([stateWord('waiting'), stateWord('live'), stateWord('idle'), stateWord(null)]).toEqual(['waiting on you', 'working', 'idle', 'state unknown'])
  })
})
