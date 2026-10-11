import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../server/chat/types.ts'

// HANDOFF (server/chat/handoff.ts): deterministic, no LLM, numbers WORD FOR WORD.

const TMP = mkdtempSync(join(tmpdir(), 'chats-handoff-'))
process.env.FUND_DATA_DIR = join(TMP, 'data')

const AGENT = { id: 'tester', name: 'tester', kind: 'standing', mode: 'active', dept: 'T', role: 'tests', cwd: '.', writes: [], model: 'haiku', effort: 'low', boot: [] }
vi.mock('../server/config.ts', () => ({ agent: (id: string) => (id === 'tester' ? AGENT : undefined), agents: () => [AGENT], config: { agents: () => [AGENT], repos: () => [] } }))
const CHANGES = {
  commits: [
    { repo: 'fund', sha: 'a'.repeat(40), ts: 2, author: 'tester', subject: 's', files: ['lab/desk/results-log.md', 'lab/desk/beliefs.md'], merge: false, reverted: false },
    { repo: 'fund', sha: 'b'.repeat(40), ts: 1, author: 'tester', subject: 'undone', files: ['lab/desk/old.md'], merge: false, reverted: true },
  ],
  working: { repo: 'app', cwd: '.', files: [{ path: 'server/chat/handoff.ts', xy: ' M', add: 3, del: 1 }, { path: 'lab/desk/beliefs.md', xy: '??', add: 1, del: 0 }] },
  errors: [],
}
vi.mock('../server/chat/changes.ts', () => ({ changes: async () => CHANGES }))

const e = (kind: Entry['kind'], content: string, over: Partial<Entry> = {}): Entry => ({ id: `${kind}:${Math.random()}`, ts: 1, kind, content, ...over })
const FIXTURE: Entry[] = [
  e('user', 'Grade the pm-001 run and hand it on. See lab#12 for context.'),
  e('assistant', [
    'I read the ledger.',
    'Median |mid gap| 2.12 pts over 191 pairs [API], read 2026-09-24.',
    'Exchange A BTC 7d +7.78% vs B +10.87% ann [V]',
    'The T-bill hurdle was 4.11% on 2026-09-21.',
    'This is prose with 3 apples and no tag.',
    'Released on 2026-09-22.',
    '```',
    'print("99% [V]")',
    '```',
  ].join('\n')),
  e('assistant', 'nested work 5.5% [V]', { nested: true }),
  e('tool', '', { action: { type: 'read', verb: 'Read', target: 'x.md' } }),
  e('user', 'And the next step?'),
  e('assistant', 'Two things are open.\nShould we re-run at +7d?\nIs the window 2026-09-01..2026-09-24 right?\nDone.'),
]

let H: typeof import('../server/chat/handoff.ts')
beforeAll(async () => {
  H = await import('../server/chat/handoff.ts')
})

describe('buildHandoff', () => {
  const h = () => H.buildHandoff({ id: 'c-x', title: 'pm-001 grade', entries: FIXTURE, changes: CHANGES as any })

  it('goal = title + the first owner message, at most 300 chars', () => {
    expect(h().goal).toBe('pm-001 grade\n\nGrade the pm-001 run and hand it on. See lab#12 for context.')
    const long = H.buildHandoff({ id: 'c', title: 't', entries: [e('user', 'x'.repeat(600))], changes: null })
    expect(long.goal.length).toBe(300)
  })

  it('extracts tagged and dated numbers WORD FOR WORD, and nothing else', () => {
    expect(h().numbers).toEqual([
      'Median |mid gap| 2.12 pts over 191 pairs [API], read 2026-09-24.',
      'Exchange A BTC 7d +7.78% vs B +10.87% ann [V]',
      'The T-bill hurdle was 4.11% on 2026-09-21.',
    ])
    const n = h().numbers.join('\n')
    expect(n).not.toContain('3 apples')            // untagged prose
    expect(n).not.toContain('Released on')         // a date with no number beside it
    expect(n).not.toContain('Is the window')       // two dates, still no figure
    expect(n).not.toContain('99%')                 // inside a code fence
    expect(n).not.toContain('nested work')         // a subagent's line
    expect(h().text).toContain('- Exchange A BTC 7d +7.78% vs B +10.87% ann [V]')
  })

  it('caps the numbers at 20, keeping the latest', () => {
    const many = Array.from({ length: 25 }, (_, i) => e('assistant', `row ${i}: ${i}.5% [V]`))
    const out = H.buildHandoff({ id: 'c', title: 't', entries: many, changes: null }).numbers
    expect(out).toHaveLength(20)
    expect(out[0]).toBe('row 5: 5.5% [V]')
  })

  it('questions come from the LAST assistant turn only', () => {
    expect(h().questions).toEqual(['Should we re-run at +7d?', 'Is the window 2026-09-01..2026-09-24 right?'])
  })

  it('files = committed (reverted ones dropped) plus dirty, deduped', () => {
    expect(h().files).toEqual([
      { repo: 'fund', path: 'lab/desk/results-log.md', state: 'committed' },
      { repo: 'fund', path: 'lab/desk/beliefs.md', state: 'committed' },
      { repo: 'app', path: 'server/chat/handoff.ts', state: 'dirty' },
      { repo: 'app', path: 'lab/desk/beliefs.md', state: 'dirty' },
    ])
  })

  it('finds the first issue reference (#n or desk#n) and skips colours and entities', () => {
    expect(h().issue).toBe('lab#12')
    expect(H.issueRef('see #7 then lab/venues#3')).toBe('#7')
    expect(H.issueRef('color #fff and &#8635; and a#b')).toBe(null)
    expect(H.issueRef('closes machine#002.')).toBe('machine#002')
  })

  it('renders markdown sections', () => {
    const t = h().text
    for (const s of ['# Handoff', '## Goal', '## Issue', '## Files', '## Numbers', '## Open questions']) expect(t).toContain(s)
    expect(t).toContain('From conversation c-x.')
  })
})

describe('draftHandoff + the route', () => {
  let routes: Record<string, (ctx: any) => any> = {}
  beforeAll(async () => {
    routes = {}
    const rec = (m: string) => (p: string, h: any) => { routes[`${m} ${p}`] = h }
    const room = await import('../server/rooms/chats.ts')
    room.register({ get: rec('GET'), post: rec('POST'), patch: rec('PATCH'), delete: rec('DELETE'), ws: () => {} } as any)
  })

  it('files come from changes.changes() for a stored conversation', async () => {
    const store = await import('../server/chat/store.ts')
    const c = await store.create(AGENT as any, 'route test')
    const out = await routes['GET /api/chats/:id/handoff']({ params: { id: c.id } })
    expect(out.files.map((f: any) => `${f.repo}:${f.path}:${f.state}`)).toEqual([
      'fund:lab/desk/results-log.md:committed', 'fund:lab/desk/beliefs.md:committed', 'app:server/chat/handoff.ts:dirty', 'app:lab/desk/beliefs.md:dirty',
    ])
    expect(out.goal).toBe('route test')
  })

  it('404 for an unknown conversation', async () => {
    await expect(async () => routes['GET /api/chats/:id/handoff']({ params: { id: 'c-nope' } })).rejects.toMatchObject({ status: 404 })
    expect(await H.draftHandoff('c-nope')).toBe(null)
  })
})
