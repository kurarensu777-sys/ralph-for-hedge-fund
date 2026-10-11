import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_AUTO_PER_DAY, chatsClient, resetAutoState, tick, type AutoDeps } from '../server/board/auto.ts'
import { DEFAULTS, MAX_AUTO_PER_DAY_CEILING, parseConfig, readConfig, writeConfig } from '../server/board/config.ts'
import { createItem, readItem } from '../server/board/store.ts'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-config-')); resetAutoState() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals() })

const file = () => join(dir, 'config.json')

describe('the board setting (app/board/config.json)', () => {
  it('no file = pickup on and the agent\'s own model (what the board did before)', () => {
    expect(readConfig(file())).toEqual(DEFAULTS)
    expect(DEFAULTS).toMatchObject({ auto: true, model: null, effort: null })
  })

  it('writes one key at a time and keeps the rest, the $comment included', () => {
    writeFileSync(file(), JSON.stringify({ $comment: 'keep me', board: { auto: true, model: 'claude-sonnet-5-5', effort: null } }))
    writeConfig(file(), { auto: false })
    expect(readConfig(file())).toEqual({ auto: false, model: 'claude-sonnet-5-5', effort: null, max: 2, perDay: MAX_AUTO_PER_DAY, source: 'config.json' })
    writeConfig(file(), { model: null, effort: 'high' })
    const j = JSON.parse(readFileSync(file(), 'utf8'))
    expect(j.$comment).toBe('keep me')
    expect(j.board).toEqual({ auto: false, model: null, effort: 'high' })
    writeConfig(file(), { max: 4 })
    expect(readConfig(file()).max).toBe(4)
  })

  it('an alias or a malformed id is never read as the model (the exact id only)', () => {
    writeFileSync(file(), JSON.stringify({ board: { model: 'sonnet' } }))
    expect(readConfig(file()).model).toBeNull()
    writeFileSync(file(), '{ not json')
    expect(readConfig(file())).toEqual(DEFAULTS)
  })

  it('perDay: absent = 10, above the ceiling clamps to 40, below 1 clamps to 1, junk reads as the default', () => {
    expect(MAX_AUTO_PER_DAY).toBe(10)
    expect(MAX_AUTO_PER_DAY_CEILING).toBe(40)
    expect(DEFAULTS.perDay).toBe(10)
    expect(parseConfig({}, null).perDay).toBe(10)
    expect(parseConfig({ perDay: 25 }, null).perDay).toBe(25)
    expect(parseConfig({ perDay: 400 }, null).perDay).toBe(40)
    expect(parseConfig({ perDay: 0 }, null).perDay).toBe(1)
    expect(parseConfig({ perDay: 'lots' }, null).perDay).toBe(10)
    writeFileSync(file(), JSON.stringify({ board: { perDay: 99 } }))
    expect(readConfig(file()).perDay).toBe(40)
    writeConfig(file(), { perDay: 20 })
    expect(readConfig(file()).perDay).toBe(20)
  })

  it('the committed file: Auto on, board work boots on each owner agent model', () => {
    const c = readConfig(join(__dirname, '..', 'board', 'config.json'))
    expect(c).toMatchObject({ auto: true, model: null, source: 'config.json' })
  })
})

describe('auto-pickup under the switch', () => {
  const base = (over: Partial<AutoDeps> = {}) => {
    const startChat = vi.fn(async () => 'c1')
    const d: AutoDeps = { dir, agents: () => [{ id: 'fund', mode: 'active' }], stopped: () => false, attested: () => true, startChat, chatState: async () => 'live', ...over }
    return { d, startChat }
  }

  it('Manual holds every pickup and says so; Auto picks the same item up', async () => {
    const it0 = createItem(dir, { title: 'go', status: 'ready', owner: 'fund', labels: ['auto'] } as any)
    const m = base({ manual: () => true })
    const r = await tick(m.d)
    expect(r.held).toBe('manual')
    expect(m.startChat).not.toHaveBeenCalled()
    expect(readItem(dir, it0.id).status).toBe('ready')
    const a = base({ manual: () => false })
    expect((await tick(a.d)).picked).toEqual([it0.id])
    expect(a.startChat).toHaveBeenCalledTimes(1)
  })

  it('the start request carries the board\'s model and effort, and neither when unset', async () => {
    const bodies: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'x' }), { status: 200 }) }))
    await chatsClient('http://h', () => ({ model: 'claude-sonnet-5-5', effort: 'medium' })).startChat('fund', 'p', 't')
    await chatsClient('http://h').startChat('fund', 'p', 't')
    expect(bodies[0]).toEqual({ agent: 'fund', prompt: 'p', title: 't', model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(bodies[1]).toEqual({ agent: 'fund', prompt: 'p', title: 't' })
  })
})
