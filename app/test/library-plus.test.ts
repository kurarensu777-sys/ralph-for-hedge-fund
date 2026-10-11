import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// A temp fund that is its own git repo with the machine (app/) nested as ITS OWN repo, as on the
// live tree since 2026-09-25 - the roster and the library of how we work live there - and a temp
// database: nothing here touches the live fund, the live roster or ~/fund-data.
const LIVE_FUND = join(__dirname, '..', '..')
const APP = join(__dirname, '..')
const ROOT = mkdtempSync(join(tmpdir(), 'libplus-'))
process.env.FUND_ROOT = ROOT
process.env.FUND_DATA_DIR = join(ROOT, '.data')

const w = (rel: string, text: string) => { mkdirSync(join(ROOT, rel, '..'), { recursive: true }); writeFileSync(join(ROOT, rel), text) }
const gIn = (cwd: string) => (...a: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test Hand', '-c', 'user.email=t@t', '-c', 'core.hooksPath=', ...a], { cwd, encoding: 'utf8' })
const g = gIn(ROOT)
const gApp = gIn(join(ROOT, 'app'))
const LAW = 'app/library/law/craft'

let db: typeof import('../server/db.ts')
let reads: typeof import('../server/library/reads.ts')
let search: typeof import('../server/library/search.ts')
let edit: typeof import('../server/library/edit.ts')
let core: typeof import('../server/library/core.ts')

beforeAll(async () => {
  // the shelves are DERIVED: app/library/law and app/library/app, both in the nested app repo
  mkdirSync(join(ROOT, 'app', 'agents'), { recursive: true })
  for (const f of readdirSync(join(LIVE_FUND, 'app', 'agents'))) copyFileSync(join(LIVE_FUND, 'app', 'agents', f), join(ROOT, 'app', 'agents', f))
  w(`${LAW}/alpha.md`, '# Alpha\n\nThe overclaiming check asks what a gate prints when the property is false.\n')
  w(`${LAW}/beta.md`, '# Beta\n\nFunding cadence is per symbol. Never assume eight hours for funding.\n')
  w(`${LAW}/crlf.md`, '# Crlf\r\n\r\nwindows line endings\r\n')
  w('app/library/app/app-book.md', '# App book\n\nlives in the nested app repo\n')
  w('lab/vol/beliefs.md', '# Beliefs - vol\n\nB1 funding leads DVOL\n')
  w('lab/vol/retros/2026-09-25.md', '# Retro digest\n\nthrough vol-w01\n')
  w('lab/vol/data/runs.jsonl', '{}\n')
  w('board/B-0001.md', '# not a lab file\n')
  w('secret.md', '# outside lab\n')
  w('repos.json', '{"repos": [{"id": "fund", "path": "."}, {"id": "app", "path": "app"}]}\n')
  w('.gitignore', '/app/\n')
  g('init', '-q'); g('add', '--', 'repos.json', '.gitignore', 'lab'); g('commit', '-q', '-m', 'seed')
  gApp('init', '-q'); gApp('add', '--', 'agents', 'library'); gApp('commit', '-q', '-m', 'seed app')
  db = await import('../server/db.ts')
  reads = await import('../server/library/reads.ts')
  search = await import('../server/library/search.ts')
  edit = await import('../server/library/edit.ts')
  core = await import('../server/library/core.ts')
})

afterAll(() => { core?.stopLibrary(); rmSync(ROOT, { recursive: true, force: true }) })

describe('read path', () => {
  it('keeps only .md under a shelf home or the lab, absolute or relative, either slash; a lab folder reads as its logical id', () => {
    const n = (p: unknown) => reads.normalizeReadPath(p, ROOT)
    expect(n(join(ROOT, 'library', 'fund', 'x.md'))).toBe('library/fund/x.md')
    expect(n(join(ROOT, 'app', 'library', 'law', 'x.md'))).toBe('app/library/law/x.md')
    expect(n('platform/library/markets/x.md')).toBeNull()   // a retired shelf home is no shelf home (B-0202)
    expect(n('app/library/dashboards/vol/runbook.md')).toBe('app/library/dashboards/vol/runbook.md')
    expect(n('platform/dashboards/vol/library/runbook.md')).toBeNull()   // no shelf inside a dashboard since 2026-09-26
    expect(n('platform/dashboards/vol/server.md')).toBeNull()
    expect(n('platform\\lab\\example\\beliefs.md')).toBe('lab/example/beliefs.md')
    expect(n('app/agents/fund.md')).toBeNull()
    expect(n('app/board/B-0001.md')).toBeNull()
    expect(n('lab\\example\\beliefs.md')).toBe('lab/example/beliefs.md')
    // a docs folder elsewhere under platform/ is no shelf home; a path that climbs out is refused
    expect(n(join(ROOT, 'platform', 'feeds', 'acme', 'docs', 'fees.md'))).toBeNull()
    expect(n('platform/CLAUDE.md')).toBeNull()
    expect(n('app/library/law/../../../platform/lab/x.md')).toBeNull()
    expect(n('library/fund/x.txt')).toBeNull()
    expect(n('agents.json')).toBeNull()
    expect(n('board/B-0001.md')).toBeNull()
    expect(n('library/../board/B-0001.md')).toBeNull()
    expect(n(join(tmpdir(), 'library', 'x.md'))).toBeNull()
    expect(n('')).toBeNull()
    expect(n(42)).toBeNull()
  })
})

describe('reads table', () => {
  it('records a pull, dedupes a paged re-read, keeps boot loads apart', async () => {
    expect((await core.listBooks()).tracking).toEqual({ since: null, pulls: 0 })
    expect((await core.listBooks()).books.find(b => b.path === 'app/library/law/craft/alpha.md')!.use).toEqual({ n30: 0, last: null, who: [], boots30: 0, lastBoot: null })
    const r1 = await reads.recordRead({ agent: 'platform', conversation: 'c1', path: join(ROOT, 'app/library/law/craft/alpha.md') })
    expect(r1).toEqual({ recorded: true, path: 'app/library/law/craft/alpha.md' })
    expect((await reads.recordRead({ agent: 'platform', conversation: 'c1', path: 'app/library/law/craft/alpha.md' })).recorded).toBe(false)
    expect((await reads.recordRead({ agent: 'fund', conversation: null, path: 'app/library/law/craft/alpha.md' })).recorded).toBe(true)
    expect((await reads.recordRead({ agent: 'fund', conversation: 'c9', path: 'lab/example/beliefs.md' })).recorded).toBe(true)
    await db.ops.recordRead('platform', 'app/library/law/craft/beta.md', { conversationId: 'c1', atBoot: true })
    // a pull older than the window counts for "last", not for n30
    await db.ops.recordRead('old', 'app/library/law/craft/beta.md', { conversationId: null, atBoot: false, ts: Date.now() - 40 * 86_400_000 })
    const books = await core.listBooks()
    expect(books.tracking!.pulls).toBe(4)
    const alpha = books.books.find(b => b.path === 'app/library/law/craft/alpha.md')!.use!
    expect(alpha.n30).toBe(2)
    expect(alpha.who.sort()).toEqual(['fund', 'platform'])
    expect(alpha.boots30).toBe(0)
    const beta = books.books.find(b => b.path === 'app/library/law/craft/beta.md')!.use!
    expect(beta).toMatchObject({ n30: 0, boots30: 1, who: [] })
    expect(beta.last).toBeLessThan(Date.now() - 30 * 86_400_000)
  })
  it('refuses a bad agent or a path outside the library', async () => {
    await expect(reads.recordRead({ agent: 'x y', path: 'library/a.md' })).rejects.toThrow(/agent/)
    await expect(reads.recordRead({ agent: 'fund', path: 'agents.json' })).rejects.toThrow(/shelf home/)
  })
  it('an agent lists the books it pulled beyond its boot list', async () => {
    const agents = await core.listAgents()
    const plat = agents.find(a => a.id === 'platform')!
    expect(plat.pulled!.map(p => p.path)).toEqual(['app/library/law/craft/alpha.md'])
    expect(plat.pulled![0]).toMatchObject({ n: 1, known: true, title: 'Alpha' })
    const fund = agents.find(a => a.id === 'fund')!
    expect(fund.pulled!.map(p => [p.path, p.known]).sort()).toEqual([['app/library/law/craft/alpha.md', true], ['lab/example/beliefs.md', false]])
    // a pull of a boot book is not "beyond boot"
    core.setBoot('fund', 'app/library/law/craft/alpha.md', true)
    expect((await core.listAgents()).find(a => a.id === 'fund')!.pulled!.map(p => p.path)).toEqual(['lab/example/beliefs.md'])
    core.setBoot('fund', 'app/library/law/craft/alpha.md', false)
    expect(gApp('status', '--porcelain', '--', 'agents').trim()).toBe('')   // on then off: the roster file is back byte for byte
  })
})

describe('search', () => {
  it('terms: lower case, quoted phrases, 2+ chars, deduped', () => {
    expect(search.terms('Funding "eight hours" a funding')).toEqual(['funding', 'eight hours'])
  })
  it('snippet marks every term inside what is shown', () => {
    const s = search.snippet('x '.repeat(200) + 'the Funding cadence and funding again', ['funding'])
    expect(s.text.startsWith('... ')).toBe(true)
    for (const [a, b] of s.marks) expect(s.text.slice(a, b).toLowerCase()).toBe('funding')
    expect(s.marks.length).toBe(2)
  })
  it('every term must match; title beats body; bodies are searched', () => {
    const r = core.searchBooks('funding')
    expect(r.hits.map(h => h.path)).toEqual(['app/library/law/craft/beta.md'])
    expect(r.hits[0].hits).toBe(2)
    expect(core.searchBooks('overclaiming property').hits.map(h => h.path)).toEqual(['app/library/law/craft/alpha.md'])
    expect(core.searchBooks('overclaiming funding').total).toBe(0)
    expect(core.searchBooks('"eight hours"').total).toBe(1)
    expect(core.searchBooks('alpha').hits[0].path).toBe('app/library/law/craft/alpha.md')
    expect(core.searchBooks(' ').hits).toEqual([])
    expect(core.searchBooks('funding').indexed).toBe(4)
  })
  it('the index follows an edit on disk', async () => {
    w('app/library/law/craft/alpha.md', '# Alpha\n\nnow about zebras\n')
    core.stopLibrary()   // what the fs watcher does on a change
    await new Promise(r => setTimeout(r, 20))
    expect(core.searchBooks('zebras').total).toBe(1)
    gApp('checkout', '--', 'library/law/craft/alpha.md')
    core.stopLibrary()
  })
})

describe('a guarded repo follows the roster (B-0453)', () => {
  const repos = [{ path: 'execution', guarded: true }, { path: 'app' }]
  const exec = (mode: string) => [{ mode, writes: ['execution/', 'platform/lab/execution/'] }, { mode: 'active', writes: ['app/'] }]
  it('a book in execution/ is editable when a live agent writes it, locked when none does or its agent sleeps', () => {
    expect(core.bookLocked('execution/docs/a.md', 'execution', repos, exec('active'))).toBe(false)
    expect(core.bookLocked('execution/docs/a.md', 'execution', repos, exec('dormant'))).toBe(true)
    expect(core.bookLocked('execution/docs/a.md', 'execution', repos, [{ mode: 'active', writes: ['app/'] }])).toBe(true)
  })
  it('the old api/execution shim stays locked whatever the roster says; an ordinary repo is never locked', () => {
    expect(core.bookLocked('platform/api/execution/a.md', 'platform', repos, [{ mode: 'active', writes: ['platform/'] }])).toBe(true)
    expect(core.bookLocked('app/library/law/a.md', 'app', repos, [])).toBe(false)
  })
})

describe('edit in place', () => {
  it('commit message carries the Agent: you trailer; subject is one line', () => {
    expect(edit.commitMessage('a.md')).toEqual(['-m', 'library: edit a.md', '-m', 'Agent: you'])
    expect(edit.commitMessage('a.md', 'fix\nthat')[1]).toBe('fix that')
  })
  it('writes, commits only that path IN THE REPO THAT HOLDS IT (app, nested), and never sweeps another staged file', async () => {
    w('app/library/law/craft/other.md', '# staged by another hand\n')
    gApp('add', '--', 'library/law/craft/other.md')
    const fundHead = g('rev-parse', 'HEAD').trim()
    const d = await core.bookDetail('app/library/law/craft/beta.md')
    expect(d.editable).toBe(true)
    expect(d.repo).toBe('app')
    const r = await core.editBook({ path: 'app/library/law/craft/beta.md', base: d.hash, content: d.content + '\nA new line.\n' })
    expect(r).toMatchObject({ written: true, committed: true })
    expect(readFileSync(join(ROOT, 'app/library/law/craft/beta.md'), 'utf8')).toContain('A new line.')
    const log = gApp('log', '-1', '--format=%s%n%(trailers:key=Agent,valueonly)', '--name-only')
    expect(log).toContain('library: edit app/library/law/craft/beta.md')
    expect(log).toContain('you')
    expect(log).toContain('library/law/craft/beta.md')
    expect(log).not.toContain('other.md')
    expect(gApp('diff', '--cached', '--name-only').trim()).toBe('library/law/craft/other.md')
    expect(g('rev-parse', 'HEAD').trim()).toBe(fundHead)   // the fund root's repo is never the one written
    gApp('reset', '-q', '--', 'library/law/craft/other.md')
  })
  it('refuses a stale base (409) and a no-op writes nothing', async () => {
    const d = await core.bookDetail('app/library/law/craft/beta.md')
    await expect(core.editBook({ path: d.book.path, base: 'stale', content: 'x' })).rejects.toThrow(/changed on disk/)
    expect(await core.editBook({ path: d.book.path, base: d.hash, content: d.content })).toMatchObject({ written: false, committed: false })
  })
  it('keeps CRLF files CRLF', async () => {
    const d = await core.bookDetail('app/library/law/craft/crlf.md')
    const r = await core.editBook({ path: d.book.path, base: d.hash, content: d.content.replace(/\r\n/g, '\n') + 'more\n' })
    expect(r.committed).toBe(true)
    expect(readFileSync(join(ROOT, 'app/library/law/craft/crlf.md'), 'utf8')).toBe('# Crlf\r\n\r\nwindows line endings\r\nmore\r\n')
  })
  it('a book in the machine\'s own shelf is editable there; an unknown path and a roster file are no book', async () => {
    const d = await core.bookDetail('app/library/app/app-book.md')
    expect(d.editable).toBe(true)
    await expect(core.editBook({ path: 'agents.json', base: 'x', content: 'x' })).rejects.toThrow(/no book/)
    await expect(core.editBook({ path: 'app/agents/fund.md', base: 'x', content: 'x' })).rejects.toThrow(/no book/)
  })
})

describe('lab files, read only', () => {
  it('serves lab/**/*.md that is on no shelf, read only, never editable', async () => {
    const d = await core.bookDetail('lab/vol/beliefs.md')
    expect(d.content).toContain('B1 funding leads DVOL')
    expect(d.book).toMatchObject({ path: 'lab/vol/beliefs.md', shelf: 'lab', series: 'vol', title: 'Beliefs - vol' })
    expect(d.editable).toBe(false)
    const r = await core.bookDetail('lab/vol/retros/2026-09-25.md')
    expect(r.book.series).toBe('retros')
    await expect(core.editBook({ path: 'lab/vol/beliefs.md', base: d.hash, content: 'x' })).rejects.toThrow(/no book/)
    expect(readFileSync(join(ROOT, 'lab/vol/beliefs.md'), 'utf8')).toContain('B1')
  })
  it('refuses traversal, non-md, missing files and folders', async () => {
    for (const p of ['lab/../board/B-0001.md', 'lab/../secret.md', 'lab/../../etc/passwd.md', 'lab/vol/../../secret.md',
      'lab\\..\\secret.md', 'lab/vol\\..\\..\\secret.md', 'lab/vol/data/runs.jsonl', 'lab/vol/nope.md', 'lab/vol.md', 'lab/.md', '../lab/vol/beliefs.md', join(ROOT, 'secret.md')]) {
      await expect(core.bookDetail(p), p).rejects.toThrow(/no book/)
    }
    expect(core.labBook('lab/vol/../vol/beliefs.md')?.path).toBe('lab/vol/beliefs.md')
    expect(core.labBook('lab/../secret.md')).toBeNull()
  })
})

describe('read hook', () => {
  const run = (env: Record<string, string>, stdin: string) => new Promise<number>(res => {
    const p = spawn(process.execPath, [join(APP, 'scripts', 'hooks', 'read-hook.mjs')], { env: { ...process.env, FUND_ROOT: ROOT, ...env }, stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('exit', c => res(c ?? -1))
    p.stdin.end(stdin)
  })
  it('POSTs {agent, conversation, path} for a library read and exits 0 on every failure', async () => {
    const got: any[] = []
    const srv = createServer((req, res) => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { got.push({ url: req.url, body: JSON.parse(b) }); res.end('{}') }) })
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
    const port = String((srv.address() as any).port)
    const ev = (file: string, tool = 'Read') => JSON.stringify({ tool_name: tool, tool_input: { file_path: file } })
    try {
      const env = { FUND_AGENT: 'platform', FUND_CONVERSATION: 'conv-1', FUNDD_PORT: port }
      expect(await run(env, ev(join(ROOT, 'app', 'library', 'law', 'craft', 'alpha.md')))).toBe(0)
      expect(await run(env, ev(join(ROOT, 'platform', 'lab', 'vol', 'beliefs.md')))).toBe(0)
      expect(await run(env, ev(join(ROOT, 'platform', 'feeds', 'acme', 'docs', 'fees.md')))).toBe(0)   // no shelf home: not posted
      expect(await run(env, ev(join(ROOT, 'app', 'agents', 'fund.md')))).toBe(0)
      expect(await run(env, ev(join(ROOT, 'lab', 'x.md'), 'Write'))).toBe(0)
      expect(await run(env, 'not json')).toBe(0)
      expect(await run({ FUND_AGENT: '', FUNDD_PORT: port }, ev(join(ROOT, 'app', 'library', 'law', 'craft', 'beta.md')))).toBe(0)
      // the hook posts the fund-relative path as read; fundd turns a platform/lab one into its logical id
      expect(got).toEqual([
        { url: '/api/library/read', body: { agent: 'platform', conversation: 'conv-1', path: 'app/library/law/craft/alpha.md' } },
        { url: '/api/library/read', body: { agent: 'platform', conversation: 'conv-1', path: 'platform/lab/vol/beliefs.md' } },
      ])
    } finally { srv.close() }
    // fundd down: still 0, still quick
    const t = Date.now()
    expect(await run({ FUND_AGENT: 'platform', FUNDD_PORT: '1' }, ev(join(ROOT, 'app', 'library', 'law', 'craft', 'alpha.md')))).toBe(0)
    expect(Date.now() - t).toBeLessThan(3000)
  })
  it('the hook tracks exactly what fundd tracks: one TRACKED pattern, character for character', () => {
    const hook = readFileSync(join(APP, 'scripts', 'hooks', 'read-hook.mjs'), 'utf8')
    const m = /^const TRACKED = (\/.+\/[a-z]*)$/m.exec(hook)
    expect(m, 'read-hook.mjs carries a one-line TRACKED pattern').not.toBeNull()
    expect(m![1]).toBe(String(reads.TRACKED))
  })
})
