import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ceoOrder, dueLabel, dueTone, localDay, parseQuickAdd } from '../shared/ceo.ts'
import { BoardError, createItem, listItems } from '../server/board/store.ts'
import { ceoFiler, ceoPrompt, createCeo, ensureChat, listCeo, noteCeo, parseCeo, readCeo, serializeCeo, setConversation, updateCeo } from '../server/board/ceo.ts'

// the plan windows persist under the data dir: a throwaway one, set before the module reads the path
process.env.FUND_DATA_DIR = join(mkdtempSync(join(tmpdir(), 'ceo-data-')), 'data')
const { windowOf, observe, readPlan, windowsFromUsage, probe, probeFailure } = await import('../server/chat/planlimit.ts')

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ceo-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const ceo = () => join(dir, 'ceo')

describe('the CEO store', () => {
  it('round-trips an issue, awkward title and the owner words included', () => {
    const i = createCeo(ceo(), { title: 'Decide: "go" / [no-go] - SR3', priority: 'p0', due: '2026-10-07', agent: 'research', from: 'app', told: 'file it, "please"' })
    const text = serializeCeo(i)
    expect(parseCeo(text, i.id)).toEqual(i)
    expect(serializeCeo(parseCeo(text, i.id))).toBe(text)
    expect(readCeo(ceo(), i.id)).toEqual(i)
  })

  it('numbers C-0001 upward and never reuses a number', () => {
    expect(createCeo(ceo(), { title: 'a' }).id).toBe('C-0001')
    expect(createCeo(ceo(), { title: 'b' }).id).toBe('C-0002')
    expect(listCeo(ceo()).map(i => i.id)).toEqual(['C-0001', 'C-0002'])
  })

  it('is a store the agents\' board never reads, and reads nothing the board holds', () => {
    createCeo(ceo(), { title: 'mine' })
    createItem(dir, { title: 'an agent item' })
    expect(listItems(dir).map(i => i.id)).toEqual(['B-0001'])          // the ceo/ folder is invisible to the board
    expect(listCeo(ceo()).map(i => i.title)).toEqual(['mine'])           // and the board's items are invisible here
  })

  it('refuses a bad title, priority, due and status', () => {
    expect(() => createCeo(ceo(), { title: '  ' })).toThrow(BoardError)
    expect(() => createCeo(ceo(), { title: 'x', priority: 'p9' })).toThrow(/priority/)
    expect(() => createCeo(ceo(), { title: 'x', due: 'tomorrow' })).toThrow(/due/)
    const i = createCeo(ceo(), { title: 'x' })
    expect(() => updateCeo(ceo(), i.id, { status: 'doing' })).toThrow(/status/)
    expect(() => readCeo(ceo(), 'B-0001')).toThrow(/not a CEO issue id/)
  })

  it('keeps ONE chat per issue: the agent is fixed once the chat exists, and the old id is noted when replaced', () => {
    const i = createCeo(ceo(), { title: 'x', agent: 'research' })
    expect(updateCeo(ceo(), i.id, { agent: 'app' }).item.agent).toBe('app')   // free until a chat starts
    updateCeo(ceo(), i.id, { agent: 'research' })
    setConversation(ceo(), i.id, 'c-1')
    expect(() => updateCeo(ceo(), i.id, { agent: 'app' })).toThrow(/one chat per issue/)
    expect(updateCeo(ceo(), i.id, { agent: 'research' }).changed).toEqual([])  // the same agent is no change
    const re = setConversation(ceo(), i.id, 'c-2')
    expect(re.conversation).toBe('c-2')
    expect(re.body).toContain('chat c-1 no longer exists')
  })

  it('stamps notes and done, and reads a file with no status as open', () => {
    const i = createCeo(ceo(), { title: 'x' })
    expect(noteCeo(ceo(), i.id, 'you', 'first').body).toContain('first')
    expect(updateCeo(ceo(), i.id, { status: 'done' }).changed).toEqual(['status'])
    writeFileSync(join(ceo(), 'C-0009.md'), '---\ntitle: "bare"\n---\n')
    expect(readCeo(ceo(), 'C-0009').status).toBe('open')
    expect(readFileSync(join(ceo(), `${i.id}.md`), 'utf8')).toContain('status: done')
  })
})

describe('who may file', () => {
  it('the cockpit files as you with no words', () => {
    expect(ceoFiler({ fromCockpit: true })).toEqual({ from: 'you', told: '' })
  })
  it('an agent files only with the owner\'s words, and the words are returned to be kept', () => {
    expect(() => ceoFiler({ fromCockpit: false, asAgent: 'research' })).toThrow(/told/)
    expect(() => ceoFiler({ fromCockpit: false, asAgent: 'research', told: '  ' })).toThrow(BoardError)
    expect(() => ceoFiler({ fromCockpit: false, told: 'do it' })).toThrow(BoardError)           // no name
    expect(() => ceoFiler({ fromCockpit: false, asAgent: 'you', told: 'do it' })).toThrow(BoardError)  // never signs as the owner
    expect(ceoFiler({ fromCockpit: false, asAgent: 'research', told: 'file it for me' })).toEqual({ from: 'research', told: 'file it for me' })
  })
})

describe('the chat prompt', () => {
  it('names the issue and says the list is the owner\'s', () => {
    const i = createCeo(ceo(), { title: 'Decide SR3', priority: 'p0', due: '2026-10-07', body: 'Gate is 50 bp.' })
    const p = ceoPrompt(i)
    expect(p).toContain('CEO issue C-0001: Decide SR3')
    expect(p).toContain('due 2026-10-07')
    expect(p).toContain('Gate is 50 bp.')
    expect(p).toContain('do not edit it and do not file items there')
  })
})

describe('order and due', () => {
  const mk = (id: string, priority: 'p0' | 'p1' | 'p2', due = '', created = '2026-10-01T00:00:00Z') => ({ id, priority, due, created })
  it('puts a chat waiting on you first, then p0, then the earliest due, then the newest', () => {
    const items = [mk('C-0001', 'p1'), mk('C-0002', 'p0', '2026-10-09'), mk('C-0003', 'p0', '2026-10-07'), mk('C-0004', 'p2'), mk('C-0005', 'p2', '', '2026-10-03T00:00:00Z')]
    const out = ceoOrder(items, i => (i.id === 'C-0004' ? 'waiting' : null)).map(i => i.id)
    expect(out).toEqual(['C-0004', 'C-0003', 'C-0002', 'C-0001', 'C-0005'])
  })
  it('reads a due date against the owner\'s day', () => {
    const now = new Date(2026, 9, 5, 12).getTime()
    expect(localDay(now)).toBe('2026-10-05')
    expect(dueTone('2026-10-04', now)).toBe('late')
    expect(dueTone('2026-10-05', now)).toBe('today')
    expect(dueTone('2026-10-08', now)).toBe('soon')
    expect(dueTone('2026-10-20', now)).toBe('')
    expect(dueTone('', now)).toBe('')
    expect(dueLabel('2026-10-05', now)).toBe('today')
    expect(dueLabel('', now)).toBe('')
  })
})

describe('the plan windows', () => {
  const now = 1_790_000_000_000
  it('reads a window event: utilization as a fraction, a reset in seconds as ms, anything else ignored', () => {
    expect(windowOf({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.62, resetsAt: 1_790_003_600 }, now))
      .toEqual({ id: 'five_hour', utilization: 0.62, raw: 0.62, resetsAt: 1_790_003_600_000, status: 'allowed', seenAt: now })
    expect(windowOf({ rateLimitType: 'seven_day_opus', utilization: 0.1 }, now)).toBeNull()
    expect(windowOf({}, now)).toBeNull()
  })
  it('does not draw a utilization outside 0..1 (a different scale is shown as unknown, the raw number kept)', () => {
    const w = windowOf({ rateLimitType: 'seven_day', utilization: 62 }, now)!
    expect(w.utilization).toBeNull()
    expect(w.raw).toBe(62)
  })
  it('marks a window stale once its reset has passed, and is empty before any event', () => {
    mkdirSync(dir, { recursive: true })
    const before = readPlan(now).windows.length
    observe({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: (now + 1000) / 1000 }, now)
    const w = readPlan(now).windows.find(x => x.id === 'five_hour')!
    expect(w.stale).toBe(false)
    expect(readPlan(now + 5000).windows.find(x => x.id === 'five_hour')!.stale).toBe(true)
    expect(before).toBeLessThanOrEqual(2)
  })
})

describe('the plan windows from /usage', () => {
  const now = 1_790_000_000_000
  it('turns percent used (0..100) into a fraction and the ISO reset into ms; a lacking window is absent', () => {
    const w = windowsFromUsage({ five_hour: { utilization: 3, resets_at: '2026-10-05T22:50:00.435950+00:00' }, seven_day: { utilization: 54, resets_at: '2026-10-10T06:00:00+00:00' } }, now)
    expect(w.map(x => [x.id, x.utilization, x.raw])).toEqual([['five_hour', 0.03, 3], ['seven_day', 0.54, 54]])
    expect(w[1].resetsAt).toBe(Date.parse('2026-10-10T06:00:00Z'))
    expect(windowsFromUsage({ five_hour: null }, now)).toEqual([])
    expect(windowsFromUsage(null, now)).toEqual([])
  })
  it('does not draw a figure outside 0..100 or a null one', () => {
    const w = windowsFromUsage({ five_hour: { utilization: 140, resets_at: null }, seven_day: { utilization: null, resets_at: null } }, now)
    expect(w.map(x => x.utilization)).toEqual([null, null])
    expect(w[0].raw).toBe(140)
  })
  it('probe stores both windows, and a failed or empty read stores nothing and says why', async () => {
    mkdirSync(dir, { recursive: true })
    const ask = (rate_limits: unknown) => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits }) }) as never
    expect(await probe(ask({ five_hour: { utilization: 10, resets_at: new Date(now + 3_600_000).toISOString() }, seven_day: { utilization: 54, resets_at: new Date(now + 86_400_000).toISOString() } }), now)).toBe(true)
    expect(readPlan(now).windows.find(x => x.id === 'seven_day')!.utilization).toBe(0.54)
    expect(probeFailure()).toBeNull()
    expect(await probe(ask(null), now)).toBe(false)
    expect(probeFailure()).toMatch(/no window/)
    expect(await probe({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('offline') } } as never, now)).toBe(false)
    expect(probeFailure()).toBe('offline')
    expect(readPlan(now).windows.find(x => x.id === 'seven_day')!.utilization).toBe(0.54)
  })
  it('an event with no figure keeps the figure the probe read for the same window', () => {
    const reset = now + 3_600_000
    observe({ rateLimitType: 'five_hour', status: 'allowed', resetsAt: reset }, now + 10)
    const w = readPlan(now + 10).windows.find(x => x.id === 'five_hour')!
    expect(w.utilization).toBe(0.1)
    expect(w.status).toBe('allowed')
  })
})

describe('one chat per issue', () => {
  const chats = (state = 'idle', prefix = 'c') => {
    const calls: { agent: string; prompt: string; title: string }[] = []
    return { calls, startChat: async (agent: string, prompt: string, title: string) => { calls.push({ agent, prompt, title }); await new Promise(r => setTimeout(r, 10)); return `${prefix}-${calls.length}` }, chatState: async () => state }
  }
  it('starts it with the issue agent the first time and answers the same id after, starting nothing', async () => {
    const i = createCeo(ceo(), { title: 'Decide SR3', agent: 'research' })
    const c = chats()
    expect(await ensureChat(ceo(), i.id, c)).toEqual({ conversation: 'c-1', started: true })
    expect(c.calls).toHaveLength(1)
    expect(c.calls[0].agent).toBe('research')
    expect(c.calls[0].title).toBe('C-0001 Decide SR3')
    expect(await ensureChat(ceo(), i.id, c)).toEqual({ conversation: 'c-1', started: false })
    expect(await ensureChat(ceo(), i.id, c)).toEqual({ conversation: 'c-1', started: false })
    expect(c.calls).toHaveLength(1)
    expect(readCeo(ceo(), i.id).conversation).toBe('c-1')
  })
  it('starts ONE chat when pressed twice at once', async () => {
    const i = createCeo(ceo(), { title: 'x', agent: 'app' })
    const c = chats()
    const [a, b] = await Promise.all([ensureChat(ceo(), i.id, c), ensureChat(ceo(), i.id, c)])
    expect(c.calls).toHaveLength(1)
    expect(a.conversation).toBe(b.conversation)
    expect([a.started, b.started].sort()).toEqual([false, true])
  })
  it('takes the agent from the press only while there is no chat, and refuses to start without one', async () => {
    const i = createCeo(ceo(), { title: 'x' })
    const c = chats()
    await expect(ensureChat(ceo(), i.id, c)).rejects.toMatchObject({ status: 409 })
    expect(c.calls).toHaveLength(0)
    await ensureChat(ceo(), i.id, c, { agent: 'platform' })
    expect(c.calls[0].agent).toBe('platform')
    await ensureChat(ceo(), i.id, c, { agent: 'app' })              // too late: the chat is with platform
    expect(readCeo(ceo(), i.id).agent).toBe('platform')
    expect(c.calls).toHaveLength(1)
  })
  it('says 410 for a chat that is gone, and a fresh press replaces it and notes the old id', async () => {
    const i = createCeo(ceo(), { title: 'x', agent: 'app' })
    await ensureChat(ceo(), i.id, chats())
    const gone = chats('gone', 'n')
    await expect(ensureChat(ceo(), i.id, gone)).rejects.toMatchObject({ status: 410 })
    expect(gone.calls).toHaveLength(0)
    const r = await ensureChat(ceo(), i.id, gone, { fresh: true })
    expect(r.started).toBe(true)
    expect(r.conversation).toBe('n-1')
    expect(readCeo(ceo(), i.id).body).toContain('chat c-1 no longer exists')
  })
})

describe('the quick-add line', () => {
  const roster = ['research', 'app']
  it('files for the agent it names, when that agent is on the roster', () => {
    expect(parseQuickAdd('@research check the gate', roster, 'app')).toEqual({ title: 'check the gate', agent: 'research', named: true })
  })
  it('files for the picked agent otherwise, and keeps an unknown @name in the title', () => {
    expect(parseQuickAdd('check the gate', roster, 'app')).toEqual({ title: 'check the gate', agent: 'app', named: false })
    expect(parseQuickAdd('@nobody check the gate', roster, '')).toEqual({ title: '@nobody check the gate', agent: '', named: false })
  })
  it('files nothing for an empty line or a bare @agent', () => {
    expect(parseQuickAdd('   ', roster, 'app')).toBeNull()
    expect(parseQuickAdd('@research', roster, 'app')).toEqual({ title: '@research', agent: 'app', named: false })
  })
})
