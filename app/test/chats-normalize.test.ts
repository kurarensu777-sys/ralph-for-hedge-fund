import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { actionFor, bookRel, newNormState, normalize } from '../server/chat/normalize.ts'
import { FUND_ROOT } from '../server/paths.ts'

// normalize(): representative SDK messages in, the small closed feed model out.

const entries = (out: ReturnType<typeof normalize>) => out.flatMap(o => (o.t === 'entry' ? [o.e] : []))

describe('normalize', () => {
  it('init sets the model and the transcript head; status is a phase, never busy', () => {
    const st = newNormState()
    expect(normalize({ type: 'system', subtype: 'init', model: 'claude-opus', session_id: 'S1' } as any, st)).toEqual([
      { t: 'meta', m: { model: 'claude-opus' } }, { t: 'head', uuid: 'S1' },
    ])
    expect(normalize({ type: 'system', subtype: 'status', status: null } as any, st)).toEqual([{ t: 'meta', m: { phase: 'working' } }])
    expect(normalize({ type: 'system', subtype: 'status', status: 'requesting' } as any, st)).toEqual([{ t: 'meta', m: { phase: 'requesting' } }])
  })

  it('streamed deltas and the final message name the SAME block, thinking and text apart', () => {
    const st = newNormState()
    normalize({ type: 'stream_event', event: { type: 'message_start', message: { id: 'M' } } } as any, st)
    normalize({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } } as any, st)
    normalize({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } } as any, st)
    const d1 = entries(normalize({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } } } as any, st))
    const d2 = entries(normalize({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } } } as any, st))
    expect(d1[0]).toMatchObject({ kind: 'assistant', content: 'Hel', streaming: true })
    expect(d2[0]).toMatchObject({ id: d1[0].id, content: 'Hello' })
    const fin = entries(normalize({ type: 'assistant', uuid: 'U1', message: { id: 'M', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hello' }] } } as any, st))
    expect(fin.map(e => e.kind)).toEqual(['thinking', 'assistant'])
    expect(fin[1].id).toBe(d1[0].id)
    expect(fin[1].streaming).toBeUndefined()
    expect(st.lastUuid).toBe('U1')
  })

  it('a tool call and its result are one entry id, with a semantic action and a status', () => {
    const st = newNormState()
    const call = entries(normalize({ type: 'assistant', uuid: 'U2', message: { id: 'M2', content: [{ type: 'tool_use', id: 'T1', name: 'Bash', input: { command: 'git status && ls -la', description: 'Show status' } }] } } as any, st))
    expect(call[0]).toMatchObject({ id: 't:T1', kind: 'tool', status: 'created', action: { type: 'command', verb: 'Bash', target: 'Show status' } })
    const res = entries(normalize({ type: 'user', uuid: 'U3', message: { content: [{ type: 'tool_result', tool_use_id: 'T1', content: 'nothing to commit', is_error: false }] } } as any, st))
    expect(res[0]).toMatchObject({ id: 't:T1', status: 'success', content: 'nothing to commit', action: { verb: 'Bash' } })
    const bad = entries(normalize({ type: 'user', uuid: 'U4', message: { content: [{ type: 'tool_result', tool_use_id: 'T9', content: 'boom', is_error: true }] } } as any, st))
    expect(bad[0]).toMatchObject({ status: 'failed', action: { type: 'other', verb: 'Tool' } })
    expect(normalize({ type: 'user', isReplay: true, message: { content: [] } } as any, st)).toEqual([])
  })

  it('a result closes the turn: busy false, per-turn and cumulative usage, errors and denials surfaced', () => {
    const st = newNormState()
    const out = normalize({
      type: 'result', subtype: 'error_during_execution', is_error: true, uuid: 'R', errors: ['it broke'], total_cost_usd: 0.5,
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 },
      modelUsage: { 'claude-haiku-x': { inputTokens: 1, outputTokens: 1 }, 'claude-opus-x': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 } },
      permission_denials: [{ tool_use_id: 'D1', tool_name: 'Read', tool_input: { file_path: 'C:\\x\\.env' } }],
    } as any, st)
    expect(out[0]).toEqual({ t: 'meta', m: { busy: false, phase: undefined, model: 'claude-opus-x' } })
    expect(out[1]).toEqual({ t: 'usage', u: {
      model: 'claude-opus-x',
      total: { tokensIn: 11, tokensOut: 21, cacheRead: 30, cacheWrite: 40, costUsd: 0.5 },
      turn: { tokensIn: 3, tokensOut: 4, cacheRead: 5, cacheWrite: 6, costUsd: 0 },
    } })
    const e = entries(out)
    expect(e[0]).toMatchObject({ kind: 'error', content: 'it broke' })
    expect(e[1]).toMatchObject({ id: 't:D1', status: 'denied', action: { type: 'read', target: '.env' } })
  })

  it('unknown message types are dropped in silence', () => {
    expect(normalize({ type: 'something_new', x: 1 } as any, newNormState())).toEqual([])
  })

  it('actionFor maps tool names to semantic actions; bookRel only for markdown inside the fund', () => {
    expect(actionFor('Grep', { pattern: 'foo\n bar' })).toMatchObject({ type: 'search', verb: 'Search', target: 'foo bar' })
    expect(actionFor('WebFetch', { url: 'https://example.com/a/b' })).toMatchObject({ type: 'webfetch', target: 'example.com' })
    expect(actionFor('Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' })).toMatchObject({ type: 'edit', diff: { old: 'x', new: 'y' } })
    const book = join(FUND_ROOT, 'memory', 'a', 'b.md')
    expect(bookRel(book)).toBe('memory/a/b.md')
    expect(actionFor('Read', { file_path: book })).toMatchObject({ type: 'read', rel: 'memory/a/b.md' })
    expect(bookRel(join(FUND_ROOT, 'x.ts'))).toBeUndefined()
    expect(bookRel('C:\\elsewhere\\x.md')).toBeUndefined()
  })
})
