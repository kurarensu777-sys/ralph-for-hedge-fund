import { describe, expect, it } from 'vitest'
import { deskRetro } from '../server/lab/retro.ts'

// the lab rail's retro clock is the loop's rule, slimmed: due / date / since / why

const DAY = 86_400_000
const NOW = Date.parse('2026-09-26T12:00:00Z')
const row = (run: string, pre = true) => JSON.stringify({ run, stage: 'result', preregistered: pre })
const jsonl = (...rs: string[]) => rs.join('\n') + '\n'
const stamp = (date: string, run: string) => '```\nLast retro: ' + date + ' · through run ' + run + ' · next bet: x\n```\n'

describe('deskRetro', () => {
  it('no runs and no stamp is not due (nothing to grade)', () => {
    const r = deskRetro('lab/x', null, null, NOW)
    expect(r.due).toBe(false)
    expect(r.date).toBeNull()
    expect(r.why).toMatch(/no runs/)
  })

  it('pre-registered results and no stamp is due, never retro\'d', () => {
    const r = deskRetro('lab/x', 'no stamp here', jsonl(row('001'), row('002')), NOW)
    expect(r.due).toBe(true)
    expect(r.why).toMatch(/never retro/)
  })

  it('imports alone owe no retro', () => {
    expect(deskRetro('lab/x', null, jsonl(row('001', false)), NOW).due).toBe(false)
  })

  it('a fresh stamp with few runs since is not due; an old one is', () => {
    const fresh = new Date(NOW - 2 * DAY).toISOString().slice(0, 10)
    const r = deskRetro('lab/x', stamp(fresh, '001'), jsonl(row('001'), row('002')), NOW)
    expect(r).toMatchObject({ due: false, date: fresh, since: 1 })
    const old = new Date(NOW - 9 * DAY).toISOString().slice(0, 10)
    const o = deskRetro('lab/x', stamp(old, '002'), jsonl(row('001'), row('002')), NOW)
    expect(o).toMatchObject({ due: true, date: old, since: 0 })
    expect(o.why).toMatch(/old/)
  })

  it('more than five runs since the stamp is due whatever its age', () => {
    const fresh = new Date(NOW - DAY).toISOString().slice(0, 10)
    const runs = jsonl(...['001', '002', '003', '004', '005', '006', '007'].map(r => row(r)))
    expect(deskRetro('lab/x', stamp(fresh, '001'), runs, NOW)).toMatchObject({ due: true, since: 6 })
  })
})
