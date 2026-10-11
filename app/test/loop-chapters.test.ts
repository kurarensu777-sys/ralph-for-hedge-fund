import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Shelf } from '../shared/types.ts'
import { chapterGist, fromGit } from '../server/loop/capture.ts'
import { DEFAULTS, type LoopConfig } from '../server/loop/config.ts'
import { type Ctx, apply, applyGates, pass } from '../server/loop/engine.ts'
import { list, read } from '../server/loop/proposals.ts'
import { bookRoots, lessons, parseChapterLog } from '../server/loop/sources.ts'
import { withBoot, withoutBoot } from '../server/library/outcomes.ts'
import { db } from '../server/db.ts'
import { resetStore } from './pg/reset.ts'

// B-0347: the loop hears a chapter. A commit that APPENDS a `## ` chapter to a book is a lesson
// (captured once), and a promote of such lessons appends a chapter to the book (`book.md#slug`).
// A TEMP git repo and this file's own database, as in loop-engine.test.ts.

const DAY = 86_400_000
const T0 = Date.parse('2026-09-10T12:00:00Z')
const agent = (id: string, dept: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: id, kind: 'dashboard', mode: 'active', dept, role: 'r', cwd: '.', writes: [], model: 'sonnet', effort: 'low', boot: [], ...extra,
})
const AGENTS: Agent[] = [agent('dash:a', 'Dashboards'), agent('dash:b', 'Dashboards'), agent('fund', 'HQ', { kind: 'standing', writes: ['library/'] })]
const SHELVES: Shelf[] = [{ id: 'dashboards', title: 'Dashboards', dept: 'Dashboards', roots: ['library/dashboards'] }, { id: 'fund', title: 'Fund', dept: 'HQ', roots: ['library/fund'] }]
const BOOK = 'library/dashboards/app/the-book.md'

const LESSON_A = 'Acme candle endpoint keeps only the latest 5000 bars; archive the hourly candles daily or the history is lost for good.'
const LESSON_B = 'The Acme candle history is capped at 5000 bars per interval, so archive hourly candles every day or that history is lost for good.'

let dir: string
let clockAt = T0

function sh(args: string[], at?: number) {
  const date = at === undefined ? {} : { GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() }
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...date } })
}
const file = (rel: string) => join(dir, rel)
const text = () => readFileSync(file(BOOK), 'utf8')
function commit(who: string | null, subject: string, at: number) {
  sh(['add', '--', BOOK])
  sh(['commit', '-q', '-m', subject, ...(who ? ['-m', `Agent: ${who}`] : [])], at)
}
const chapter = (title: string, readWhen: string, body: string) => `\n## ${title}\n\nRead when: ${readWhen}\n\n${body}\n`

function ctx(cfg: Partial<LoopConfig> = {}): Ctx {
  return { db, fundRoot: dir, agents: AGENTS, shelves: SHELVES, repos: [{ id: 'fund', path: '.' } as any], config: { ...DEFAULTS, ...cfg }, now: () => clockAt }
}

const capturedChapters = async () => {
  const found = await lessons(dir, bookRoots([{ id: 'fund', path: '.' }], ['library/dashboards', 'library/fund']), null)
  expect(found.errors).toEqual([])
  return fromGit(dir, found.lessons, AGENTS).filter(c => c.ref.includes('#'))
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'loop-chapters-'))
  sh(['init', '-q', '-b', 'main'])
  sh(['config', 'user.email', 'loop@test'])
  sh(['config', 'user.name', 'loop test'])
  sh(['config', 'core.hooksPath', join(dir, '.nohooks')])
  sh(['config', 'core.autocrlf', 'false'])
  mkdirSync(file('library/dashboards/app'), { recursive: true })
  mkdirSync(file('library/fund'), { recursive: true })
  writeFileSync(file(BOOK), '# The book\n\n## First\n\nRead when: about to start\n\nbody one\n')
  writeFileSync(file('README.md'), 'temp fund\n')
  sh(['add', '--', '.'])
  sh(['commit', '-q', '-m', 'init'], T0 - 9 * DAY)
  await resetStore()
  clockAt = T0
})

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows file lock */ }
})

describe('parseChapterLog', () => {
  const log = (patch: string) => '\x1e' + 'a'.repeat(40) + '\n' + patch
  it('reads the ## headings a commit added per .md file, not ### and not other files', () => {
    const m = parseChapterLog(log('diff --git a/library/x/b.md b/library/x/b.md\n--- a/library/x/b.md\n+++ b/library/x/b.md\n@@ -3,0 +4,3 @@\n+## New one\n+Read when: x\n+### Not a chapter\ndiff --git a/lab/r.jsonl b/lab/r.jsonl\n--- a/lab/r.jsonl\n+++ b/lab/r.jsonl\n@@ -1 +1 @@\n+## ignored\n'), 'app')
    expect([...m.get('a'.repeat(40))!]).toEqual([['app/library/x/b.md', ['New one']]])
  })
  it('a heading that only rewords one removed in the same file is a rename, not a chapter', () => {
    const m = parseChapterLog(log('diff --git a/b.md b/b.md\n--- a/b.md\n+++ b/b.md\n@@ -5 +5 @@\n-## Candle history is capped\n+## The candle history cap\n@@ -9,0 +10,1 @@\n+## Unrelated rule about fees\n'), '')
    expect(m.get('a'.repeat(40))!.get('b.md')).toEqual(['Unrelated rule about fees'])
  })
})

describe('capture hears an appended chapter', () => {
  it('a commit that appends one chapter is captured exactly once, however often it is read', async () => {
    writeFileSync(file(BOOK), text() + chapter('Archive hourly candles daily', 'about to fetch Acme candles', LESSON_A))
    commit('dash:a', 'book: candle history cap', T0 - 3 * DAY)
    const first = await capturedChapters()
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ source: 'git', agent: 'dash:a', title: 'Archive hourly candles daily', readWhen: 'about to fetch Acme candles', ref: `${BOOK}#archive-hourly-candles-daily`, state: 'open' })
    expect(first[0].text).toBe(LESSON_A)
    expect(first[0].key).toMatch(/^git:[0-9a-f]{12}:library\/dashboards\/app\/the-book\.md#archive-hourly-candles-daily$/)
    expect((await capturedChapters()).map(c => c.key)).toEqual(first.map(c => c.key))
    // an edit of that chapter, or a rewording of its heading, is not a second lesson
    writeFileSync(file(BOOK), text().replace('lost for good.', 'lost for good (checked).'))
    commit('dash:a', 'book: tidy', T0 - 2 * DAY)
    expect((await capturedChapters()).map(c => c.key)).toEqual(first.map(c => c.key))
    writeFileSync(file(BOOK), text().replace('## Archive hourly candles daily', '## Archive the hourly candles daily'))
    commit('dash:a', 'book: reword the heading', T0 - 1 * DAY)
    // the old heading is gone from the tree (nothing left to promote under it) and the reword adds no second lesson
    expect(await capturedChapters()).toEqual([])
  })

  it('a commit that appends more than five chapters is a reorganization, not a lesson', async () => {
    writeFileSync(file(BOOK), text() + ['a', 'b', 'c', 'd', 'e', 'f'].map(n => chapter(`Rule ${n} about candles`, `about to do ${n}`, `${n} body`)).join(''))
    commit('dash:a', 'book: split', T0 - 3 * DAY)
    expect(await capturedChapters()).toEqual([])
  })

  it('a heading that is gone from the tree now is nothing to promote', () => {
    expect(chapterGist(dir, BOOK, 'No such chapter')).toBeNull()
    expect(chapterGist(dir, BOOK, 'First')).toMatchObject({ slug: 'first', readWhen: 'about to start', text: 'body one' })
  })
})

describe('promote appends a chapter (book.md#slug)', () => {
  async function proposed(): Promise<string> {
    writeFileSync(file(BOOK), text() + chapter('Archive hourly candles daily', 'about to fetch Acme candles', LESSON_A))
    commit('dash:a', 'book: candle history cap', T0 - 3 * DAY)
    writeFileSync(file(BOOK), text() + chapter('Acme candle history is capped', 'about to fetch candles', LESSON_B))
    commit('dash:b', 'book: candle cap again', T0 - 2 * DAY)
    const r = await pass(ctx(), 'manual')
    expect(r.errors).toEqual([])
    const promote = list(dir).proposals.find(p => p.kind === 'promote')!
    expect(promote).toBeTruthy()
    return promote.id
  }

  it('targets the book and the new slug alone: no new file, no _series.md row', async () => {
    const p = read(dir, await proposed())!
    expect(p.target).toEqual([`${BOOK}#shared-archive-hourly-candles-daily`])
    expect(p.auto).toBe(true)
    expect(p.gates.map(g => g.name)).toEqual(['rails', 'agents', 'new', 'house'])
    expect(applyGates(ctx(), p)).toEqual([])
  })

  it('apply appends the chapter in one commit of the book alone, with its Read when line, then refuses the slug a second time', async () => {
    const id = await proposed()
    const before = text()
    const p = await apply(ctx(), id, 'owner')
    expect(p.state).toBe('watching')
    expect(sh(['show', '--name-only', '--format=', p.commit!]).trim()).toBe(BOOK)
    const after = text()
    expect(after.startsWith(before.replace(/\s+$/, '') + '\n\n## Shared: Archive hourly candles daily\n\nRead when: about to fetch Acme candles')).toBe(true)
    expect(after).toContain('### dash:a - 2026-09-07')
    expect(after).toContain('### dash:b - 2026-09-08')
    expect(applyGates(ctx(), p).join(';')).toMatch(/already exists/)
  })

  it('refuses a slug that already exists, and a book that is not there', async () => {
    const id = await proposed()
    writeFileSync(file(BOOK), text() + chapter('Shared: Archive hourly candles daily', 'about to x', 'taken'))
    commit('fund', 'book: takes the slug', T0 - 1 * DAY)
    await expect(apply(ctx(), id, 'owner')).rejects.toThrow(/shared-archive-hourly-candles-daily already exists/)
    rmSync(file(BOOK))
    expect(applyGates(ctx(), read(dir, id)!).join(';')).toMatch(/is not there/)
  })
})

describe('retire takes a book\'s chapters out of boot and puts them back as they were', () => {
  const toggle = (agents: Agent[], id: string, path: string, on: boolean) => {
    const a = agents.find(x => x.id === id)!
    const has = (a.boot ?? []).includes(path)
    if (on === has) return { agents, changed: false }
    return { agents: agents.map(x => (x.id === id ? { ...x, boot: on ? [...(x.boot ?? []), path] : (x.boot ?? []).filter(p => p !== path) } : x)), changed: true }
  }
  it('whole-book and chapter refs both leave; each returns to its own shape', () => {
    const agents = [agent('a', 'X', { boot: ['b.md', 'c.md#one', 'c.md#two'] }), agent('d', 'X', { boot: ['c.md'] }), agent('e', 'X', { boot: ['other.md#one'] })]
    const out = withoutBoot(agents, 'c.md', toggle)
    expect(out.agents.map(a => a.boot)).toEqual([['b.md'], [], ['other.md#one']])
    expect(out.from).toEqual(['a', 'd'])
    expect(out.entries).toEqual(['a|one', 'a|two', 'd'])
    const back = withBoot(out.agents, 'c.md', out.entries, toggle)
    expect(back.agents.map(a => a.boot)).toEqual([['b.md', 'c.md#one', 'c.md#two'], ['c.md'], ['other.md#one']])
    expect(back.to).toEqual(['a', 'd'])
  })
  it('a mark written before chapters (plain agent ids) still restores the whole book', () => {
    const back = withBoot([agent('a', 'X', { boot: [] })], 'c.md', ['a', 'ghost'], toggle)
    expect(back.agents[0].boot).toEqual(['c.md'])
    expect(back.to).toEqual(['a'])
  })
})
