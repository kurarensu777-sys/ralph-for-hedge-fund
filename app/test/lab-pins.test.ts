import { describe, expect, it } from 'vitest'
import { groupRuns } from '../server/lab/runs.ts'
import { fpOf, pinCount, truncated, type FpInput, type Fingerprint } from '../server/lab/fingerprint.ts'

// THE LAB READS PINS (B-0327): a pin's hash IS a fingerprint input's sha256 (database B-0324), so an
// input is pinned when its row carries `pin` or the pin index holds its sha256; a pinned input's
// truncation is read from the pinned rows, never from what the cache holds now.

const H = 3_600_000
const JUL = Date.parse('2026-07-15T00:00:00Z')
const A = 'a'.repeat(64), B = 'b'.repeat(64)
const inp = (over: Partial<FpInput> = {}): FpInput => ({ venue: 'acme', symbol: 'xyz:ABC', dataset: 'candles', interval: '1h', first_ts: JUL, last_ts: JUL + 100 * H, rows: 101, sha256: A, stored_first: JUL - 1000 * H, trunc: false, ...over })
const fp = (inputs: FpInput[]): Fingerprint => ({ digest: '0000000a', window: { from: JUL, to: JUL + 100 * H }, inputs })

describe('pins in the window fingerprint', () => {
  it('reads a recorded pin; drops one that is not a 64-hex hash', () => {
    const f = fpOf({ fingerprint: { digest: '0000000a', window: { from: JUL, to: JUL + 1 }, inputs: [{ ...inp(), pin: A }, { ...inp({ sha256: B }), pin: 'nope' }] } })!
    expect(f.inputs.map(i => i.pin)).toEqual([A, null])
  })
  it('counts pinned inputs from the row and from the index; an unread index is not "unpinned"', () => {
    const f = fp([inp({ pin: A }), inp({ sha256: B, dataset: 'funding', interval: '' })])
    expect(pinCount(f, null)).toEqual({ pinned: 1, of: 2, known: false })
    expect(pinCount(f, new Set())).toEqual({ pinned: 1, of: 2, known: true })
    expect(pinCount(f, new Set([B]))).toEqual({ pinned: 2, of: 2, known: true })          // the backfill pinned it later
    expect(pinCount(null, new Set([A]))).toBeNull()
  })
  it('a pinned input is truncated by its OWN first row, not by the cache', () => {
    // the cache now starts late (evicted head) but the pinned rows start at the window's from
    const lateCache = inp({ stored_first: JUL + 50 * H, trunc: true, first_ts: JUL })
    expect(truncated(fp([lateCache]))).toBe(true)                                          // unpinned: the old rule stands
    expect(truncated(fp([lateCache]), undefined, new Set([A]))).toBe(false)                 // pinned: the rows the result used
    // a pin whose own rows start late IS truncated, whatever the cache holds
    const latePin = inp({ first_ts: JUL + 5 * H, stored_first: JUL - 9 * H, pin: A })
    expect(truncated(fp([latePin]))).toBe(true)
  })
  it('runs carry their pin count through the ledger reader', () => {
    const RES = { run: '009', stage: 'result', desk: 'd', ts: '2026-09-14T00:00:00Z', kind: 'explore', mechanic: 'M2', predicted: {}, metrics: { x: 1 },
      window: { from: '2026-07-15', to: '2026-07-20' }, fingerprint: fp([inp(), inp({ sha256: B, symbol: 'BTC' })]) }
    expect(groupRuns('d', [RES], JUL)[0].pins).toEqual({ pinned: 0, of: 2, known: false })
    expect(groupRuns('d', [RES], JUL, 0, new Set([A, B]))[0].pins).toEqual({ pinned: 2, of: 2, known: true })
  })
})
