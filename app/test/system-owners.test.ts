import { describe, expect, it } from 'vitest'
import { ownerRows, ownerCellTitle, ownerLabelTitle } from '../src/rooms/system/owners.ts'
import type { HeatCell, HeatRow } from '../src/rooms/system/heat.tsx'

const c = (s: HeatCell['s'], seen = true): HeatCell => ({ s, at: s === 'none' ? null : 1, reading: '', n: 1, seen })
const row = (id: string, ...cells: HeatCell[]): HeatRow => ({ id, cells })
const owner = (id: string) => id.startsWith('p') ? 'platform' : 'fund'

describe('owner heat summary', () => {
  it('one row per owner, each hour the worst of its probes', () => {
    const rows = ownerRows([row('p1', c('ok'), c('ok'), c('none')), row('p2', c('warn'), c('fail'), c('none')), row('f1', c('ok'), c('ok'), c('ok'))], owner)
    const p = rows.find(r => r.owner === 'platform')!
    expect(p.cells.map(x => x.s)).toEqual(['warn', 'fail', 'none'])
    expect(p.cells[1].who).toEqual(['p2'])
    expect(rows.find(r => r.owner === 'fund')!.cells.map(x => x.s)).toEqual(['ok', 'ok', 'ok'])
  })
  it('never paints green over unknown or nothing recorded', () => {
    const [r] = ownerRows([row('f1', c('unknown'), c('none')), row('f2', c('ok'), c('none'))], owner)
    expect(r.cells.map(x => x.s)).toEqual(['unknown', 'none'])
    expect(ownerCellTitle(r, 1, 0)).toMatch(/no reading recorded/)
  })
  it('held only when every probe at the worst state was held', () => {
    const [r] = ownerRows([row('f1', c('ok', false), c('ok', false)), row('f2', c('ok', false), c('ok', true))], owner)
    expect(r.cells.map(x => x.held)).toEqual([true, false])
  })
  it('stale outranks warn, and a red owner sorts first', () => {
    const rows = ownerRows([row('f1', c('ok')), row('p1', c('fail'))], owner)
    expect(rows[0].owner).toBe('platform')
    const [r] = ownerRows([row('f1', c('warn')), row('f2', c('stale', false))], owner)
    expect(r.cells[0].s).toBe('stale')
  })
  it('a probe with no heat row still counts toward its owner, as grey', () => {
    const own = (id: string) => id === 'p1' ? 'platform' : 'app'
    const rows = ownerRows([row('a1', c('ok'), c('warn')), row('p1', c('ok'), c('ok'))], own, ['fundd', 'backups', 'a1', 'p1'])
    const a = rows.find(r => r.owner === 'app')!
    expect(a.probes).toEqual(['a1', 'backups', 'fundd'])
    expect(a.unrec).toEqual(['backups', 'fundd'])
    expect(a.cells.map(x => x.s)).toEqual(['ok', 'warn'])
    expect(a.cells[0].none).toEqual(['backups', 'fundd'])
    expect(ownerCellTitle(a, 0, 0)).toBe('app 00:00-01:00Z  ok\n1 of 3 ok\n2 no reading recorded: backups, fundd')
    expect(ownerLabelTitle(a)).toBe('app: 3 probes, 1 with hourly readings\na1, backups (no reading recorded), fundd (no reading recorded)')
    expect(rows.find(r => r.owner === 'platform')!.unrec).toEqual([])
  })
  it('an owner whose every probe has no heat row is all grey', () => {
    const [r] = ownerRows([row('x', c('ok'), c('ok'))], id => id === 'x' ? 'fund' : 'app', ['x', 'fundd']).filter(o => o.owner === 'app')
    expect(r.cells.map(x => x.s)).toEqual(['none', 'none'])
    expect(ownerCellTitle(r, 0, 0)).toMatch(/no reading recorded/)
  })
})
