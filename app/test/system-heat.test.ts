import { describe, expect, it } from 'vitest'
import { HOUR, heatCells, hourGrid, probeHeat, type Reading } from '../server/system/heat.ts'
import { ops } from '../server/db.ts'

const now = 1000 * HOUR + 20 * 60_000          // 20 minutes into an hour
const r = (ts: number, status: string, windowS: number | null = 3600, reading = status): Reading => ({ ts, status, reading, windowS })

describe('hourGrid', () => {
  it('ends in the hour in progress and starts 23 clock hours before it', () => {
    const g = hourGrid(now)
    expect(g.starts).toHaveLength(24)
    expect(g.starts[23]).toBe(1000 * HOUR)
    expect(g.from).toBe(977 * HOUR)
  })
})

describe('heatCells', () => {
  it('nothing recorded is grey, never green', () => {
    expect(heatCells([], now).every(c => c.s === 'none')).toBe(true)
  })
  it('an hour draws its worst reading, with its time and count', () => {
    const c = heatCells([r(1000 * HOUR + 60_000, 'ok'), r(1000 * HOUR + 120_000, 'fail', 3600, 'selftest 60/61'), r(1000 * HOUR + 180_000, 'ok')], now)[23]
    expect(c).toMatchObject({ s: 'fail', at: 1000 * HOUR + 120_000, reading: 'selftest 60/61', n: 3, seen: true })
  })
  it('a verdict holds inside its window (paler), then goes stale, never kept green', () => {
    const cells = heatCells([r(990 * HOUR + 5 * 60_000, 'ok', 4 * 3600)], now)
    expect(cells[12]).toMatchObject({ s: 'none' })                        // 989h: before the reading
    expect(cells[13]).toMatchObject({ s: 'ok', seen: true })              // 990h: read there
    expect(cells[14]).toMatchObject({ s: 'ok', seen: false })             // 991h..994h: held
    expect(cells[17]).toMatchObject({ s: 'ok', seen: false })
    expect(cells[18]).toMatchObject({ s: 'stale', seen: false })          // 995h: its 4h window ran out
    expect(cells[23].s).toBe('stale')
  })
  it('a reading with no window is not held', () => {
    const cells = heatCells([r(999 * HOUR, 'ok', null)], now)
    expect(cells[22].s).toBe('ok')
    expect(cells[23].s).toBe('stale')
  })
  it('an unknown claim is unknown, not ok', () => {
    expect(heatCells([r(1000 * HOUR, 'weird')], now)[23].s).toBe('unknown')
  })
})

describe('probeHeat', () => {
  it('reads the strip back, carrying a reading from before the grid while its window covers', async () => {
    // what a probe records itself (fund_db record_health: detail = the whole reading, its window in it)
    await ops.recordHealth('system:selftest', 'system', 'ok', { reading: 'selftest ok', detail: { id: 'selftest', window_s: 7200 }, ts: 999 * HOUR })
    await ops.recordHealth('system:selftest', 'system', 'fail', { reading: 'selftest fail', detail: { id: 'selftest', window_s: 7200 }, ts: 1000 * HOUR + 60_000 })
    await ops.recordHealth('system:old', 'system', 'warn', { reading: 'x', detail: { window_s: 7200 }, ts: 976 * HOUR + 30 * 60_000 })
    await ops.recordHealth('system:old', 'system', 'ok', { reading: 'older', detail: { window_s: 60 }, ts: 900 * HOUR })   // only the LAST one before the grid is carried
    const out = await probeHeat(['selftest', 'old', 'absent'], now)
    const by = new Map(out.items.map(x => [x.id, x.cells]))
    expect(by.get('selftest')![22]).toMatchObject({ s: 'ok', seen: true })
    expect(by.get('selftest')![23]).toMatchObject({ s: 'fail', seen: true })
    expect(by.get('old')![0]).toMatchObject({ s: 'warn', seen: false })    // 977h: inside the 2h window of 976:30
    expect(by.get('old')![1].s).toBe('warn')                                // 978h: 976:30 + 2h still covers its start
    expect(by.get('old')![2].s).toBe('stale')
    expect(by.get('absent')!.every(c => c.s === 'none')).toBe(true)
  })
})
