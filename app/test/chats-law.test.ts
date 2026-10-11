import { query as sql } from '@fund/db'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// THE LOADED-LAW MANIFEST (server/chat/law.ts): the InstructionsLoaded hook in buildLaunch drives
// rows into law_loads; boot rows from the brief + boot books; drift for an edited file, a deleted
// file and a file lost to compaction; the route.

const TMP = mkdtempSync(join(tmpdir(), 'chats-law-'))
const ROOT = join(TMP, 'fund')
process.env.FUND_DATA_DIR = join(TMP, 'data')
process.env.FUND_ROOT = ROOT
mkdirSync(join(ROOT, 'lab', 'desk'), { recursive: true })
mkdirSync(join(ROOT, 'library', 's'), { recursive: true })
const put = (p: string, t: string) => writeFileSync(join(ROOT, p), t)
put('CLAUDE.md', '# law\n\nthe root law\n')
put('lab/desk/CLAUDE.md', '# desk law\n')
put('lab/desk/rules.md', '# rules\n')
put('library/s/boot.md', '# boot\n\nbook\n')
const CHAP = '# chap\n\n## One\n\nfirst\n\n## Two\n\nsecond\n'
put('library/s/chap.md', CHAP)

const AGENT = { id: 'tester', name: 'tester', kind: 'standing', mode: 'active', dept: 'T', role: 'tests', cwd: '.', writes: [], model: 'haiku', effort: 'low', boot: ['library/s/boot.md'] }
vi.mock('../server/config.ts', () => ({ agent: (id: string) => (id === 'tester' ? AGENT : undefined), agents: () => [AGENT], config: { agents: () => [AGENT], repos: () => [] } }))

let db: typeof import('../server/db.ts')
let L: typeof import('../server/chat/law.ts')
let fire: (input: Record<string, unknown>) => Promise<unknown>
const hashObject = (p: string) => execFileSync('git', ['hash-object', join(ROOT, p)], { encoding: 'utf8' }).trim()

beforeAll(async () => {
  db = await import('../server/db.ts')
  L = await import('../server/chat/law.ts')
  const { buildLaunch } = await import('../server/chat/launch.ts')
  const l = buildLaunch({ agent: AGENT as any, conversationId: 'c1', uuid: '00000000-0000-4000-8000-000000000000', resume: false, env: { PATH: '' } })
  const m = (l.options.hooks as any).InstructionsLoaded
  expect(m).toHaveLength(1)
  fire = input => m[0].hooks[0]({ hook_event_name: 'InstructionsLoaded', session_id: 's', transcript_path: '', cwd: ROOT, ...input }, undefined, { signal: new AbortController().signal })
})

describe('the InstructionsLoaded hook -> law_loads', () => {
  it('writes one row per load: fund-relative path, reason, trigger, the git blob sha, a chars/4 estimate', async () => {
    await fire({ file_path: join(ROOT, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' })
    await fire({ file_path: join(ROOT, 'lab', 'desk', 'CLAUDE.md'), memory_type: 'Project', load_reason: 'nested_traversal', trigger_file_path: join(ROOT, 'lab', 'desk', 'rules.md') })
    const law = await L.law('c1')
    const root = law.rows.find(r => r.path === 'CLAUDE.md')!
    expect(root).toMatchObject({ reason: 'session_start', memoryType: 'Project', drift: null, tokens: Math.round('# law\n\nthe root law\n'.length / 4) })
    expect(root.sha).toBe(hashObject('CLAUDE.md'))
    const desk = law.rows.find(r => r.path === 'lab/desk/CLAUDE.md')!
    expect(desk).toMatchObject({ reason: 'nested_traversal', trigger: 'lab/desk/rules.md' })
    expect(law.drift).toBe(0)
  })

  it('writes the brief and the boot books as boot rows (a missing brief has no sha)', async () => {
    void L.recordBoot('c1', 'tester', ['app/agents/tester.md', 'library/s/boot.md'])
    const law = await L.law('c1')          // law() waits for the queued rows
    expect(law.rows.find(r => r.path === 'library/s/boot.md')).toMatchObject({ reason: 'boot', sha: hashObject('library/s/boot.md'), drift: null })
    expect(law.rows.find(r => r.path === 'app/agents/tester.md')).toMatchObject({ reason: 'boot', sha: null, drift: 'missing' })
  })

  it('ignores a hook call with no file path', async () => {
    const before = (await L.law('c1')).rows.length
    await fire({ load_reason: 'session_start' })
    expect((await L.law('c1')).rows.length).toBe(before)
  })
})

describe('the start chain (the SDK fires no InstructionsLoaded for session_start)', () => {
  it('reads user memory, every CLAUDE.md from the root down to the cwd, and their @imports', () => {
    const home = join(TMP, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'CLAUDE.md'), 'user memory\n')
    put('CLAUDE.md', '# law\n\n@lab/imported.md\n\n```\n@not/an/import.md\n```\n')
    put('lab/imported.md', 'imported\n')
    const chain = L.startChain(join(ROOT, 'lab', 'desk'), ROOT, home)
    expect(chain.map(c => [L.lawPath(c.path, ROOT), c.memoryType, c.reason, c.trigger && L.lawPath(c.trigger, ROOT)])).toEqual([
      [join(home, 'CLAUDE.md').split('\\').join('/'), 'User', 'session_start', null],
      ['CLAUDE.md', 'Project', 'session_start', null],
      ['lab/imported.md', 'Project', 'include', 'CLAUDE.md'],
      ['lab/desk/CLAUDE.md', 'Project', 'session_start', null],
    ])
    put('CLAUDE.md', '# law\n\nthe root law\n')
  })
})

describe('a boot chapter (<book>#<slug>, B-0345) is hashed as its slice, not the file', () => {
  it('the row keeps the slug, its sha is the chapter slice blob hash, and only an edit INSIDE the chapter drifts', async () => {
    const { blobSha } = L
    void L.recordBoot('c-chap', 'tester', ['library/s/chap.md#one'])
    const row = (await L.law('c-chap')).rows.find(r => r.path === 'library/s/chap.md#one')!
    const one = '## One\n\nfirst\n\n'
    expect(row).toMatchObject({ reason: 'boot', drift: null, tokens: Math.round(one.length / 4) })
    expect(row.sha).toBe(blobSha(Buffer.from(one)))
    expect(row.sha).not.toBe(hashObject('library/s/chap.md'))
    put('library/s/chap.md', CHAP.replace('second', 'second, edited in another chapter'))
    expect((await L.law('c-chap')).rows.find(r => r.path === 'library/s/chap.md#one')?.drift).toBe(null)
    put('library/s/chap.md', CHAP.replace('first', 'first, edited'))
    expect((await L.law('c-chap')).rows.find(r => r.path === 'library/s/chap.md#one')?.drift).toBe('changed')
    put('library/s/chap.md', CHAP.replace('## One', '## Uno'))
    expect((await L.law('c-chap')).rows.find(r => r.path === 'library/s/chap.md#one')?.drift).toBe('missing')
    put('library/s/chap.md', CHAP)
  })
})

describe('drift', () => {
  it('an edited file drifts as changed', async () => {
    await fire({ file_path: join(ROOT, 'lab', 'desk', 'rules.md'), memory_type: 'Project', load_reason: 'path_glob_match' })
    expect((await L.law('c1')).rows.find(r => r.path === 'lab/desk/rules.md')?.drift).toBe(null)
    put('lab/desk/rules.md', '# rules\n\nedited after the load\n')
    expect((await L.law('c1')).rows.find(r => r.path === 'lab/desk/rules.md')?.drift).toBe('changed')
  })

  it('a deleted file drifts as missing', async () => {
    put('lab/desk/tmp.md', 'x')
    await fire({ file_path: join(ROOT, 'lab', 'desk', 'tmp.md'), memory_type: 'Project', load_reason: 'include' })
    rmSync(join(ROOT, 'lab', 'desk', 'tmp.md'))
    expect((await L.law('c1')).rows.find(r => r.path === 'lab/desk/tmp.md')?.drift).toBe('missing')
  })

  it('a session_start file that does not come back after a compaction is lost; one that does is not', async () => {
    await fire({ file_path: join(ROOT, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' })
    const t = Date.now() + 10
    await L.recordBoundary('c2', 'tester', t)
    // c2: two files at start, only one reloads after the compaction
    await sql("UPDATE ops.law_loads SET conversation_id = 'c2' WHERE conversation_id = 'c1' AND file_path = 'CLAUDE.md'")
    void L.recordLoad('c2', 'tester', { file_path: join(ROOT, 'lab', 'desk', 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' }, ROOT, t - 5)
    void L.recordLoad('c2', 'tester', { file_path: join(ROOT, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'compact' }, ROOT, t + 5)
    const law = await L.law('c2')
    expect(law.compactions).toBe(1)
    expect(law.rows.find(r => r.path === 'lab/desk/CLAUDE.md')?.drift).toBe('compacted')
    expect(law.rows.find(r => r.path === 'CLAUDE.md')).toMatchObject({ reason: 'compact', drift: null })
    expect(law.rows.some(r => r.reason === 'compact_boundary')).toBe(false)
    expect(law.drift).toBe(1)
  })

  it('counts pulls from the reads table for books', async () => {
    await db.ops.recordRead('tester', 'library/s/boot.md', { conversationId: 'c1', atBoot: false, ts: 1 })
    await db.ops.recordRead('tester', 'library/s/boot.md', { conversationId: 'c1', atBoot: true, ts: 2 })     // a boot load is not a pull
    expect((await L.law('c1')).rows.find(r => r.path === 'library/s/boot.md')?.read).toBe(1)
  })

  it('a row recorded from the stream lands in ops.law_loads with its source', async () => {
    void L.recordLoad('c3', 'tester', { file_path: join(ROOT, 'CLAUDE.md'), memory_type: 'Project', load_reason: 'session_start' })
    await db.settled()
    const rows = await db.ops.listLawLoads('c3')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'tester', file_path: 'CLAUDE.md', load_reason: 'session_start', source: 'hook', sha: hashObject('CLAUDE.md') })
  })
})

describe('GET /api/chats/:id/law', () => {
  it('answers the rows plus drift for a stored conversation, 404 for an unknown one', async () => {
    const routes: Record<string, (ctx: any) => any> = {}
    const rec = (m: string) => (p: string, h: any) => { routes[`${m} ${p}`] = h }
    const room = await import('../server/rooms/chats.ts')
    room.register({ get: rec('GET'), post: rec('POST'), patch: rec('PATCH'), delete: rec('DELETE'), ws: () => {} } as any)
    const store = await import('../server/chat/store.ts')
    const c = await store.create(AGENT as any, 'law route')
    void L.recordBoot(c.id, 'tester', ['library/s/boot.md'])
    const out = await routes['GET /api/chats/:id/law']({ params: { id: c.id } })
    expect(out.rows).toHaveLength(1)
    expect(out).toMatchObject({ drift: 0, compactions: 0 })
    await expect(async () => routes['GET /api/chats/:id/law']({ params: { id: 'c-nope' } })).rejects.toMatchObject({ status: 404 })
  })
})
