import { describe, expect, it } from 'vitest'
import { checklist, convSteps, progressOf } from '../src/rooms/board/state.ts'

// A card's progress bar is drawn only from a real count: the owner conversation's own todo list,
// else the item's markdown checklist. Nothing else may invent one.
describe('board card progress', () => {
  it('counts a markdown checklist, ticked either case', () => {
    expect(checklist('why\n\n- [x] one\n- [ ] two\n* [X] three\n  - [ ] four')).toEqual({ done: 2, total: 4, src: 'checklist' })
  })
  it('no checklist -> no bar', () => {
    expect(checklist('plain text\n- a bullet\n- [] not a box\n[x] no bullet')).toBeNull()
    expect(checklist('')).toBeNull()
  })
  it('an empty box with no text is not an item', () => {
    expect(checklist('- [ ]\n- [x] real')).toEqual({ done: 1, total: 1, src: 'checklist' })
  })
  it("reads the conversation's LAST todo list", () => {
    const e = [
      { action: { type: 'todo', todos: [{ status: 'pending' }, { status: 'pending' }] } },
      { action: { type: 'read' } },
      { action: { type: 'todo', todos: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }] } },
      {},
    ]
    expect(convSteps(e)).toEqual({ done: 1, total: 3, src: 'steps' })
  })
  it('a conversation that never wrote a todo list has no steps', () => {
    expect(convSteps([{ action: { type: 'read' } }, { action: { type: 'todo', todos: [] } }])).toBeNull()
    expect(convSteps(null)).toBeNull()
  })
  it('the conversation steps win over the checklist; neither -> null', () => {
    const s = { done: 1, total: 3, src: 'steps' as const }, c = { done: 2, total: 2, src: 'checklist' as const }
    expect(progressOf(s, c)).toBe(s)
    expect(progressOf(null, c)).toBe(c)
    expect(progressOf(null, null)).toBeNull()
  })
})

// The command pill's text filters the kanban AND the Suggested lane by one rule, so the lane's
// count follows the same text the cards do.
describe('board text filter', () => {
  it('every word, anywhere, any case; empty matches all', async () => {
    const { textMatch } = await import('../src/rooms/board/state.ts')
    expect(textMatch('Fix the Guard hook', 'guard fix')).toBe(true)
    expect(textMatch('Fix the Guard hook', 'guard lint')).toBe(false)
    expect(textMatch('anything', '   ')).toBe(true)
  })
  it('a suggestion matches on title, quote and path', async () => {
    const { sugMatches } = await import('../src/rooms/board/state.ts')
    const s = { title: 'Retire the shim', quote: 'TODO: drop api/ after the move', path: 'platform/app/cache.py', ref: 'cache.py:12', owner: null }
    expect(sugMatches(s, 'shim')).toBe(true)
    expect(sugMatches(s, 'drop api')).toBe(true)
    expect(sugMatches(s, 'cache.py')).toBe(true)
    expect(sugMatches(s, 'venues')).toBe(false)
  })
})
