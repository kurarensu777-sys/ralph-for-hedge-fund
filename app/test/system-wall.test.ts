import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { laneMarks, laneTally, occurrencesIn, readLanes, type WallRun } from '../server/system/wall.ts'

// and the lab's fixed-age reads. Local-clock cases pin their instants
// the alert engine's lane and the lab's fixed-age reads. Local-clock cases pin their instants
// with new Date(y, m, d, h, mi) so they hold in any machine zone; the DST case runs in a child
// process pinned to Europe/London (BST ends 2026-10-25 02:00 -> 01:00).

const at = (d: number, h: number, m = 0, mo = 8) => new Date(2026, mo, d, h, m, 0).getTime()
const BS = String.fromCharCode(92)

describe('occurrence enumeration', () => {
  it('every Nh: the epoch-anchored grid inside the window', () => {
    const from = at(24, 0), to = at(24, 23, 59)
    const occ = occurrencesIn('every 4h', from, to)
    expect(occ.map(t => new Date(t).getHours())).toEqual([0, 4, 8, 12, 16, 20])
  })
  it('every Nm', () => {
    expect(occurrencesIn('every 15m', at(24, 10, 0), at(24, 11, 0)).length).toBe(5)
  })
  it('daily HH:MM, one per day, the window inclusive', () => {
    const occ = occurrencesIn('daily 06:30', at(18, 0), at(25, 6, 30))
    expect(occ.length).toBe(8)
    expect(occ.every(t => new Date(t).getHours() === 6 && new Date(t).getMinutes() === 30)).toBe(true)
    expect(occ[occ.length - 1]).toBe(at(25, 6, 30))
  })
  it('weekly DOW HH:MM lands on that weekday', () => {
    const occ = occurrencesIn('weekly mon 08:00', at(1, 0), at(30, 23))
    expect(occ.map(t => new Date(t).getDate())).toEqual([7, 14, 21, 28])
    expect(occ.every(t => new Date(t).getDay() === 1)).toBe(true)
  })
  it('at <iso>: inside the window or not at all', () => {
    expect(occurrencesIn('at 2026-10-01T23:15', at(28, 0), at(30, 0, 0, 9))).toEqual([new Date(2026, 9, 1, 23, 15).getTime()])
    expect(occurrencesIn('at 2026-10-01T23:15', at(20, 0), at(27, 0))).toEqual([])
  })
  it('an unparsable cadence enumerates nothing', () => {
    expect(occurrencesIn('whenever', at(1, 0), at(30, 0))).toEqual([])
  })
})

describe('consumption: owed vs actual', () => {
  const job = { cadence: 'daily 06:30', windowS: 6 * 3600, enabled: true }
  const from = at(20, 0), to = at(26, 0), now = at(25, 13)
  const run = (id: number, due: number | null, status: string, start: number | null = due, end: number | null = start === null ? null : start + 60_000): WallRun =>
    ({ id, due_at: due, started_at: start, ended_at: end, status, trigger: due === null ? 'manual' : 'schedule' })

  it('a run consumes the occurrence whose due_at it carries; the rest are missed or owed', () => {
    const runs = [run(1, at(22, 6, 30), 'ok', at(22, 6, 31)), run(2, at(23, 6, 30), 'fail', at(23, 6, 31)), run(3, at(24, 6, 30), 'missed', null, at(24, 13))]
    const m = laneMarks(job, runs, from, to, now)
    const by = new Map(m.map(x => [new Date(x.t).getDate(), x]))
    expect(by.get(20)!.kind).toBe('missed')           // no row, window long gone
    expect(by.get(21)!.kind).toBe('missed')
    expect(by.get(22)!.status).toBe('ok')              // drawn at its start
    expect(by.get(22)!.t).toBe(at(22, 6, 31))
    expect(by.get(23)!.status).toBe('fail')
    expect(by.get(24)!.kind).toBe('missed')            // the scheduler logged it missed
    expect(by.get(24)!.row).toBe(3)
    expect(by.get(25)!.kind).toBe('missed')            // 06:30 + 6h grace < 13:00, no row
    expect(laneTally(m)).toEqual({ missed: 4, ok: 1, fail: 1 })
  })
  it('inside its window or in the future: owed, never missed', () => {
    const m = laneMarks(job, [], at(25, 0), at(26, 12), at(25, 9))
    expect(m.map(x => x.kind)).toEqual(['owed', 'owed'])
    expect(m[0].end).toBe(at(25, 12, 30))              // the owed bar spans the grace window
  })
  it('a manual run is an actual that consumes nothing', () => {
    const m = laneMarks(job, [run(9, null, 'ok', at(25, 11))], at(25, 0), at(25, 23), at(25, 11, 30))
    expect(m.map(x => [x.kind, !!x.manual])).toEqual([['owed', false], ['run', true]])   // 06:30 + 6h grace is still open at 11:30
  })
  it('a skipped row beside a real run for one occurrence: the run is the mark', () => {
    const m = laneMarks(job, [run(1, at(24, 6, 30), 'skipped', null, at(24, 6, 31)), run(2, at(24, 6, 30), 'ok', at(24, 7))], at(24, 0), at(24, 23), at(24, 20))
    expect(m).toHaveLength(1)
    expect(m[0].status).toBe('ok')
  })
  it('a row whose due matches no occurrence (the cadence changed) is still drawn', () => {
    const m = laneMarks(job, [run(4, at(24, 9, 0), 'ok', at(24, 9, 0))], at(24, 0), at(24, 23), at(24, 20), at(24, 0))
    expect(m.some(x => x.row === 4 && x.status === 'ok')).toBe(true)
  })
  it('before the run record began, an unconsumed occurrence is not drawn (the record cannot tell)', () => {
    const m = laneMarks(job, [], from, to, now, at(24, 20))
    expect(m.map(x => new Date(x.t).getDate())).toEqual([25])
  })
  it('a scheduler-written missed row whose grace ended before the record began is not drawn either', () => {
    const runs = [run(5, at(23, 6, 30), 'missed', null, at(24, 20)), run(6, at(24, 6, 30), 'missed', null, at(24, 20))]
    const m = laneMarks(job, runs, from, to, now, at(24, 10))
    // 23rd: grace ended 12:30 on the 23rd, before the record (24th 10:00) - dropped; 24th: grace runs past 10:00 - kept
    expect(m.map(x => [new Date(x.t).getDate(), x.row])).toEqual([[24, 6], [25, null]])
  })
  it('a disabled job owes nothing', () => {
    expect(laneMarks({ ...job, enabled: false }, [], from, to, now)).toEqual([])
  })
})

describe('lab read lanes', () => {
  const D = 86_400_000
  it('a done read is an actual; a due one is owed; a late one is a miss; outside the window and not owed: no lane', () => {
    const from = at(20, 0), to = at(27, 0)
    const lanes = readLanes([
      { key: 'lab/x#001', desk: 'lab/x', run: '001', reads: { '7d': { due: at(22, 9), state: 'done', row: { ts: new Date(at(22, 10)).toISOString() } }, '30d': { due: at(22, 9) + 23 * D, state: 'pending' } } },
      { key: 'lab/x#002', desk: 'lab/x', run: '002', reads: { '7d': { due: at(24, 9), state: 'due' }, '30d': { due: null, state: 'none' } } },
      { key: 'lab/x#003', desk: 'lab/x', run: '003', reads: { '7d': { due: at(10, 9), state: 'late' }, '30d': { due: null, state: 'none' } } },
      { key: 'lab/x#004', desk: 'lab/x', run: '004', reads: { '7d': { due: at(2, 9), state: 'done', row: { ts: at(2, 9) } }, '30d': { due: null, state: 'none' } } },
    ], from, to)
    expect(lanes.map(l => l.run).sort()).toEqual(['001', '002', '003'])
    const get = (r: string) => lanes.find(l => l.run === r)!.marks
    expect(get('001').map(m => m.kind)).toEqual(['run'])
    expect(get('001')[0].t).toBe(at(22, 10))
    expect(get('002').map(m => m.kind)).toEqual(['owed'])
    expect(get('003').map(m => [m.kind, m.status])).toEqual([['missed', 'late']])
    expect(get('003')[0].t).toBe(from)                 // a debt older than the window pins to its left edge
  })
})

describe('DST (Europe/London, BST ends 2026-10-25)', () => {
  it('a daily stays at its wall time and every 1h keeps 25 distinct instants on the 25-hour day', () => {
    const script = `
      import { occurrencesIn } from ${JSON.stringify('file:///' + resolve(__dirname, '..', 'server', 'system', 'wall.ts').split(BS).join('/'))}
      const from = new Date(2026, 9, 24, 0, 0).getTime(), to = new Date(2026, 9, 26, 23, 59).getTime()
      const daily = occurrencesIn('daily 06:30', from, to).map(t => new Date(t).toTimeString().slice(0, 5))
      const gaps = occurrencesIn('daily 06:30', from, to).map((t, i, a) => i ? (t - a[i - 1]) / 3600000 : 0).slice(1)
      const d0 = new Date(2026, 9, 25, 0, 0).getTime(), d1 = new Date(2026, 9, 26, 0, 0).getTime() - 1
      const hourly = occurrencesIn('every 1h', d0, d1)
      console.log(JSON.stringify({ daily, gaps, hourly: hourly.length, distinct: new Set(hourly).size, span: (d1 + 1 - d0) / 3600000 }))
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'Europe/London' }, encoding: 'utf8' })
    const r = JSON.parse(out.trim().split('\n').pop()!)
    expect(r.span).toBe(25)                             // the zone really has the fall-back day
    expect(r.daily).toEqual(['06:30', '06:30', '06:30'])
    expect(r.gaps).toEqual([25, 24])                    // the 25-hour day, then 24 real hours
    expect(r.distinct).toBe(r.hourly)                   // no instant twice
    expect(r.hourly).toBeGreaterThanOrEqual(24)
  })
})
