import { describe, expect, it } from 'vitest'
import { splitOrphans } from '../server/system/probes.ts'
import { orphanLine } from '../src/rooms/system/orphans.ts'
import { expectedSet, worst } from '../server/system/probes.ts'
import { join } from 'node:path'
import { FUND_ROOT, PYTHON, TOOLS_DIR } from '../server/paths.ts'

// ORPHANS (2026-09-27, the owner's call): a stored reading outside staleness.py's expected set is
// folded out of the Health view into one dim line; it never counts toward a tile, a group or a dot.

const r = (id: string, status: string, ageS: number | null = 10) => ({ id, status, ageS, stale: false })
const ex = { registry: ['selftest', 'probe-sweep'], recorded: ['scheduler', 'budget', 'retro-due'] }

describe('the orphan readings', () => {
  it('folds every reading outside the expected set out of the judged probes', () => {
    const all = [r('selftest', 'ok'), r('scheduler', 'ok'), r('feed-refresh', 'warn', 122000), r('feed-probe', 'fail', 125000)]
    const { probes, orphans } = splitOrphans(all, ex)
    expect(probes.map(p => p.id)).toEqual(['selftest', 'scheduler'])
    expect(orphans.map(p => p.id)).toEqual(['feed-refresh', 'feed-probe'])
    // an orphan's red never reaches a dot: the worst of the judged rows is what shows
    expect(worst(probes)).toBe('ok')
    expect(worst(all)).toBe('fail')
  })
  it('folds nothing when the expected set could not be read: every reading stays judged', () => {
    const all = [r('selftest', 'ok'), r('feed-probe', 'fail')]
    expect(splitOrphans(all, null)).toEqual({ probes: all, orphans: [] })
  })
  it('says them as one line, the names and ages in its tooltip', () => {
    const l = orphanLine([{ id: 'feed-refresh', ageS: 122000 }, { id: 'feed-probe', ageS: 125000 }], null)!
    expect(l.text).toBe('2 orphan readings')
    expect(l.title).toContain('feed-refresh: 33.9h old')
    expect(l.title).toContain('feed-probe: 34.7h old')
    expect(orphanLine([{ id: 'x', ageS: null }], null)!.text).toBe('1 orphan reading')
    expect(orphanLine([], null)).toBeNull()
    expect(orphanLine(undefined, 'staleness.py --expected: boom')!.title).toMatch(/boom/)
  })
  it('asks staleness.py for the set - one definition - and gets the registry and the recorded writers', async () => {
    const { set, why } = await expectedSet(join(TOOLS_DIR, 'probes', 'staleness.py'), PYTHON, FUND_ROOT)
    expect(why).toBeNull()
    expect(set!.registry).toEqual(expect.arrayContaining(['git', 'probe-sweep']))
    expect(set!.recorded).toEqual(expect.arrayContaining(['scheduler', 'budget', 'probe-staleness']))
    // probe-git's job has health false on purpose (its probe writes the git row): a stored probe-git reading is an orphan
    expect([...set!.registry, ...set!.recorded]).not.toContain('probe-git')
  })
})
