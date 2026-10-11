import { describe, expect, it } from 'vitest'
import { shouldWake, WAKE_DEBOUNCE_MS, wakePrompt, wakeTitle } from '../server/proc/wake.ts'

const H = 3_600_000
const base = { onFail: 'wake_agent', lastWake: null, now: 100 * H }

describe('on_fail: wake_agent', () => {
  it('wakes on the transition into failing', () => {
    expect(shouldWake({ ...base, prev: 'running', next: 'failing' })).toBe(true)
    expect(shouldWake({ ...base, prev: 'stale', next: 'failing' })).toBe(true)
    expect(shouldWake({ ...base, prev: undefined, next: 'failing' })).toBe(true)
  })
  it('does not wake while it stays failing, or for any other state', () => {
    expect(shouldWake({ ...base, prev: 'failing', next: 'failing' })).toBe(false)
    for (const next of ['running', 'stale', 'stopped', 'dev', 'starting']) expect(shouldWake({ ...base, prev: 'running', next })).toBe(false)
  })
  it('never while floor/STOP is set', () => {
    expect(shouldWake({ ...base, prev: 'running', next: 'failing', stopped: true })).toBe(false)
    expect(shouldWake({ ...base, prev: 'running', next: 'failing', stopped: false })).toBe(true)
  })
  it('only when on_fail says wake_agent', () => {
    expect(shouldWake({ ...base, onFail: 'notify', prev: 'running', next: 'failing' })).toBe(false)
    expect(shouldWake({ ...base, onFail: undefined, prev: 'running', next: 'failing' })).toBe(false)
  })
  it('at most once per six hours', () => {
    expect(WAKE_DEBOUNCE_MS).toBe(6 * H)
    const t = { ...base, prev: 'running', next: 'failing' }
    expect(shouldWake({ ...t, lastWake: base.now - 1 * H })).toBe(false)
    expect(shouldWake({ ...t, lastWake: base.now - 6 * H + 1 })).toBe(false)
    expect(shouldWake({ ...t, lastWake: base.now - 6 * H })).toBe(true)
  })
  it('a flapping dashboard wakes once in the window', () => {
    const states = ['running', 'failing', 'running', 'failing', 'stale', 'failing']
    let prev: string | undefined, lastWake: number | null = null, n = 0
    states.forEach((next, i) => {
      const now = base.now + i * 15 * 60_000
      if (shouldWake({ onFail: 'wake_agent', prev, next, lastWake, now })) { n++; lastWake = now }
      prev = next
    })
    expect(n).toBe(1)
  })
  it('names the dashboard and the failing checks with their readings', () => {
    const p = wakePrompt('Trade', [
      { id: 'port', check: 'port', target: ':8787', status: 'ok', reading: 'open' },
      { id: 'fresh', check: 'file', target: 'x.json', status: 'fail', reading: '31h old' },
    ])
    expect(p).toBe('Trade is failing: fresh (file x.json): fail - 31h old. Diagnose and fix it; if you cannot, file a board item for the owner.')
    expect(wakeTitle('Trade')).toBe('Trade failing')
  })
})
