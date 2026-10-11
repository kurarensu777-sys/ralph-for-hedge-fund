import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GRACE_MS, MAX_AUTO, MAX_AUTO_PER_DAY, eligible, holdReason, pickupsSince, resetAutoState, tick, type AutoDeps, type ChatLook } from '../server/board/auto.ts'
import {
  cleanBlockers, createItem, filterItems, listItems, openBlockers, parseItem, rankNext, readItem, serializeItem, splitBody, updateItem, writeItem,
} from '../server/board/store.ts'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-auto-')); resetAutoState() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const AGENTS = [{ id: 'fund', mode: 'active', dept: 'ceo' }, { id: 'platform', mode: 'active', dept: 'build' }, { id: 'execution', mode: 'dormant', dept: 'build' }]

const YES = () => true

function deps(over: Partial<AutoDeps> = {}, states: Record<string, ChatLook> = {}) {
  let n = 0
  const startChat = vi.fn(async (_a: string, _p: string, _t: string) => `c${++n}`)
  const chatState = vi.fn(async (id: string) => states[id] ?? 'live')
  const d: AutoDeps = { dir, agents: () => AGENTS, stopped: () => false, attested: YES, startChat, chatState, ...over }
  return { d, startChat, chatState, states }
}

const auto = (title: string, over: Record<string, unknown> = {}) =>
  createItem(dir, { title, status: 'ready', owner: 'fund', labels: ['auto'], ...over } as any)

describe('store: blocked_by + conversation', () => {
  it('an old file (no new fields) round-trips byte-identical and parses without them', () => {
    const raw = '---\ntitle: "old"\nstatus: ready\nkind: todo\nowner: fund\nfrom: you\npriority: p2\nlabels: []\ncreated: 2026-09-20T00:00:00Z\nupdated: 2026-09-20T00:00:00Z\n---\n\nbody\n'
    const it = parseItem(raw, 'B-0001')
    expect('blocked_by' in it).toBe(false)
    expect('conversation' in it).toBe(false)
    expect(serializeItem(it)).toBe(raw)
  })

  it('writes and reads both fields, and clears them back to absent', () => {
    const a = createItem(dir, { title: 'a' })
    const b = createItem(dir, { title: 'b', blocked_by: ['b-0001', 'B-0001'] } as any)
    expect(b.blocked_by).toEqual(['B-0001'])
    updateItem(dir, b.id, { conversation: 'abc-123' })
    const raw = readFileSync(join(dir, `${b.id}.md`), 'utf8')
    expect(raw).toContain('blocked_by: [B-0001]\nconversation: abc-123\n---')
    expect(readItem(dir, b.id)).toMatchObject({ blocked_by: ['B-0001'], conversation: 'abc-123' })
    const { changed } = updateItem(dir, b.id, { blocked_by: [], conversation: '' })
    expect(changed.sort()).toEqual(['blocked_by', 'conversation'])
    expect(readFileSync(join(dir, `${b.id}.md`), 'utf8')).not.toMatch(/blocked_by|conversation/)
    expect(a.id).toBe('B-0001')
  })

  it('blocked_by takes ids only and never itself', () => {
    expect(cleanBlockers('B-0003, b-0004 B-0003', 'B-0004')).toEqual(['B-0003'])
    expect(() => cleanBlockers(['nope'])).toThrow(/board ids/)
  })

  it('a blocker blocks until it is done; an unknown id blocks too', () => {
    const a = createItem(dir, { title: 'a' })
    const b = createItem(dir, { title: 'b', status: 'ready', owner: 'platform', blocked_by: [a.id, 'B-0099'] } as any)
    expect(openBlockers(b, listItems(dir))).toEqual([a.id, 'B-0099'])
    updateItem(dir, a.id, { status: 'done' })
    expect(openBlockers(readItem(dir, b.id), listItems(dir))).toEqual(['B-0099'])
    expect(rankNext(listItems(dir), 'platform', AGENTS)).toEqual([])
    updateItem(dir, b.id, { blocked_by: [a.id] })
    expect(rankNext(listItems(dir), 'platform', AGENTS).map(i => i.id)).toEqual([b.id])
  })

  it('from filter: an id, or "agents" for anything an agent filed', () => {
    createItem(dir, { title: 'mine', from: 'you' })
    createItem(dir, { title: 'theirs', from: 'platform' })
    createItem(dir, { title: 'fund', from: 'fund' })
    const all = listItems(dir)
    expect(filterItems(all, { from: 'agents' }).map(i => i.title)).toEqual(['theirs', 'fund'])
    expect(filterItems(all, { from: 'platform' }).map(i => i.title)).toEqual(['theirs'])
    expect(filterItems(all, { from: 'you' }).map(i => i.title)).toEqual(['mine'])
  })
})

describe('auto: who qualifies', () => {
  it('needs ready + auto + an active agent owner + no open blockers', () => {
    const ok = auto('ok')
    const noLabel = createItem(dir, { title: 'x', status: 'ready', owner: 'fund' })
    const backlog = auto('x', { status: 'backlog' })
    const you = auto('x', { owner: 'you' })
    const dormant = auto('x', { owner: 'execution' })
    const ghost = auto('x', { owner: 'nobody' })
    const blocked = auto('x', { blocked_by: [backlog.id] })
    const items = listItems(dir)
    expect(eligible(items, AGENTS, YES).map(i => i.id)).toEqual([ok.id])
    const why = (id: string) => holdReason(items.find(i => i.id === id)!, items, AGENTS, YES)
    expect(why(noLabel.id)).toBe('not auto')
    expect(why(backlog.id)).toBe('status backlog')
    expect(why(you.id)).toBe('no agent owner')
    expect(why(dormant.id)).toBe('execution is dormant')
    expect(why(ghost.id)).toBe('no agent nobody')
    expect(why(blocked.id)).toBe(`blocked by ${backlog.id}`)
  })
  it('NOW work: an item one agent files for ANOTHER runs without the owner, attested or not; never one for itself', () => {
    const byAgent = auto('x', { from: 'platform' })          // platform instructs fund (the owner here)
    const forSelf = auto('x', { from: 'fund' })
    const stranger = auto('x', { from: 'somebody' })
    const items = listItems(dir)
    const NO = () => false
    expect(eligible(items, AGENTS, NO).map(i => i.id)).toEqual([byAgent.id])
    expect(holdReason(items.find(i => i.id === byAgent.id)!, items, AGENTS, NO)).toBeNull()
    expect(holdReason(items.find(i => i.id === forSelf.id)!, items, AGENTS, YES)).toBe('filed by fund for itself')
    expect(holdReason(items.find(i => i.id === stranger.id)!, items, AGENTS, YES)).toBe('filed by somebody, not an agent on the roster')
  })
  it('BACKLOG: an agent\'s item that is not ready + auto never starts, and now work still waits on its blockers', () => {
    const back = createItem(dir, { title: 'later', owner: 'fund', from: 'platform' })          // default: backlog
    const readyNoLabel = createItem(dir, { title: 'r', owner: 'fund', from: 'platform', status: 'ready' })
    const blocked = auto('x', { from: 'platform', blocked_by: [back.id] })
    const items = listItems(dir)
    const why = (id: string) => holdReason(items.find(i => i.id === id)!, items, AGENTS, () => false)
    expect(why(back.id)).toBe('not auto')
    expect(why(readyNoLabel.id)).toBe('not auto')
    expect(why(blocked.id)).toBe(`blocked by ${back.id}`)
  })
  it('the owner\'s own item, and an agent\'s item he chose on, still need his attested word', () => {
    const mine = auto('x', { from: 'you' })
    const made = auto('x', { from: 'platform' })
    writeItem(dir, { ...readItem(dir, made.id), chosen: 'go' })     // createItem takes no `chosen`: set it as chooseItem does
    const chosen = readItem(dir, made.id)
    expect(chosen.chosen).toBe('go')
    const items = listItems(dir)
    const why = (id: string) => holdReason(items.find(i => i.id === id)!, items, AGENTS, () => false)
    expect(why(mine.id)).toMatch(/not attested/)
    expect(why(chosen.id)).toMatch(/the choice go is not attested/)
  })
})

describe('auto: the daily cap', () => {
  it('stops picking up once MAX_AUTO_PER_DAY pickups started today', async () => {
    const today = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    for (let k = 0; k < MAX_AUTO_PER_DAY; k++) {
      createItem(dir, { title: `done ${k}`, status: 'done', owner: 'fund', labels: ['auto'], body: `### ${today} - fundd\n\nauto: picked up for fund; starting a conversation\n` } as any)
    }
    expect(pickupsSince(listItems(dir), Date.now() - 86_400_000)).toBe(MAX_AUTO_PER_DAY)
    auto('waiting')
    const { d, startChat } = deps()
    const r = await tick(d)
    expect(r.picked).toEqual([])
    expect(r.held).toBe(`${MAX_AUTO_PER_DAY} pickups today`)
    expect(startChat).not.toHaveBeenCalled()
  })
})

describe('auto: the daily cap is a setting (board.perDay)', () => {
  const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const seed = (n: number) => { for (let k = 0; k < n; k++) createItem(dir, { title: `done ${k}`, status: 'done', owner: 'fund', labels: ['auto'], body: `### ${stamp()} - fundd

auto: picked up for fund; starting a conversation
` } as any) }

  it('a raised perDay lets a pickup start past the default 10; the default still holds without it', async () => {
    seed(MAX_AUTO_PER_DAY)
    const it0 = auto('one more')
    const held = deps()
    expect((await tick(held.d)).held).toBe(`${MAX_AUTO_PER_DAY} pickups today`)
    expect(held.startChat).not.toHaveBeenCalled()
    resetAutoState()
    const raised = deps({ perDay: () => MAX_AUTO_PER_DAY + 5 })
    expect((await tick(raised.d)).picked).toEqual([it0.id])
  })

  it('a lowered perDay holds earlier and the held reason names the setting, not the default', async () => {
    seed(3)
    auto('waits')
    const { d, startChat } = deps({ perDay: () => 3 })
    expect((await tick(d)).held).toBe('3 pickups today')
    expect(startChat).not.toHaveBeenCalled()
  })
})

describe('auto: the tick', () => {
  it('picks up, claims first, stores the conversation and notes it', async () => {
    const a = auto('Reply ready', { body: 'Reply ready in this conversation, then stop' })
    const { d, startChat } = deps()
    const r = await tick(d)
    expect(r.picked).toEqual([a.id])
    expect(startChat).toHaveBeenCalledTimes(1)
    const [agent, prompt, title] = startChat.mock.calls[0]
    expect(agent).toBe('fund')
    expect(prompt).toContain('Reply ready in this conversation, then stop')
    expect(title).toBe(`${a.id} Reply ready`)
    const it = readItem(dir, a.id)
    expect(it.status).toBe('doing')
    expect(it.conversation).toBe('c1')
    expect(splitBody(it.body).notes.map(n => n.who)).toEqual(['fundd', 'fundd'])
  })

  it('never runs more than MAX_AUTO at once, priority first', async () => {
    const low = auto('low', { priority: 'p2' })
    const hi = auto('hi', { priority: 'p0' })
    const mid = auto('mid', { priority: 'p1' })
    const { d, startChat } = deps()
    const r = await tick(d)
    expect(MAX_AUTO).toBe(2)
    expect(r.picked).toEqual([hi.id, mid.id])
    expect((await tick(d)).picked).toEqual([])                // both still live
    expect(startChat).toHaveBeenCalledTimes(2)
    expect(readItem(dir, low.id).status).toBe('ready')
  })

  it('does nothing while floor/STOP exists', async () => {
    const a = auto('a')
    const { d, startChat } = deps({ stopped: () => true })
    const r = await tick(d)
    expect(r.held).toBe('floor/STOP')
    expect(startChat).not.toHaveBeenCalled()
    expect(readItem(dir, a.id).status).toBe('ready')
  })

  it('moves an item still in doing to review when its conversation ends, and frees the slot', async () => {
    const a = auto('a'); const b = auto('b'); const c = auto('c')
    const { d, states } = deps()
    await tick(d)                                              // a, b running as c1, c2
    states.c1 = 'live'; await tick(d)                          // seen working
    states.c1 = 'idle'
    const r = await tick(d)
    expect(r.ended).toEqual([a.id])
    expect(r.picked).toEqual([c.id])
    const it = readItem(dir, a.id)
    expect(it.status).toBe('review')
    expect(splitBody(it.body).notes.at(-1)!.text).toMatch(/c1 ended \(idle\).*review/)
    expect(readItem(dir, b.id).status).toBe('doing')
  })

  it('leaves the item alone if the agent already moved it', async () => {
    const a = auto('a')
    const { d, states } = deps()
    await tick(d)
    states.c1 = 'live'; await tick(d)
    updateItem(dir, a.id, { status: 'review' })
    states.c1 = 'idle'
    const r = await tick(d)
    expect(r.ended).toEqual([])
    expect(splitBody(readItem(dir, a.id).body).notes).toHaveLength(2)
  })

  it('an idle conversation never seen working is given a grace period; unknown keeps the slot', async () => {
    let t = 1_000_000
    const a = auto('a')
    const { d, states } = deps({ now: () => t })
    await tick(d)
    states.c1 = 'idle'
    expect((await tick(d)).ended).toEqual([])
    states.c1 = 'unknown'; t += GRACE_MS * 2
    expect((await tick(d)).running).toEqual([a.id])
    states.c1 = 'closed'
    expect((await tick(d)).ended).toEqual([a.id])
  })

  it('a start that fails parks the item in needs-you with the reason', async () => {
    const a = auto('a')
    const { d } = deps({ startChat: async () => { throw new Error('Fund is dormant') } })
    const r = await tick(d)
    expect(r.failed).toEqual([a.id])
    const it = readItem(dir, a.id)
    expect(it.status).toBe('needs-you')
    expect(it.conversation).toBeUndefined()
    expect(splitBody(it.body).notes.at(-1)!.text).toMatch(/Fund is dormant/)
    expect((await tick(d)).picked).toEqual([])                // not retried
  })

  it('never picks a blocked item until the blocker is done', async () => {
    const first = createItem(dir, { title: 'first' })
    const b = auto('b', { blocked_by: [first.id] })
    const { d } = deps()
    expect((await tick(d)).picked).toEqual([])
    updateItem(dir, first.id, { status: 'done' })
    expect((await tick(d)).picked).toEqual([b.id])
  })

  it('a file edited by hand with a conversation field survives parsing', () => {
    const f = join(dir, 'B-0001.md')
    writeFileSync(f, '---\ntitle: "x"\nstatus: doing\nlabels: [auto]\nconversation: "abc def"\nblocked_by: [B-0002, junk]\n---\n')
    const it = readItem(dir, 'B-0001')
    expect(it.conversation).toBe('abc def')
    expect(it.blocked_by).toEqual(['B-0002'])
  })
})
