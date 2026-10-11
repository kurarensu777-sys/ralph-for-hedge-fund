import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { BOOK_TYPES, chapterOf, chaptersOf, parentOf, slugOf, splitRef, typeFault, typeOf } from '../shared/bookmeta.ts'
import { audit, citationRefs, citations, recallCitations } from '../server/library/links.ts'
import { recallIndex, recallTable } from '../server/library/need.ts'
import { scanBooks } from '../server/library/scan.ts'
import { readersOf } from '../server/library/core.ts'

// LIBRARY CHAPTERS (B-0345): a `## ` heading is a chapter, addressed `<book>.md#<slug>`; a boot list and a
// Recall row may name one. The grammar, the boot of exactly one chapter, the dead-anchor audit (broken once on
// purpose: a renamed heading), the reader counts, the scan's chapters, type / parent, and the guard's type rule.

// the scratch fund root is set BEFORE the imports below evaluate (server/paths.ts reads FUND_ROOT once)
const { TMP, ROOT } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs'), { tmpdir } = require('node:os'), { join } = require('node:path')
  const TMP = mkdtempSync(join(tmpdir(), 'lib-chapters-'))
  const ROOT = join(TMP, 'fund')
  process.env.FUND_ROOT = ROOT
  process.env.FUND_DATA_DIR = join(TMP, 'data')
  return { TMP, ROOT }
})
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const put = (rel: string, text: string) => { mkdirSync(join(ROOT, rel, '..'), { recursive: true }); writeFileSync(join(ROOT, rel), text) }

const HOW = `---
topics: [rules]
type: guide
---

# How we work

Intro, before any chapter.

## Who writes where

Read when: about to commit, or to ask another agent for a change

Every agent writes only inside its \`writes\`.

### A sub-heading stays inside its chapter

\`\`\`
## not a heading, it is fenced
\`\`\`

## The sync law
Read when: about to push

Pull before you write.
`

describe('the grammar (shared/bookmeta.ts)', () => {
  it('slugOf: lower-cased, every run of non-alphanumerics one -, trimmed', () => {
    expect(slugOf('Who writes where')).toBe('who-writes-where')
    expect(slugOf('  The sync law - (v2)!  ')).toBe('the-sync-law-v2')
    expect(slugOf('A/B  C')).toBe('a-b-c')
  })

  it('splitRef: <book>.md#<slug>; anything else is the whole ref and no slug', () => {
    expect(splitRef('app/library/law/how-we-work.md#who-writes-where')).toEqual({ path: 'app/library/law/how-we-work.md', slug: 'who-writes-where' })
    expect(splitRef('a/b.md')).toEqual({ path: 'a/b.md', slug: null })
    expect(splitRef('a/b.md#')).toEqual({ path: 'a/b.md', slug: null })
    expect(splitRef('a#b/c.md')).toEqual({ path: 'a#b/c.md', slug: null })   // a # in a folder name is not a chapter
    expect(splitRef('a/_series.md#x')).toEqual({ path: 'a/_series.md', slug: 'x' })
  })

  it('chaptersOf: a ## heading to the next ## or the end; ### and fenced ## are not chapters; the intro is none', () => {
    const cs = chaptersOf(HOW)
    expect(cs.map(c => [c.slug, c.title, c.readWhen])).toEqual([
      ['who-writes-where', 'Who writes where', 'about to commit, or to ask another agent for a change'],
      ['the-sync-law', 'The sync law', 'about to push'],
    ])
    expect(cs[0].text.startsWith('## Who writes where\n')).toBe(true)
    expect(cs[0].text).toContain('### A sub-heading stays inside its chapter')
    expect(cs[0].text).toContain('## not a heading, it is fenced')
    expect(cs[0].text).not.toContain('The sync law')
    expect(cs[1].text).toBe('## The sync law\nRead when: about to push\n\nPull before you write.\n')
    expect(chaptersOf('# only a title\n\ntext\n')).toEqual([])
  })

  it('chapterOf: the named chapter, null when no heading has the slug (the first wins when a slug repeats)', () => {
    expect(chapterOf(HOW, 'the-sync-law')?.title).toBe('The sync law')
    expect(chapterOf(HOW, 'nope')).toBeNull()
    expect(chapterOf('## A\none\n## a\ntwo\n', 'a')?.text).toBe('## A\none\n')
    expect(chapterOf(HOW.replace(/\n/g, '\r\n'), 'the-sync-law')?.readWhen).toBe('about to push')   // CRLF files
  })

  it('a chapter with no Read-when line has an empty one; a Read-when later than the first non-empty line does not count', () => {
    expect(chaptersOf('## A\n\ntext\nRead when: late\n')[0].readWhen).toBe('')
  })

  it('typeOf / parentOf / typeFault: the frontmatter only; a type off the list is named', () => {
    const fm = (body: string) => `---\ntopics: [x]\n${body}\n---\n\n# B\n`
    expect(typeOf(HOW)).toBe('guide')
    expect(typeOf(fm('type: strategy\nparent: research'))).toBe('strategy')
    expect(parentOf(fm('type: strategy\nparent: research # the family'))).toBe('research')
    expect(parentOf(HOW)).toBeNull()
    expect(typeOf('# type: guide in the body\n')).toBeNull()
    for (const t of BOOK_TYPES) expect(typeFault(fm(`type: ${t}`)), t).toBeNull()
    expect(typeFault(fm(''))).toBeNull()
    expect(typeFault(fm('type: essay'))).toBe('type "essay" is not one of guide, strategy')
  })
})

describe('boot: exactly one chapter', () => {
  it('app/library/law/how-we-work.md#who-writes-where boots that chapter and nothing else, under its own header', async () => {
    put('app/library/law/how-we-work.md', HOW)
    const { bootBooks, systemAppend } = await import('../server/chat/launch.ts')
    const ref = 'app/library/law/how-we-work.md#who-writes-where'
    const a = { id: 't', name: 't', kind: 'standing', mode: 'active', dept: 'T', role: 'r', cwd: '.', writes: [], model: 'm', effort: 'e', boot: [ref] } as any
    const books = bootBooks(a)
    expect(books).toHaveLength(1)
    expect(books[0].path).toBe(ref)
    expect(books[0].text).toBe(chapterOf(HOW, 'who-writes-where')!.text.trimEnd())
    const sp = systemAppend(a, books)
    expect(sp).toContain(`# Boot book ${ref}\n\n## Who writes where\n`)
    expect(sp).toContain('Every agent writes only inside its `writes`.')
    expect(sp).not.toContain('Intro, before any chapter')     // the book's opening is not the chapter
    expect(sp).not.toContain('Pull before you write')         // nor is the next chapter
  })

  it('a slug naming no heading boots "(missing chapter)", loudly; a missing file stays "(missing on disk)"', async () => {
    const { bootBooks, systemAppend } = await import('../server/chat/launch.ts')
    const a = { id: 't', name: 't', kind: 'standing', mode: 'active', dept: 'T', role: 'r', cwd: '.', writes: [], model: 'm', effort: 'e',
      boot: ['app/library/law/how-we-work.md#renamed-away', 'app/library/law/gone.md#x', 'app/library/law/how-we-work.md'] } as any
    const books = bootBooks(a)
    expect(books.map(b => [b.text === null, b.missing])).toEqual([[true, 'chapter'], [true, 'disk'], [false, undefined]])
    const sp = systemAppend(a, books)
    expect(sp).toContain('# Boot book app/library/law/how-we-work.md#renamed-away\n\n(missing chapter)')
    expect(sp).toContain('# Boot book app/library/law/gone.md#x\n\n(missing on disk)')
    expect(books[2].text).toBe(HOW)                         // the bare path still boots the whole book
  })
})

describe('the scan carries chapters, type and parent', () => {
  it('chapters [{slug, title, readWhen, tokens}], each chapter\'s tokens its own slice', () => {
    put('app/library/law/_series.md', '# L\n\n| Book | Read when |\n|---|---|\n| `how-we-work.md` | about to work |\n')
    put('app/library/law/strat.md', '---\ntopics: [rules]\ntype: strategy\nparent: research\n---\n\n# S\n')
    const books = scanBooks(ROOT, [{ id: 'law', title: 'Law', dept: 'HQ', roots: ['app/library/law'] }])
    const how = books.find(b => b.path === 'app/library/law/how-we-work.md')!
    expect(how.type).toBe('guide')
    expect(how.parent).toBeNull()
    expect(how.chapters.map(c => [c.slug, c.title, c.readWhen])).toEqual([
      ['who-writes-where', 'Who writes where', 'about to commit, or to ask another agent for a change'],
      ['the-sync-law', 'The sync law', 'about to push'],
    ])
    for (const c of how.chapters) expect(c.tokens).toBe(Math.round(chapterOf(HOW, c.slug)!.text.length / 4))
    expect(how.chapters[0].tokens + how.chapters[1].tokens).toBeLessThan(how.tokens)
    const s = books.find(b => b.path === 'app/library/law/strat.md')!
    expect([s.type, s.parent, s.chapters]).toEqual(['strategy', 'research', []])
  })
})

describe('readers count per chapter', () => {
  it('a chapter ref is its own key; the book key holds every agent that boots the book whole or any chapter, once', () => {
    const m = readersOf([
      { id: 'a', boot: ['b.md#x', 'b.md#y', 'b.md'] },
      { id: 'c', boot: ['b.md#x'] },
      { id: 'd', boot: ['other.md'] },
    ] as any)
    expect(m.get('b.md#x')).toEqual(['a', 'c'])
    expect(m.get('b.md#y')).toEqual(['a'])
    expect(m.get('b.md')).toEqual(['a', 'c'])
    expect(m.get('other.md')).toEqual(['d'])
  })
})

describe('Recall rows keep the slug', () => {
  const claude = '# Law\n\n## Recall\n\n| The moment | Read |\n|---|---|\n| about to commit | `lib/how.md#who-writes-where` |\n| about to push | `lib/how.md` + `lib/how.md#the-sync-law` |\n'
  it('citationRefs keeps `#slug`; citations (the bare paths) drops it', () => {
    expect(citationRefs('see `a/b.md#c-d`, [x](e.md#f) and `g.md`.')).toEqual(['a/b.md#c-d', 'g.md', 'e.md#f'])   // code spans, then links
    expect(citations('see `a/b.md#c-d`, [x](e.md#f) and `g.md`.')).toEqual(['a/b.md', 'g.md', 'e.md'])
    expect(recallCitations(claude)).toEqual(['lib/how.md', 'lib/how.md', 'lib/how.md'])
    expect(recallCitations(claude, true)).toEqual(['lib/how.md#who-writes-where', 'lib/how.md', 'lib/how.md#the-sync-law'])
  })
  it('recallTable / recallIndex: the row cites the chapter, and the book carries a row per chapter it is cited at', () => {
    expect(recallTable(claude).map(r => r.cites)).toEqual([['lib/how.md#who-writes-where'], ['lib/how.md', 'lib/how.md#the-sync-law']])
    put('CLAUDE.md', claude)
    const idx = recallIndex(ROOT, ['CLAUDE.md'], p => p === 'lib/how.md')
    expect(idx.get('lib/how.md')).toEqual([
      { file: 'CLAUDE.md', moment: 'about to commit', chapter: 'who-writes-where' },
      { file: 'CLAUDE.md', moment: 'about to push' },
      { file: 'CLAUDE.md', moment: 'about to push', chapter: 'the-sync-law' },
    ])
  })
})

describe('the link audit: dead-anchor', () => {
  const SHELVES = [{ id: 'law', title: 'Law', dept: 'HQ', roots: ['lib'] }]
  const idx = '# S\n\n| Book | Read when |\n|---|---|\n| `how.md` | about to work |\n'
  const recall = (c: string) => `# Law\n\n## Recall\n\n| The moment | Read |\n|---|---|\n| before x | \`${c}\` |\n`
  const tree = (how: string, claude: string): string => {
    const root = mkdtempSync(join(TMP, 'audit-'))
    for (const [rel, text] of Object.entries({ 'CLAUDE.md': claude, 'lib/_series.md': idx, 'lib/how.md': how })) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
    return root
  }
  const agents = (...boot: string[]) => [{ id: 'fund', boot }]

  it('a boot ref and a Recall ref whose slug names a heading are no fault', () => {
    const root = tree(HOW, recall('lib/how.md#the-sync-law'))
    expect(audit(root, SHELVES, agents('lib/how.md#who-writes-where'))).toEqual([])
  })

  it('MUTATION (broken once on purpose): rename the chapter heading and the audit goes red, for a boot ref and a Recall ref', () => {
    const root = tree(HOW, recall('lib/how.md#the-sync-law'))
    const boot = agents('lib/how.md#who-writes-where')
    expect(audit(root, SHELVES, boot)).toEqual([])
    writeFileSync(join(root, 'lib/how.md'), HOW.replace('## Who writes where', '## Who may write where').replace('## The sync law', '## Syncing'))
    expect(audit(root, SHELVES, boot).map(r => [r.fault, r.path, r.target, r.agent])).toEqual([
      ['dead-anchor', 'app/agents/fund.md', 'lib/how.md#who-writes-where', 'fund'],
      ['dead-anchor', 'CLAUDE.md', 'lib/how.md#the-sync-law', undefined],
    ])
  })

  it('a ref to a book that is not there is dead-boot / dead-recall, not dead-anchor', () => {
    const root = tree(HOW, recall('lib/gone.md#x'))
    expect(audit(root, SHELVES, agents('lib/gone.md#x')).map(r => [r.fault, r.target])).toEqual([['dead-boot', 'lib/gone.md#x'], ['dead-recall', 'lib/gone.md'], ['unreached', null]])
  })

  it('a chapter ref still reaches its book (no unreached fault)', () => {
    const root = tree(HOW, '# Law\n')
    expect(audit(root, SHELVES, agents()).map(r => r.fault)).toContain('unreached')
    expect(audit(root, SHELVES, agents('lib/how.md#the-sync-law'))).toEqual([])
  })
})
