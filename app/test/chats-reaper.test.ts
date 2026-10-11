import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { REAP_DEFAULTS, parseReapConfig, pickReaps, reapNote, readReapConfig, reapable, sweep, type HandView, type ReapConfig } from '../server/chat/reaper.ts'
import { isHand, parseProcs, readHands, type Proc } from '../server/chat/handprocs.ts'

// THE IDLE-HAND REAPER (B-0420): the pure choice (reaper.ts), the runner's guarded close, and the
// process reading behind the System room line and the boot sweep (handprocs.ts). The Agent SDK's
// `query` is mocked as in chats-runner.test.ts: no agent process is ever started.

const TMP = mkdtempSync(join(tmpdir(), 'chats-reaper-'))
process.env.FUND_DATA_DIR = join(TMP, 'data')
process.env.USERPROFILE = join(TMP, 'home')
process.env.HOME = join(TMP, 'home')

class FakeQuery {
  sent: any[] = []
  msgs: any[] = []
  done = false
  private wake: (() => void) | null = null
  constructor(readonly prompt: AsyncIterable<any>, readonly options: { abortController: AbortController }) {
    void (async () => { for await (const m of prompt) this.sent.push(m) })()
    options.abortController.signal.addEventListener('abort', () => this.end())
  }
  emit(m: any) { this.msgs.push(m); this.poke() }
  end() { this.done = true; this.poke() }
  private poke() { const w = this.wake; this.wake = null; w?.() }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.msgs.length) yield this.msgs.shift()
      if (this.done) return
      await new Promise<void>(r => { this.wake = r })
    }
  }
  async interrupt() { /* none */ }
  async getContextUsage() { return { percentage: 1, totalTokens: 1, maxTokens: 10 } }
  async setModel() { /* none */ }
}
const fakes: FakeQuery[] = []
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<any>; options: { abortController: AbortController } }) => { const q = new FakeQuery(prompt, options); fakes.push(q); return q },
}))
const AGENTS: Record<string, any> = {
  tester: { id: 'tester', name: 'tester', kind: 'standing', mode: 'active', dept: 'Test', role: 'tests', cwd: '.', writes: [], model: 'haiku', effort: 'low', boot: [] },
}
vi.mock('../server/config.ts', () => ({ agent: (id: string) => AGENTS[id], agents: () => Object.values(AGENTS), agentsDoc: () => null }))

let R: typeof import('../server/chat/runner.ts')
beforeAll(async () => { R = await import('../server/chat/runner.ts') })
afterAll(async () => { await R.stopAll() })
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

const MIN = 60_000, GB = 1024 ** 3
const NOW = 1_000_000_000_000
const cfg: ReapConfig = { ...REAP_DEFAULTS }
/** an idle hand last active `ago` ms before NOW; `over` changes what it holds */
const hand = (id: string, ago: number, over: Partial<HandView> = {}): HandView => ({ id, busy: false, waiting: false, spawning: false, tasks: [], later: [], lastActive: NOW - ago, ...over })
const ids = (rs: { id: string }[]) => rs.map(r => r.id)

describe('pickReaps: the idle sweep', () => {
  it('closes a hand idle past idleMs and leaves a younger one', () => {
    const r = pickReaps([hand('old', 121 * MIN), hand('young', 119 * MIN)], NOW, 20 * GB, cfg)
    expect(r).toEqual([{ id: 'old', why: 'idle', idleMs: 121 * MIN }])
  })
  it('NEVER closes a hand with a turn running, a decision parked, a spawn in flight or background work, however long it has been quiet', () => {
    const day = 24 * 60 * MIN
    const held = [
      hand('busy', day, { busy: true }),
      hand('asks', day, { waiting: true }),
      hand('spawning', day, { spawning: true }),
      hand('task', day, { tasks: ['local_bash "npm run verify"'] }),
      hand('wake', day, { later: ['wake-up 30 14 * * *'] }),
    ]
    expect(pickReaps(held, NOW, 20 * GB, cfg)).toEqual([])
    // ... not under memory pressure, not over the idle cap either
    expect(pickReaps(held, NOW, 0.5 * GB, cfg)).toEqual([])
    expect(pickReaps(held, NOW, 20 * GB, { ...cfg, maxIdleHands: 1 })).toEqual([])
    for (const h of held) expect(reapable(h)).toBe(false)
  })
  it('an unreadable free-memory reading is not pressure', () => {
    expect(pickReaps([hand('a', 15 * MIN)], NOW, null, cfg)).toEqual([])
  })
})

describe('pickReaps: the memory valve and the cap', () => {
  it('under 3 GB free, closes idle hands oldest-first, only those idle 10 min or more, a batch at a time', () => {
    const hs = [hand('a', 11 * MIN), hand('b', 90 * MIN), hand('fresh', 9 * MIN), hand('c', 30 * MIN), hand('d', 20 * MIN), hand('e', 15 * MIN)]
    const r = pickReaps(hs, NOW, 2 * GB, cfg)
    expect(r.map(x => [x.id, x.why])).toEqual([['b', 'pressure'], ['c', 'pressure'], ['d', 'pressure'], ['e', 'pressure']])   // batch of 4; a and fresh stay
    expect(pickReaps(hs, NOW, 4 * GB, cfg)).toEqual([])                                                                     // enough free: nothing
  })
  it('more than the cap of idle hands: the least recently active go first, whatever their age', () => {
    const hs = Array.from({ length: 11 }, (_, i) => hand(`h${i}`, (i + 6) * MIN))          // h10 is the oldest, 16 min idle
    expect(ids(pickReaps(hs, NOW, 20 * GB, cfg))).toEqual(['h10', 'h9', 'h8'])
    expect(pickReaps(hs, NOW, 20 * GB, cfg).every(r => r.why === 'cap')).toBe(true)
  })
  it('B-0609: a hand whose background work ended this second is never taken, for any reason; 11 min on it may be', () => {
    const h3 = 3 * 60 * MIN
    // its tasks cleared now: lastActive is now (the runner bumps it on every message), however long it ran
    const fresh = hand('fresh', 0)
    const old = hand('old', 11 * MIN)
    const crowd = Array.from({ length: 9 }, (_, i) => hand(`c${i}`, (i + 6) * MIN))
    expect(pickReaps([fresh], NOW, 20 * GB, cfg)).toEqual([])
    expect(pickReaps([hand('stale', h3)], NOW, 20 * GB, cfg).map(r => r.why)).toEqual(['idle'])   // the bug: lastActive left at the last turn, 3 h ago
    expect(pickReaps([fresh, old], NOW, 0.5 * GB, cfg).map(r => [r.id, r.why])).toEqual([['old', 'pressure']])             // pressure
    expect(pickReaps([fresh, ...crowd], NOW, 20 * GB, cfg).map(r => [r.id, r.why])).toEqual([['c8', 'cap'], ['c7', 'cap']])   // cap: 10 open, 2 over, fresh stays
    expect(pickReaps([fresh, ...crowd], NOW, 20 * GB, { ...cfg, maxIdleHands: 1 }).some(r => r.id === 'fresh')).toBe(false)
    expect(pickReaps([hand('edge', 5 * MIN - 1)], NOW, 0.5 * GB, { ...cfg, pressureMinIdleMs: MIN })).toEqual([])
    expect(pickReaps([hand('edge', 5 * MIN)], NOW, 0.5 * GB, { ...cfg, pressureMinIdleMs: MIN })).toHaveLength(1)
  })
  it('the cap counts hands that cannot go, and a hand is picked once', () => {
    const hs = [...Array.from({ length: 8 }, (_, i) => hand(`h${i}`, MIN * (i + 6))), hand('bg', 6 * MIN, { tasks: ['x'] }), hand('old', 200 * MIN)]
    // 10 idle open; 'old' goes for idle and counts against the excess; one more must go for the cap (9 - 8)
    const r = pickReaps(hs, NOW, 20 * GB, cfg)
    expect(r.map(x => [x.id, x.why])).toEqual([['old', 'idle'], ['h7', 'cap']])
  })
})

describe('the reaper file', () => {
  it('a missing or bad key takes its default; real numbers convert to ms and bytes', () => {
    expect(parseReapConfig(null)).toEqual(REAP_DEFAULTS)
    expect(parseReapConfig({ idleMinutes: 'soon', maxIdleHands: -2, pressureBatch: 0 })).toEqual(REAP_DEFAULTS)
    expect(parseReapConfig({ idleMinutes: 30, pressureFreeGb: 1.5, maxIdleHands: 3.4, sweepSeconds: 1, settleMinutes: 2 })).toMatchObject({ idleMs: 30 * MIN, pressureFreeBytes: 1.5 * GB, maxIdleHands: 3, sweepMs: 5000, settleMs: 2 * MIN })
    expect(REAP_DEFAULTS.settleMs).toBe(5 * MIN)
    expect(readReapConfig(join(TMP, 'no-such.json'))).toEqual(REAP_DEFAULTS)
    writeFileSync(join(TMP, 'reaper.json'), JSON.stringify({ idleMinutes: 5 }))
    expect(readReapConfig(join(TMP, 'reaper.json')).idleMs).toBe(5 * MIN)
  })
})

describe('sweep: one synchronous pass', () => {
  it('closes what the runner agrees to, logs each, and skips a hand the runner refuses', () => {
    const logged: string[] = [], tried: string[] = []
    const done = sweep({
      now: () => NOW, free: () => 20 * GB, config: () => cfg, hands: () => [hand('a', 3 * 60 * MIN), hand('b', 4 * 60 * MIN)],
      reap: r => { tried.push(r.id); return r.id === 'b' }, log: r => logged.push(r.id),
    })
    expect(tried).toEqual(['b', 'a'])
    expect(ids(done)).toEqual(['b'])
    expect(logged).toEqual(['b'])
  })
  it('the note names the idle time and the reason, and says the next message reopens it', () => {
    expect(reapNote({ id: 'x', why: 'idle', idleMs: 150 * MIN })).toBe('Closed after 2.5 h idle (idle too long). Your next message reopens it where it stood.')
    expect(reapNote({ id: 'x', why: 'pressure', idleMs: 12 * MIN })).toContain('12 min idle (memory is low)')
  })
})

describe('runner: the guarded close', () => {
  const turnEnd = (q: FakeQuery, n: string) => {
    q.emit({ type: 'assistant', uuid: `a${n}`, parent_tool_use_id: null, message: { id: `m${n}`, content: [{ type: 'text', text: 'done' }] } })
    q.emit({ type: 'result', subtype: 'success', uuid: `r${n}`, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, total_cost_usd: 0 })
  }
  it('a quiet hand closes with a note on its ring, and the next message reopens it', async () => {
    const { id } = await R.start('tester', 'hello')
    await tick()
    turnEnd(fakes.at(-1)!, '1'); await tick()
    expect(R.liveState(id)).toBe('idle')
    const v = R.handViews().find(h => h.id === id)!
    expect(v).toMatchObject({ busy: false, waiting: false, spawning: false, tasks: [], later: [], agent: 'tester' })
    expect(Date.now() - v.lastActive).toBeLessThan(5000)
    expect(R.reapIdle({ id, why: 'idle', idleMs: 2 * 60 * MIN })).toBe(true)
    await tick()
    expect(R.liveState(id)).toBe('closed')
    expect((await R.entries(id)).entries.at(-1)).toMatchObject({ kind: 'system', content: expect.stringContaining('Closed after 2.0 h idle') })
    const n = fakes.length
    await R.send(id, 'back again'); await tick()
    expect(fakes.length).toBe(n + 1)                   // a new process, resumed
    expect(R.liveState(id)).toBe('live')
    R.forget(id)
  })
  it('refuses a hand that is running a turn, or holds background work, or is not open at all', async () => {
    const { id } = await R.start('tester', 'long job')
    await tick()
    expect(R.liveState(id)).toBe('live')
    expect(R.reapIdle({ id, why: 'idle', idleMs: 9e9 })).toBe(false)
    expect(R.liveState(id)).toBe('live')
    const q = fakes.at(-1)!
    q.emit({ type: 'system', subtype: 'background_tasks_changed', uuid: 'b1', session_id: 's', tasks: [{ task_id: 't1', task_type: 'local_bash', description: 'npm run verify' }] })
    turnEnd(q, '2'); await tick()
    expect(R.liveState(id)).toBe('idle')
    expect(R.reapIdle({ id, why: 'idle', idleMs: 9e9 })).toBe(false)         // idle, but its process holds a command
    q.emit({ type: 'system', subtype: 'background_tasks_changed', uuid: 'b2', session_id: 's', tasks: [] }); await tick()
    expect(R.reapIdle({ id: 'nobody', why: 'idle', idleMs: 9e9 })).toBe(false)
    expect(R.reapIdle({ id, why: 'idle', idleMs: 9e9 })).toBe(true)          // the command ended: now it may go
    R.forget(id)
  })
})

describe('runner: activity from the process (B-0609)', () => {
  const turnEnd = (q: FakeQuery, n: string) => {
    q.emit({ type: 'assistant', uuid: `a${n}`, parent_tool_use_id: null, message: { id: `m${n}`, content: [{ type: 'text', text: 'done' }] } })
    q.emit({ type: 'result', subtype: 'success', uuid: `r${n}`, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, total_cost_usd: 0 })
  }
  const lastActive = (id: string) => R.handViews().find(h => h.id === id)!.lastActive
  it('a task_notification bumps lastActive; a keep_alive and a rate_limit_event do not', async () => {
    const { id } = await R.start('tester', 'dispatch')
    await tick()
    const q = fakes.at(-1)!
    q.emit({ type: 'system', subtype: 'background_tasks_changed', uuid: 'b1', session_id: 's', tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'review' }] })
    turnEnd(q, '1'); await tick()
    expect(R.handViews().find(h => h.id === id)!.tasks).toHaveLength(1)
    const before = lastActive(id)
    await tick(60)
    q.emit({ type: 'keep_alive' }); q.emit({ type: 'rate_limit_event', rate_limit_info: {} }); await tick()
    expect(lastActive(id)).toBe(before)
    q.emit({ type: 'system', subtype: 'task_notification', uuid: 'n1', session_id: 's', task_id: 't1', status: 'completed', summary: 'done', output_file: '' }); await tick()
    expect(lastActive(id)).toBeGreaterThan(before)
    R.forget(id)
  })
  it('the tasks clearing bumps lastActive, and the settle grace refuses the close at that moment', async () => {
    const { id } = await R.start('tester', 'dispatch')
    await tick()
    const q = fakes.at(-1)!
    q.emit({ type: 'system', subtype: 'background_tasks_changed', uuid: 'b1', session_id: 's', tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'review' }] })
    turnEnd(q, '3'); await tick()
    const before = lastActive(id)
    await tick(60)
    q.emit({ type: 'system', subtype: 'background_tasks_changed', uuid: 'b2', session_id: 's', tasks: [] }); await tick()
    expect(lastActive(id)).toBeGreaterThan(before)
    expect(R.handViews().find(h => h.id === id)!.tasks).toEqual([])
    expect(R.reapIdle({ id, why: 'idle', idleMs: 9e9 }, 5 * MIN)).toBe(false)     // active a moment ago: inside the grace
    expect(R.reapIdle({ id, why: 'idle', idleMs: 9e9 }, 0)).toBe(true)            // without the grace it would go
    R.forget(id)
  })
  it('the chat meta names what the hand waits on, and drops it when the work ends', async () => {
    const { id } = await R.start('tester', 'dispatch')
    await tick()
    const q = fakes.at(-1)!
    q.emit({ type: 'system', subtype: 'background_tasks_changed', uuid: 'b1', session_id: 's', tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'review the diff' }] }); await tick()
    expect((await R.entries(id)).meta.bg).toEqual(['local_agent "review the diff"'])
    q.emit({ type: 'system', subtype: 'background_tasks_changed', uuid: 'b2', session_id: 's', tasks: [] }); await tick()
    expect((await R.entries(id)).meta.bg).toBeUndefined()
    R.forget(id)
  })
})

describe('the hands as processes', () => {
  const SDK = 'C:\\dev\\fund\\app\\node_modules\\@anthropic-ai'
  const HAND = `${SDK}\\claude-agent-sdk-win32-x64\\claude.exe --output-format stream-json --verbose --input-format stream-json --model x`
  const P = (pid: number, ppid: number, name: string, mb: number, cmd = ''): Proc => ({ pid, ppid, name, rssB: mb * 1048576, cmd })

  it('parses the listing, skipping a line that is not a process', () => {
    const t = ['100\t4\t1048576\tnode.exe\tnode fundd.ts', 'garbage', '101\t100\t2097152\tclaude.exe\t' + HAND, '\t\t\t\t'].join('\r\n')
    expect(parseProcs(t)).toEqual([
      { pid: 100, ppid: 4, name: 'node.exe', rssB: 1048576, cmd: 'node fundd.ts' },
      { pid: 101, ppid: 100, name: 'claude.exe', rssB: 2097152, cmd: HAND },
    ])
  })
  it('a hand is THIS app\'s SDK binary in stream-json mode: not the owner\'s terminal claude, not another app\'s SDK', () => {
    expect(isHand(P(1, 2, 'claude.exe', 1, HAND), SDK)).toBe(true)
    expect(isHand(P(1, 2, 'claude.exe', 1, `"${HAND.replace(' --output', '" --output')}`), SDK)).toBe(true)   // a quoted path
    expect(isHand(P(1, 2, 'claude.exe', 1, 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'), SDK)).toBe(false)
    expect(isHand(P(1, 2, 'claude.exe', 1, HAND.replace('C:\\dev\\fund\\app', 'C:\\other\\app')), SDK)).toBe(false)
    expect(isHand(P(1, 2, 'claude.exe', 1, HAND.replace('--input-format stream-json', '')), SDK)).toBe(false)
    expect(isHand(P(1, 2, 'node.exe', 1, HAND), SDK)).toBe(false)
  })
  it('weighs each hand with its children, finds the hand whose parent is gone, and only counts the owner\'s sessions', () => {
    const procs = [
      P(10, 1, 'node.exe', 80, 'node fundd.ts'),
      P(11, 10, 'claude.exe', 200, HAND), P(12, 11, 'node.exe', 75), P(13, 11, 'python.exe', 40),    // a live hand: 315 MB
      P(20, 9999, 'claude.exe', 190, HAND), P(21, 20, 'node.exe', 75),                               // parent 9999 is not running: orphan, 265 MB
      P(30, 31, 'claude.exe', 260, 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'),   // the owner's terminal
      P(40, 41, 'Claude.exe', 190, 'C:/Program Files/WindowsApps/Claude_2/app/Claude.exe --type=renderer'), P(42, 41, 'Claude.exe', 190, 'C:/Program Files/WindowsApps/Claude_2/app/Claude.exe'),   // the desktop app: not a terminal session
    ]
    const r = readHands(procs, SDK)
    expect(r.hands).toEqual([{ pid: 11, ppid: 10, bytes: 315 * 1048576 }])
    expect(r.orphans).toEqual([{ pid: 20, ppid: 9999, bytes: 265 * 1048576 }])
    expect(r.others).toEqual([{ pid: 30, bytes: 260 * 1048576 }])
    expect(r.bytes).toBe(580 * 1048576)
  })
})
