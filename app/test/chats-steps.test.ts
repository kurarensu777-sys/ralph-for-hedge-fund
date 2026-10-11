import { describe, expect, it } from 'vitest'
import { resultOf, ringOf, ringOfStep, rowsOf, stepCount } from '../src/rooms/chats/steps.ts'
import { categoryOf, CATEGORIES, initials } from '../src/ui/categories.ts'
import type { Entry } from '../server/chat/types.ts'

let n = 0
const E = (p: Partial<Entry>): Entry => ({ id: `e${++n}`, ts: n, kind: 'tool', content: '', ...p })
const read = (p: Partial<Entry> = {}) => E({ action: { type: 'read', verb: 'Read', target: 'a.md' }, status: 'success', ...p })
const cmd = (p: Partial<Entry> = {}) => E({ action: { type: 'command', verb: 'Bash', cmd: 'npm test' }, status: 'success', ...p })

describe('chat step timeline', () => {
  it('a run of tools and thoughts between prose is ONE steps row; prose, bubbles and nested entries are not steps', () => {
    const rows = rowsOf([
      E({ kind: 'user', content: 'go' }),
      E({ kind: 'thinking', content: 'hmm' }),
      read(), read(), cmd(),
      E({ kind: 'tool', nested: true, action: { type: 'read', verb: 'Read' }, status: 'success' }),
      E({ kind: 'assistant', content: 'done' }),
      cmd(),
    ])
    expect(rows.map(r => r.kind)).toEqual(['entry', 'steps', 'entry', 'steps'])
    const s = rows[1].kind === 'steps' ? rows[1].steps : []
    expect(s.map(x => x.kind)).toEqual(['entry', 'fold', 'entry'])
    expect(stepCount(s)).toBe(4)
  })
  it('a failed read is its own step, never folded away', () => {
    const rows = rowsOf([read(), read({ status: 'failed', content: 'ENOENT: no such file' }), read()])
    const s = rows[0].kind === 'steps' ? rows[0].steps : []
    expect(s.map(x => x.kind)).toEqual(['entry', 'entry', 'entry'])
  })
  it('rings: done / running / failed / denied, a fold takes its worst', () => {
    expect(ringOf(cmd())).toBe('done')
    expect(ringOf(cmd({ status: 'created' }))).toBe('run')
    expect(ringOf(cmd({ status: 'failed' }))).toBe('fail')
    expect(ringOf(cmd({ status: 'denied' }))).toBe('denied')
    expect(ringOf(E({ kind: 'thinking', streaming: true }))).toBe('run')
    expect(ringOfStep({ key: 'f', kind: 'fold', items: [read(), read({ status: 'created' })] })).toBe('run')
    expect(ringOfStep({ key: 'f', kind: 'fold', items: [read(), read()] })).toBe('done')
  })
  it('the short result says only what came back', () => {
    expect(resultOf(cmd({ status: 'created' }))).toBe('')
    expect(resultOf(cmd({ res: { stdout: 'x\n Tests  633 passed\n\n' } }))).toBe('pass 633')
    expect(resultOf(cmd({ res: { stdout: ' Tests  1 failed | 16 passed (17)' } }))).toBe('1 fail · 16 pass')
    expect(resultOf(cmd({ res: { stdout: 'verify 17/17 ALL PASS' } }))).toBe('pass 17/17')
    expect(resultOf(cmd({ res: { stdout: '== 5 passed, 1 failed in 0.3s ==' } }))).toBe('1 fail · 5 pass')
    // a raw fragment of the output is never the result: a line count is
    expect(resultOf(cmd({ res: { stdout: '301: if first and self.pages % PUBLISH_EVERY:\n302: x' } }))).toBe('2 lines')
    expect(resultOf(cmd({ res: { stdout: '[main 1a2b3c4d] ui: fix' } }))).toBe('commit 1a2b3c4')
    expect(resultOf(cmd({ res: {} }))).toBe('no output')
    expect(resultOf(cmd({ status: 'failed', res: { stderr: 'Traceback\n  File x\nModuleNotFoundError: No module named api' } }))).toBe('ModuleNotFoundError')
    expect(resultOf(cmd({ status: 'failed', res: { stderr: 'Exit code 2\nlong message here that says a lot' } }))).toBe('exit 2')
    expect(resultOf(cmd({ status: 'failed', res: { stderr: 'boom\nmore' } }))).toBe('boom')
    expect(resultOf(cmd({ status: 'denied' }))).toBe('denied')
    expect(resultOf(read({ res: { lines: 42 } }))).toBe('42 lines')
    expect(resultOf(read())).toBe('')
    expect(resultOf(E({ action: { type: 'search', verb: 'Search' }, status: 'success', content: 'a.ts\nb.ts' }))).toBe('2 hits')
    expect(resultOf(E({ action: { type: 'search', verb: 'Search' }, status: 'success', content: 'No matches found' }))).toBe('none')
    expect(resultOf(E({ action: { type: 'todo', verb: 'Todos', todos: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }] }, status: 'success' }))).toBe('1/2 done')
    expect(resultOf(cmd({ res: { stdout: 'y'.repeat(200) } })).length).toBeLessThanOrEqual(58)
  })
})

describe('agent categories', () => {
  it('one colour per department, dashboards by kind or id', () => {
    expect(categoryOf('app').color).toBe('#8b8cf7')
    expect(categoryOf('dash:vol')).toBe(CATEGORIES.dashboards)
    expect(categoryOf({ id: 'x', kind: 'dashboard' })).toBe(CATEGORIES.dashboards)
    expect(categoryOf({ id: 'newdesk', dept: 'Research' })).toBe(CATEGORIES.research)
    expect(categoryOf('execution').color).toBe('#8a8f98')
    expect(categoryOf(null)).toBe(CATEGORIES.fund)
    expect(initials('dash:vol')).toBe('VO')
  })
})
