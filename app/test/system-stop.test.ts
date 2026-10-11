import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../server/sched/index.ts'
import { parseEnd, readStopState, setStop, stopHolds, untilOf } from '../server/system/stop.ts'

let dir = ''
let file = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cockpit-stopuntil-')); file = join(dir, 'STOP') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const T0 = Date.parse('2026-10-04T12:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000)

describe('floor/STOP with an optional end time', () => {
  it('writes the end time on a second line and reads it back; no end time reads null', () => {
    const on = setStop(file, true, new Date(T0), at(60))
    expect(on).toMatchObject({ stopped: true, until: T0 + 3_600_000 })
    expect(readFileSync(file, 'utf8')).toBe('stopped 2026-10-04T12:00:00\nuntil 2026-10-04T13:00:00.000Z\n')
    expect(setStop(file, true, new Date(T0)).until).toBeNull()
    expect(readFileSync(file, 'utf8')).toBe('stopped 2026-10-04T12:00:00\n')
  })

  it('an expired STOP no longer holds, the file is cleared, and onExpire hears the end time', () => {
    setStop(file, true, new Date(T0), at(60))
    const heard = vi.fn()
    expect(stopHolds(file, T0 + 59 * 60_000, heard)).toBe(true)          // before the end: holds
    expect(existsSync(file)).toBe(true)
    expect(heard).not.toHaveBeenCalled()
    expect(stopHolds(file, T0 + 60 * 60_000, heard)).toBe(false)         // at the end: lifted
    expect(existsSync(file)).toBe(false)
    expect(heard).toHaveBeenCalledOnce()
    expect(heard).toHaveBeenCalledWith(T0 + 3_600_000)
    expect(stopHolds(file, T0 + 61 * 60_000, heard)).toBe(false)         // nothing left to clear, nothing logged twice
    expect(heard).toHaveBeenCalledOnce()
  })

  it('a STOP with no end time still holds, however old', () => {
    setStop(file, true, new Date(T0))
    expect(stopHolds(file, T0 + 400 * 86_400_000)).toBe(true)
    expect(existsSync(file)).toBe(true)
  })

  it('a STOP whose end time cannot be read still holds (never guessed away); so does a hand-written one', () => {
    writeFileSync(file, 'stopped 2026-10-04T12:00:00\nuntil tomorrow-ish\n')
    expect(untilOf(readFileSync(file, 'utf8'))).toBeNull()
    expect(stopHolds(file, T0 + 86_400_000)).toBe(true)
    writeFileSync(file, 'stopped\n')
    expect(stopHolds(file, T0 + 86_400_000)).toBe(true)
  })

  it('the scheduler lifts an expired STOP itself; an open-ended and a future-dated one still stop it', () => {
    const root = join(dir, 'fund'); mkdirSync(join(root, 'floor'), { recursive: true })
    const s = new Scheduler({ fundRoot: root, floorDir: join(root, 'floor'), logDir: join(dir, 'logs') })
    writeFileSync(s.stopFile, `stopped\nuntil ${new Date(Date.now() - 1000).toISOString()}\n`)
    expect(s.stopped()).toBe(false)
    expect(existsSync(s.stopFile)).toBe(false)
    writeFileSync(s.stopFile, 'stopped\n')
    expect(s.stopped()).toBe(true)
    writeFileSync(s.stopFile, `stopped\nuntil ${new Date(Date.now() + 3_600_000).toISOString()}\n`)
    expect(s.stopped()).toBe(true)
  })

  it('a halt request: no end time is open-ended; a future instant with its zone passes; the rest are refused with a reason', () => {
    expect(parseEnd(true, undefined, T0)).toEqual({ end: null })
    expect(parseEnd(true, null, T0)).toEqual({ end: null })
    expect(parseEnd(true, '2026-10-04T13:00:00Z', T0).end?.getTime()).toBe(T0 + 3_600_000)
    expect(parseEnd(true, '2026-10-04T15:00:00+02:00', T0).end?.getTime()).toBe(T0 + 3_600_000)
    for (const bad of ['2026-10-04T13:00:00', '1h', 'tomorrow', 12345, '2026-13-45T99:00:00Z']) expect(parseEnd(true, bad, T0).error, String(bad)).toMatch(/ISO instant/)
    expect(parseEnd(true, '2026-10-04T11:00:00Z', T0).error).toMatch(/past/)
    expect(parseEnd(true, '2026-10-04T12:00:00Z', T0).error).toMatch(/past/)
    expect(parseEnd(false, '2026-10-04T13:00:00Z', T0).error).toMatch(/on: true/)
  })

  it('readStopState carries the end time for the System room', () => {
    expect(readStopState(file)).toEqual({ stopped: false, text: null, at: null, until: null })
    setStop(file, true, new Date(T0), at(30))
    expect(readStopState(file).until).toBe(T0 + 1_800_000)
  })
})
