import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeAgentFile } from '../shared/agentfile.ts'
import { holdReason, resetAutoState, tick, type AutoDeps } from '../server/board/auto.ts'
import * as S from '../server/board/store.ts'

// An agent asks another agent to start an EXISTING item (board.mjs pickup B-NNNN, B-0421): ready + auto +
// asked_by + a note, then a tick. The asker stands where the filer would in holdReason; every bound stays.
const ROSTER = ['app', 'fund', 'platform']
const AGENTS = ROSTER.map(id => ({ id, mode: 'active' }))
const NOT = () => false   // nothing is attested as the owner's

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-pickup-')); resetAutoState() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const file = (extra: Record<string, unknown> = {}) =>
  S.createItem(dir, { title: 'old backlog item', status: 'backlog', owner: 'platform', from: 'you', ...extra } as any)
const why = (id: string, attested: (i: S.Item) => boolean = NOT) => holdReason(S.readItem(dir, id), S.listAllItems(dir), AGENTS, attested)

describe('pickupItem (the store)', () => {
  it('makes a backlog item ready + auto + asked_by and notes it as the asker', () => {
    const i = file()
    const got = S.pickupItem(dir, i.id, 'app', 'the owner wants it today', ROSTER)
    expect(got).toMatchObject({ status: 'ready', asked_by: 'app', owner: 'platform', from: 'you' })
    expect(got.labels).toContain(S.AUTO_LABEL)
    const back = S.readItem(dir, i.id)
    expect(back.asked_by).toBe('app')
    expect(S.splitBody(back.body).notes.at(-1)).toMatchObject({ who: 'app', text: 'asked platform to pick this up now: the owner wants it today' })
    expect(readFileSync(join(dir, `${i.id}.md`), 'utf8')).toContain('asked_by: app\n')
  })

  it("an asker that is the item's owner is refused: an agent never starts itself", () => {
    const i = file({ owner: 'app' })
    expect(() => S.pickupItem(dir, i.id, 'app', '', ROSTER)).toThrow(/never by starting itself/)
    expect(S.readItem(dir, i.id).status).toBe('backlog')
  })

  it('no asker (the owner has the Board room), an unknown asker and an owner who is no agent are refused', () => {
    const i = file()
    expect(() => S.pickupItem(dir, i.id, '', '', ROSTER)).toThrow(/only an agent asks/)
    expect(() => S.pickupItem(dir, i.id, 'you', '', ROSTER)).toThrow(/only an agent asks/)
    expect(() => S.pickupItem(dir, i.id, 'ghost', '', ROSTER)).toThrow(/not an agent on the roster/)
    const mine = file({ owner: 'you' })
    expect(() => S.pickupItem(dir, mine.id, 'app', '', ROSTER)).toThrow(/no agent owner/)
    const loose = file({ owner: '' })
    expect(() => S.pickupItem(dir, loose.id, 'app', '', ROSTER)).toThrow(/no agent owner/)
    expect(S.readItem(dir, i.id).status).toBe('backlog')
  })

  it('an item already doing, done or waiting on the owner is refused; a second pickup of a doing item too', () => {
    const i = file()
    S.pickupItem(dir, i.id, 'app', '', ROSTER)
    S.updateItem(dir, i.id, { status: 'doing' })
    expect(() => S.pickupItem(dir, i.id, 'fund', '', ROSTER)).toThrow(/is doing/)
    for (const status of ['done', 'needs-you'] as const) {
      const x = file({ status })
      expect(() => S.pickupItem(dir, x.id, 'app', '', ROSTER), status).toThrow(new RegExp(`is ${status}`))
    }
    expect(S.readItem(dir, i.id).status).toBe('doing')
  })

  it('a review item can be asked again; a blocked item is NOT refused', () => {
    const r = file({ status: 'review' })
    expect(S.pickupItem(dir, r.id, 'app', '', ROSTER).status).toBe('ready')
    const dep = file()
    const blocked = file({ blocked_by: [dep.id] })
    expect(S.pickupItem(dir, blocked.id, 'app', '', ROSTER).status).toBe('ready')
  })

  it('a new owner is a new hand: changing the owner drops asked_by', () => {
    const i = file()
    S.pickupItem(dir, i.id, 'app', '', ROSTER)
    S.updateItem(dir, i.id, { owner: 'fund' })
    expect('asked_by' in S.readItem(dir, i.id)).toBe(false)
  })
})

describe('holdReason with asked_by', () => {
  it("asked_by wins over from: you: an item the owner filed but never attested starts on an agent's ask", () => {
    const plain = file({ status: 'ready', labels: ['auto'] })
    expect(why(plain.id)).toMatch(/from: you is not attested/)          // the contrast: no ask, no start
    const asked = file()
    S.pickupItem(dir, asked.id, 'app', '', ROSTER)
    expect(why(asked.id)).toBeNull()
  })

  it('an asker that is not on the roster holds it, saying "asked", never "filed"', () => {
    const i = file()
    S.writeItem(dir, { ...S.readItem(dir, i.id), status: 'ready', labels: ['auto'], asked_by: 'ghost' })
    expect(why(i.id)).toBe('asked by ghost, not an agent on the roster')
  })

  it('an asker equal to the owner is held too (a hand-written asked_by cannot start itself)', () => {
    const i = file()
    S.writeItem(dir, { ...S.readItem(dir, i.id), status: 'ready', labels: ['auto'], asked_by: 'platform' })
    expect(why(i.id)).toBe('asked by platform for itself')
  })

  it('a blocked item holds with the blocker named, not refused', () => {
    const dep = file()
    const i = file({ blocked_by: [dep.id] })
    S.pickupItem(dir, i.id, 'app', '', ROSTER)
    expect(why(i.id)).toBe(`blocked by ${dep.id}`)
  })

  it('an item the owner chose an option on keeps its attested path, ask or no ask', () => {
    const i = file({ status: 'needs-you', from: 'platform', options: [{ id: 'go', label: 'Go' }] })
    S.writeItem(dir, { ...S.readItem(dir, i.id), status: 'ready', labels: ['auto'], chosen: 'go', asked_by: 'app' })
    expect(why(i.id)).toMatch(/the choice go is not attested/)
  })

  it('the bounds stay: a dormant owner and a spent cap hold an asked item', () => {
    const i = file()
    S.pickupItem(dir, i.id, 'app', '', ROSTER)
    const it = S.readItem(dir, i.id)
    expect(holdReason(it, S.listAllItems(dir), [{ id: 'app', mode: 'active' }, { id: 'platform', mode: 'dormant' }], NOT)).toBe('platform is dormant')
    expect(holdReason(it, S.listAllItems(dir), AGENTS, NOT, () => false)).toBe('capped')
  })
})

describe('tick starts an asked item, inside the same bounds', () => {
  const deps = (over: Partial<AutoDeps> = {}) => {
    const startChat = vi.fn(async (_a: string, _p: string, _t: string) => 'c1')
    const d: AutoDeps = { dir, agents: () => AGENTS, stopped: () => false, attested: NOT, startChat, chatState: async () => 'live', ...over }
    return { d, startChat }
  }

  it('starts it for its owner with the asker in the brief', async () => {
    const i = file()
    S.pickupItem(dir, i.id, 'app', '', ROSTER)
    const { d, startChat } = deps()
    expect((await tick(d)).picked).toEqual([i.id])
    expect(startChat.mock.calls[0][1]).toContain('on the request of app')
  })

  it('floor/STOP and Manual still hold it', async () => {
    const i = file()
    S.pickupItem(dir, i.id, 'app', '', ROSTER)
    const stopped = deps({ stopped: () => true })
    expect((await tick(stopped.d)).held).toBe('floor/STOP')
    expect(stopped.startChat).not.toHaveBeenCalled()
    const manual = deps({ manual: () => true })
    expect((await tick(manual.d)).held).toBe('manual')
    expect(manual.startChat).not.toHaveBeenCalled()
  })

  it('the day cap and the running cap do not hold it (B-0562)', async () => {
    const i = file()
    S.pickupItem(dir, i.id, 'app', '', ROSTER)
    const day = deps({ perDay: () => 0 })
    expect((await tick(day.d)).picked).toEqual([i.id])
    expect(day.startChat).toHaveBeenCalledTimes(1)
  })

  it('a full running cap does not hold it, and it starts ahead of an older, higher-priority unasked item', async () => {
    resetAutoState()
    const busy = [file(), file()].map(x => { S.writeItem(dir, { ...S.readItem(dir, x.id), status: 'doing', labels: ['auto'], conversation: `r-${x.id}` }); return x })
    const unasked = S.createItem(dir, { title: 'unasked p0', status: 'ready', owner: 'platform', from: 'app', priority: 'p0', labels: ['auto'] } as any)
    const asked = file({ priority: 'p2' })
    S.pickupItem(dir, asked.id, 'app', '', ROSTER)
    const { d, startChat } = deps({ max: () => 2 })
    const r = await tick(d)
    expect(busy.length).toBe(2)
    expect(r.picked).toEqual([asked.id])
    expect(r.held).toBe('2 running')                 // the unasked item still waits behind the cap
    expect(S.readItem(dir, unasked.id).status).toBe('ready')
    expect(startChat).toHaveBeenCalledTimes(1)
  })

  it('names what holds an asked item that did not start', async () => {
    const dep = file()
    const i = file({ blocked_by: [dep.id] })
    S.pickupItem(dir, i.id, 'app', '', ROSTER)
    const r = await tick(deps().d)
    expect(r.picked).toEqual([])
    expect(r.askedHeld[i.id]).toBe(`blocked by ${dep.id}`)
  })
})

// ---- the CLI ----
const TMP = mkdtempSync(join(tmpdir(), 'board-pickup-cli-'))
const ROOT = join(TMP, 'fund')
const BOARD = join(ROOT, 'app', 'board')
mkdirSync(BOARD, { recursive: true })
mkdirSync(join(ROOT, 'app', 'agents'), { recursive: true })
for (const id of ROSTER) {
  writeFileSync(join(ROOT, 'app', 'agents', `${id}.md`), serializeAgentFile({ id, name: id, kind: 'standing', mode: 'active', dept: 'x', role: 'r', cwd: '.', model: 'opus', effort: 'high', writes: [`${id}/`], boot: [] }, `# ${id}\n`))
}
const CLI = resolve(__dirname, '..', 'scripts', 'board.mjs')
const cli = (args: string[], port: number, agent: string | null) => new Promise<{ status: number | null; out: string; err: string }>(done => {
  const env: Record<string, string | undefined> = { ...process.env, FUND_ROOT: ROOT, FUND_BOARD_DIR: BOARD, FUNDD_PORT: String(port) }
  if (agent) env.FUND_AGENT = agent; else delete env.FUND_AGENT
  const p = spawn(process.execPath, [CLI, ...args], { env })
  let out = '', err = ''
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
  p.on('close', status => done({ status, out, err }))
})

let fundd: Server
let port = 0
const hits: string[] = []
beforeAll(async () => {
  fundd = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: { picked: [], held: '4 running' } }))
  })
  await new Promise<void>(r => fundd.listen(0, '127.0.0.1', r))
  port = (fundd.address() as AddressInfo).port
})
afterAll(() => { fundd.close(); rmSync(TMP, { recursive: true, force: true }) })

describe('board.mjs pickup', () => {
  it('readies an existing item for its owner, notes it, and asks fundd for a tick', async () => {
    const old = S.createItem(BOARD, { title: 'filed by the owner long ago', status: 'backlog', owner: 'platform', from: 'you' } as any)
    hits.length = 0
    const r = await cli(['pickup', old.id, '--note', 'owner wants it now'], port, 'app')
    expect(r.status).toBe(0)
    expect(hits).toEqual(['POST /api/board/auto/tick'])
    expect(r.out).toMatch(/waits for the board's next tick \(held: 4 running\)/)
    const got = S.readItem(BOARD, old.id)
    expect(got).toMatchObject({ status: 'ready', asked_by: 'app' })
    expect(got.labels).toContain('auto')
  })

  it("is refused for the owner's own shell (no FUND_AGENT) and for the item's own agent; nothing changes", async () => {
    const i = S.createItem(BOARD, { title: 'second', status: 'backlog', owner: 'platform', from: 'you' } as any)
    hits.length = 0
    const owner = await cli(['pickup', i.id], port, null)
    expect(owner.status).toBe(1)
    expect(owner.err).toMatch(/only an agent asks/)
    const self = await cli(['pickup', i.id], port, 'platform')
    expect(self.status).toBe(1)
    expect(self.err).toMatch(/never by starting itself/)
    expect(hits).toEqual([])
    expect(S.readItem(BOARD, i.id).status).toBe('backlog')
  })

  it('a second pickup of a doing item is refused', async () => {
    const i = S.createItem(BOARD, { title: 'third', status: 'backlog', owner: 'platform', from: 'you' } as any)
    expect((await cli(['pickup', i.id], port, 'app')).status).toBe(0)
    S.updateItem(BOARD, i.id, { status: 'doing' })
    const again = await cli(['pickup', i.id], port, 'fund')
    expect(again.status).toBe(1)
    expect(again.err).toMatch(/is doing/)
  })
})
