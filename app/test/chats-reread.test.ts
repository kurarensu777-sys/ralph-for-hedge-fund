import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// RE-READ AFTER COMPACTION (server/chat/reread.ts + the SessionStart 'compact' hook in launch.ts +
// the runner's divider). A throwaway fund root holds the books, a throwaway database the reads.

const TMP = mkdtempSync(join(tmpdir(), 'chats-reread-'))
const ROOT = join(TMP, 'fund')
process.env.FUND_DATA_DIR = join(TMP, 'data')
process.env.FUND_ROOT = ROOT
mkdirSync(join(ROOT, 'library', 's'), { recursive: true })
const book = (p: string, text: string) => writeFileSync(join(ROOT, p), text)
book('library/s/alpha.md', '# Alpha book\n\nalpha body line\n')
book('library/s/beta.md', '# Beta book\n\n' + 'b'.repeat(400) + '\n')
book('library/s/boot.md', '# Boot book\n\nloaded at boot\n')
book('library/s/other.md', '# Other conv\n\nnot mine\n')

vi.mock('../server/config.ts', () => {
  const a = { id: 'tester', name: 'tester', kind: 'standing', mode: 'active', dept: 'T', role: 'tests', cwd: '.', writes: [], model: 'haiku', effort: 'low', boot: [] }
  return { agent: (id: string) => (id === 'tester' ? a : undefined), agents: () => [a], config: { agents: () => [a], repos: () => [] } }
})

let db: typeof import('../server/db.ts')
let RR: typeof import('../server/chat/reread.ts')
beforeAll(async () => {
  db = await import('../server/db.ts')
  RR = await import('../server/chat/reread.ts')
  const ins = (ts: number, conv: string, book: string, atBoot: boolean) => db.ops.recordRead('tester', book, { conversationId: conv, atBoot, ts })
  await ins(1, 'c1', 'library/s/alpha.md', false)
  await ins(3, 'c1', 'library/s/beta.md', false)
  await ins(2, 'c1', 'library/s/alpha.md', false)        // a second pull of alpha, older than beta
  await ins(4, 'c1', 'library/s/boot.md', true)          // boot: survives in systemPrompt.append
  await ins(5, 'c2', 'library/s/other.md', false)        // another conversation
  await ins(6, 'c3', 'library/s/gone.md', false)
  await ins(7, 'c3', 'library/s/alpha.md', false)
})

describe('the re-read budget is not the boot cap', () => {
  it('keeps 12k for a standing seat and 8k for a dashboard seat: moving the boot cap (context-caps.json) never changes what compaction restores', () => {
    expect(RR.REREAD_STANDING).toBe(12_000)
    expect(RR.REREAD_DASHBOARD).toBe(8_000)
    expect(RR.rereadBudgetFor({ kind: 'standing' })).toBe(12_000)
    expect(RR.rereadBudgetFor({ kind: 'dashboard' })).toBe(8_000)
  })
  it('a conversation with no known seat is restored under the standing 12k', async () => {
    const r = await RR.rereadContext('c1')   // the mocked roster has one standing agent, `tester`
    expect(r.budget).toBe(12_000)
  })
})

describe('rereadContext', () => {
  it('puts back only this conversation\'s PULLED books, newest pull first, boot rows excluded', async () => {
    const r = await RR.rereadContext('c1', undefined, 10_000)
    expect(r.books.map(b => b.path)).toEqual(['library/s/beta.md', 'library/s/alpha.md'])
    expect(r.books.every(b => b.state === 'restored')).toBe(true)
    expect(r.text).toContain('alpha body line')
    expect(r.text).toContain('b'.repeat(400))
    expect(r.text).not.toContain('loaded at boot')
    expect(r.text).not.toContain('not mine')
    expect(r.restored).toBe(2)
  })

  it('respects the token cap and LISTS the overflow as pulled earlier, re-read if needed', async () => {
    const r = await RR.rereadContext('c1', undefined, 110)            // beta (~106 tok) fits, alpha does not
    expect(r.books.map(b => [b.path, b.state])).toEqual([['library/s/beta.md', 'restored'], ['library/s/alpha.md', 'listed']])
    expect(r.text).toContain('Pulled earlier, re-read if needed')
    expect(r.text).toContain('- library/s/alpha.md')
    expect(r.text).not.toContain('alpha body line')
  })

  it('names a missing book instead of dropping it', async () => {
    const r = await RR.rereadContext('c3', undefined, 10_000)
    expect(r.books.find(b => b.path === 'library/s/gone.md')?.state).toBe('missing')
    expect(r.text).toContain('missing on disk now')
    expect(r.text).toContain('library/s/gone.md')
    expect(r.restored).toBe(1)
  })

  it('a conversation that pulled nothing gets no context at all', async () => {
    expect((await RR.rereadContext('nobody', undefined, 10_000)).text).toBe('')
  })
})

describe('the compaction divider', () => {
  it('stays ONE divider; the runner rewrites it to "compacted · N books restored" with the titles in meta.books', async () => {
    const { normalize, newNormState } = await import('../server/chat/normalize.ts')
    const fixture = { type: 'system', subtype: 'compact_boundary', uuid: 'cb-1', session_id: 's', compact_metadata: { trigger: 'manual', pre_tokens: 152_000 } }
    const out = normalize(fixture as any, newNormState(), 1000)
    const entries = out.filter(x => x.t === 'entry')
    expect(entries).toHaveLength(1)
    const e = (entries[0] as any).e
    expect(e.meta).toMatchObject({ compact: true, pre: 152_000 })
    const { compactDivider } = await import('../server/chat/runner.ts')
    const d = await compactDivider({ id: 'c1', agent: { id: 'tester' } }, e)
    expect(d.content).toBe('compacted · 2 books restored')
    expect(d.meta?.books).toEqual(['Beta book', 'Alpha book'])
    const { compactTip } = await import('../src/rooms/chats/compact.ts')
    const tip = compactTip(d)!
    expect(tip).toContain('was 152k tokens')
    expect(tip).toContain('Beta book')
    expect(tip).toContain('Alpha book')
    // the boundary is marked in the law manifest
    const n = { n: await db.ops.count('law_loads', { conversation_id: 'c1', load_reason: 'compact_boundary' }) }
    expect(n.n).toBe(1)
  })

  it('a non-compaction system entry carries no tooltip', async () => {
    const { compactTip } = await import('../src/rooms/chats/compact.ts')
    expect(compactTip({ id: 's', ts: 1, kind: 'system', content: 'Interrupted' })).toBeUndefined()
  })
})

describe('the hook in buildLaunch', () => {
  it('registers SessionStart with matcher compact, and it returns the books as additionalContext (no user message)', async () => {
    const { buildLaunch } = await import('../server/chat/launch.ts')
    const agent = { id: 'tester', name: 'tester', kind: 'standing', mode: 'active', dept: 'T', role: 'tests', cwd: '.', writes: [], model: 'haiku', effort: 'low', boot: [] } as any
    const l = buildLaunch({ agent, conversationId: 'c1', uuid: '00000000-0000-4000-8000-000000000000', resume: false, env: { PATH: '' } })
    const ss = (l.options.hooks as any).SessionStart
    expect(ss).toHaveLength(1)
    expect(ss[0].matcher).toBe('compact')
    const out = await ss[0].hooks[0]({ hook_event_name: 'SessionStart', source: 'compact', session_id: 's', transcript_path: '', cwd: ROOT }, undefined, { signal: new AbortController().signal })
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput.additionalContext).toContain('alpha body line')
    expect(out.hookSpecificOutput.initialUserMessage).toBeUndefined()
  })
})
