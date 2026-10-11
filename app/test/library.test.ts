import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// A temp fund: every module that reads FUND_ROOT is imported AFTER the env points here, so the
// boot toggle below rewrites a COPY of the roster (app/agents/*.md) and never the live one.
const LIVE_FUND = join(__dirname, '..', '..')
const ROOT = mkdtempSync(join(tmpdir(), 'lib-test-'))
process.env.FUND_ROOT = ROOT
process.env.FUND_DATA_DIR = join(ROOT, '.data')

const w = (rel: string, text: string) => { mkdirSync(join(ROOT, rel, '..'), { recursive: true }); writeFileSync(join(ROOT, rel), text) }

let scan: typeof import('../server/library/scan.ts')
let core: typeof import('../server/library/core.ts')

beforeAll(async () => {
  // the shelves are DERIVED from these folders: app/library/<x> (app, dashboards, desk, law, platform -
  // the one library); a platform/dashboards/vol/library left behind is NOT a shelf (2026-09-26), nor is
  // a platform/library/<x> left on a machine (that home was retired 2026-09-26, B-0202)
  mkdirSync(join(ROOT, 'app', 'agents'), { recursive: true })
  for (const f of readdirSync(join(LIVE_FUND, 'app', 'agents'))) copyFileSync(join(LIVE_FUND, 'app', 'agents', f), join(ROOT, 'app', 'agents', f))
  mkdirSync(join(ROOT, 'app', 'tools'), { recursive: true })
  copyFileSync(join(LIVE_FUND, 'app', 'tools', 'context-caps.json'), join(ROOT, 'app', 'tools', 'context-caps.json'))
  w('CLAUDE.md', '# base\n\n' + 'law line. '.repeat(40))
  w('app/CLAUDE.md', '# app workspace\n\n' + 'workspace line. '.repeat(30))
  w('app/library/platform/_series.md', '---\ntitle: Platform - the shelf\ntags: [platform]\n---\n\n# Platform\n')
  w('platform/library/markets/stray.md', '# a book in the retired platform/library home: never a shelf, never scanned')
  mkdirSync(join(ROOT, 'app', 'library', 'app'), { recursive: true })
  mkdirSync(join(ROOT, 'app', 'library', '_drafts'), { recursive: true })   // underscore: not a shelf
  w('app/library/shelf.md', '# the vet list, a loose file: not a shelf\n')
  w('app/library/law/craft/_series.md', '---\ntitle: Craft\ntags: [a]\n---\n\n# Craft\n\n| Book | Read when |\n|---|---|\n| `alpha.md` | about to **ship** a gate |\n| beta.md | before a retro |\n')
  w('app/library/law/craft/alpha.md', '---\ntitle: fm title\n---\n\n# Alpha - the first\n\nbody text here\n\n## Part one\n\nRead when: about to boot one part\n\nthe chapter')
  w('app/library/law/craft/beta.md', 'no heading at all, just words')
  w('app/library/law/craft/README.md', '# not a book')
  w('app/library/law/craft/CLAUDE.md', '# not a book')
  w('app/library/law/craft/AGENTS.md', '# not a book')
  w('app/library/desk/beliefs.md', '# Beliefs')
  w('app/library/desk/node_modules/pkg/readme2.md', '# skipped dir')
  w('app/library/desk/notes.txt', 'not markdown')
  w('app/library/dashboards/vol/runbook.md', '# Vol runbook')
  w('platform/dashboards/vol/library/stray.md', '# a stray book inside a dashboard folder: never scanned')
  w('platform/dashboards/vol/dashboard.json', '{}')
  scan = await import('../server/library/scan.ts')
  core = await import('../server/library/core.ts')
})

afterAll(async () => {
  core?.stopLibrary()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('series index', () => {
  it('maps file -> read when, with or without backticks, stripping markdown', () => {
    const m = scan.parseSeriesIndex(readFileSync(join(ROOT, 'app/library/law/craft/_series.md'), 'utf8'))
    expect(m.get('alpha.md')).toBe('about to ship a gate')
    expect(m.get('beta.md')).toBe('before a retro')
    expect(m.has('book')).toBe(false)
    expect(m.size).toBe(2)
  })
  it('parses a real fund series index', () => {
    const m = scan.parseSeriesIndex(readFileSync(join(LIVE_FUND, 'app/library/law/_series.md'), 'utf8'))
    expect(m.get('how-we-know.md')).toMatch(/^about to conclude anything from a number/)
  })
})

describe('derived shelves', () => {
  it('one shelf per top-level folder of app/library (the one library), never the retired platform/library; dept from the roster', async () => {
    const { config } = await import('../server/config.ts')
    expect(config.shelves()).toEqual([
      { id: 'app', title: 'App', dept: 'Build', roots: ['app/library/app'] },
      { id: 'dashboards', title: 'Dashboards', dept: 'Dashboards', roots: ['app/library/dashboards'] },
      { id: 'desk', title: 'Desk', dept: 'Desk', roots: ['app/library/desk'] },
      { id: 'law', title: 'Law', dept: 'Law', roots: ['app/library/law'] },
      { id: 'platform', title: 'Platform', dept: 'Build', roots: ['app/library/platform'] },
    ])
  })
  it('a shelf top _series.md names its title and dept; a legacy or retired home of the same name adds no root', async () => {
    const S = await import('../server/shelves.ts')
    expect(S.shelfMeta('---\ntitle: Craft - the shelf\ndept: HQ\n---\n# x')).toEqual({ title: 'Craft', dept: 'HQ' })
    expect(S.shelfMeta('# no frontmatter')).toEqual({})
    const R = mkdtempSync(join(tmpdir(), 'shelves-'))
    try {
      mkdirSync(join(R, 'platform', 'dashboards', 'vol', 'library'), { recursive: true })   // not a shelf
      mkdirSync(join(R, 'app', 'library', 'dashboards', 'vol'), { recursive: true })
      mkdirSync(join(R, 'platform', 'library', 'dashboards'), { recursive: true })   // retired home: not a root (B-0202)
      writeFileSync(join(R, 'app', 'library', 'dashboards', '_series.md'), '---\ntitle: Dashboards - the shelf\ndept: Screens\n---\n')
      // a legacy root library/ folder whose id a current home holds adds nothing; a retired one never shows
      mkdirSync(join(R, 'library', 'dashboards'), { recursive: true })
      mkdirSync(join(R, 'library', 'fund'), { recursive: true })
      expect(S.deriveShelves(R, [{ id: 'dash:x', dept: 'Dashboards' }])).toEqual([
        { id: 'dashboards', title: 'Dashboards', dept: 'Screens', roots: ['app/library/dashboards'] },
      ])
      // a legacy shelf no current home holds still shows, after the current homes
      mkdirSync(join(R, 'library', 'markets'), { recursive: true })
      expect(S.shelfRoots(R)).toEqual(['app/library/dashboards', 'library/markets'])
      expect(S.deriveShelves(join(R, 'nowhere'), [])).toEqual([])
    } finally { rmSync(R, { recursive: true, force: true }) }
  })
})

describe('the configuration watch', () => {
  it('announces only configuration: repos.json, the jobs, the loop setting, the board setting, the controls setting, a roster file, any dashboard.json, a shelf folder', async () => {
    const { homes } = await import('../server/config.ts')
    const hs = homes()
    const hit = (i: number, n: string) => hs[i].hit(n)
    expect(hit(0, 'repos.json')).toBe('repos.json')
    expect(hit(0, 'README.md')).toBeNull()
    expect(hit(1, 'schedule.json')).toBe('app/schedule.json')
    expect(hit(1, 'package.json')).toBeNull()
    expect(hit(2, 'config.json')).toBe('app/loop/config.json')
    expect(hit(3, 'dash-vol.md')).toBe('app/agents/dash-vol.md')
    expect(hit(3, 'dash-vol.md.123.tmp')).toBeNull()
    expect(hit(4, 'vol/dashboard.json')).toBe('platform/dashboards/vol/dashboard.json')
    expect(hit(4, 'vol/library')).toBeNull()   // a dashboard's books are app/library/dashboards/<id> since 2026-09-26
    expect(hit(4, 'vol/server.py')).toBeNull()
    expect(hit(5, 'craft')).toBe('app/library/craft')
    expect(hit(5, 'dashboards')).toBe('app/library/dashboards')
    expect(hit(5, 'shelf.md')).toBeNull()
    expect(hit(6, 'markets')).toBe('library/markets')   // the legacy root library/; the retired platform/library is not watched (B-0202)
    expect(hit(7, 'config.json')).toBe('app/board/config.json')
    expect(hit(7, 'B-0001.md')).toBeNull()
    expect(hit(8, 'controls.json')).toBe('app/controls.json')
    expect(hit(8, 'package.json')).toBeNull()
    expect(hs).toHaveLength(9)
    expect(hs.some(h => /[\\/]platform[\\/]library$/.test(h.dir))).toBe(false)
    expect(hs[4].recursive).toBe(true)
  })
})

describe('book scan', () => {
  it('excludes README, AGENTS, CLAUDE, _series and non-md files, skips node_modules', () => {
    const books = core.books()
    expect(books.map(b => b.path).sort()).toEqual(['app/library/dashboards/vol/runbook.md', 'app/library/desk/beliefs.md', 'app/library/law/craft/alpha.md', 'app/library/law/craft/beta.md'])
  })
  it('reads title, series, readWhen and tokens', () => {
    const alpha = core.books().find(b => b.path === 'app/library/law/craft/alpha.md')!
    expect(alpha).toMatchObject({ shelf: 'law', series: 'craft', title: 'Alpha - the first', readWhen: 'about to ship a gate' })
    expect(alpha.tokens).toBe(Math.round(readFileSync(join(ROOT, alpha.path), 'utf8').length / 4))
    const beta = core.books().find(b => b.path === 'app/library/law/craft/beta.md')!
    expect(beta.title).toBe('beta')
    expect(core.books().find(b => b.path === 'app/library/desk/beliefs.md')!.readWhen).toBe('')
    expect(core.books().find(b => b.path === 'app/library/dashboards/vol/runbook.md')).toMatchObject({ shelf: 'dashboards', series: 'vol', title: 'Vol runbook' })
  })
})

describe('boot toggle', () => {
  it('pure toggle refuses unknown agents and unknown books', () => {
    const agents = [{ id: 'a', boot: ['x.md'] }] as any
    expect(() => core.toggleBoot(agents, 'nobody', 'x.md', true, () => true)).toThrow(/no agent/)
    expect(() => core.toggleBoot(agents, 'a', 'y.md', true, () => false)).toThrow(/not a book/)
    expect(core.toggleBoot(agents, 'a', 'x.md', true, () => true).changed).toBe(false)
    expect(core.toggleBoot(agents, 'a', 'x.md', false, () => false).agents[0].boot).toEqual([])
  })
  it('on then off through saveAgents round-trips the temp copy, byte for byte, brief untouched', () => {
    const file = join(ROOT, 'app', 'agents', 'app.md')
    const before = readFileSync(file, 'utf8')
    const r1 = core.setBoot('app', 'app/library/law/craft/alpha.md', true)
    expect(r1.changed).toBe(true)
    const on = readFileSync(file, 'utf8')
    expect(on).toContain('  - app/library/law/craft/alpha.md\n')
    expect(on.slice(on.indexOf('\n---\n'))).toBe(before.slice(before.indexOf('\n---\n')))   // the brief is not touched
    expect(core.setBoot('app', 'app/library/law/craft/alpha.md', true).changed).toBe(false)
    const r2 = core.setBoot('app', 'app/library/law/craft/alpha.md', false)
    expect(r2.changed).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readFileSync(join(LIVE_FUND, 'app', 'agents', 'app.md'), 'utf8')).toBe(before)   // the live roster was never the one written
    expect(() => core.setBoot('app', 'app/library/law/craft/README.md', true)).toThrow(/not a book/)
    expect(() => core.setBoot('ghost', 'app/library/law/craft/alpha.md', true)).toThrow(/no agent/)
  })
  it('a chapter ref (<book>#<slug>, B-0345) boots: added when the slug names a heading, refused when it does not; the agent list prices the chapter alone', async () => {
    const file = join(ROOT, 'app', 'agents', 'app.md')
    const before = readFileSync(file, 'utf8')
    const ref = 'app/library/law/craft/alpha.md#part-one'
    expect(() => core.setBoot('app', 'app/library/law/craft/alpha.md#no-such-part', true)).toThrow(/not a book/)
    expect(() => core.setBoot('app', 'app/library/law/craft/beta.md#part-one', true)).toThrow(/not a book/)
    expect(core.setBoot('app', ref, true).changed).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain(`  - ${ref}\n`)
    const app = (await core.listAgents()).find(a => a.id === 'app')!
    const row = app.boot.find(b => b.path === ref)!
    const alpha = core.books().find(b => b.path === 'app/library/law/craft/alpha.md')!
    expect(row).toMatchObject({ known: true, shelf: 'law', title: 'Alpha - the first - Part one', tokens: alpha.chapters[0].tokens })
    expect(row.tokens).toBeLessThan(alpha.tokens)
    const listed = (await core.listBooks()).books.find(b => b.path === alpha.path)!
    expect(listed.chapters[0]).toMatchObject({ slug: 'part-one', readers: ['app'] })
    expect(listed.readers).toContain('app')
    // a chapter whose heading was renamed since is listed unknown, never priced at zero as if it were fine
    writeFileSync(join(ROOT, 'app/library/law/craft/alpha.md'), readFileSync(join(ROOT, 'app/library/law/craft/alpha.md'), 'utf8').replace('## Part one', '## Part 1'))
    core.stopLibrary()
    expect((await core.listAgents()).find(a => a.id === 'app')!.boot.find(b => b.path === ref)).toMatchObject({ known: false, tokens: 0 })
    expect(core.setBoot('app', ref, false).changed).toBe(true)     // a stale entry can still be taken out
    writeFileSync(join(ROOT, 'app/library/law/craft/alpha.md'), readFileSync(join(ROOT, 'app/library/law/craft/alpha.md'), 'utf8').replace('## Part 1', '## Part one'))
    core.stopLibrary()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
  it('agents carry the ONE boot cap from context-caps.json, the same for every kind, and the layers around it', async () => {
    const boot = JSON.parse(readFileSync(join(LIVE_FUND, 'app', 'tools', 'context-caps.json'), 'utf8')).boot
    expect(boot).toBe(375000)   // 40% of the 1M context circle less the other layers (owner, 2026-10-07); a change is the owner's word, here and in the JSON
    const agents = await core.listAgents()
    for (const a of agents) expect(a.budget).toBe(boot)
    const app = agents.find(a => a.id === 'app')!
    const base = Math.round(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').length / 4)
    const ws = Math.round(readFileSync(join(ROOT, 'app', 'CLAUDE.md'), 'utf8').length / 4)
    expect(app.layers).toMatchObject({ base, workspace: ws, workspaceFiles: [{ file: 'app/CLAUDE.md', tokens: ws }], agent: app.brief.tokens, boot: app.bootTokens, caps: { base: 6000, agent: 2000, boot } })
    expect(app.layers!.total).toBe(base + ws + app.brief.tokens + app.bootTokens)   // "all in", as context.py --table sums it
    // the fund agent works at the root: no workspace file between the root and its cwd
    expect(agents.find(a => a.id === 'fund')!.layers).toMatchObject({ workspace: 0, workspaceFiles: [] })
    // books carry the caps for the over-size marks
    expect((await core.listBooks()).caps).toEqual({ chapter: 4500, chapterTarget: 3750, book: 40000, boot })
  })
  it('a caps file that cannot be read is null on every reading: no meter, no verdict, never a made-up cap', async () => {
    const f = join(ROOT, 'app', 'tools', 'context-caps.json')
    const keep = readFileSync(f, 'utf8')
    writeFileSync(f, '{ not json')
    try {
      expect((await core.listBooks()).caps).toBeNull()
      const a = (await core.listAgents())[0]
      expect(a.budget).toBeNull()
      expect(a.layers).toBeNull()
    } finally { writeFileSync(f, keep) }
  })
  it("agents carry their brief: the body of their roster file under the header; a missing one says so, never an empty string", async () => {
    const configMod = await import('../server/config.ts')
    const raw = readFileSync(join(ROOT, 'app', 'agents', 'fund.md'), 'utf8')
    w('app/agents/fund.md', raw.slice(0, raw.indexOf('\n---\n') + 5) + '\n# fund - the brief\n\nWho you are.\n')
    const agents = await core.listAgents()
    const fund = agents.find(a => a.id === 'fund')!
    expect(fund.brief).toEqual({ path: 'app/agents/fund.md', text: '# fund - the brief\n\nWho you are.\n', tokens: 8 })
    // an agent row that names a brief file of its own that is not on disk
    const dash = { ...configMod.config.agents().find(a => a.id === 'dash:vol')!, brief: 'app/agents/gone.md' }
    const b = core.briefOfAgent(dash)
    expect(b.path).toBe('app/agents/gone.md')
    expect(b.text).toBeNull()
    expect(b.tokens).toBe(0)
  })
})

describe('vet list', () => {
  it('parses the owner app/library/shelf.md into rows with tags and book links', () => {
    const rows = scan.parseVet(readFileSync(join(LIVE_FUND, 'app', 'library', 'shelf.md'), 'utf8'), p => p.startsWith('app/library/'))
    expect(rows.length).toBeGreaterThan(0)
    const bar = rows.find(r => r.title === 'The Evidence Bar')!
    expect(bar.tag).toBe('LAW')
    expect(bar.book).toBe('app/library/law/how-we-know.md')
    expect(rows.find(r => r.title === 'The Base Prompt')!.book).toBeNull()
  })
})

describe('vet rows that cite a chapter', () => {
  const vet = '| Doc | The vet |\n|---|---|\n| **Alpha part** `app/library/law/craft/alpha.md#part-one` | **LAW** - the chapter |\n| **Alpha gone** `app/library/law/craft/alpha.md#no-such` | **LAW** - a dead chapter |\n| **Beta** `app/library/law/craft/beta.md` | **MACHINE** - the book |\n| **None** `nowhere.md#x` | **LAW** - no book |\n'
  it('splits the ref: the book is the path before the #, the chapter its slug', () => {
    const rows = scan.parseVet(vet, p => p.startsWith('app/library/'))
    expect(rows.map(r => [r.book, r.chapter])).toEqual([['app/library/law/craft/alpha.md', 'part-one'], ['app/library/law/craft/alpha.md', 'no-such'], ['app/library/law/craft/beta.md', null], [null, null]])
  })
  it('vetList keeps the chapter only when that heading exists; the book still links', () => {
    w('app/library/shelf.md', vet)
    core.stopLibrary()
    const rows = core.vetList()
    expect(rows.map(r => [r.book, r.chapter])).toEqual([['app/library/law/craft/alpha.md', 'part-one'], ['app/library/law/craft/alpha.md', null], ['app/library/law/craft/beta.md', null], [null, null]])
    w('app/library/shelf.md', '# the vet list, a loose file: not a shelf\n')
    core.stopLibrary()
  })
})

describe('git log parse', () => {
  it('keeps pipes in the subject', () => {
    expect(core.parseLog('abc123|1700000000|platform|a | b\n')).toEqual([{ sha: 'abc123', ts: 1700000000000, who: 'platform', subject: 'a | b' }])
  })
  it('names the Agent: trailer, else "you" - never the git author', () => {
    expect(core.parseLog('abc123|1700000000||fix x\n')[0].who).toBe('you')
    expect(core.LOG_FORMAT).not.toMatch(/%an|%ae|%cn|%ce/)
  })
  it('reads a real Agent: trailer through git', async () => {
    const { execFileSync } = await import('node:child_process')
    const d = mkdtempSync(join(tmpdir(), 'libgit-'))
    const g = (...a: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Somebody Real', '-c', 'user.email=x@y', ...a], { cwd: d, encoding: 'utf8' })
    try {
      g('init', '-q')
      writeFileSync(join(d, 'a.md'), '# a\n'); g('add', 'a.md'); g('commit', '-q', '-m', 'one', '-m', 'Agent: platform')
      writeFileSync(join(d, 'a.md'), '# b\n'); g('add', 'a.md'); g('commit', '-q', '-m', 'two')
      const rows = core.parseLog(g('log', `--format=${core.LOG_FORMAT}`, '--', 'a.md'))
      expect(rows.map(r => [r.subject, r.who])).toEqual([['two', 'you'], ['one', 'platform']])
      expect(JSON.stringify(rows)).not.toContain('Somebody')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})
