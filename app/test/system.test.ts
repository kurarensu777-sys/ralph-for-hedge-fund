import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { latestReading, loadProbes, probeFromReading, probeRow, readingOf, worst } from '../server/system/probes.ts'
import { ops } from '../server/db.ts'
import { resetStore } from './pg/reset.ts'
import { fmtIn, lastOccurrence, lastRuns, nextOccurrence, toWall, fromWall } from '../server/system/schedule.ts'

const NOW = new Date(2026, 8, 24, 16, 55, 0).getTime()   // Thu 2026-09-24 16:55 LOCAL

describe('probe staleness', () => {
  const file = (status: string, ageS: number, windowS = 3600) => JSON.stringify({ id: 'x', label: 'l', owner: '.', status, reading: 'r', probed_ts: (NOW - ageS * 1000) / 1000, window_s: windowS })
  it('fresh ok stays ok', () => {
    const p = probeRow('x.json', file('ok', 100), NOW)
    expect(p).toMatchObject({ status: 'ok', stale: false, ageS: 100, windowS: 3600 })
  })
  it('ok but older than its window is STALE and not green', () => {
    expect(probeRow('x.json', file('ok', 3600), NOW).stale).toBe(false)
    const p = probeRow('x.json', file('ok', 3601), NOW)
    expect(p.stale).toBe(true)
    expect(p.status).toBe('warn')
    expect(p.claimed).toBe('ok')
  })
  it('a stale fail is an OLD verdict: amber, not red; a fresh fail is red; unknown stays unknown', () => {
    expect(probeRow('x.json', file('fail', 99999), NOW)).toMatchObject({ status: 'warn', stale: true, claimed: 'fail' })
    expect(probeRow('x.json', file('fail', 10), NOW).status).toBe('fail')
    expect(probeRow('x.json', file('unknown', 10), NOW).status).toBe('unknown')
  })
  it('no probed_ts or broken JSON is unknown, never ok', () => {
    expect(probeRow('x.json', JSON.stringify({ id: 'x', status: 'ok' }), NOW).status).toBe('unknown')
    expect(probeRow('y.json', '{nope', NOW)).toMatchObject({ id: 'y', status: 'unknown', reading: 'not JSON' })
  })
  it('loads the NEWEST reading of each probe from the ops store and ranks the worst', async () => {
    await resetStore()
    expect(await loadProbes(NOW)).toEqual([])                                      // nothing recorded: no rows, not a green one
    const rec = (id: string, status: string, ageS: number, extra: object = {}) => ops.recordHealth(`system:${id}`, 'system', status,
      { reading: `${id} ${status}`, detail: { ...JSON.parse(file(status, ageS)), id, ...extra }, ts: NOW - ageS * 1000 })
    await rec('a', 'fail', 500)
    await rec('a', 'ok', 10, { label: 'the a probe' })                           // newer: this one counts
    await rec('b', 'fail', 10)
    await ops.recordHealth('dash:terminal', 'dashboard', 'fail', { reading: 'x', ts: NOW })   // another target: not a probe
    await ops.recordHealth('feed-trust:acme', 'system', 'fail', { reading: 'x', ts: NOW })    // not a system: key
    const ps = await loadProbes(NOW)
    expect(ps.map(p => [p.id, p.status, p.label, p.file])).toEqual([
      ['a', 'ok', 'the a probe', 'ops.health_readings system:a'], ['b', 'fail', 'l', 'ops.health_readings system:b']])
    expect(worst(ps)).toBe('fail')
    expect(worst([])).toBe('unknown')
    expect((await latestReading('a'))?.label).toBe('the a probe')
    expect(await latestReading('never')).toBeNull()
  })
  it('an older heat-only row (detail {window_s}) still reads: id, status, reading and time from the row', () => {
    const r = { probe_id: 'system:git', ts: NOW - 5000, status: 'ok', reading: 'clean', detail_json: { window_s: 3600 } }
    expect(readingOf(r)).toEqual({ window_s: 3600, id: 'git', status: 'ok', reading: 'clean', probed_ts: Math.floor((NOW - 5000) / 1000) })
    expect(probeFromReading(r, NOW)).toMatchObject({ id: 'git', status: 'ok', stale: false, ageS: 5 })
    expect(probeFromReading({ ...r, detail_json: '{nope' }, NOW)).toMatchObject({ id: 'git', status: 'ok', windowS: null })
  })
})

describe('cadence grammar (tools/fundcli/schedule.py)', () => {
  it('wall clock round trip', () => {
    expect(fromWall(toWall(NOW))).toBe(NOW)
  })
  it('daily: the next HH:MM after now, local', () => {
    const later = new Date(nextOccurrence('daily 18:00', NOW)!)
    expect([later.getDate(), later.getHours(), later.getMinutes()]).toEqual([24, 18, 0])
    const tomorrow = new Date(nextOccurrence('daily 06:30', NOW)!)
    expect([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([25, 6, 30])
    expect(new Date(lastOccurrence('daily 06:30', NOW)!).getDate()).toBe(24)
  })
  it('weekly: day names, case-insensitive', () => {
    const mon = new Date(nextOccurrence('weekly mon 08:00', NOW)!)
    expect([mon.getDay(), mon.getDate(), mon.getHours()]).toEqual([1, 28, 8])
    const sun = new Date(nextOccurrence('weekly SUN 18:15', NOW)!)
    expect([sun.getDay(), sun.getDate()]).toEqual([0, 27])
    const thuPast = new Date(nextOccurrence('weekly thursday 09:00', NOW)!)
    expect(thuPast.getDate()).toBe(1)          // today's 09:00 is gone -> next Thursday (Oct 1)
    expect(new Date(lastOccurrence('weekly thursday 09:00', NOW)!).getDate()).toBe(24)
  })
  it('every Nh / Nm: an epoch-anchored LOCAL grid', () => {
    const n = nextOccurrence('every 4h', NOW)!
    expect(toWall(n) % (4 * 3600_000)).toBe(0)
    expect(n - NOW).toBeGreaterThan(0)
    expect(n - NOW).toBeLessThanOrEqual(4 * 3600_000)
    expect(new Date(n).getHours()).toBe(20)
    const m = nextOccurrence('every 15m', NOW)!
    expect(new Date(m).getMinutes()).toBe(0)
    expect(new Date(m).getHours()).toBe(17)
  })
  it('at <iso>: once, in the future only', () => {
    expect(new Date(nextOccurrence('at 2026-09-28T09:00', NOW)!).getDate()).toBe(28)
    expect(nextOccurrence('at 2026-09-01T09:00', NOW)).toBeNull()
    expect(lastOccurrence('at 2026-09-01T09:00', NOW)).not.toBeNull()
  })
  it('anything else is null, shown as "-"', () => {
    expect(nextOccurrence('hourly', NOW)).toBeNull()
    expect(nextOccurrence('daily 25:00', NOW)).toBeNull()
    expect(nextOccurrence('weekly funday 08:00', NOW)).toBeNull()
    expect(nextOccurrence('every 0h', NOW)).toBeNull()
  })
  it('last run per job, and the "in" label', () => {
    const m = lastRuns([
      { job: 'a', status: 'ok', due_ts: 100, end: 110 },
      { job: 'a', status: 'missed', due_ts: 200, end: null },
      { job: 'b', status: 'fail', due_ts: 50, end: 60 },
    ])
    expect(m.get('a')!.status).toBe('missed')
    expect(m.get('b')!.status).toBe('fail')
    expect(fmtIn(2 * 3600_000)).toBe('2h')
    expect(fmtIn(90_000)).toBe('2m')
  })
})

describe('floor/STOP (Stop / Resume)', () => {
  it('writes, reads back with its mtime, and clears; a missing floor is a no-op', async () => {
    const { readStopState, setStop } = await import('../server/system/stop.ts')
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-stop-'))
    try {
      const f = join(dir, 'STOP')
      expect(readStopState(f)).toEqual({ stopped: false, text: null, at: null, until: null })
      const on = setStop(f, true, new Date('2026-09-24T09:05:00Z'))
      expect(on.stopped).toBe(true)
      expect(on.text).toBe('stopped 2026-09-24T09:05:00')
      expect(typeof on.at).toBe('number')
      expect(setStop(f, false)).toEqual({ stopped: false, text: null, at: null, until: null })
      expect(setStop(f, false).stopped).toBe(false)          // resume twice is harmless
      expect(setStop(join(dir, 'nofloor', 'STOP'), true).stopped).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
