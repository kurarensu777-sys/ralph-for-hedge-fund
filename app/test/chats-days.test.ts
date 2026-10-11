import { describe, expect, it } from 'vitest'
import { askFirst, byDay, dayLabel } from '../src/rooms/chats/days.ts'
import { previewLine } from '../server/chat/preview.ts'

const now = Date.parse('2026-09-25T10:00:00Z')

describe('chats landing timeline days', () => {
  it('labels today, yesterday and older by UTC date', () => {
    expect(dayLabel(Date.parse('2026-09-25T00:01:00Z'), now)).toBe('Today')
    expect(dayLabel(Date.parse('2026-09-24T23:59:00Z'), now)).toBe('Yesterday')
    expect(dayLabel(Date.parse('2026-09-23T12:00:00Z'), now)).toBe('2026-09-23')
    expect(dayLabel(NaN, now)).toBe('-')
  })
  it('groups consecutive rows and keeps their order', () => {
    const ts = ['2026-09-25T09:00Z', '2026-09-25T01:00Z', '2026-09-24T08:00Z', '2026-09-20T08:00Z'].map(Date.parse)
    const g = byDay(ts, x => x, now)
    expect(g.map(x => x.label)).toEqual(['Today', 'Yesterday', '2026-09-20'])
    expect(g[0].items).toEqual([ts[0], ts[1]])
  })
  it('empty in, empty out', () => expect(byDay([], x => x as number, now)).toEqual([]))
})

describe('chats landing: what waits on the owner leads its day', () => {
  it('moves ask rows to the top of each day, order kept in both halves', () => {
    const g = [{ label: 'Today', items: ['a', 'B', 'c', 'D'] }, { label: 'Yesterday', items: ['e', 'F'] }]
    const up = (x: string) => x === x.toUpperCase()
    expect(askFirst(g, up)).toEqual([{ label: 'Today', items: ['B', 'D', 'a', 'c'] }, { label: 'Yesterday', items: ['F', 'e'] }])
  })
})

describe('chats landing preview line', () => {
  it('collapses whitespace and drops markdown noise', () => {
    expect(previewLine('## Cause\n\n**A different** process holds `8791`.\n- see [the log](http://x)')).toBe('Cause A different process holds 8791. see the log')
  })
  it('empty or code-only text gives no line', () => {
    expect(previewLine('')).toBe('')
    expect(previewLine('```\nx = 1\n```')).toBe('')
  })
  it('cuts long text at a word with an ellipsis', () => {
    const p = previewLine('word '.repeat(100), 40)
    expect(p.length).toBeLessThanOrEqual(43)
    expect(p.endsWith('word...')).toBe(true)
  })
})
