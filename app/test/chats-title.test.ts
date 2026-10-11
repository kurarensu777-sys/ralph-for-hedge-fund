import { describe, expect, it } from 'vitest'
import { chatTitle, convLabel } from '../src/rooms/chats/title.ts'

describe('chat display titles', () => {
  it('two to four words from the raw first message', () => {
    expect(chatTitle('your job is tto send cheaptest agent to fully understand the cu...')).toBe('Cheaptest agent')
    expect(chatTitle('Permission probe. Do exactly these two things, once each, and n...')).toBe('Permission probe')
    expect(chatTitle('ssend sonnet agents to read the whole repo')).toBe('Sonnet agents')
    expect(chatTitle('Preds failing')).toBe('Preds failing')
    expect(chatTitle('can you fix the board drawer layout please')).toBe('Board drawer layout')
  })
  it('a noun phrase, never the first words', () => {
    expect(chatTitle('Help me fix these Claude Code settings issues. For each issue:...')).toBe('Claude Code settings')
    expect(chatTitle('Run exactly these two shell commands with the Bash tool, one at...')).toBe('Bash tool')
    expect(chatTitle('cto did this, you need to enable it. fgo Auto-approve, to the l...')).toBe('CTO Auto-approve')
    expect(chatTitle('the preds port 8792 keeps failing after restart')).toBe('Preds port 8792')
  })
  it('a bare label or a lone verb is never the whole title', () => {
    expect(chatTitle('verify: ready ping')).toBe('Verify ready ping')
    expect(chatTitle('handoff: Run exactly these two shell commands with the Bash tool, one at')).toBe('Handoff Bash tool')
    expect(chatTitle('Reply with the single word: ready')).toBe('Single word ready')
    expect(chatTitle('B-0008 Reply with the single word: ready')).toBe('Reply single word')
  })
  it('no noun: agent and time; no message yet: empty', () => {
    const at = new Date(2026, 8, 24, 14, 2).getTime()
    expect(convLabel({ title: 'do it now please and then tell me when it is done ok', agent: 'fund', startedAt: at })).toBe('fund 14:02')
    expect(convLabel({ title: '', agent: 'fund', startedAt: at })).toBe('')
  })
  it('an empty title stays empty', () => {
    expect(chatTitle('')).toBe('')
    expect(chatTitle(null)).toBe('')
  })
})
