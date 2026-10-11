import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BoardError, archiveDir, createItem, listAllItems, listItems, openBlockers, rankNext, readAnyItem, readItem,
  updateItem,
} from '../server/board/store.ts'

// B-0079: the weekly archive (board.mjs archive) MOVES done items into <board>/done/. Everything that
// reasons about an id - the next number, an item's blockers, a read by id - must still see them, and
// the room's list must not. Each case below is what the first archive run would have broken.
let dir = ''
const archive = (id: string) => { mkdirSync(archiveDir(dir), { recursive: true }); renameSync(join(dir, `${id}.md`), join(archiveDir(dir), `${id}.md`)) }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-archive-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the board sees its archive', () => {
  it('an archived number is never handed out again', () => {
    createItem(dir, { title: 'one' })
    const two = createItem(dir, { title: 'two', status: 'done' })
    archive(two.id)                                                  // the highest number leaves the live board
    expect(createItem(dir, { title: 'three' }).id).toBe('B-0003')    // live-only numbering would say B-0002 again
  })

  it('an archived blocker is done, not unknown', () => {
    const blocker = createItem(dir, { title: 'blocker', status: 'done' })
    const item = createItem(dir, { title: 'waits', status: 'ready', owner: 'app', blocked_by: [blocker.id] })
    archive(blocker.id)
    expect(openBlockers(item, listItems(dir))).toEqual([blocker.id])   // the bug: live-only reads it as unknown
    expect(openBlockers(item, listAllItems(dir))).toEqual([])
    expect(rankNext(listAllItems(dir), 'app', [{ id: 'app', dept: '' }]).map(i => i.id)).toEqual([item.id])
  })

  it('the room lists the live board only; an id still opens from the archive, read-only', () => {
    const a = createItem(dir, { title: 'kept' })
    const b = createItem(dir, { title: 'archived', status: 'done' })
    archive(b.id)
    expect(listItems(dir).map(i => i.id)).toEqual([a.id])
    expect(listAllItems(dir).map(i => i.id)).toEqual([a.id, b.id])
    expect(readAnyItem(dir, b.id).title).toBe('archived')
    expect(() => readItem(dir, b.id)).toThrow(BoardError)                   // a write path cannot reach it...
    expect(() => updateItem(dir, b.id, { status: 'ready' })).toThrow(BoardError)   // ...so nothing revives it
    expect(() => readAnyItem(dir, 'B-0099')).toThrow(BoardError)
  })
})

describe('a refused create reserves nothing', () => {
  it('a bad blocked_by is refused before a number is taken, so no blank item is left behind', () => {
    createItem(dir, { title: 'one' })
    expect(() => createItem(dir, { title: 'bad', blocked_by: ['none'] })).toThrow(BoardError)
    expect(listItems(dir).map(i => i.id)).toEqual(['B-0001'])                  // no empty B-0002 reserved
    expect(createItem(dir, { title: 'two' }).id).toBe('B-0002')
  })
})
