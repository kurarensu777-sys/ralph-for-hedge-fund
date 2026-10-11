import { describe, expect, it } from 'vitest'
import { progressOf } from '../server/chat/progress.ts'
import type { Entry, Todo } from '../server/chat/types.ts'
import { FADE_MS, tabProgress } from '../src/rooms/chats/progress.ts'

let n = 0
const at = (ts: number, e: Partial<Entry>): Entry => ({ id: `e${n++}`, ts, kind: 'system', content: '', ...e })
const user = (ts: number) => at(ts, { kind: 'user', content: 'go' })
const tool = (ts: number, verb = 'Bash', target = 'npm test', nested = false) => at(ts, { kind: 'tool', action: { type: 'command', verb, target }, status: 'success', nested })
const todo = (ts: number, st: Todo['status'][], nested = false) => at(ts, {
  kind: 'tool', nested, status: 'success',
  action: { type: 'todo', verb: 'Todos', todos: st.map((s, i) => ({ text: `item ${i}`, active: `doing item ${i}`, status: s })) },
})
const say = (ts: number) => at(ts, { kind: 'assistant', content: 'done' })
const BUSY = { busy: true, waiting: false }, IDLE = { busy: false, waiting: false }

describe('a turn\'s progress (server/chat/progress.ts)', () => {
  it('nothing before the first message, idle', () => {
    expect(progressOf([], IDLE)).toBe(null)
  })

  it('working with no todo list: steps counted, no denominator (never a guessed fill)', () => {
    const p = progressOf([user(1), tool(2), tool(3, 'Read', 'types.ts')], BUSY)!
    expect(p.kind).toBe('work')
    expect(p.total).toBeUndefined()
    expect(p.done).toBeUndefined()
    expect(p.steps).toBe(2)
    expect(p.now).toBe('Read types.ts')
    expect(p.since).toBe(1)
  })

  it('working with a list: the LATEST list, done of total, the item in progress by its active form', () => {
    const p = progressOf([user(1), todo(2, ['in_progress', 'pending', 'pending']), tool(3), todo(4, ['completed', 'completed', 'in_progress'])], BUSY)!
    expect(p).toMatchObject({ kind: 'work', done: 2, total: 3, steps: 3, now: 'doing item 2' })
  })

  it('a list from an EARLIER turn is not this turn\'s', () => {
    const p = progressOf([user(1), todo(2, ['completed', 'in_progress']), say(3), user(4), tool(5)], BUSY)!
    expect(p.total).toBeUndefined()
    expect(p.steps).toBe(1)
    expect(p.since).toBe(4)
  })

  it('a subagent\'s steps and lists are not the turn\'s', () => {
    const p = progressOf([user(1), tool(2), tool(3, 'Read', 'x', true), todo(4, ['completed'], true)], BUSY)!
    expect(p.steps).toBe(1)
    expect(p.total).toBeUndefined()
  })

  it('waiting on the owner is ask, whatever runs', () => {
    expect(progressOf([user(1), todo(2, ['completed', 'in_progress'])], { busy: true, waiting: true })!.kind).toBe('ask')
  })

  it('ended: done when every item is ticked (or there was no list), open when some are not', () => {
    expect(progressOf([user(1), todo(2, ['completed', 'completed']), say(3)], IDLE)).toMatchObject({ kind: 'done', done: 2, total: 2, now: '', at: 3 })
    expect(progressOf([user(1), tool(2), say(3)], IDLE)!.kind).toBe('done')
    expect(progressOf([user(1), todo(2, ['completed', 'in_progress', 'pending']), say(3)], IDLE)).toMatchObject({ kind: 'open', done: 1, total: 3 })
  })

  it('ended on an error is fail; an error the agent answered past is not', () => {
    expect(progressOf([user(1), tool(2), at(3, { kind: 'error', content: 'boom' })], IDLE)!.kind).toBe('fail')
    expect(progressOf([user(1), at(2, { kind: 'error', content: 'boom' }), say(3)], IDLE)!.kind).toBe('done')
  })

  it('interrupted, stopped or cut is stop', () => {
    expect(progressOf([user(1), tool(2), at(3, { content: 'Interrupted' })], IDLE)!.kind).toBe('stop')
    expect(progressOf([user(1), tool(2), at(3, { content: 'Stopped (STOP pressed)' })], IDLE)!.kind).toBe('stop')
    expect(progressOf([user(1), at(3, { content: 'The agent process ended in the middle of this turn.' })], IDLE)!.kind).toBe('stop')
  })

  it('a turn the process started itself (no message in the ring) still reads while it runs', () => {
    expect(progressOf([tool(5), tool(6)], BUSY)).toMatchObject({ kind: 'work', steps: 2, since: 5 })
  })
})

describe('the light in a tab (src/rooms/chats/progress.ts)', () => {
  const work = { kind: 'work' as const, steps: 7, now: 'Running npm test', since: 0, at: 1000 }
  const off = { light: null, watched: false, now: 60_000 }

  it('no reading, no light', () => {
    expect(tabProgress(undefined, off)).toBe(null)
  })

  it('working with no list sweeps (pct null) and says the steps', () => {
    expect(tabProgress(work, off)).toMatchObject({ kind: 'work', pct: null, count: '7 steps', now: 'Running npm test', fade: false })
  })

  it('working with a list fills done of total', () => {
    expect(tabProgress({ ...work, done: 2, total: 5 }, off)).toMatchObject({ pct: 40, count: '2/5' })
  })

  it('waiting says so, full blue when there is no list', () => {
    expect(tabProgress({ ...work, kind: 'ask' }, off)).toMatchObject({ kind: 'ask', pct: 100, count: '', now: 'waiting on you' })
  })

  it('an ended turn stays lit while its tab is lit (unseen)', () => {
    const done = { ...work, kind: 'done' as const, done: 5, total: 5 }
    expect(tabProgress(done, { ...off, light: 'done' })).toMatchObject({ pct: 100, count: '5/5', fade: false })
  })

  it('an ended turn in the watched tab fades for FADE_MS, then is gone; seen elsewhere it is gone', () => {
    const done = { ...work, kind: 'done' as const, at: 10_000 }
    expect(tabProgress(done, { light: null, watched: true, now: 10_000 + FADE_MS - 1 })!.fade).toBe(true)
    expect(tabProgress(done, { light: null, watched: true, now: 10_000 + FADE_MS })).toBe(null)
    expect(tabProgress(done, { light: null, watched: false, now: 10_001 })).toBe(null)
  })

  it('an unfinished list says how many are open', () => {
    expect(tabProgress({ ...work, kind: 'open', done: 3, total: 5 }, { ...off, light: 'done' })!.tip).toMatch(/^ended with 2 open: 3 of 5 done/)
  })
})
