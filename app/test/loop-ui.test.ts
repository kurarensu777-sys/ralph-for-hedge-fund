import { describe, expect, it } from 'vitest'
import { bodyIsTitle, stateWord, titleFull, titleLine } from '../src/rooms/loop/Review.tsx'

describe('loop review card body', () => {
  it('hides the body when the whole excerpt is the title line', () => {
    expect(bodyIsTitle('Done: the book is filed.')).toBe(true)
    expect(bodyIsTitle('**Done**: the book is filed.')).toBe(true)
    expect(bodyIsTitle('... done the book is filed.')).toBe(true)
  })
  it('keeps the body when it says more than the title', () => {
    expect(bodyIsTitle('Done: the book is filed. Then the series row landed too.')).toBe(false)
    expect(bodyIsTitle('')).toBe(false)
    const long = 'word '.repeat(40)
    expect(titleLine(long).endsWith('…')).toBe(true)
    expect(bodyIsTitle(long)).toBe(false)
  })
})

describe('loop learned timeline', () => {
  const now = Date.parse('2026-09-25T10:00:00Z')
  it('groups Today / Yesterday / Earlier (UTC), newest first, empty groups dropped', async () => {
    const { lessonDays } = await import('../src/rooms/loop/days.ts')
    const at = (s: string) => Date.parse(s)
    const xs = ['2026-09-20T01:00:00Z', '2026-09-25T00:10:00Z', '2026-09-25T09:00:00Z', '2026-09-24T23:59:00Z'].map(at)
    const g = lessonDays(xs, x => x, now)
    expect(g.map(x => x.label)).toEqual(['Today', 'Yesterday', 'Earlier'])
    expect(g[0].items).toEqual([at('2026-09-25T09:00:00Z'), at('2026-09-25T00:10:00Z')])
    expect(lessonDays([at('2026-09-01T00:00:00Z')], x => x, now).map(x => x.label)).toEqual(['Earlier'])
    expect(lessonDays([], (x: number) => x, now)).toEqual([])
  })
})

describe('loop review card state word and title', () => {
  it('omits the word for the usual open state, shows any other, and says unknown when it cannot tell', () => {
    expect(stateWord('open')).toBe(null)
    expect(stateWord('closed')).toBe('closed')
    expect(stateWord('blocked')).toBe('blocked')
    expect(stateWord(undefined)).toBe('unknown')
    expect(stateWord('')).toBe('unknown')
  })
  it('keeps the whole first sentence for the tooltip and cuts only the drawn title', () => {
    const long = `${'word '.repeat(50)}end.`
    expect(titleFull(long).endsWith('end.')).toBe(true)
    expect(titleLine(long).length).toBeLessThanOrEqual(160)
    expect(titleLine('A short line here. Then more.')).toBe('A short line here.')
  })
})

describe('loop learned grid', () => {
  const now = Date.parse('2026-09-26T10:00:00Z')
  const at = (s: string) => Date.parse(s)
  type L = { ts: number; agent: string | null }
  const ls: L[] = [
    { ts: at('2026-09-26T08:00:00Z'), agent: 'fund' }, { ts: at('2026-09-26T01:00:00Z'), agent: 'fund' },
    { ts: at('2026-09-25T12:00:00Z'), agent: 'app' }, { ts: at('2026-09-20T12:00:00Z'), agent: null },
  ]
  it('one UTC day per column, today on the right; rows by lessons, the unattributed row last', async () => {
    const { lessonGrid } = await import('../src/rooms/loop/shape.ts')
    const g = lessonGrid(ls, l => l.ts, l => l.agent, 7, now)
    expect(g.cols).toHaveLength(7)
    expect(g.cols[6].label).toBe('09-26')
    expect(g.rows.map(r => [r.agent, r.total])).toEqual([['fund', 2], ['app', 1], [null, 1]])
    expect(g.rows[0].cells[6]).toHaveLength(2)
    expect(g.rows[1].cells[5]).toHaveLength(1)
    expect(g.rows[2].cells[0]).toHaveLength(1)
    expect(g.max).toBe(2)
  })
  it('never drops a lesson the range cut mid-day, and `all` fits the span into at most cap columns', async () => {
    const { lessonGrid } = await import('../src/rooms/loop/shape.ts')
    const g = lessonGrid([{ ts: at('2026-09-19T20:00:00Z'), agent: 'fund' }], l => l.ts, l => l.agent, 7, now)
    expect(g.cols).toHaveLength(8)
    expect(g.rows[0].total).toBe(1)
    const all = lessonGrid([{ ts: at('2026-06-01T00:00:00Z'), agent: 'fund' }, ...ls], l => l.ts, l => l.agent, null, now, 30)
    expect(all.cols.length).toBeLessThanOrEqual(30)
    expect(all.bucket).toBeGreaterThan(1)
    expect(all.rows.reduce((s, r) => s + r.total, 0)).toBe(5)
    expect(all.cols[all.cols.length - 1].to).toBe(at('2026-09-27T00:00:00Z'))
    expect(lessonGrid([], (l: L) => l.ts, l => l.agent, 30, now)).toMatchObject({ rows: [], max: 0 })
  })
  it('a cell is empty at zero and full at the busiest count', async () => {
    const { heat } = await import('../src/rooms/loop/shape.ts')
    expect(heat(0, 5)).toBe(0)
    expect(heat(5, 5)).toBe(1)
    expect(heat(1, 5)).toBeGreaterThan(0.3)
  })
})

describe('loop retro chips and funnel', () => {
  it('colours a desk by its stamp: due amber, a stamp green, nothing to grade grey', async () => {
    const { retroChip } = await import('../src/rooms/loop/shape.ts')
    expect(retroChip({ desk: 'lab/feeds/acme', due: true, ageDays: null, since: 5, graded: 5, stamp: { date: null } })).toEqual({ tone: 'due', mark: '5', group: 'feeds', name: 'acme' })
    expect(retroChip({ desk: 'lab/vol', due: false, ageDays: 1.9, since: 1, graded: 2, stamp: { date: '2026-09-25' } })).toEqual({ tone: 'fresh', mark: '1d', group: '', name: 'vol' })
    expect(retroChip({ desk: 'lab/research', due: false, ageDays: null, since: 0, graded: 0, stamp: { date: null } }).tone).toBe('idle')
  })
  it('counts the flow; unjudged is a part of kept, never a fourth outcome', async () => {
    const { funnel } = await import('../src/rooms/loop/shape.ts')
    const f = funnel([{ state: 'proposed', unjudged: false }, { state: 'watching', unjudged: false }, { state: 'applied', unjudged: false },
      { state: 'kept', unjudged: true }, { state: 'kept', unjudged: false }, { state: 'vetoed', unjudged: false }])
    expect(f).toEqual({ proposed: 1, watching: 2, kept: 2, unjudged: 1, reverted: 0, vetoed: 1 })
  })
})
