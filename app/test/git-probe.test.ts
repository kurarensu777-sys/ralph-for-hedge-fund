import { describe, expect, it } from 'vitest'
import { probeDisagrees, REPROBE_MS, reprobeFor } from '../server/git/probe.ts'

describe('git probe vs the live Git room (B-0056: only behind re-runs it)', () => {
  const probe = { fund: { dirty: 2, ahead: 4, behind: 0 }, app: { dirty: 19, ahead: 0, behind: 3, upstream: '' }, platform: { dirty: 0, ahead: 0 } }
  const T = 10 * REPROBE_MS
  it('dirty and ahead churn alone never re-probes', () => {
    const live = [{ id: 'fund', dirty: 1, ahead: 6, behind: 0 }, { id: 'app', dirty: 0, ahead: 2, behind: 1 }, { id: 'platform', dirty: 7, ahead: 3, behind: 0 }]
    expect(probeDisagrees(probe, live)).toEqual([])
    expect(reprobeFor(probe, live, T, 0)).toEqual([])
  })
  it('a behind disagreement re-probes, either way round', () => {
    // probe says fund in sync, cards say behind; probe says app behind, cards say in sync
    const live = [{ id: 'fund', dirty: 2, ahead: 4, behind: 2 }, { id: 'app', dirty: 19, ahead: 0, behind: 0 }, { id: 'platform', behind: 0 }]
    expect(reprobeFor(probe, live, T, 0)).toEqual(['fund', 'app'])
  })
  it('the 180 s floor still holds', () => {
    const live = [{ id: 'fund', behind: 2 }]
    expect(reprobeFor(probe, live, T, T - REPROBE_MS + 1)).toEqual([])
    expect(reprobeFor(probe, live, T, T - REPROBE_MS)).toEqual(['fund'])
    expect(REPROBE_MS).toBe(180_000)
  })
  it('no probe reading, a repo it never read, or an unknown live behind (no upstream) is nothing to compare', () => {
    expect(reprobeFor(null, [{ id: 'fund', behind: 1 }], T, 0)).toEqual([])
    expect(reprobeFor(probe, [{ id: 'research', behind: 3 }], T, 0)).toEqual([])
    expect(reprobeFor(probe, [{ id: 'app', behind: null }], T, 0)).toEqual([])
  })
})
