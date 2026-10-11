import { query as sql } from '@fund/db'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Agent, Shelf } from '../shared/types.ts'

// A temp fund that is its own git repo, and this file's own database: nothing here touches the live fund.
const ROOT = mkdtempSync(join(tmpdir(), 'libdrafts-'))
process.env.FUND_ROOT = ROOT
process.env.FUND_DATA_DIR = join(ROOT, '.data')

const w = (rel: string, text: string) => { mkdirSync(join(ROOT, rel, '..'), { recursive: true }); writeFileSync(join(ROOT, rel), text) }
const g = (...a: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test Hand', '-c', 'user.email=t@t', ...a], { cwd: ROOT, encoding: 'utf8' })

const SHELVES: Shelf[] = [
  { id: 'fund', title: 'Fund', dept: 'HQ', roots: ['library/fund'] },
  { id: 'research', title: 'Research', dept: 'Research', roots: ['library/research'], topics: [{ id: 'numbers', holds: 'how a number is kept' }, { id: 'desks', holds: 'the lab desks' }] },
  { id: 'platform', title: 'Platform', dept: 'Build', roots: ['library/platform'] },
  { id: 'app', title: 'App', dept: 'Build', roots: ['app/library'] },
] as Shelf[]
const agent = (id: string, dept: string, writes: string[]): Agent => ({ id, name: id, kind: 'standing', mode: 'active', dept, role: `${id} role`, cwd: '.', writes, model: 'haiku', effort: 'low', boot: [] } as unknown as Agent)
const AGENTS = [
  agent('fund', 'HQ', ['library/', 'agents.json']),
  agent('research', 'Research', ['library/research/', 'lab/']),
  agent('app', 'Build', ['app/']),
  agent('crypto-hand', 'Build', ['crypto/']),
]

let db: typeof import('../server/db.ts')
let D: typeof import('../server/library/drafts.ts')

beforeAll(async () => {
  w('agents.json', JSON.stringify({ agents: AGENTS }))
  w('library/fund/craft/_series.md', '# Craft\n\n| Book | Read when |\n|---|---|\n| `alpha.md` | about to write a gate |\n')
  w('library/fund/craft/alpha.md', '# Alpha\n\ntext\n')
  w('library/research/the-desks-lessons/_series.md', '# Desks\n\n| Book | Read when |\n|---|---|\n')
  w('library/platform/x.md', '# X\n')
  g('init', '-q'); g('add', '--', 'library', 'agents.json'); g('commit', '-q', '-m', 'seed')
  mkdirSync(join(ROOT, 'app/library'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: join(ROOT, 'app') })
  db = await import('../server/db.ts')
  D = await import('../server/library/drafts.ts')
})

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('prefilter', () => {
  it('keeps correction-shaped owner turns and drops the rest', () => {
    const out = D.prefilter([
      'run the backtest please',
      'no, always tag every number with the date it was read',
      'From now on put the window next to every result',
      'what is the funding on BTC?',
      'never round a fee in our favour',
    ])
    expect(out).toEqual([
      'no, always tag every number with the date it was read',
      'From now on put the window next to every result',
      'never round a fee in our favour',
    ])
  })
  it('skips anything that matches a secret, even when correction-shaped', () => {
    expect(D.prefilter(['always use this api_key: abcd1234efgh'])).toEqual([])
    expect(D.prefilter([`never paste ${'sk-' + 'ant-api03-'}${'A'.repeat(22)} here again`])).toEqual([])
    expect(D.prefilter(['from now on the password = hunter2'])).toEqual([])
    expect(D.prefilter([`always sign with ${'a1'.repeat(24)}`])).toEqual([])
  })
  it('keeps the most recent turns only', () => {
    const many = Array.from({ length: 30 }, (_, i) => `always do thing number ${i}`)
    const out = D.prefilter(many)
    expect(out.length).toBe(D.MAX_TURNS)
    expect(out[out.length - 1]).toBe('always do thing number 29')
  })
})

describe('shelf placement', () => {
  const [fund, research, app, cryptoHand] = AGENTS
  it('agent level: the agent\'s own shelf first', () => {
    expect(D.place('agent', research, SHELVES, ROOT)?.shelf.id).toBe('research')
    expect(D.place('agent', research, SHELVES, ROOT)?.level).toBe('agent')
    expect(D.place('agent', fund, SHELVES, ROOT)?.shelf.id).toBe('fund')
  })
  it('a shelf inside a sub-repo is the agent\'s own when its writes cover it (committed in that repo)', () => {
    const p = D.place('agent', app, SHELVES, ROOT)
    expect(p?.shelf.id).toBe('app')   // since 2026-09-25 the library of how we work lives in app/library
    expect(p?.level).toBe('agent')
  })
  it('falls back to the role when the agent writes no shelf of its own; a guarded shelf is never a target', () => {
    const guarded = [{ id: 'execution', title: 'Execution', dept: 'Build', roots: ['app/library/craft/execution'] }, ...SHELVES] as Shelf[]
    const exe = agent('execution', 'Build', ['execution/', 'app/library/craft/execution/'])
    const p = D.place('agent', exe, guarded, ROOT)
    expect(p?.shelf.id).toBe('platform')
    expect(p?.level).toBe('role')
    expect(D.validPath('app/library/craft/execution/x.md', guarded)).toBeNull()
    expect(D.validPath('app/library/x.md', SHELVES)).toBe('app/library/x.md')
  })
  it('role and fund levels', () => {
    expect(D.place('role', research, SHELVES, ROOT)?.shelf.id).toBe('research')
    expect(D.place('fund', research, SHELVES, ROOT)?.shelf.id).toBe('fund')
    expect(D.place('fund', research, SHELVES, ROOT)?.level).toBe('fund')
  })
  it('an agent whose writes are railed still lands on its role shelf, never under crypto/', () => {
    const p = D.place('agent', cryptoHand, SHELVES, ROOT)!
    expect(p.root.startsWith('library/')).toBe(true)
    expect(D.RAILED.test(p.root)).toBe(false)
  })
  it('uses an existing series when named, else the default', () => {
    expect(D.place('agent', research, SHELVES, ROOT, 'the-desks-lessons')?.series).toBe('the-desks-lessons')
    expect(D.place('agent', research, SHELVES, ROOT, 'made-up-series')?.series).toBe(D.DEFAULT_SERIES)
  })
  it('a railed or non-library shelf root is never a target', () => {
    const bad = [{ id: 'x', title: 'X', dept: 'HQ', roots: ['crypto/api/execution/docs'] }] as Shelf[]
    expect(D.place('fund', fund, bad, ROOT)).toBeNull()
    expect(D.validPath('library/fund/crypto/x.md', SHELVES)).toBeNull()
    expect(D.validPath('library/fund/../spine/x.md', SHELVES)).toBeNull()
    expect(D.validPath('library/fund/craft/_series.md', SHELVES)).toBeNull()
    expect(D.validPath('library/fund/craft/new.md', SHELVES)).toBe('library/fund/craft/new.md')
  })
})

describe('parse', () => {
  const turns = ['no, always tag every number with the date it was read']
  const lesson = { quote: 'always tag every number with the date it was read', title: 'Tag every number with its read date', level: 'role', series: null, readWhen: 'about to put a number on a board', body: 'Every number carries the day it was read. A number without one cannot be checked.' }
  it('keeps a lesson whose quote is the owner\'s own words', () => {
    expect(D.parseProposals(JSON.stringify({ lessons: [lesson] }), turns)).toHaveLength(1)
  })
  it('drops an invented quote and malformed JSON', () => {
    expect(D.parseProposals(JSON.stringify({ lessons: [{ ...lesson, quote: 'the owner never said this at all' }] }), turns)).toEqual([])
    expect(D.parseProposals('not json', turns)).toEqual([])
  })
  it('house style: no em-dash survives', () => {
    const p = D.parseProposals(JSON.stringify({ lessons: [{ ...lesson, body: `${lesson.body} \u2014 always.` }] }), turns)
    expect(p[0].body).not.toMatch(/[\u2014\u2013]/)
  })
  it('topics: only those on the TARGET shelf\'s list, at most 3, in the model\'s order; none without a list', () => {
    const asked = { ...lesson, topics: ['Numbers', 'bogus', 'desks', 'numbers', 'a', 'b'] }
    const seen: [string, string | null][] = []
    const lists = (level: string, series: string | null) => { seen.push([level, series]); return level === 'role' ? ['desks', 'numbers', 'a', 'b'] : [] }
    expect(D.parseProposals(JSON.stringify({ lessons: [asked] }), turns, lists)[0].topics).toEqual(['numbers', 'desks', 'a'])
    expect(seen).toEqual([['role', null]])
    expect(D.parseProposals(JSON.stringify({ lessons: [{ ...asked, level: 'fund' }] }), turns, lists)[0].topics).toEqual([])
    expect(D.parseProposals(JSON.stringify({ lessons: [asked] }), turns)[0].topics).toEqual([])
    expect(D.parseProposals(JSON.stringify({ lessons: [{ ...lesson, topics: 'numbers' }] }), turns, lists)[0].topics).toEqual([])
  })
})

describe('topics on a draft', () => {
  const research = AGENTS[1]
  const p = { quote: 'q', title: 'Tag every number', level: 'agent' as const, series: null, readWhen: 'about to put a number anywhere', body: 'The body of the rule, long enough.', topics: ['numbers', 'engines'] }
  it('draftFiles writes the topics on the shelf\'s list into the book\'s frontmatter; a shelf with none gets a bare book', () => {
    const at = D.place('agent', research, SHELVES, ROOT)!
    const f = D.draftFiles(p, at, 'c-x', Date.UTC(2026, 8, 26), () => false)
    expect(f.book.startsWith('---\ntopics: [numbers]\n---\n\n# Tag every number\n')).toBe(true)
    const fund = D.place('fund', research, SHELVES, ROOT)!
    expect(D.draftFiles(p, fund, 'c-x', 0, () => false).book.startsWith('# Tag every number\n')).toBe(true)
  })
  it('the prompt names each candidate shelf\'s list and asks for topics', () => {
    const c = D.candidateShelves(research, SHELVES, ROOT)
    expect(c.map(x => `${x.level}:${x.shelf.id}`)).toEqual(['agent:research', 'fund:fund'])
    const prompt = D.promptFor(research, ['always x'], [], c)
    expect(prompt).toMatch(/level "agent" -> shelf research:\n {4}numbers: how a number is kept\n {4}desks: the lab desks/)
    expect(prompt).not.toMatch(/shelf fund:/)   // it names no list
    expect(prompt).toMatch(/"topics": \[\]/)
    expect(D.promptFor(research, ['always x'], [])).not.toMatch(/The shelves a lesson can land on/)
  })
  it('a new series index carries a title and no tags', () => {
    expect(D.seriesHeader('the-owners-corrections')).toMatch(/^---\ntitle: The Owners Corrections\n---\n/)
    expect(D.seriesHeader('the-owners-corrections')).not.toMatch(/tags:/)
  })
})

const conv = async (id: string, agentId: string, lines: string[], lastAt = Date.now() - 3_600_000) => {
  const file = join(ROOT, '.t', `${id}.jsonl`)
  mkdirSync(join(ROOT, '.t'), { recursive: true })
  writeFileSync(file, lines.map((t, i) => JSON.stringify({ type: 'user', uuid: `${id}-${i}`, timestamp: new Date(lastAt - 60_000 + i).toISOString(), message: { role: 'user', content: t } })).join('\n') + '\n')
  await db.ops.upsert('conversations', { id, agent_id: agentId, title: id, state: 'closed', cwd: ROOT, started_at: lastAt - 100_000, last_at: lastAt })
  return file
}

describe('scan, save, dismiss', () => {
  const files = new Map<string, string>()
  let calls = 0
  const llm: import('../server/library/drafts.ts').Llm = async prompt => {
    calls++
    const quote = /never round a fee in our favour/.test(prompt) ? 'never round a fee in our favour' : 'always tag every number with the date it was read'
    return { cost: 0.001, text: JSON.stringify({ lessons: [{ quote, title: quote.includes('fee') ? 'Never round a fee in our favour' : 'Tag every number with its read date', level: 'agent', series: null, readWhen: 'about to put a number on a board or in a result', body: 'The rule, and why: a number sizes a position here, so the ugly true one ships.', topics: ['numbers', 'bogus'] }] }) }
  }
  const deps = () => ({ db: db.db, agents: AGENTS, shelves: SHELVES, fundRoot: ROOT, llm, now: Date.now(), fileOf: (c: string) => files.get(c) ?? null })

  it('drafts from a closed conversation, writes nothing to the tree, and mirrors into loop_lessons', async () => {
    files.set('c-1', await conv('c-1', 'research', ['please run it', 'no, always tag every number with the date it was read']))
    const head = g('rev-parse', 'HEAD').trim()
    const r = await D.scan(deps())
    expect(r.found).toBe(1)
    expect(calls).toBe(1)
    expect(g('rev-parse', 'HEAD').trim()).toBe(head)
    expect(g('status', '--porcelain', '--', 'library').trim()).toBe('')
    const q = await D.listDrafts(db.db)
    expect(q.drafts).toHaveLength(1)
    expect(q.drafts[0].path).toBe('library/research/the-owners-corrections/tag-every-number-with-its-read-date.md')
    expect(q.drafts[0].quote).toBe('always tag every number with the date it was read')
    expect(q.drafts[0].book.startsWith('---\ntopics: [numbers]\n---\n\n# Tag every number')).toBe(true)   // its shelf's list only
    const l = await sql('SELECT agent_id, conversation_id, state FROM ops.loop_lessons')
    expect(l).toEqual([{ agent_id: 'research', conversation_id: 'c-1', state: 'open' }])
  })

  it('a second scan of the same conversation does not duplicate the draft', async () => {
    // not due (last_at did not move): no model call at all
    await D.scan(deps())
    expect(calls).toBe(1)
    // moved (the owner came back): read again, same correction -> still one draft
    files.set('c-1', await conv('c-1', 'research', ['please run it', 'no, always tag every number with the date it was read', 'ok thanks'], Date.now() - 1_800_000))
    await D.scan(deps())
    expect(calls).toBe(2)
    expect((await D.listDrafts(db.db)).drafts).toHaveLength(1)
  })

  it('a wrapped conversation is skipped without a model call', async () => {
    files.set('c-2', await conv('c-2', 'research', ['never round a fee in our favour', "that's a wrap"]))
    const before = calls
    await D.scan(deps())
    expect(calls).toBe(before)
    expect((await sql("SELECT note FROM ops.library_draft_scans WHERE conv = 'c-2'"))[0]).toEqual({ note: 'wrapped' })
  })

  it('dismiss writes nothing', async () => {
    files.set('c-3', await conv('c-3', 'fund', ['never round a fee in our favour']))
    await D.scan(deps())
    const d = (await D.listDrafts(db.db)).drafts.find(x => x.conv === 'c-3')!
    expect(d.path.startsWith('library/fund/')).toBe(true)
    const head = g('rev-parse', 'HEAD').trim()
    await D.dismissDraft(db.db, d.id)
    expect(g('rev-parse', 'HEAD').trim()).toBe(head)
    expect(existsSync(join(ROOT, d.path))).toBe(false)
    expect(g('status', '--porcelain').split('\n').filter(l => l.includes('library/')).length).toBe(0)
    expect((await D.listDrafts(db.db)).drafts.some(x => x.id === d.id)).toBe(false)
    await expect(D.dismissDraft(db.db, d.id)).rejects.toThrow(/dismissed/)
  })

  it('save lands the book and its series row in ONE commit', async () => {
    const d = (await D.listDrafts(db.db)).drafts.find(x => x.conv === 'c-1')!
    await D.editDraft(db.db, d.id, { book: d.book.replace('The rule', 'The edited rule') }, SHELVES)
    const before = Number(g('rev-list', '--count', 'HEAD').trim())
    const r = await D.saveDraft(db.db, d.id, ROOT, SHELVES)
    expect(Number(g('rev-list', '--count', 'HEAD').trim())).toBe(before + 1)
    const names = g('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()
    expect(names).toEqual([d.path, 'library/research/the-owners-corrections/_series.md'].sort())
    expect(g('log', '-1', '--format=%B')).toMatch(/Agent: you/)
    expect(readFileSync(join(ROOT, d.path), 'utf8')).toMatch(/The edited rule/)
    const series = readFileSync(join(ROOT, 'library/research/the-owners-corrections/_series.md'), 'utf8')
    expect(series).toMatch(/\| `tag-every-number-with-its-read-date\.md` \| about to put a number/)
    expect(r.sha).toBeTruthy()
    expect((await sql('SELECT state FROM ops.loop_lessons WHERE conversation_id = $1', ['c-1']))[0]).toEqual({ state: 'promoted' })
    await expect(D.saveDraft(db.db, d.id, ROOT, SHELVES)).rejects.toThrow(/saved/)
  })

  it('save into an existing series appends one row and keeps the file', async () => {
    const id = (await db.ops.addLibraryDraft({ conv: 'c-9', agent: 'fund', shelf: 'fund', level: 'fund', path: 'library/fund/craft/gamma.md', title: 'Gamma',
      book: '# Gamma\n\nthe body of gamma is here.\n', series_row: '| `gamma.md` | about to do gamma |', quote: 'q', key: 'k-9', state: 'open', ts: 1 }))!
    await D.saveDraft(db.db, id, ROOT, SHELVES)
    const s = readFileSync(join(ROOT, 'library/fund/craft/_series.md'), 'utf8')
    expect(s).toMatch(/alpha\.md/)
    expect(s.trim().split('\n').pop()).toBe('| `gamma.md` | about to do gamma |')
  })

  it('a draft for a shelf in a sub-repo lands there: book + series row, ONE commit in THAT repo', async () => {
    const gApp = (...a: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test Hand', '-c', 'user.email=t@t', ...a], { cwd: join(ROOT, 'app'), encoding: 'utf8' })
    const id = (await db.ops.addLibraryDraft({ conv: 'c-7', agent: 'app', shelf: 'app', level: 'agent', path: 'app/library/the-owners-corrections/delta.md', title: 'Delta',
      book: '# Delta\n\nthe body of delta is here.\n', series_row: '| `delta.md` | about to do delta |', quote: 'q', key: 'k-7', state: 'open', ts: 1 }))!
    const fundHead = g('rev-parse', 'HEAD').trim()
    await D.saveDraft(db.db, id, ROOT, SHELVES)
    expect(g('rev-parse', 'HEAD').trim()).toBe(fundHead)   // the fund root's repo is not the one written
    const names = gApp('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()
    expect(names).toEqual(['library/the-owners-corrections/_series.md', 'library/the-owners-corrections/delta.md'])
    expect(gApp('log', '-1', '--format=%B')).toMatch(/Agent: you/)
  })

  it('a book that already exists is refused and nothing is written', async () => {
    const id = (await db.ops.addLibraryDraft({ conv: 'c-8', agent: 'fund', shelf: 'fund', level: 'fund', path: 'library/fund/craft/alpha.md', title: 'Alpha',
      book: '# Alpha again\n\nsomething new entirely.\n', series_row: '| `alpha.md` | x x x x x |', quote: 'q', key: 'k-8', state: 'open', ts: 1 }))!
    const head = g('rev-parse', 'HEAD').trim()
    await expect(D.saveDraft(db.db, id, ROOT, SHELVES)).rejects.toThrow(/already exists/)
    expect(g('rev-parse', 'HEAD').trim()).toBe(head)
    expect(readFileSync(join(ROOT, 'library/fund/craft/alpha.md'), 'utf8')).toBe('# Alpha\n\ntext\n')
  })
})
