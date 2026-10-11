import { describe, expect, it } from 'vitest'
import { bookRoots, deskOfBook, parseBookLog, parseNoLesson, parseStamp, retroStatus } from '../server/loop/sources.ts'
import { canonicalDesk, legacyDeskFragment, libraryCandidates, libraryOf } from '../server/paths.ts'

const NOW = Date.parse('2026-09-24T12:00:00Z')

describe('lessons', () => {
  it('keeps .md books only, marks the series index, maps the desk', () => {
    const raw = '\x1eabc\x1fOwner\x1f1790000000\x1fa lesson\x1f\n\nA\tlibrary/dashboards/app/s/_series.md\nA\tlibrary/dashboards/app/s/book.md\nM\tlab/dashboards/app/data/runs.jsonl\n'
      + '\x1edef\x1fOwner\x1f1790000100\x1fcode only\x1f\n\nM\tserver/x.ts\n'
    const l = parseBookLog(raw, 'fund', '')
    expect(l).toHaveLength(1)
    expect(l[0].books.map(b => [b.path, b.status, b.index])).toEqual([
      ['library/dashboards/app/s/_series.md', 'A', true],
      ['library/dashboards/app/s/book.md', 'A', false],
    ])
    expect(l[0].desk).toBe('lab/dashboards/app')
    expect(l[0].ts).toBe(1790000000_000)
  })
  it('prefixes a nested repo path so the book id is fund-relative', () => {
    const l = parseBookLog('\x1eabc\x1fA\x1f1\x1fs\x1f\n\nM\tlibrary/cockpit/how.md\n', 'app', 'app')
    expect(l[0].books[0].path).toBe('app/library/cockpit/how.md')
  })
  it('desk of a book', () => {
    expect(deskOfBook('library/fund/the-debrief/x.md')).toBe('.')
    expect(deskOfBook('library/platform/carry/the-desks-lessons/x.md')).toBe('lab/platform/carry')
    expect(deskOfBook('library/platform/data/desk-law.md')).toBe('lab/platform/data')
    expect(deskOfBook('library/platform/store/x.md')).toBe('lab/platform/store')
    expect(deskOfBook('library/dashboards/frontend/x.md')).toBe('lab/dashboards/frontend')
    expect(deskOfBook('library/execution/desk-law.md')).toBe('.')   // execution files no books since 2026-10-03
    expect(deskOfBook('library/research/the-thesis-first-study/x.md')).toBe('lab/research')
    // the homes since the 2026-09-25 re-shelve (B-0073) and the platform's own library
    expect(deskOfBook('library/craft/research/the-thesis-first-study/x.md')).toBe('lab/research')
    expect(deskOfBook('library/craft/dashboards/the-terminal-runbook.md')).toBe('lab/dashboards/app')
    expect(deskOfBook('library/craft/execution/the-desks-lessons/x.md')).toBe('.')
    expect(deskOfBook('library/markets/predmkts/x.md')).toBe('lab/predmkts')
    expect(deskOfBook('library/markets/tradfi/x.md')).toBe('.')
    expect(deskOfBook('library/craft/engineering/x.md')).toBe('.')
    // the homes since the 2026-09-25 relayout: app/library (the machine), a dashboard's own. The one-day
    // platform/library home (2026-09-25..26) is retired and names no desk (B-0202)
    expect(deskOfBook('platform/library/markets/crypto/the-desks-lessons/x.md')).toBe('.')
    expect(deskOfBook('platform/library/platform/carry/x.md')).toBe('.')
    expect(deskOfBook('app/library/craft/research/the-thesis-first-study/x.md')).toBe('lab/research')   // an old home
    expect(deskOfBook('app/library/research/research.md')).toBe('lab/research')
    expect(deskOfBook('app/library/research/predmkts.md')).toBe('lab/predmkts')
    expect(deskOfBook('app/library/platform/platform.md')).toBe('lab/platform')
    expect(deskOfBook('app/library/platform/engines.md')).toBe('lab/platform/carry')
    expect(deskOfBook('app/library/platform/dashboards.md')).toBe('lab/dashboards/app')
    expect(deskOfBook('platform/dashboards/vol/CLAUDE.md')).toBe('lab/dashboards/vol')   // a screen's runbook
    expect(deskOfBook('app/library/research/carry.md')).toBe('.')   // a strategy book is its dashboards' and research's, no one desk's
    expect(deskOfBook('app/library/craft/dashboards/the-terminal-runbook.md')).toBe('lab/dashboards/app')
    expect(deskOfBook('app/library/craft/execution/x.md')).toBe('.')
    expect(deskOfBook('platform/dashboards/vol/library/runbook.md')).toBe('lab/dashboards/vol')
    expect(deskOfBook('app/library/law/the-craft-constitution/x.md')).toBe('.')
    expect(deskOfBook('app/library/craft/engineering/x.md')).toBe('.')
    // the ONE library since 2026-09-26: the platform's shelves and every dashboard's own came into app/library
    expect(deskOfBook('app/library/platform/carry/the-desks-lessons/x.md')).toBe('lab/platform/carry')
    expect(deskOfBook('app/library/platform/data/desk-law.md')).toBe('lab/platform/data')
    expect(deskOfBook('app/library/markets/predmkts/x.md')).toBe('lab/predmkts')
    expect(deskOfBook('app/library/markets/tradfi/x.md')).toBe('.')
    expect(deskOfBook('app/library/dashboards/vol/runbook.md')).toBe('lab/dashboards/vol')
    expect(deskOfBook('app/library/dashboards/terminal/sellvol/x.md')).toBe('lab/dashboards/terminal')
    // history filed before the cut-over maps onto the desk's CURRENT lab folder
    expect(deskOfBook('desks/api/lib/carry/memory/s/x.md')).toBe('lab/platform/carry')
    expect(deskOfBook('desks/app/memory/s/x.md')).toBe('lab/dashboards/app')
  })
  it('a desk maps to its library home by the table (B-0073); old desk ids read as their new names', () => {
    const none = () => false
    // the current homes (2026-09-26): the one library, app/library; the retired platform/library home is
    // never a candidate (B-0202)
    expect(libraryCandidates('lab/research')).toEqual(['app/library/research/research.md', 'app/library/craft/research', 'library/craft/research', 'library/research'])
    expect(libraryOf('lab/platform/carry', none)).toBe('app/library/platform/engines.md')   // the engines book (B-0392); the rest of platform/ share platform.md
    expect(libraryOf('lab/platform/data', none)).toBe('app/library/platform/platform.md')
    expect(libraryOf('lab/dashboards/app', none)).toBe('app/library/platform/dashboards.md')
    expect(libraryOf('lab/dashboards/vol', none)).toBe('platform/dashboards/vol/CLAUDE.md')   // a screen's runbook is its CLAUDE.md (2026-10-03)
    expect(libraryOf('lab/dashboards/vol', p => p === 'app/library/dashboards/vol')).toBe('app/library/dashboards/vol')   // until its agent folds the old shelf in
    expect(libraryOf('lab/dashboards/vol', p => p === 'platform/dashboards/vol/library')).toBe('platform/dashboards/vol/library')   // its home before 2026-09-26
    expect(libraryOf('lab/execution', none)).toBeNull()   // execution files no books
    expect(libraryOf('lab/research', none)).toBe('app/library/research/research.md')
    expect(libraryOf('lab/predmkts', none)).toBe('app/library/research/predmkts.md')
    expect(libraryOf('desks/api/lib', none)).toBe('app/library/platform/platform.md')
    expect(libraryOf('lab/nowhere', none)).toBeNull()
    expect(libraryOf('lab/vol', none)).toBeNull()
    // the first home that exists wins: a shelf mid-move still resolves to where its books are
    expect(libraryOf('lab/platform/carry', p => p === 'library/platform/carry')).toBe('library/platform/carry')   // an old home on disk beats the book that holds none of it yet
    // a desk's folder (platform/lab/...) reads as its logical id
    expect(canonicalDesk('platform/lab/research')).toBe('lab/research')
    expect(canonicalDesk('lab/api/data/store')).toBe('lab/platform/store')
    expect(canonicalDesk('desks/app/server')).toBe('lab/dashboards/server')
    expect(canonicalDesk('lab/apiary')).toBe('lab/apiary')
    expect(legacyDeskFragment('platform/data')).toBe('api/data')
    expect(legacyDeskFragment('research')).toBeNull()
  })
  it('roots: shelves inside a library, assigned to the repo that holds them; a nested root adds nothing', () => {
    const r2 = bookRoots([{ id: 'fund', path: '.' }, { id: 'platform', path: 'platform' }, { id: 'app', path: 'app' }],
      ['app/library/craft', 'app/library/platform', 'platform/feeds/acme/docs', 'platform/dashboards/vol/library', 'library/old', 'app/library'])
    expect(r2.find(r => r.repo === 'fund')!.pathspecs).toEqual([':(glob)desks/**/memory/**', 'library', 'memory'])
    // a sub-repo's library folder is assigned to that repo, while a folder that is no library (a docs/
    // folder, a desk folder) adds nothing
    expect(r2.find(r => r.repo === 'platform')).toEqual({ repo: 'platform', repoPath: 'platform', pathspecs: ['dashboards/vol/library'] })
    const r3 = bookRoots([{ id: 'platform', path: 'platform' }], ['platform/feeds/acme/docs', 'platform/lab/example'])
    expect(r3.flatMap(r => r.pathspecs)).toEqual([])
    expect(r2.find(r => r.repo === 'app')).toEqual({ repo: 'app', repoPath: 'app', pathspecs: ['library'] })
  })
  it('roots: memory/library shelves only, assigned to the repo that holds them', () => {
    const repos = [{ id: 'fund', path: '.' }, { id: 'app', path: 'app' }, { id: 'platform', path: 'platform' }]
    const roots = bookRoots(repos, ['library/fund', 'library/markets', 'lab/example', 'app/library'])
    const fund = roots.find(r => r.repo === 'fund')!
    expect(fund.pathspecs).toContain('library')
    // pre-cut-over homes stay, so lessons filed before the move are still history
    expect(fund.pathspecs).toContain(':(glob)desks/**/memory/**')
    expect(fund.pathspecs).toContain('memory')
    expect(fund.pathspecs).not.toContain('lab/example')
    expect(roots.find(r => r.repo === 'app')).toEqual({ repo: 'app', repoPath: 'app', pathspecs: ['library'] })
  })
})

describe('no-lesson', () => {
  it('parses the real shape, newest first, counts broken lines', () => {
    const a = { desk: '.', hand: 'master', operator: 'x', reason: 'one-line bug', subject: 's1', touched: ['a.py'], ts: '2026-09-21T18:00:02Z' }
    const b = { ...a, subject: 's2', ts: '2026-09-22T18:00:02Z' }
    const { rows, bad } = parseNoLesson(`${JSON.stringify(a)}\n${JSON.stringify(b)}\nnot json\n`)
    expect(bad).toBe(1)
    expect(rows.map(r => r.subject)).toEqual(['s2', 's1'])
    expect(rows[0].touched).toEqual(['a.py'])
  })
})

describe('retro stamp and due rule (port of retro_due.py)', () => {
  it('reads the template stamp and a dated stamp', () => {
    const t = parseStamp('```\nLast retro: none yet · through run 00 · next bet: unset - until the first retro\n```')
    expect(t).toMatchObject({ found: true, date: null, raw: 'none yet', run: '00' })
    const d = parseStamp('Last retro: 2026-09-10 · through run 004 · next bet: widen the band')
    expect(d).toMatchObject({ date: '2026-09-10', run: '004', bet: 'widen the band' })
    expect(parseStamp('no stamp here').found).toBe(false)
  })
  const res = (run: string, imported = false) => ({ run, stage: 'result', ...(imported ? { preregistered: false } : {}) })
  it('imports only: an honest empty ledger, not a debt', () => {
    const r = retroStatus('d', 'Last retro: none yet · through run 008', [res('001', true), res('002', true)], NOW)
    expect(r.due).toBe(false)
    expect(r.imported).toBe(2)
    expect(r.graded).toBe(0)
  })
  it('never retro\'d with a graded run -> due', () => {
    expect(retroStatus('d', 'Last retro: none yet · through run 00', [res('001')], NOW).due).toBe(true)
  })
  it('due at 7 days or 5 runs, whichever first', () => {
    const fresh = 'Last retro: 2026-09-20 · through run 002'
    expect(retroStatus('d', fresh, [res('001'), res('002'), res('003')], NOW).due).toBe(false)
    expect(retroStatus('d', 'Last retro: 2026-09-10 · through run 002', [res('001')], NOW).due).toBe(true)
    const six = ['002', '003', '004', '005', '006', '007', '008'].map(x => res(x))
    const r = retroStatus('d', fresh, six, NOW)
    expect(r.since).toBe(6)
    expect(r.due).toBe(true)
    expect(r.dueAt).toBe(Date.parse('2026-09-27T00:00:00Z'))
  })
})

describe('retro digests (B-0067)', () => {
  it('parses the file digest.py --write saves; counts open FILL slots', async () => {
    const { parseDigest } = await import('../server/loop/sources.ts')
    const d = parseDigest('---\r\ndesk: lab/vol\r\ndate: 2026-09-25\r\nthrough: vol-001\r\nsource: tools/loop/digest.py --write\r\n---\r\n\r\n# Retro - lab/vol - 2026-09-25\r\n\r\n- judge: 3/4 in band\r\n- <FILL: THE NEXT BET - one line>\r\n', 'lab/vol/retros/2026-09-25.md', 2)
    expect(d).toEqual({ path: 'lab/vol/retros/2026-09-25.md', date: '2026-09-25', through: 'vol-001', source: 'tools/loop/digest.py --write', lines: ['judge: 3/4 in band', '<FILL: THE NEXT BET - one line>'], fills: 1, count: 2 })
    expect(parseDigest('---\ndesk: x\nthrough: none\n---\n', 'lab/x/retros/2026-01-02.md').through).toBeNull()
  })
  it('latest = the newest dated file; no folder = null (an honest empty)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { latestDigest } = await import('../server/loop/sources.ts')
    const root = mkdtempSync(join(tmpdir(), 'digest-'))
    expect(latestDigest(root, 'lab/vol')).toBeNull()
    mkdirSync(join(root, 'lab/vol/retros'), { recursive: true })
    expect(latestDigest(root, 'lab/vol')).toBeNull()
    writeFileSync(join(root, 'lab/vol/retros/2026-09-18.md'), '---\ndate: 2026-09-18\n---\n- old\n')
    writeFileSync(join(root, 'lab/vol/retros/2026-09-25.md'), '---\ndate: 2026-09-25\n---\n- new\n')
    writeFileSync(join(root, 'lab/vol/retros/notes.txt'), 'x')
    const d = latestDigest(root, 'lab/vol')!
    expect(d.path).toBe('lab/vol/retros/2026-09-25.md')
    expect(d.lines).toEqual(['new'])
    expect(d.count).toBe(2)
  })
})
