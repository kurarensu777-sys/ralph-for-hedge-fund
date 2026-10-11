import { describe, expect, it } from 'vitest'
import { fmtIn, nextJobOf, sparkPoints, spendWeek } from '../src/shell/status.ts'
import { dashTip, dashUp, isZeroRow, railCard, railTally, repoOrder, repoStateTip, repoSync, tallyTip } from '../src/shell/rail.ts'
import type { ServiceRow } from '../shared/types.ts'

const H = 3_600_000

describe('status bar: next job', () => {
  it('picks the soonest job and measures its ring from the last scheduled occurrence', () => {
    const now = 10 * H
    const nj = nextJobOf([
      { id: 'late', next: now + 5 * H, last: { trigger: 'schedule', due: now - H } },
      { id: 'soon', next: now + 0.5 * H, last: { trigger: 'schedule', due: now - 0.5 * H } },
      { id: 'off', next: null },
    ], now)
    expect(nj).toEqual({ id: 'soon', inMs: 0.5 * H, frac: 0.5 })
  })
  it('draws no ring when the previous occurrence is not known (a manual run, never ran)', () => {
    const now = 10 * H
    expect(nextJobOf([{ id: 'm', next: now + H, last: { trigger: 'manual', due: null } }], now)?.frac).toBeNull()
    expect(nextJobOf([{ id: 'n', next: now + H, last: null }], now)?.frac).toBeNull()
  })
  it('is null with no job due, and for a missing schedule', () => {
    expect(nextJobOf([{ id: 'x', next: null }], 0)).toBeNull()
    expect(nextJobOf(null, 0)).toBeNull()
  })
  it('counts down in the one format', () => {
    expect(fmtIn(26 * 60_000)).toBe('26m')
    expect(fmtIn(3 * H)).toBe('3h')
    expect(fmtIn(72 * H)).toBe('3d')
  })
})

describe('status bar: spend sparkline', () => {
  const today = new Date(2026, 8, 25, 12)
  const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}`
  it('sums billable tokens per day over exactly the last 7 days', () => {
    const rows = [19, 20, 21, 22, 23, 24, 25].flatMap(d => [{ day: day(d), tin: 1, cw: 2, tout: d }, { day: day(d), tin: 1, cw: 0, tout: 0 }])
    expect(spendWeek([...rows, { day: day(10), tin: 99 }], today)).toEqual([23, 24, 25, 26, 27, 28, 29])
  })
  it('draws nothing unless every one of the 7 days was recorded', () => {
    const rows = [24, 25].map(d => ({ day: day(d), tin: 5 }))
    expect(spendWeek(rows, today)).toBeNull()
    expect(spendWeek([20, 21, 22, 23, 24, 25].map(d => ({ day: day(d), tin: 1 })), today)).toBeNull()
    expect(spendWeek(null, today)).toBeNull()
  })
  it('maps the lowest value to the bottom edge', () => {
    const pts = sparkPoints([0, 10], 36, 12, 0).split(' ')
    expect(pts).toEqual(['0.0,12.0', '36.0,0.0'])
  })
})

describe('rail: zero rows', () => {
  const row = (status: ServiceRow['status'], reading: string): ServiceRow => ({ id: reading, label: 'x', status, reading })
  it('hides measured zeros and keeps trouble, unknowns and real values', () => {
    expect(isZeroRow(row('ok', '0'))).toBe(true)
    expect(isZeroRow(row('ok', 'none due'))).toBe(true)
    expect(isZeroRow(row('off', 'none'))).toBe(true)
    expect(isZeroRow(row('ok', 'clean'))).toBe(true)
    expect(isZeroRow(row('ok', '0 fail · 0 stale'))).toBe(true)
    expect(isZeroRow(row('warn', '0'))).toBe(false)
    expect(isZeroRow(row('unknown', '0'))).toBe(false)
    expect(isZeroRow(row('ok', ''))).toBe(false)
    expect(isZeroRow(row('ok', '6'))).toBe(false)
    expect(isZeroRow(row('ok', '0 proposed · 24m'))).toBe(false)
    expect(isZeroRow(row('off', 'stopped'))).toBe(false)
  })
  it('keeps the whole total on the card and folds an all-zero card to its header', () => {
    const c = railCard({ id: 'board', label: 'Board', rows: [row('warn', '6'), row('ok', '0'), row('ok', '0')] })
    expect([c.shown.length, c.total, c.hidden]).toEqual([1, 3, 2])
    const q = railCard({ id: 'loop', label: 'Loop', rows: [row('ok', 'none due'), row('off', 'none')] })
    expect([q.shown.length, q.total]).toEqual([0, 2])
  })
})

describe('rail: header tally + repo strip', () => {
  const row = (status: ServiceRow['status'], reading = ''): ServiceRow => ({ id: status + reading, label: 'x', status, reading })
  it('counts each state once, run as ok, off/unknown as grey, and the owner count is down + asking', () => {
    const t = railTally([row('fail'), row('warn'), row('ask'), row('ask'), row('ok'), row('run'), row('off'), row('unknown')])
    expect(t).toEqual({ fail: 1, warn: 1, ask: 2, ok: 2, grey: 2, owner: 3 })
    expect(tallyTip(t, 'up')).toBe('1 down · 1 warn · 2 waiting on you · 2 up · 2 off or unknown')
    expect(railTally([row('ok')]).owner).toBe(0)
    expect(tallyTip(railTally([]))).toBe('empty')
  })
  it('reads a repo as in sync only when clean or local', () => {
    expect(repoSync(row('ok', 'clean'))).toBe('sync')
    expect(repoSync(row('ok', 'local'))).toBe('sync')
    expect(repoSync(row('ok', '1 ahead'))).toBe('behind')
    expect(repoSync(row('warn', '2 dirty'))).toBe('behind')
    expect(repoSync(row('warn', '3 behind'))).toBe('behind')
    expect(repoSync(row('fail', '1 conflict'))).toBe('conflict')
    expect(repoSync(row('unknown', 'git failed'))).toBe('unknown')
  })
  it('names each repo square state, the reading when it says more', () => {
    expect(repoStateTip(row('ok', 'clean'))).toBe('in sync')
    expect(repoStateTip(row('warn', '3 behind'))).toBe('3 behind')
    expect(repoStateTip(row('unknown', ''))).toBe('unknown')
  })
  it('orders the fund repo first, strangers after in their own order', () => {
    const ids = ['repo:research', 'repo:zzz', 'repo:app', 'repo:fund', 'repo:platform'].map(id => ({ id }))
    expect(repoOrder(ids).map(r => r.id)).toEqual(['repo:fund', 'repo:research', 'repo:zzz', 'repo:app', 'repo:platform'])
  })
  it('reads the dashboards count from the tally, unknown (null) never 0', () => {
    expect(dashUp('3/7 up')).toEqual({ up: 3, total: 7 })
    expect(dashUp('0/7 up')).toEqual({ up: 0, total: 7 })
    expect(dashUp(undefined)).toBeNull()
    expect(dashUp('?')).toBeNull()
  })
})

describe('dashTip', () => {
  it('names what the count counts, tools apart, and every row', () => {
    const rows = [{ label: 'Trade', reading: 'stopped', kind: 'dashboard' }, { label: 'Vol', kind: 'dashboard' }, { label: 'Jupyter', reading: 'up 2h', kind: 'tool' }]
    const t = dashTip({ up: 1, total: 3 }, rows)
    expect(t.split('\n')[0]).toBe('1 of 3 up: 2 dashboards + 1 tool (Jupyter)')
    expect(t).toContain('Vol: unknown')
    expect(t).toContain('Jupyter (tool): up 2h')
  })
  it('says dashboards alone when no tool is counted', () => {
    expect(dashTip({ up: 0, total: 1 }, [{ label: 'Trade', reading: 'stopped' }]).split('\n')[0]).toBe('0 of 1 up: 1 dashboard')
  })
})
