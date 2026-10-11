import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setTopics, topicFault, topicsOf, vocabFaults, vocabOf } from '../shared/bookmeta.ts'
import type { LibBook } from '../server/library/types.ts'
import { audit } from '../server/library/links.ts'
import { loadsOf, recallIndex, recallTable } from '../server/library/need.ts'
import { scanBooks } from '../server/library/scan.ts'
import { deriveShelves } from '../server/shelves.ts'
import { isFiltered, matcher, readerTags, recallWho, type Facets } from '../src/rooms/library/facets.ts'
import { distinctLabels } from '../src/rooms/library/spine.ts'

// Topics (what a book is about), need (who must read it) and the live library's own lists.

const FUND = join(__dirname, '..', '..')

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lib-topics-'))
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t) }
  return root
}

describe('the grammar (shared/bookmeta.ts)', () => {
  it('reads a flow list, a block list, and no key as null', () => {
    expect(topicsOf('---\ntopics: [data, fees]\n---\n# X')).toEqual(['data', 'fees'])
    expect(topicsOf('---\ntopics:\n  - a\n  - b\n---\n')).toEqual(['a', 'b'])
    expect(topicsOf('---\ntitle: x\n---\n')).toBeNull()
    expect(topicsOf('# no frontmatter')).toBeNull()
  })
  it('reads a shelf list as ordered id -> holds, and stops at the next key', () => {
    const v = vocabOf('---\ntitle: P\ntopics:\n  data: data I/O\n  engines: the engines\ndept: Build\n---\n')
    expect(v).toEqual([{ id: 'data', holds: 'data I/O' }, { id: 'engines', holds: 'the engines' }])
  })
  it('names what is wrong with a book, and passes a sound one', () => {
    const v = [{ id: 'data', holds: '' }, { id: 'fees', holds: '' }]
    expect(topicFault(['data'], v)).toBeNull()
    expect(topicFault([], v)).toMatch(/no topics/)
    expect(topicFault(null, v)).toMatch(/no topics/)
    expect(topicFault(['dta'], v)).toMatch(/"dta" not on this shelf \(data, fees\)/)
    expect(topicFault(['data', 'fees', 'data', 'fees'], v)).toMatch(/4 topics/)
    expect(topicFault(['data', 'data'], v)).toMatch(/twice/)
  })
  it('names what is wrong with a list', () => {
    expect(vocabFaults([], 'x')).not.toEqual([])
    expect(vocabFaults([{ id: 'Data', holds: '' }], 'x')[0]).toMatch(/not a topic id/)
    expect(vocabFaults([{ id: 'platform', holds: '' }], 'platform')[0]).toMatch(/repeats the shelf/)
    expect(vocabFaults([{ id: 'data', holds: '' }], 'platform')).toEqual([])
  })
  it('setTopics writes in place, retires tags, adds frontmatter, keeps CRLF and the body', () => {
    expect(setTopics('---\ntitle: X\ntags: [a, b]\n---\n\n# X\nbody\n', ['data'])).toBe('---\ntitle: X\ntopics: [data]\n---\n\n# X\nbody\n')
    expect(setTopics('# Y\n', ['ui'])).toBe('---\ntopics: [ui]\n---\n\n# Y\n')
    expect(setTopics('---\r\ntopics: [x]\r\n---\r\n# Z\r\n', ['y'])).toBe('---\r\ntopics: [y]\r\n---\r\n# Z\r\n')
  })
})

describe('shelves carry their list; books their topics; the audit holds them', () => {
  const root = tree({
    'app/library/platform/_series.md': '---\ntitle: Platform - the shelf\ntopics:\n  data: fetchers\n  engines: engines\n---\n# P\n| file | read when |\n|---|---|\n| `a.md` | x |\n| `b.md` | y |\n| `c.md` | z |\n',
    'app/library/platform/a.md': '---\ntopics: [data]\n---\n# A\n',
    'app/library/platform/b.md': '# B, no topics\n',
    'app/library/platform/c.md': '---\ntopics: [enignes]\n---\n# C\n',
    'app/library/craft/_series.md': '---\ntitle: Craft\n---\n# Craft\n| file | read when |\n|---|---|\n| `d.md` | w |\n',
    'app/library/craft/d.md': '# D\n',
  })
  const shelves = deriveShelves(root, [])
  it('a shelf reads its topics from its top _series.md; one that names none has none', () => {
    expect(shelves.find(s => s.id === 'platform')?.topics?.map(t => t.id)).toEqual(['data', 'engines'])
    expect(shelves.find(s => s.id === 'craft')?.topics).toBeUndefined()
  })
  it('a book carries its topics as written', () => {
    const books = scanBooks(root, shelves)
    expect(books.find(b => b.path.endsWith('/a.md'))?.topics).toEqual(['data'])
    expect(books.find(b => b.path.endsWith('/b.md'))?.topics).toEqual([])
  })
  it('the link audit names a missing and an unknown topic, and asks nothing of a shelf with no list', () => {
    const rows = audit(root, shelves, [], [])
    const t = rows.filter(r => /topic/.test(r.fault))
    expect(t.map(r => [r.fault, r.path.split('/').pop()])).toEqual([['bad-topic', 'c.md'], ['no-topic', 'b.md']])
    expect(t.some(r => r.path.endsWith('d.md'))).toBe(false)
  })
})

describe('who must read it (server/library/need.ts)', () => {
  const root = tree({
    'CLAUDE.md': '# Law\n## Recall\n| The moment | Read |\n|---|---|\n| about to X | `app/library/law/x.md` |\n| about to Z | `app/library/law/_series.md` |\n## Next\n| a | `app/library/law/y.md` |\n',
    'app/CLAUDE.md': '# App\n## Recall\n| The moment | Read |\n|---|---|\n| about to Y | `library/law/y.md` |\n',
    'platform/feeds/hl/CLAUDE.md': '## Recall\n| when | `../../../app/library/law/y.md` |\n',
    'app/library/law/x.md': '# X', 'app/library/law/y.md': '# Y',
  })
  const files = ['CLAUDE.md', 'app/CLAUDE.md', 'platform/feeds/hl/CLAUDE.md']
  const isBook = (p: string) => p === 'app/library/law/x.md' || p === 'app/library/law/y.md'
  it('reads only Recall tables, keeps the moment, and skips a series index', () => {
    expect(recallTable('## Recall\n|---|---|\n| **about** to X | `a.md` |\n## Other\n| b | `b.md` |')).toEqual([{ moment: 'about to X', cites: ['a.md'] }])
    const idx = recallIndex(root, files, isBook)
    expect(idx.get('app/library/law/x.md')).toEqual([{ file: 'CLAUDE.md', moment: 'about to X' }])
    expect(idx.get('app/library/law/y.md')?.map(r => r.file)).toEqual(['app/CLAUDE.md', 'platform/feeds/hl/CLAUDE.md'])
  })
  it('an agent loads the CLAUDE.md of its cwd and every folder above, and no other', () => {
    expect(loadsOf('.', files)).toEqual(['CLAUDE.md'])
    expect(loadsOf('app', files)).toEqual(['CLAUDE.md', 'app/CLAUDE.md'])
    expect(loadsOf('platform/research', files)).toEqual(['CLAUDE.md'])
    expect(loadsOf('application', files)).toEqual(['CLAUDE.md'])   // a prefix of a name is not a parent
  })
})

// ---- the room's facets (pure) ----
const book = (p: Partial<LibBook>): LibBook => ({
  path: 'app/library/law/x.md', shelf: 'law', series: 'law', title: 'X', readWhen: '', topics: [], type: null, parent: null, chapters: [], tokens: 1, updated: 0,
  readers: [], recall: [], use: { n30: 0, last: null, who: [], boots30: 0, lastBoot: null }, ...p,
})
const AGENTS = ['fund', 'app', 'platform', 'dash:a', 'dash:b']
const LOADS = { fund: ['CLAUDE.md'], app: ['CLAUDE.md', 'app/CLAUDE.md'], platform: ['CLAUDE.md'], 'dash:a': ['CLAUDE.md'], 'dash:b': ['CLAUDE.md'] }
const mark = (id: string) => id.replace('dash:', '').slice(0, 2).toUpperCase()

describe('facets (src/rooms/library/facets.ts)', () => {
  const F: Facets = { shelf: null, topics: [], who: null, need: '', read: '', q: '' }
  const boot = book({ path: 'b', readers: ['app'] })
  const rc = book({ path: 'r', recall: [{ file: 'app/CLAUDE.md', moment: 'm' }] })
  const opt = book({ path: 'o', topics: ['fees'], shelf: 'markets' })
  const all = [boot, rc, opt]
  const pick = (f: Partial<typeof F>) => all.filter(matcher({ loads: LOADS }, { ...F, ...f })).map(b => b.path)
  it('need: boot, recall, optional; the lens narrows each to one agent', () => {
    expect(pick({ need: 'boot' })).toEqual(['b'])
    expect(pick({ need: 'recall' })).toEqual(['r'])
    expect(pick({ need: 'must' })).toEqual(['b', 'r'])
    expect(pick({ need: 'opt' })).toEqual(['o'])
    expect(pick({ who: 'app' })).toEqual(['b', 'r'])
    expect(pick({ who: 'fund' })).toEqual([])                   // fund does not load app/CLAUDE.md
  })
  it('topics OR among keys; #prefix in the text; untagged', () => {
    expect(pick({ topics: ['markets/fees'] })).toEqual(['o'])
    expect(pick({ topics: ['law/-'] })).toEqual(['b', 'r'])
    expect(pick({ q: '#fe' })).toEqual(['o'])
    expect(isFiltered({ ...F })).toBe(false)
  })
  it('read: a book whose reads are unknown matches no read filter (never a false "never read")', () => {
    const unknown = book({ path: 'u', use: undefined })
    expect([unknown].filter(matcher({ loads: LOADS }, { ...F, read: 'never' }))).toEqual([])
    expect([boot].filter(matcher({ loads: LOADS }, { ...F, read: 'never' })).length).toBe(1)
  })
  it('recall with no CLAUDE.md list is unknown, not nobody', () => {
    expect(recallWho(rc, null)).toBeNull()
    expect(recallWho(rc, LOADS)).toEqual(['app'])
  })
})

describe('reader tags under a book', () => {
  const tags = (b: LibBook) => readerTags(b, recallWho(b, LOADS), AGENTS, mark).map(t => `${t.kind}:${t.text}`)
  it('every agent collapses to ALL, every dashboard agent to DSH', () => {
    expect(tags(book({ readers: AGENTS }))).toEqual(['boot:ALL'])
    expect(tags(book({ readers: ['dash:a', 'dash:b', 'app'] }))).toEqual(['boot:DSH', 'boot:AP'])
  })
  it('recall shows the agents that do not already boot with it, ALL when the row reaches everyone', () => {
    expect(tags(book({ readers: ['dash:a', 'dash:b'], recall: [{ file: 'CLAUDE.md', moment: '' }] }))).toEqual(['boot:DSH', 'recall:ALL'])
    expect(tags(book({ readers: ['app'], recall: [{ file: 'app/CLAUDE.md', moment: '' }] }))).toEqual(['boot:AP'])
    expect(tags(book({ recall: [{ file: 'app/CLAUDE.md', moment: '' }] }))).toEqual(['recall:AP'])
  })
  it('a Recall row no agent starts under is OD; nothing = optional (no tag)', () => {
    expect(tags(book({ recall: [{ file: 'platform/feeds/hl/CLAUDE.md', moment: '' }] }))).toEqual(['demand:OD'])
    expect(tags(book({}))).toEqual([])
    expect(readerTags(book({ recall: [{ file: 'x', moment: '' }] }), null, AGENTS, mark).map(t => t.text)).toEqual(['?'])
  })
})

describe('spine labels never repeat along a shelf', () => {
  it('colliding short titles take what follows the dash', () => {
    const m = distinctLabels(['Field read - Etape', 'Field read - Order book heatmap', 'Acme - funding', 'The loop graph'])
    expect(m.get('Field read - Etape')).toBe('Etape')
    expect(m.get('Field read - Order book heatmap')).toBe('Order book heatmap')
    expect(m.get('Acme - funding')).toBe('Acme')
    expect(m.get('The loop graph')).toBe('The loop graph')
  })
})

describe('the live library: every shelf that names topics is fully and soundly tagged', () => {
  const shelves = deriveShelves(FUND, [])
  const books = scanBooks(FUND, shelves)
  for (const s of shelves.filter(x => x.topics)) {
    it(`${s.id}: a sound list, and every book on it passes`, () => {
      expect(vocabFaults(s.topics!, s.id)).toEqual([])
      const bad = books.filter(b => b.shelf === s.id).map(b => [b.path, topicFault(b.topics, s.topics!)]).filter(([, f]) => f)
      expect(bad).toEqual([])
    })
  }
  it('at least the four app shelves name a list', () => {
    expect(shelves.filter(s => s.topics).map(s => s.id).sort()).toEqual(expect.arrayContaining(['app', 'law', 'platform', 'research']))
  })
})
