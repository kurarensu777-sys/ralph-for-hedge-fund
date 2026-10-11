import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent, Shelf } from '../shared/types.ts'
import type { Captured } from '../server/loop/capture.ts'
import { promoteDrafts, promotedTopics, shelfForLessons } from '../server/loop/rules.ts'

// B-0063: a promote lands on the shelf its lessons came from, not the role's first shelf
const agent = (id: string, writes: string[]): Agent => ({ id, name: id, kind: 'standing', mode: 'active', dept: 'Build', role: '', cwd: '.', writes, model: 'opus', effort: 'high', boot: [] })
const AGENTS = [
  agent('app', ['app/']),
  agent('platform', ['platform/api/data/', 'library/platform/', 'library/venues/']),
  agent('helper', ['app/']),
]
const shelf = (id: string, root: string): Shelf => ({ id, title: id, dept: 'Build', roots: [root] })
const LESSON = 'Stage explicit paths only when committing from a nested repo because the guard refuses staged paths outside the writes list'
const cap = (key: string, agentId: string, ts: number, source: 'inbox' | 'git' = 'inbox', ref = 'conv-1'): Captured =>
  ({ key, source, ts, agent: agentId, title: 'Stage explicit paths in a nested repo', text: LESSON, readWhen: null, ref, state: 'open' })

describe('promote routes by the lessons own scope', () => {
  const fundRoot = mkdtempSync(join(tmpdir(), 'loop-shelf-'))
  // app files 2 of the 3 lessons; platform files 1
  const three = [cap('inbox:1', 'app', 1), cap('inbox:2', 'platform', 2), cap('inbox:3', 'helper', 3)]

  it('app files 2 of 3 -> the book lands on library/app, not library/platform', () => {
    const shelves = [shelf('platform', 'library/platform'), shelf('feeds', 'library/feeds'), shelf('app', 'library/app')]
    // an app agent whose writes include the library/app shelf
    const agents = AGENTS.map(a => (a.id === 'platform' ? a : { ...a, writes: [...a.writes, 'library/app/'] }))
    const d = promoteDrafts(three, { fundRoot, agents, shelves, open: [] })
    expect(d).toHaveLength(1)
    expect(d[0].target[0]).toMatch(/^library\/app\/the-shared-lessons\//)
    expect(d[0].target[1]).toBe('library/app/the-shared-lessons/_series.md')
    expect(d[0].auto).toBe(true)
  })

  it('the platform shelf lives in the one library (app/library/platform, since 2026-09-26): it routes there and, a registered shelf root, can auto-apply (B-0069)', () => {
    const shelves = [shelf('craft', 'library/craft'), shelf('platform', 'app/library/platform'), shelf('app', 'app/library')]
    const agents = AGENTS.map(a => (a.id === 'platform' ? { ...a, writes: ['platform/fundplat/data/', 'app/library/platform/'] } : a))
    const items = [cap('inbox:1', 'platform', 1), cap('inbox:2', 'platform', 2), cap('inbox:3', 'app', 3)]
    const d = promoteDrafts(items, { fundRoot, agents, shelves, open: [] })
    expect(d[0].target[0]).toMatch(/^app\/library\/platform\/the-shared-lessons\//)
    expect(d[0].gates.find(g => g.name === 'rails')!.ok).toBe(true)
    expect(d[0].auto).toBe(true)
  })

  it('the app shelf lives in app/library, so it routes there and, a registered shelf root, can auto-apply (B-0069)', () => {
    const shelves = [shelf('platform', 'library/platform'), shelf('feeds', 'library/feeds'), shelf('app', 'app/library')]
    const d = promoteDrafts(three, { fundRoot, agents: AGENTS, shelves, open: [] })
    expect(d[0].target[0]).toMatch(/^app\/library\/the-shared-lessons\//)
    expect(d[0].gates.find(g => g.name === 'rails')!.ok).toBe(true)
    expect(d[0].auto).toBe(true)
  })

  it('platform majority -> library/platform (first platform shelf in the shelf order)', () => {
    const shelves = [shelf('platform', 'library/platform'), shelf('feeds', 'library/feeds'), shelf('app', 'library/app')]
    const items = [cap('inbox:1', 'platform', 1), cap('git:a:x', 'platform', 2, 'git', 'library/feeds/acme/x.md'), cap('inbox:3', 'app', 3)]
    // one git lesson sits on feeds: votes platform 1, feeds 1, app 1 -> tie -> first listed
    expect(shelfForLessons(items, 'Build', AGENTS, shelves)!.shelf.id).toBe('platform')
    const two = [cap('git:a:x', 'platform', 1, 'git', 'library/feeds/acme/x.md'), cap('git:b:y', 'app', 2, 'git', 'library/feeds/acme/y.md'), cap('inbox:3', 'app', 3)]
    // a git lesson's own book path outranks its author's writes
    expect(shelfForLessons(two, 'Build', AGENTS, shelves)!.shelf.id).toBe('feeds')
  })

  it('a promoted book carries the union of its source books\' topics, kept to the target shelf\'s list', () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-topics-'))
    const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text) }
    put('app/library/dashboards/carry/a.md', '---\ntopics: [guide, lesson]\n---\n\n# A\n')
    put('app/library/dashboards/vol/b.md', '---\ntopics: [lesson, bogus]\n---\n\n# B\n')
    put('app/library/dashboards/vol/c.md', '# C, no topics\n')
    const LIST = ['runbook', 'guide', 'design', 'lesson']
    const listed: Shelf = { ...shelf('dashboards', 'app/library/dashboards'), topics: LIST.map(id => ({ id, holds: id })) }
    const git = (k: string, a: string, ts: number, ref: string) => cap(k, a, ts, 'git', ref)
    const items = [git('git:a:x', 'app', 1, 'app/library/dashboards/carry/a.md'), git('git:b:y', 'helper', 2, 'app/library/dashboards/vol/b.md'), git('git:c:z', 'app', 3, 'app/library/dashboards/vol/c.md')]
    // lesson is carried twice, guide once; bogus is off the list
    expect(promotedTopics(items, LIST, root)).toEqual(['lesson', 'guide'])
    const [d] = promoteDrafts(items, { fundRoot: root, agents: AGENTS, shelves: [listed], open: [] })
    expect(d.gates.find(g => g.name === 'topics')).toEqual({ name: 'topics', ok: true, note: 'lesson, guide' })
    expect(d.body).toMatch(/~~~markdown\n---\ntopics: \[lesson, guide\]\n---\n\n# Stage explicit paths/)
    expect(d.auto).toBe(true)
    // no source book carries one: the promotion fails its topics gate, naming the list
    const inbox = [cap('inbox:1', 'app', 1), cap('inbox:2', 'helper', 2)]
    const agents = AGENTS.map(a => ({ ...a, writes: ['app/library/dashboards/'] }))
    const [e] = promoteDrafts(inbox, { fundRoot: root, agents, shelves: [listed], open: [] })
    expect(e.gates.find(g => g.name === 'topics')).toEqual({ name: 'topics', ok: false, note: "no source book carries a topic on dashboards's list (runbook, guide, design, lesson); set 1 to 3 by hand" })
    expect(e.auto).toBe(false)
    expect(e.body).toMatch(/~~~markdown\n# Stage explicit paths/)
    // a shelf with no list asks nothing
    const [f] = promoteDrafts(inbox, { fundRoot: root, agents, shelves: [shelf('dashboards', 'app/library/dashboards')], open: [] })
    expect(f.gates.find(g => g.name === 'topics')!.ok).toBe(true)
    expect(f.auto).toBe(true)
    expect(f.body).not.toMatch(/topics:/)
  })

  it('no lesson carries a scope -> the role\'s first library shelf, as before', () => {
    const shelves = [shelf('platform', 'library/platform')]
    const nobody = [agent('x', ['elsewhere/']), agent('y', [])]
    const items = [cap('inbox:1', 'x', 1), cap('inbox:2', 'y', 2)]
    expect(shelfForLessons(items, 'Build', nobody, shelves)!.root).toBe('library/platform')
  })
})
