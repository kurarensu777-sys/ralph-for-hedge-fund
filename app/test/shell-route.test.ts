import { describe, expect, it } from 'vitest'
import { choiceOf, formatHash, parseHash, routeOf, stepFor, ROOM_IDS } from '../src/shell/route.ts'

describe('the URL of a view', () => {
  it('names every room', () => {
    for (const r of ROOM_IDS) expect(parseHash(formatHash({ room: r, target: null }))).toEqual({ room: r, target: null })
  })

  it('round-trips a conversation, a board item, a book path, a run key', () => {
    for (const [room, target] of [['chats', 'c_1790349188709_ab'], ['board', 'B-0049'], ['library', 'library/fund/the-operating-manual/the-sync-law.md'], ['lab', 'lab/crypto/basis#12'], ['library', 'agent:dash:trade']] as const) {
      const h = formatHash({ room, target })
      expect(parseHash(h)).toEqual({ room, target })
    }
  })

  it('keeps a book path readable: slashes stay, other reserved characters are escaped', () => {
    expect(formatHash({ room: 'library', target: 'library/fund/x y.md' })).toBe('#/library/library/fund/x%20y.md')
    expect(formatHash({ room: 'lab', target: 'desk#12?x' })).toBe('#/lab/desk%2312%3Fx')
  })

  it('a room may carry a query after the target: the Library filters, kept in the URL', () => {
    const r = { room: 'library' as const, target: null, query: 'type=guide&shelf=law' }
    expect(formatHash(r)).toBe('#/library?type=guide&shelf=law')
    expect(parseHash('#/library?type=guide&shelf=law')).toEqual(r)
    expect(parseHash('#/library/app/library/law/x.md%23the-slug?type=guide')).toEqual({ room: 'library', target: 'app/library/law/x.md#the-slug', query: 'type=guide' })
    expect(parseHash(formatHash({ room: 'library', target: 'app/library/law/x.md#a?b', query: 'q=1' }))).toEqual({ room: 'library', target: 'app/library/law/x.md#a?b', query: 'q=1' })
    expect(routeOf('library', null, null, 'q=1')).toEqual({ room: 'library', target: null, query: 'q=1' })
    expect(routeOf('library', null, null, '')).toEqual({ room: 'library', target: null })   // no query: the route is as before
  })

  it('a chapter deep link is a book path and a slug: #/library/<book path>#<slug>', () => {
    const ref = 'app/library/law/how-we-guard.md#probing-the-deny-list'
    expect(formatHash({ room: 'library', target: ref })).toBe('#/library/app/library/law/how-we-guard.md%23probing-the-deny-list')
    expect(parseHash(formatHash({ room: 'library', target: ref }))).toEqual({ room: 'library', target: ref })
  })

  it('refuses what is not a room, so the remembered room opens instead', () => {
    expect(parseHash('')).toBeNull()
    expect(parseHash('#')).toBeNull()
    expect(parseHash('#/')).toBeNull()
    expect(parseHash('#/nowhere/x')).toBeNull()
    expect(parseHash('#top')).toBeNull()
    expect(parseHash('#/board/%E0%A4%A')).toBeNull() // a malformed escape is not a target
  })

  it('a trailing slash is no target', () => {
    expect(parseHash('#/board/')).toEqual({ room: 'board', target: null })
  })

  it('a linked drawer wins over the room selection', () => {
    expect(routeOf('board', null, 'B-0001')).toEqual({ room: 'board', target: 'B-0001' })
    expect(routeOf('chats', 'c_1', undefined)).toEqual({ room: 'chats', target: 'c_1' })
    expect(routeOf('chats', 'c_1', null)).toEqual({ room: 'chats', target: 'c_1' })
  })
})

describe('the history step for a view change', () => {
  const base = { url: '#/board', d: null }
  it('does nothing when the entry already is the view', () => {
    expect(stepFor(base, { url: '#/board', d: null })).toEqual({ op: 'none' })
  })

  it('a move to another room or selection pushes', () => {
    expect(stepFor(base, { url: '#/chats/c_1', d: null })).toEqual({ op: 'push', entry: { url: '#/chats/c_1', d: null } })
  })

  it('a drawer opened over a view gets its own entry, remembering the view under it', () => {
    expect(stepFor(base, { url: '#/board/B-1', d: 7 })).toEqual({ op: 'push', entry: { url: '#/board/B-1', d: 7, over: '#/board' } })
    expect(stepFor({ url: '#/chats/c_1', d: null }, { url: '#/chats/c_1', d: 8 })).toEqual({ op: 'push', entry: { url: '#/chats/c_1', d: 8, over: '#/chats/c_1' } })
  })

  it('closing that drawer pops its entry instead of stacking another', () => {
    expect(stepFor({ url: '#/board/B-1', d: 7, over: '#/board' }, { url: '#/board', d: null }, { closed: 7 })).toEqual({ op: 'back' })
  })

  it('an entry whose drawer did not come back is rewritten, never popped', () => {
    // Forward onto a drawer with no link: no drawer reopened, then an unrelated change runs
    expect(stepFor({ url: '#/chats/c_1', d: 3, over: '#/chats/c_1' }, { url: '#/chats/c_1', d: null }, { closed: null }))
      .toEqual({ op: 'replace', entry: { url: '#/chats/c_1', d: null } })
  })

  it('a drawer closed by moving away pushes the new view (Back returns to the drawer)', () => {
    expect(stepFor({ url: '#/board/B-1', d: 7, over: '#/board' }, { url: '#/chats/c_9', d: null }, { closed: 7 }))
      .toEqual({ op: 'push', entry: { url: '#/chats/c_9', d: null } })
  })

  it('a pasted link the room turned into its drawer is that entry, not a layer over it', () => {
    expect(stepFor({ url: '#/board/B-1', d: null }, { url: '#/board/B-1', d: 9 }, { arrived: true }))
      .toEqual({ op: 'replace', entry: { url: '#/board/B-1', d: 9 } })
    // and closing it moves to the room (Back reopens the item)
    expect(stepFor({ url: '#/board/B-1', d: 9 }, { url: '#/board', d: null }, { closed: 9 }))
      .toEqual({ op: 'push', entry: { url: '#/board', d: null } })
  })

  it('a drawer swapped for another keeps the view under it', () => {
    expect(stepFor({ url: '#/board/B-1', d: 7, over: '#/board' }, { url: '#/board/B-2', d: 8 }))
      .toEqual({ op: 'replace', entry: { url: '#/board/B-2', d: 8, over: '#/board' } })
  })
})

describe('a target the room cannot show', () => {
  const TABS = ['health', 'schedule', 'spend'] as const

  it('a known target is the choice and stays', () => {
    expect(choiceOf('spend', TABS, 'health')).toEqual({ choice: 'spend', settle: false })
  })

  it('an unknown target falls back AND is rewritten, so the URL names the view on screen', () => {
    expect(choiceOf('nonsense', TABS, 'health')).toEqual({ choice: 'health', settle: true })
  })

  it('no target is the default view with a bare URL, never rewritten', () => {
    for (const s of [null, undefined, '']) expect(choiceOf(s, TABS, 'health')).toEqual({ choice: 'health', settle: false })
  })

  it('the rewrite replaces the entry: Back never lands on the bad URL again', () => {
    expect(stepFor({ url: '#/system/nonsense', d: null }, { url: '#/system/health', d: null }, { settled: true }))
      .toEqual({ op: 'replace', entry: { url: '#/system/health', d: null } })
    // the same move without the settle flag is an ordinary push (the flag is what changes it)
    expect(stepFor({ url: '#/system/nonsense', d: null }, { url: '#/system/health', d: null }).op).toBe('push')
  })
})
