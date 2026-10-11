import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// B-0372 item 1: search is chapter-granular. A temp fund holds a law book written as chapters (every ## has a
// Read when line) and a reference note that is not; the modules are imported AFTER FUND_ROOT points here.
const LIVE_FUND = join(__dirname, '..', '..')
const ROOT = mkdtempSync(join(tmpdir(), 'lib-chsearch-'))
process.env.FUND_ROOT = ROOT
process.env.FUND_DATA_DIR = join(ROOT, '.data')
const w = (rel: string, text: string) => { mkdirSync(join(ROOT, rel, '..'), { recursive: true }); writeFileSync(join(ROOT, rel), text) }

const GUARD = [
  '---', 'type: guide', 'topics: [law]', '---', '', '# How we guard', '',
  'The lead paragraph says the deny list is the gate, once.', '',
  '## Probing the deny list', '', 'Read when: you add or remove a row of the deny list or write a settings file', '',
  'Probe a row by running the command it blocks. A deny list that was never probed blocks nothing you can name.', '',
  '## Data: the four classes', '', 'Read when: pulling, keeping or deleting data', '',
  'Each datum is one of four classes. The deny list also names the data folders, in passing.', '',
].join('\n')
const DOCS = '# Acme fees\n\n## Maker fee\n\nthe deny list is not mentioned here, only fees\n\nA reference note has headings but no Read when line.\n'

let core: typeof import('../server/library/core.ts')
let search: typeof import('../server/library/search.ts')

beforeAll(async () => {
  mkdirSync(join(ROOT, 'app', 'agents'), { recursive: true })
  for (const f of readdirSync(join(LIVE_FUND, 'app', 'agents'))) copyFileSync(join(LIVE_FUND, 'app', 'agents', f), join(ROOT, 'app', 'agents', f))
  w('app/library/law/_series.md', '---\ntitle: Law\n---\n\n# Law\n\n| Book | Read when |\n|---|---|\n| `how-we-guard.md` | about to guard something |\n')
  w('app/library/law/how-we-guard.md', GUARD)
  w('app/library/markets/fees.md', DOCS)
  core = await import('../server/library/core.ts')
  search = await import('../server/library/search.ts')
})
afterAll(() => { core?.stopLibrary(); rmSync(ROOT, { recursive: true, force: true }) })

describe('docsOf: the units a book is searched as', () => {
  const b = { path: 'app/library/law/how-we-guard.md', title: 'How we guard', shelf: 'law', series: 'law' }
  it('a book written as chapters is one doc per chapter, titled Book > Chapter, plus its lead text', () => {
    const d = search.docsOf(b, GUARD)
    expect(d.map(x => [x.title, x.chapter?.slug])).toEqual([
      ['How we guard', undefined], ['How we guard > Probing the deny list', 'probing-the-deny-list'], ['How we guard > Data: the four classes', 'data-the-four-classes'],
    ])
    expect(d[0].text).toBe('The lead paragraph says the deny list is the gate, once.')
    expect(d[1].text).toContain('A deny list that was never probed')
    expect(d[1].text).not.toContain('four classes')
    expect(d.every(x => x.path === b.path && x.shelf === 'law' && x.series === 'law')).toBe(true)
  })
  it('a book without Read when lines (a reference note) stays ONE doc, whole', () => {
    const d = search.docsOf({ path: 'app/library/markets/fees.md', title: 'Acme fees', shelf: 'markets', series: 'markets' }, DOCS)
    expect(d).toHaveLength(1)
    expect(d[0].chapter).toBeUndefined()
    expect(d[0].text).toBe(DOCS)
  })
  it('a book with one chapter that lacks a Read when line is whole, not half-split', () => {
    expect(search.docsOf(b, GUARD.replace('Read when: pulling, keeping or deleting data', 'no moment here'))).toHaveLength(1)
  })
})

describe('searchBooks over the temp fund', () => {
  it('"deny list" ranks the Probing the deny list chapter first, and the hit names its book, chapter and snippet', () => {
    const r = core.searchBooks('deny list')
    const first = r.hits[0]
    expect(`${first.path}#${first.chapter?.slug}`).toBe('app/library/law/how-we-guard.md#probing-the-deny-list')
    expect(first).toMatchObject({ book: 'How we guard', title: 'How we guard > Probing the deny list', chapter: { slug: 'probing-the-deny-list', title: 'Probing the deny list' } })
    expect(first.snippet.toLowerCase()).toContain('deny list')
    for (const [a, z] of first.marks) expect(['deny', 'list']).toContain(first.snippet.slice(a, z).toLowerCase())
    // the other chapters and books that mention the words follow; each is its own hit
    expect(r.hits.map(h => h.chapter?.slug ?? h.path)).toEqual(expect.arrayContaining(['probing-the-deny-list', 'data-the-four-classes', 'app/library/markets/fees.md']))
  })
  it('a hit in a book without chapters carries no chapter and its own title', () => {
    const h = core.searchBooks('only fees').hits.find(x => x.path.endsWith('fees.md'))!
    expect(h.chapter).toBeUndefined()
    expect(h.book).toBe('Acme fees')
  })
  it('indexed counts books, not chapters', () => {
    expect(core.searchBooks('deny').indexed).toBe(2)
  })
})
