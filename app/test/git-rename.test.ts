import { describe, expect, it } from 'vitest'
// plain ESM (the hooks run outside the TypeScript build); typed by guard-lib.d.mts
import * as lib from '../scripts/hooks/guard-lib.mjs'

// B-0023: a REWORDED `##` heading is a rename, not a lost section.

const sec = (h: string, body: string[]) => [`## ${h}`, ...body, '']
const doc = (...parts: string[][]) => ['# Book', '', ...parts.flat()].join('\n')
const body = (tag: string, n = 4) => Array.from({ length: n }, (_, i) => `${tag} line ${i}`)

describe('reworded headings', () => {
  it('a reworded heading with its body kept is renamed, not lost', () => {
    const before = doc(sec('Setup', body('a')), sec('Rules', body('b')), sec('Checks', body('c')))
    const after = doc(sec('Install', body('a')), sec('Rules', body('b')), sec('Checks', body('c')))
    const s = lib.bookShrink(before, after)
    expect(s.lostHeadings).toEqual([])
    expect(s.renamedHeadings).toEqual([{ from: 'Setup', to: 'Install' }])
    expect(s.sectionsPct).toBe(0)
    expect(s.flagged).toBe(false)
  })
  it('a reworded heading with its words mostly kept is renamed even when the body was rewritten', () => {
    const before = doc(sec('The fill window', body('a')), sec('X', body('x')))
    const after = doc(sec('The fill window, measured', body('z')), sec('X', body('x')))
    expect(lib.bookShrink(before, after)).toMatchObject({ lostHeadings: [], renamedHeadings: [{ from: 'The fill window', to: 'The fill window, measured' }], flagged: false })
    // case and punctuation alone
    expect(lib.headingSimilarity('Read when', 'read-when')).toBe(1)
  })
  it('a section really gone is still lost, and a new unrelated one does not absorb it', () => {
    const before = doc(sec('Alpha', body('a')), sec('Beta', body('b')), sec('Gamma', body('c')))
    const after = doc(sec('Alpha', body('a')), sec('Omega', body('o')), sec('Gamma', body('c')))
    const s = lib.bookShrink(before, after)
    expect(s.lostHeadings).toEqual(['Beta'])
    expect(s.renamedHeadings).toEqual([])
    expect(s.sectionsPct).toBe(-33)
    expect(s.flagged).toBe(true)
  })
  it('each new heading takes one rename at most, best match first', () => {
    const before = doc(sec('Fees', body('f')), sec('Funding', body('g')))
    const after = doc(sec('Fees and rebates', body('q')))
    const s = lib.bookShrink(before, after)
    expect(s.renamedHeadings).toEqual([{ from: 'Fees', to: 'Fees and rebates' }])
    expect(s.lostHeadings).toEqual(['Funding'])
  })
  it('an empty section needs its words to match: a bare body can never vouch for a rename', () => {
    const before = doc(sec('One', []), sec('Two', body('t')))
    const after = doc(sec('Uno', []), sec('Two', body('t')))
    expect(lib.bookShrink(before, after)).toMatchObject({ lostHeadings: ['One'], renamedHeadings: [] })
  })
  it('the report carries renames so the Git room tooltip can show them', () => {
    const before = doc(sec('Setup', body('a', 40)), sec('Rules', body('b', 40)))
    // body kept 25 of 40 lines: a rename; Rules really went, and the book lost > 30% of its lines
    const after = doc(sec('Install', body('a', 25)))
    const r = lib.shrinkReport([{ path: 'library/s/a.md', before, after }], 'trim')
    expect(r.files).toHaveLength(1)
    expect(r.files[0]).toMatchObject({ lostHeadings: ['Rules'], renamedHeadings: [{ from: 'Setup', to: 'Install' }], sectionsPct: -50 })
    // body kept 10 of 40 lines (25%) and no shared words: not a rename, so Setup is lost too
    expect(lib.bookShrink(before, doc(sec('Install', body('a', 10)))).lostHeadings).toEqual(['Setup', 'Rules'])
  })
  it('sections skip fenced code', () => {
    expect(lib.sections('## A\nx\n```\n## B\n```\n## C\n\ny\n').map(s => s.heading)).toEqual(['A', 'C'])
  })
})
