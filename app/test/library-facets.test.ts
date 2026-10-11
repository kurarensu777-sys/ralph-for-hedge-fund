import { describe, expect, it } from 'vitest'
import type { LibBook } from '../server/library/types.ts'
import { chapterHits, isFiltered, matcher, nested, textOk, typeOk } from '../src/rooms/library/facets.ts'
import { DEFAULT_URL, decodeFacets, encodeFacets } from '../src/rooms/library/url.ts'

// B-0372 items 2 and 3 (+ the URL of the room's filters): the pure half of the Library UI.

const ch = (slug: string, title: string, readWhen: string, tokens = 300) => ({ slug, title, readWhen, tokens, readers: [] as string[] })
const book = (over: Partial<LibBook>): LibBook => ({
  path: 'app/library/law/how-we-guard.md', shelf: 'law', series: 'law', title: 'How we guard', readWhen: 'about to guard something', topics: [], type: 'guide', parent: null,
  chapters: [ch('probing-the-deny-list', 'Probing the deny list', 'you add a row to a settings file'), ch('data-the-four-classes', 'Data: the four classes', 'pulling, keeping or deleting data')],
  tokens: 2000, updated: 0, readers: [], recall: [], ...over,
})

describe('the text filter sees chapters', () => {
  const b = book({})
  it('a query only a chapter TITLE contains matches its book', () => {
    expect(`${b.title} ${b.path} ${b.readWhen}`.toLowerCase()).not.toContain('deny list')   // the old filter read nothing else
    expect(textOk(b, 'deny list')).toBe(true)
  })
  it("a query only a chapter's Read when line contains matches its book", () => {
    expect(textOk(b, 'settings file')).toBe(true)
    expect(textOk(b, 'deleting data')).toBe(true)
  })
  it('a query nothing holds still matches nothing', () => {
    expect(textOk(b, 'zebra stripes')).toBe(false)
  })
  it('lists the chapters that match, for "N chapters match" under the book row', () => {
    expect(chapterHits(b, 'data').map(c => c.slug)).toEqual(['data-the-four-classes'])
    expect(chapterHits(b, 'the').map(c => c.slug)).toEqual(['probing-the-deny-list', 'data-the-four-classes'])
    expect(chapterHits(b, 'zebra')).toEqual([])
    expect(chapterHits(b, '')).toEqual([])
  })
  it('the #topic prefix syntax stays: it matches topics only, never chapters', () => {
    const t = book({ topics: ['fees'], chapters: [ch('fees-x', 'Fees at a venue', 'x')] })
    expect(textOk(t, '#fe')).toBe(true)
    expect(textOk(t, '#deny')).toBe(false)
    expect(textOk(t, '#')).toBe(false)
    expect(chapterHits(t, '#fe')).toEqual([])
  })
})

describe('the type control', () => {
  const guide = book({}), strat = book({ path: 'app/library/research/carry.md', shelf: 'research', title: 'Carry', type: 'strategy', parent: 'research' }), untyped = book({ path: 'app/library/markets/f.md', shelf: 'markets', type: null })
  it('All shows every book; Guides and Strategies each only their own; an untyped book shows under All only', () => {
    expect([guide, strat, untyped].map(b => typeOk(b, ''))).toEqual([true, true, true])
    expect([guide, strat, untyped].map(b => typeOk(b, 'guide'))).toEqual([true, false, false])
    expect([guide, strat, untyped].map(b => typeOk(b, 'strategy'))).toEqual([false, true, false])
  })
  it('the matcher applies it with the other facets; a type is a filter (isFiltered)', () => {
    const f = { shelf: null, topics: [], who: null, need: '' as const, read: '' as const, q: '' }
    expect(matcher({ loads: null }, { ...f, type: 'strategy' })(strat)).toBe(true)
    expect(matcher({ loads: null }, { ...f, type: 'strategy' })(guide)).toBe(false)
    expect(isFiltered({ ...f, type: 'guide' })).toBe(true)
    expect(isFiltered(f)).toBe(false)
  })
})

describe('a strategy book stands under its parent', () => {
  const mk = (stem: string, parent: string | null, shelf = 'research') => book({ path: `app/library/${shelf}/${stem}.md`, shelf, title: stem, parent, type: parent ? 'strategy' : 'guide' })
  it('children follow the parent, one level in; the order of the rest is kept', () => {
    const list = [mk('carry', 'research'), mk('equity-perps', 'research'), mk('multi-leg', 'research'), mk('research', null), mk('vol', 'research'), mk('notes', null)]
    expect(nested(list).map(x => [x.book.title, x.depth])).toEqual([['research', 0], ['carry', 1], ['equity-perps', 1], ['multi-leg', 1], ['vol', 1], ['notes', 0]])
  })
  it('a parent that is not in the list (filtered out, or on another shelf) leaves its children at the top level', () => {
    expect(nested([mk('carry', 'research'), mk('vol', 'research')]).map(x => x.depth)).toEqual([0, 0])
    expect(nested([mk('carry', 'research', 'law'), mk('research', null)]).map(x => x.depth)).toEqual([0, 0])
  })
  it('every book appears exactly once, even in a parent cycle (a bad `parent:` never hides a book)', () => {
    const out = nested([mk('a', 'b'), mk('b', 'a'), mk('c', null)])
    expect(out.map(x => x.book.title).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('the Library filters in the URL hash', () => {
  const s = { ...DEFAULT_URL, shelf: 'research', type: 'strategy' as const, topics: ['research/carry', 'research/vol'], q: 'deny list', text: true, need: 'must' as const, who: 'dash:vol' }
  it('round-trips every facet', () => {
    expect(decodeFacets(encodeFacets(s))).toEqual(s)
    const t = { ...DEFAULT_URL, view: 'readers' as const, read: 'never' as const, hide: true, agent: 'app' }
    expect(decodeFacets(encodeFacets(t))).toEqual(t)
  })
  it('the default view is the empty query, so a plain Library URL stays bare', () => {
    expect(encodeFacets(DEFAULT_URL)).toBe('')
    expect(decodeFacets('')).toEqual(DEFAULT_URL)
  })
  it('a value the room does not draw is dropped to the default, never carried into the state', () => {
    expect(decodeFacets('type=bogus&need=x&read=y&view=z')).toEqual(DEFAULT_URL)
  })
  it('a link names the whole view: keys it omits are the default, not whatever was on screen', () => {
    expect(decodeFacets('type=guide')).toEqual({ ...DEFAULT_URL, type: 'guide' })
  })
})
