import { describe, expect, it } from 'vitest'
import { litChats, litTitle, markSeen, paneInView, rowMark, tabLight, watchedPane, type Look, type Seen } from '../src/rooms/chats/mark.ts'

const seen: Seen = { base: 1000, at: { a: 2000 } }

describe('chats row mark', () => {
  it('running wins, even when open or unread', () => {
    expect(rowMark({ id: 'x', state: 'live', lastAt: 5000 }, seen)).toBe('running')
    expect(rowMark({ id: 'x', state: 'live', lastAt: 5000 }, seen, true)).toBe('running')
  })
  it('unread only when it moved after the last look (or the first-look base)', () => {
    expect(rowMark({ id: 'a', state: 'idle', lastAt: 2000 }, seen)).toBe(null)
    expect(rowMark({ id: 'a', state: 'waiting', lastAt: 2001 }, seen)).toBe('unread')
    expect(rowMark({ id: 'b', state: 'closed', lastAt: 900 }, seen)).toBe(null)
    expect(rowMark({ id: 'b', state: 'closed', lastAt: 1100 }, seen)).toBe('unread')
  })
  it('the pane in view is never unread; idle rows carry no mark', () => {
    expect(rowMark({ id: 'b', state: 'idle', lastAt: 9000 }, seen, true)).toBe(null)
  })
  it('tab light: ask while parked (seen or not), done/fail only when new, never watched or running', () => {
    expect(tabLight({ id: 'a', state: 'waiting', lastAt: 2000 }, seen, false)).toBe('ask')
    expect(tabLight({ id: 'a', state: 'waiting', lastAt: 9000 }, seen, true)).toBe(null)
    expect(tabLight({ id: 'x', state: 'live', lastAt: 9000 }, seen, false)).toBe(null)
    expect(tabLight({ id: 'a', state: 'idle', lastAt: 2000 }, seen, false)).toBe(null)
    expect(tabLight({ id: 'a', state: 'idle', lastAt: 2001 }, seen, false)).toBe('done')
    expect(tabLight({ id: 'b', state: 'closed', lastAt: 1100 }, seen, false)).toBe('done')
    expect(tabLight({ id: 'a', state: 'idle', lastAt: 2001, failed: true }, seen, false)).toBe('fail')
    expect(tabLight({ id: 'a', state: 'idle', lastAt: 2001, failed: true }, seen, true)).toBe(null)
    expect(tabLight({ id: 'a', state: 'idle', lastAt: 2000, failed: true }, seen, false)).toBe(null)
    // opening it puts the light out
    expect(tabLight({ id: 'a', state: 'idle', lastAt: 2001 }, markSeen(seen, 'a', 2001), false)).toBe(null)
  })
  it('markSeen records, is a no-op when not newer, and prunes into the base', () => {
    const s1 = markSeen(seen, 'b', 3000)
    expect(rowMark({ id: 'b', state: 'idle', lastAt: 3000 }, s1)).toBe(null)
    expect(markSeen(s1, 'b', 2500)).toBe(s1)
    const s2 = markSeen(markSeen({ base: 0, at: {} }, 'p', 10, 2), 'q', 20, 2)
    const s3 = markSeen(s2, 'r', 30, 2)
    expect(Object.keys(s3.at).sort()).toEqual(['q', 'r'])
    expect(s3.base).toBe(10)
    expect(rowMark({ id: 'p', state: 'closed', lastAt: 10 }, s3)).toBe(null)
  })

  // B-0253: seen = the Chats room on screen AND the pane in view AND the tab visible AND focused
  describe('the look (B-0253)', () => {
    const all: Look = { room: true, visible: true, focused: true }
    it('the pane in view is the selection when open, else the newest pane', () => {
      expect(paneInView('b', ['a', 'b', 'c'])).toBe('b')
      expect(paneInView('z', ['a', 'b', 'c'])).toBe('c')
      expect(paneInView(null, [])).toBe(null)
    })
    it('in view, room shown, tab visible and focused: watched', () => {
      expect(watchedPane('a', all)).toBe('a')
    })
    it('the Chats room not on screen: not watched', () => {
      expect(watchedPane('a', { ...all, room: false })).toBe(null)
    })
    it('the browser tab hidden: not watched', () => {
      expect(watchedPane('a', { ...all, visible: false })).toBe(null)
    })
    it('the window blurred: not watched', () => {
      expect(watchedPane('a', { ...all, focused: false })).toBe(null)
    })
    it('no pane in view: nothing watched', () => {
      expect(watchedPane(null, all)).toBe(null)
    })
    it('a turn that ends on the pane in view while not looking lights, and stays lit until looked at', () => {
      const c = { id: 'a', state: 'idle', lastAt: 5000 }
      for (const l of [{ ...all, room: false }, { ...all, visible: false }, { ...all, focused: false }]) {
        expect(tabLight(c, seen, watchedPane('a', l) === 'a')).toBe('done')
        expect(tabLight({ ...c, failed: true }, seen, watchedPane('a', l) === 'a')).toBe('fail')
      }
      expect(tabLight({ ...c, state: 'waiting' }, seen, watchedPane('a', { ...all, focused: false }) === 'a')).toBe('ask')
      // looking at it: dark, and once marked seen it stays dark after the owner looks away again
      expect(tabLight(c, seen, watchedPane('a', all) === 'a')).toBe(null)
      expect(tabLight(c, markSeen(seen, 'a', 5000), watchedPane('a', { ...all, visible: false }) === 'a')).toBe(null)
    })
  })

  describe('the lit count (B-0253)', () => {
    const convs = [
      { id: 'a', state: 'idle', lastAt: 5000 },                   // open, new: done
      { id: 'b', state: 'idle', lastAt: 5000, failed: true },     // open, new, errored: fail
      { id: 'c', state: 'waiting', lastAt: 100 },                 // open, parked: ask
      { id: 'd', state: 'waiting', lastAt: 100 },                 // no pane, parked: ask
      { id: 'e', state: 'idle', lastAt: 5000 },                   // no pane, new: not a lit chat (a row mark only)
      { id: 'f', state: 'live', lastAt: 5000 },                   // open, running: never lit
    ]
    const panes = ['a', 'b', 'c', 'f', 'term:1']
    it('counts every lit tab plus every parked conversation without a pane; tone is the worst', () => {
      expect(litChats(convs, panes, seen, null)).toEqual({ n: 4, tone: 'fail' })
    })
    it('the watched pane is not lit', () => {
      expect(litChats(convs, panes, seen, 'b')).toEqual({ n: 3, tone: 'ask' })
      expect(litChats(convs.slice(0, 1), ['a'], seen, null)).toEqual({ n: 1 })
      expect(litChats(convs.slice(0, 1), ['a'], seen, 'a')).toEqual({ n: 0 })
    })
    it('the browser tab title carries the count, and none at zero', () => {
      expect(litTitle('AI Native Hedge Fund', 2)).toBe('(2) AI Native Hedge Fund')
      expect(litTitle('(2) AI Native Hedge Fund', 0)).toBe('AI Native Hedge Fund')
      expect(litTitle('(2) AI Native Hedge Fund', 3)).toBe('(3) AI Native Hedge Fund')
      expect(litTitle('AI', 150)).toBe('(99+) AI')
      expect(litTitle('(99+) AI', 0)).toBe('AI')
    })
  })
})
