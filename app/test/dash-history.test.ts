import { describe, expect, it } from 'vitest'
import { parseProbe, runState, summarize, type HistRow } from '../server/proc/history.ts'

const H = 3_600_000
const now = 100 * H
const ports = new Map([['trade', new Set(['port'])], ['tool', new Set<string>()]])
const run = (id: string, ts: number, s: Record<string, string>): HistRow[] => Object.entries(s).map(([c, status]) => ({ probe_id: `dash:${id}/${c}`, ts, status }))

describe('parseProbe / runState', () => {
  it('reads dashboard probe ids only', () => {
    expect(parseProbe('dash:trade/port')).toEqual(['trade', 'port'])
    expect(parseProbe('feed:acme')).toBeNull()
  })
  it('follows the live status rule: a closed port is off, not failing', () => {
    const p = new Set(['port'])
    expect(runState(new Map([['port', 'fail'], ['api', 'fail']]), p)).toBe('off')
    expect(runState(new Map([['port', 'ok'], ['api', 'fail']]), p)).toBe('fail')
    expect(runState(new Map([['port', 'ok'], ['data', 'warn']]), p)).toBe('warn')
    expect(runState(new Map([['port', 'ok'], ['api', 'unknown']]), p)).toBe('unknown')
    expect(runState(new Map([['port', 'ok'], ['api', 'ok']]), p)).toBe('ok')
  })
})

describe('summarize', () => {
  it('counts runs, uptime over the same runs the strip draws, and buckets the worst', () => {
    const rows = [
      ...run('trade', now - 23.9 * H, { port: 'ok', api: 'ok' }),
      ...run('trade', now - 23.8 * H, { port: 'fail', api: 'fail' }),   // same bucket as the one above
      ...run('trade', now - 10 * H, { port: 'ok', api: 'fail' }),
      ...run('trade', now - 0.1 * H, { port: 'ok', api: 'ok' }),
      ...run('trade', now - 30 * H, { port: 'fail' }),                  // outside the window
      { probe_id: 'dash:gone/port', ts: now - H, status: 'ok' },        // not in the config
    ]
    const [t] = summarize(rows, ports, now, 24 * H, 48)
    expect(t.runs).toBe(4)
    expect(t.up).toBe(2)            // the open-port run whose api failed is DOWN, as the strip paints it
    expect(t.measured).toBe(4)
    expect(t.uptime).toBe(0.5)
    expect(t.first).toBe(now - 23.9 * H)
    expect(t.counts).toEqual({ ok: 2, off: 1, fail: 1, warn: 0, unknown: 0 })
    expect(t.cells).toHaveLength(48)
    expect(t.cells[0]).toBe('part')         // a stop inside a serving bucket is shown as part served, part stopped (never all grey beside an uptime)
    expect(t.cells[28]).toBe('fail')
    expect(t.cells[47]).toBe('ok')
    expect(t.cells.filter(c => c === null)).toHaveLength(45)
  })
  it('is honest when it cannot tell: no runs is uptime null; a tool with no port check reads its own checks', () => {
    const rows = run('tool', now - H, { data: 'ok' })
    const out = summarize(rows, ports, now)
    expect(out.find(x => x.id === 'trade')).toMatchObject({ runs: 0, uptime: null, first: null })
    expect(out.find(x => x.id === 'tool')).toMatchObject({ runs: 1, uptime: 1, counts: { ok: 1 } })
  })
  it('does not count an unknown run as up or down', () => {
    const rows = [...run('trade', now - H, { port: 'unknown' }), ...run('trade', now - 2 * H, { port: 'ok' })]
    expect(summarize(rows, ports, now)[0]).toMatchObject({ runs: 2, up: 1, measured: 1, uptime: 1 })
  })
  it('the picture and the number agree: red strip, low uptime; nothing before the first run', () => {
    // the preds case: health failing with the port open for an hour, then healthy
    const rows = [
      ...Array.from({ length: 24 }, (_, i) => run('trade', now - 2 * H + i * 60_000 * 2.5, { port: 'ok', api: 'fail' })).flat(),
      ...Array.from({ length: 31 }, (_, i) => run('trade', now - H + i * 60_000 * 1.9, { port: 'ok', api: 'ok' })).flat(),
    ]
    const [t] = summarize(rows, ports, now)
    expect(t.uptime).toBeCloseTo(31 / 55)
    expect(t.cells.slice(0, 44).every(c => c === null)).toBe(true)   // unsampled, never red
    expect(t.cells.filter(c => c === 'fail').length).toBeGreaterThan(0)
  })
})

describe('summarizeHours (the heat strip)', () => {
  it('one cell per clock hour, the hour in progress last, each with the run it draws', async () => {
    const { summarizeHours } = await import('../server/proc/history.ts')
    const t0 = now + 20 * 60_000                            // 20 min into hour 100
    const rows: HistRow[] = [
      ...run('trade', 100 * H + 60_000, { port: 'ok', api: 'ok' }),
      ...run('trade', 100 * H + 120_000, { port: 'ok', api: 'fail' }).map(x => ({ ...x, reading: x.status === 'fail' ? '500 12ms' : ':8791 open' })),
      ...run('trade', 90 * H, { port: 'fail' }),
      ...run('trade', 76 * H + 1, { port: 'ok' }),        // before the 24 clock hours (77..100)
    ]
    const [t] = summarizeHours(rows, ports, t0)
    expect(t.cells).toHaveLength(24)
    expect(t.from).toBe(77 * H)
    expect(t.bucketMs).toBe(H)
    expect(t.cells[23]).toBe('fail')
    expect(t.notes[23]).toEqual({ at: 100 * H + 120_000, n: 2, note: 'api: fail (500 12ms)' })
    expect(t.cells[13]).toBe('off')
    expect(t.cells.filter(c => c === null)).toHaveLength(22)
    expect(t.runs).toBe(3)
  })
})
