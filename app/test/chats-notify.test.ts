import { describe, expect, it } from 'vitest'
import { bellState, LESSON_PROMPT, makeDedupe, noteFor, WRAP_PROMPT } from '../src/rooms/chats/notify.ts'
import { WRAP } from '../server/library/drafts.ts'
import { counts, patchRows } from '../src/rooms/chats/diff.ts'

const ok = { hidden: true, on: true, permission: 'granted' }

describe('desktop notifications', () => {
  it('raises on waiting and on a finished turn, titled by the agent', () => {
    expect(noteFor({ id: 'c1', state: 'waiting', agent: 'quant', note: 'Which window?' }, ok))
      .toEqual({ tag: 'chat:c1:waiting', title: 'quant', body: 'Which window?', conv: 'c1' })
    expect(noteFor({ id: 'c1', turn: 'done', agent: 'quant', note: '' }, ok)?.body).toBe('turn finished')
  })
  it('stays quiet when visible, off, not granted, or not a note-worthy event', () => {
    const d = { id: 'c1', state: 'waiting', agent: 'a' }
    expect(noteFor(d, { ...ok, hidden: false })).toBeNull()
    expect(noteFor(d, { ...ok, on: false })).toBeNull()
    expect(noteFor(d, { ...ok, permission: 'default' })).toBeNull()
    expect(noteFor({ id: 'c1', state: 'live' }, ok)).toBeNull()
    expect(noteFor({ id: 'c1', reverted: 2 }, ok)).toBeNull()
    expect(noteFor({ state: 'waiting' }, ok)).toBeNull()
  })
  it('dedupes a repeat inside the window only', () => {
    const seen = makeDedupe(1000)
    expect(seen('t', 0)).toBe(false)
    expect(seen('t', 500)).toBe(true)
    expect(seen('t', 5000)).toBe(false)
  })
  it('the bell has four honest states', () => {
    expect(bellState(false, 'granted', true)).toBe('unsupported')
    expect(bellState(true, 'denied', true)).toBe('denied')
    expect(bellState(true, 'granted', true)).toBe('on')
    expect(bellState(true, 'default', true)).toBe('off')
  })
  it('the lesson prompt is the fixed debrief line', () => {
    expect(LESSON_PROMPT).toBe('Debrief: file what you learned this session as a book + its moment-line (library/...), or say there is nothing to file.')
  })
  it('the wrap prompt fires the debrief skill and reads as a wrap to the drafts scan', () => {
    expect(WRAP_PROMPT).toMatch(/^That's a wrap - debrief this conversation/)
    expect(WRAP_PROMPT).toMatch(/summarise/)
    expect(WRAP_PROMPT).toMatch(/strategy's book/)
    expect(WRAP.test(WRAP_PROMPT)).toBe(true)
    expect(WRAP.test('summarise what we did')).toBe(false)
  })
})

describe('patch rows', () => {
  it('drops headers, keeps hunks, counts', () => {
    const p = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n'
    const r = patchRows(p)
    expect(r).toEqual([{ t: 'gap', s: '@@ -1,2 +1,2 @@' }, { t: 'ctx', s: 'keep' }, { t: 'del', s: 'old' }, { t: 'add', s: 'new' }])
    expect(counts(r)).toEqual({ add: 1, del: 1 })
  })
  it('reads the server added-file patch and a binary note', () => {
    expect(counts(patchRows('new file n.md\n@@ -0,0 +1,2 @@\n+a\n+b'))).toEqual({ add: 2, del: 0 })
    expect(patchRows('binary file img.png')).toEqual([{ t: 'meta', s: 'binary file img.png' }])
  })
})
