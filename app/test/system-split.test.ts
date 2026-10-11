import { describe, expect, it } from 'vitest'
import { splitProbes } from '../src/rooms/system/split.ts'

const p = (id: string, status: string, stale = false) => ({ id, status, stale })

describe('health split', () => {
  it('fail, warn and unknown lead in that order; ok folds', () => {
    const s = splitProbes([p('b', 'ok'), p('u', 'unknown'), p('w', 'warn'), p('f', 'fail'), p('a', 'ok')])
    expect(s.lead.map(x => x.id)).toEqual(['f', 'w', 'u'])
    expect(s.ok.map(x => x.id)).toEqual(['a', 'b'])
  })
  it('a stale ok is not ok: it leads', () => {
    const s = splitProbes([p('a', 'ok', true), p('b', 'ok')])
    expect(s.lead.map(x => x.id)).toEqual(['a'])
    expect(s.ok.map(x => x.id)).toEqual(['b'])
  })
  it('nothing failing leaves an empty lead', () => {
    expect(splitProbes([p('a', 'ok')]).lead).toEqual([])
  })
})

import { cardDot, groupCards } from '../src/rooms/system/split.ts'

describe('health cards', () => {
  const q = (id: string, owner: string, status: string, stale = false) => ({ id, owner, status, stale })
  const own = (x: { owner: string }) => x.owner
  it('one card per owner, each with its own split', () => {
    const c = groupCards([q('a', 'app', 'ok'), q('b', 'app', 'fail'), q('c', 'fund', 'ok')], own, ['fund', 'app'])
    expect(c.map(x => x.owner)).toEqual(['app', 'fund'])
    expect(c[0].lead.map(x => x.id)).toEqual(['b'])
    expect(c[0].ok.map(x => x.id)).toEqual(['a'])
  })
  it('fail before stale before unknown before all ok; ties keep the category order', () => {
    const c = groupCards([q('u', 'research', 'unknown'), q('s', 'platform', 'ok', true), q('o1', 'fund', 'ok'), q('o2', 'app', 'ok'), q('f', 'zed', 'fail')], own, ['fund', 'app', 'platform', 'research'])
    expect(c.map(x => x.owner)).toEqual(['zed', 'platform', 'research', 'fund', 'app'])
  })
  it('unknown stays its own rank, never folded into ok', () => {
    const c = groupCards([q('u', 'fund', 'unknown')], own)
    expect(c[0].ok).toEqual([])
    expect(c[0].rank).toBe(2)
  })
})

describe('cardDot', () => {
  it('reds a failing card, ambers a stale one, hollows an unknown one and draws nothing when all ok', () => {
    expect([0, 1, 2, 3].map(cardDot)).toEqual(['fail', 'warn', 'unknown', null])
  })
})
