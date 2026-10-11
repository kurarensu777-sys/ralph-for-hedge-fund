import { describe, expect, it } from 'vitest'
import { dayCells, type Mark } from '../src/rooms/system/jobcells.ts'

const H = 3_600_000
const NOW = Date.parse('2026-09-26T20:30:00Z')   // the hour in progress is 20:00-21:00Z, the last cell
const at = (hhmm: string) => Date.parse(`2026-09-26T${hhmm}:00Z`)
const run = (t: number, status: string): Mark => ({ t, end: t + 60_000, kind: 'run', status })

describe("a job's 24h strip", () => {
  it('is 24 clock hours ending in the hour in progress', () => {
    const c = dayCells([], NOW, null)
    expect(c).toHaveLength(24)
    expect(c[23].title.startsWith('20:00-21:00Z')).toBe(true)
    expect(c[0].title.startsWith('21:00-22:00Z')).toBe(true)
  })
  it('draws fail over missed over ok, and nothing as grey (never green by default)', () => {
    const c = dayCells([run(at('20:05'), 'ok'), run(at('20:10'), 'fail'), { t: at('19:00'), end: null, kind: 'missed', status: 'missed' }, run(at('18:00'), 'ok'),
      { t: at('17:00'), end: null, kind: 'owed', status: 'owed' }, run(at('16:00'), 'running'), { t: at('15:00'), end: null, kind: 'skipped', status: 'skipped' }], NOW, null)
    expect(c.slice(19).map(x => x.s)).toEqual(['none', 'none', 'ok', 'missed', 'fail'])
    expect(c[23].title).toContain('ok 1 · fail 1')
    expect(c[20].title).toContain('owed 1')
    expect(c[19].title).toContain('running 1')
    expect(c[18].s).toBe('none')
    expect(c[0].title).toContain('nothing ran')
  })
  it('says an hour before the run record began is not known', () => {
    const c = dayCells([], NOW, at('20:00') - 2 * H)
    expect(c[0].title).toContain('no run record yet')
    expect(c[22].title).toContain('nothing ran')
  })
})
