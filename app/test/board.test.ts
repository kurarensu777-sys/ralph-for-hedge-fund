import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardItem } from '../shared/types.ts'
import {
  appendNote, claimItem, createItem, filterItems, listItems, parseItem, rankNext, readItem,
  serializeItem, splitBody, updateItem,
} from '../server/board/store.ts'

const base = (over: Partial<BoardItem> = {}): BoardItem => ({
  id: 'B-0001', title: 'A title', status: 'backlog', kind: 'todo', owner: '', from: 'you', priority: 'p2',
  labels: [], created: '2026-09-20T00:00:00Z', updated: '2026-09-20T00:00:00Z', body: '', ...over,
})

describe('frontmatter', () => {
  it('round-trips every field, awkward titles and labels included', () => {
    const item = base({
      title: 'Colons: "quotes", [brackets] - and a # hash',
      status: 'needs-you', kind: 'question', owner: 'dash:trade', from: 'platform', priority: 'p0',
      labels: ['urgent', 'data-loss', 'dept:build'],
      body: '## The ask\n\nDo the thing.\n\n### 2026-09-21T10:00:00Z - platform\n\nfirst note',
    })
    const text = serializeItem(item)
    expect(text.startsWith('---\ntitle: ')).toBe(true)
    expect(parseItem(text, 'B-0001')).toEqual(item)
    // idempotent
    expect(serializeItem(parseItem(text, 'B-0001'))).toBe(text)
  })

  it('writes exactly the nine fields in order', () => {
    const keys = serializeItem(base()).split('\n---')[0].split('\n').slice(1).map(l => l.split(':')[0])
    expect(keys).toEqual(['title', 'status', 'kind', 'owner', 'from', 'priority', 'labels', 'created', 'updated'])
  })

  it('reads CRLF, unquoted titles and quoted labels; defaults unknown enums', () => {
    const raw = '---\r\ntitle: plain: title here\r\nstatus: weird\r\nlabels: ["a", \'b\', c]\r\nowner:\r\n---\r\n\r\nbody line\r\n'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const x = parseItem(raw, 'B-0009')
    parseItem(raw, 'B-0009')
    expect(warn).toHaveBeenCalledTimes(1)   // never silent, and once per (item, field, value)
    expect(String(warn.mock.calls[0][0])).toMatch(/B-0009 status "weird" is not one of needs-you \| backlog/)
    warn.mockRestore()
    expect(x.title).toBe('plain: title here')
    expect(x.status).toBe('backlog')
    expect(x.labels).toEqual(['a', 'b', 'c'])
    expect(x.owner).toBe('')
    expect(x.body).toBe('body line')
  })

  it('splits the thinking from the notes thread', () => {
    const { text, notes } = splitBody('thinking\n\n### 2026-09-21T10:00:00Z - you\n\none\n\n### 2026-09-22T10:00:00Z - dash:trade\n\ntwo\nlines')
    expect(text).toBe('thinking')
    expect(notes).toEqual([
      { ts: '2026-09-21T10:00:00Z', who: 'you', text: 'one' },
      { ts: '2026-09-22T10:00:00Z', who: 'dash:trade', text: 'two\nlines' },
    ])
  })
})

describe('folder', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('numbers from the next free id and leaves no temp files', () => {
    writeFileSync(join(dir, 'B-0041.md'), serializeItem(base({ id: 'B-0041' })))
    const a = createItem(dir, { title: 'one' })
    const b = createItem(dir, { title: 'two', owner: 'platform', priority: 'p1' })
    expect([a.id, b.id]).toEqual(['B-0042', 'B-0043'])
    expect(readdirSync(dir).sort()).toEqual(['B-0041.md', 'B-0042.md', 'B-0043.md'])
    expect(readItem(dir, 'B-0043').owner).toBe('platform')
  })

  it('notes append newest last; claim refuses a foreign doing item', () => {
    const a = createItem(dir, { title: 'x', body: 'why' })
    appendNote(dir, a.id, 'you', 'first')
    const c = claimItem(dir, a.id, 'platform')
    expect(c.status).toBe('doing')
    expect(c.owner).toBe('platform')
    const notes = splitBody(readItem(dir, a.id).body).notes
    expect(notes.map(n => n.who)).toEqual(['you', 'platform'])
    expect(() => claimItem(dir, a.id, 'research')).toThrow(/being done by platform/)
    expect(claimItem(dir, a.id, 'platform').owner).toBe('platform')
    expect(readFileSync(join(dir, `${a.id}.md`), 'utf8')).toContain('why\n\n### ')
  })

  it('patch validates and reports what changed', () => {
    const a = createItem(dir, { title: 'x' })
    expect(() => updateItem(dir, a.id, { status: 'nope' })).toThrow(/status must be/)
    expect(updateItem(dir, a.id, { status: 'review', title: 'x' }).changed).toEqual(['status'])
    expect(filterItems(listItems(dir), { status: 'review' }).length).toBe(1)
    expect(filterItems(listItems(dir), { owner: '-' }).length).toBe(1)
  })
})

describe('next', () => {
  const agents = [{ id: 'platform', dept: 'Build' }, { id: 'app', dept: 'Build' }, { id: 'research', dept: 'Research' }]
  const items: BoardItem[] = [
    base({ id: 'B-0001', status: 'ready', owner: '', priority: 'p0', created: '2026-09-01T00:00:00Z' }),                        // open to all, p0
    base({ id: 'B-0002', status: 'ready', owner: 'platform', priority: 'p2', created: '2026-09-10T00:00:00Z' }),               // own
    base({ id: 'B-0003', status: 'ready', owner: 'platform', priority: 'p1', created: '2026-09-12T00:00:00Z' }),               // own, higher
    base({ id: 'B-0004', status: 'ready', owner: '', from: 'app', priority: 'p2', created: '2026-09-02T00:00:00Z' }),          // dept Build via filer
    base({ id: 'B-0005', status: 'ready', owner: '', from: 'research', priority: 'p0', created: '2026-09-01T00:00:00Z' }),     // other dept
    base({ id: 'B-0006', status: 'ready', owner: 'research', priority: 'p0' }),                                                // someone else's
    base({ id: 'B-0007', status: 'backlog', owner: 'platform', priority: 'p0' }),                                              // not ready
    base({ id: 'B-0008', status: 'ready', owner: '', labels: ['dept:build'], priority: 'p2', created: '2026-09-01T00:00:00Z' }), // dept label, older
  ]

  it('own ready first, then unassigned in its dept, then unassigned with no dept; priority then age', () => {
    expect(rankNext(items, 'platform', agents).map(i => i.id)).toEqual(['B-0003', 'B-0002', 'B-0008', 'B-0004', 'B-0001'])
  })

  it('another dept sees its own and the undepartmented ones only', () => {
    expect(rankNext(items, 'research', agents).map(i => i.id)).toEqual(['B-0006', 'B-0005', 'B-0001'])
  })

  it('an unknown agent gets only the open-to-all items', () => {
    expect(rankNext(items, 'ghost', agents).map(i => i.id)).toEqual(['B-0001'])
  })
})
