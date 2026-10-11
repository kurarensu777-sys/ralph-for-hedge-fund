import { describe, expect, it } from 'vitest'
import { parseShow, shortSubject } from '../src/rooms/git/show.ts'

const TEXT = [
  'app: review fixes - the loop reverts only its own commits',
  '',
  '- loop revert: the proposal file must carry `Agent: loop` +',
  '  `Loop-Change: <id>`, every path it touched must pass',
  '- scheduler: a job exit map (a due retro is a nag, not a',
  '  fail)',
  '',
  'A closing paragraph that was',
  'hard wrapped.',
  '',
  'Agent: app',
  'Co-Authored-By: Claude <noreply@anthropic.com>',
  '',
  '',
  ' server/board/store.ts          | 20 +++++++++++++++-----',
  ' db/assets/logo.png             | Bin 0 -> 1024 bytes',
  ' 2 files changed, 15 insertions(+), 5 deletions(-)',
].join('\n')

describe('git show, as the drawer draws it', () => {
  const s = parseShow(TEXT)
  it('soft-wraps list items and paragraphs, drops the trailers', () => {
    expect(s.subject).toBe('app: review fixes - the loop reverts only its own commits')
    expect(s.blocks).toEqual([
      { kind: 'li', text: 'loop revert: the proposal file must carry `Agent: loop` + `Loop-Change: <id>`, every path it touched must pass' },
      { kind: 'li', text: 'scheduler: a job exit map (a due retro is a nag, not a fail)' },
      { kind: 'p', text: 'A closing paragraph that was hard wrapped.' },
    ])
  })
  it('reads the diffstat as numbers', () => {
    expect(s.stat[0]).toEqual({ path: 'server/board/store.ts', n: 20, plus: 15, minus: 5, bin: false })
    expect(s.stat[1].bin).toBe(true)
    expect(s.totals).toEqual({ files: 2, plus: 15, minus: 5 })
  })
  it('shortens a subject to its first clause', () => {
    expect(shortSubject('app: review fixes - the loop')).toBe('app: review fixes')
  })
})

describe('splitSubject', () => {
  it('splits on the first ": "', async () => {
    const { splitSubject } = await import('../src/rooms/git/show.ts')
    expect(splitSubject('dash ui round 2: the chip: rides')).toEqual({ prefix: 'dash ui round 2: ', rest: 'the chip: rides' })
    expect(splitSubject('no prefix here')).toEqual({ prefix: '', rest: 'no prefix here' })
    expect(splitSubject(': leading')).toEqual({ prefix: '', rest: ': leading' })
    expect(splitSubject('trailing: ')).toEqual({ prefix: '', rest: 'trailing: ' })
    expect(splitSubject('http://x')).toEqual({ prefix: '', rest: 'http://x' })
  })
})
