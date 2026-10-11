import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTROLS, modelSummary } from '../server/system/controls.ts'
import { DEFAULTS, docWithCap, parseControls, readControls, writeControls } from '../server/system/controlsfile.ts'
import { ceilings } from '../server/system/spend.ts'
import { wakeHeld } from '../server/proc/wake.ts'
import { MAX_AUTO, tick, resetAutoState, type AutoDeps } from '../server/board/auto.ts'
import { DEFAULTS as BOARD_DEFAULTS, MAX_AUTO_CEILING, parseConfig } from '../server/board/config.ts'
import { createItem } from '../server/board/store.ts'
import { parseTokens } from '../src/rooms/system/controls.tsx'

const APP = join(__dirname, '..')
let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'controls-')); resetAutoState() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the Controls page is held to the code', () => {
  const ui = readFileSync(join(APP, 'src/rooms/system/controls.tsx'), 'utf8')
  const serverSrc = (() => {
    const out: string[] = []
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) out.push(readFileSync(p, 'utf8')) } }
    walk(join(APP, 'server'))
    return out.join('\n')
  })()

  it('every control in the table has a row on the page (data-control) - and the page has no row the table lacks', () => {
    for (const c of CONTROLS) expect(ui, `${c.id} has no row`).toMatch(new RegExp(`data-control="${c.id}"|id="${c.id}"`))
    const onPage = [...ui.matchAll(/(?:data-control|<Row id)="(\w+)"/g)].map(m => m[1])
    expect([...new Set(onPage)].sort()).toEqual(CONTROLS.map(c => c.id).sort())
  })

  it('every writer the table names is a real route', () => {
    for (const c of CONTROLS) {
      const [method, path] = c.write.split(' ')
      expect(serverSrc, `${c.id}: ${c.write} is not registered`).toContain(`.${method.toLowerCase()}('${path}'`)
    }
  })

  it('the page is the System room\'s default view, and the first tab', () => {
    const idx = readFileSync(join(APP, 'src/rooms/system/index.tsx'), 'utf8')
    expect(idx).toMatch(/const VIEWS = \[\{ id: 'controls'/)
    expect(idx).toMatch(/: 'controls'\) as View/)
  })
})

describe('app/controls.json', () => {
  it('no file = wakes on and no cap (what the fund did before the page)', () => {
    expect(readControls(join(dir, 'nope.json'))).toEqual(DEFAULTS)
    expect(DEFAULTS).toMatchObject({ wakes: true, tokenCap: null })
  })

  it('writes one key at a time and keeps the $comment; a cap must be a positive whole number', () => {
    const f = join(dir, 'controls.json')
    writeFileSync(f, JSON.stringify({ $comment: 'keep me', wakes: true, tokenCap: null }))
    writeControls(f, { tokenCap: 5_000_000 })
    writeControls(f, { wakes: false })
    expect(readControls(f)).toEqual({ wakes: false, tokenCap: 5_000_000, source: 'controls.json' })
    expect(JSON.parse(readFileSync(f, 'utf8')).$comment).toBe('keep me')
    expect(parseControls({ tokenCap: -5 }, null).tokenCap).toBeNull()
    expect(parseControls({ tokenCap: 'lots' }, null).tokenCap).toBeNull()
    expect(parseControls({ tokenCap: 12.6 }, null).tokenCap).toBe(13)
    writeFileSync(f, '{ not json')
    expect(readControls(f)).toEqual(DEFAULTS)
  })

  it('the cap reaches an agent as the fallback ceiling, and an agent\'s own ceiling still wins', () => {
    const headers = [{ id: 'fund' }, { id: 'app', budgetTokensPerDay: 100 }]
    expect(ceilings(docWithCap(headers, 5000)).byAgent).toEqual({ fund: 5000, app: 100 })
    expect(ceilings(docWithCap(headers, null)).byAgent).toEqual({ fund: null, app: 100 })   // no cap = no ceiling, never invented
  })
})

describe('dashboard wakes', () => {
  it('held by floor/STOP, held by the switch, and open only when neither', () => {
    expect(wakeHeld(true, true)).toMatch(/floor\/STOP/)
    expect(wakeHeld(false, false)).toMatch(/System > Controls/)
    expect(wakeHeld(true, false)).toMatch(/floor\/STOP/)
    expect(wakeHeld(false, true)).toBeNull()
  })
})

describe('the default model row', () => {
  it('says "all agents" only when they agree, else who differs from the commonest', () => {
    expect(modelSummary([{ id: 'a', model: 'm1' }, { id: 'b', model: 'm1' }])).toEqual({ model: 'm1', mixed: [] })
    expect(modelSummary([{ id: 'a', model: 'm1' }, { id: 'b', model: 'm1' }, { id: 'c', model: 'm2' }])).toEqual({ model: null, mixed: ['c'] })
    expect(modelSummary([])).toEqual({ model: null, mixed: [] })
  })
})

describe('the token box', () => {
  it('reads 5m, 250k, a plain number, and "none" as no cap; anything else is refused', () => {
    expect(parseTokens('5m')).toBe(5_000_000)
    expect(parseTokens(' 250K ')).toBe(250_000)
    expect(parseTokens('1,200,000')).toBe(1_200_000)
    expect(parseTokens('')).toBeNull()
    expect(parseTokens('none')).toBeNull()
    expect(parseTokens('lots')).toBeUndefined()
    expect(parseTokens('0')).toBeUndefined()
    expect(parseTokens('-5')).toBeUndefined()
  })
})

describe('board pickup: how many at once', () => {
  it('the setting is clamped to 1 .. the ceiling, and defaults to MAX_AUTO', () => {
    expect(BOARD_DEFAULTS.max).toBe(MAX_AUTO)
    expect(parseConfig({ max: 0 }, null).max).toBe(1)
    expect(parseConfig({ max: 99 }, null).max).toBe(MAX_AUTO_CEILING)
    expect(parseConfig({ max: 3 }, null).max).toBe(3)
    expect(parseConfig({ max: 'many' }, null).max).toBe(MAX_AUTO)
  })

  it('tick starts exactly as many as the box says (here 3 of 5 ready items), and says "N running" when full', async () => {
    for (let i = 0; i < 5; i++) createItem(dir, { title: `go ${i}`, status: 'ready', owner: 'fund', labels: ['auto'] } as any)
    let n = 0
    const d: AutoDeps = { dir, agents: () => [{ id: 'fund', mode: 'active' }], stopped: () => false, attested: () => true, max: () => 3, startChat: async () => `c${++n}`, chatState: async () => 'live' }
    const r = await tick(d)
    expect(r.picked).toHaveLength(3)
    expect((await tick(d)).held).toBe('3 running')
  })
})
