import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// B-0254, the owner's question 2026-09-27: why do chats end abruptly? At 12:40Z three platform chats
// were started through POST /api/chats; at 12:54:15Z a session outside the cockpit ran
// `prod.mjs --stop` (a taskkill) over their running turns. The fundd holding them never reached the
// idle restart, so nothing was saved, nothing reopened, and the NEXT fundd's restart at 12:56:46Z
// truthfully logged "0 conversation(s) saved". This drives the same path end to end: the chats room
// on a real Router, a chat started over HTTP and held mid-turn, the Restarter wired to the real
// holder the way fundd.ts wires it, then a fundd that ends WITHOUT go() - and the next boot.
// The Agent SDK is faked (no agent runs); the store is the throwaway test cluster.

const TMP = mkdtempSync(join(tmpdir(), 'restart-chats-'))
process.env.FUND_DATA_DIR = join(TMP, 'data')
process.env.USERPROFILE = join(TMP, 'home')
process.env.HOME = join(TMP, 'home')

type Opts = { abortController: AbortController; perTaskStopAffordance?: boolean; hooks?: Record<string, { hooks: ((i: any) => Promise<unknown>)[] }[]> }
class FakeQuery {
  sent: any[] = []
  msgs: any[] = []
  done = false
  private wake: (() => void) | null = null
  constructor(readonly prompt: AsyncIterable<any>, readonly options: Opts) {
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
  interrupts = 0
  stopped: string[] = []
  async interrupt() { this.interrupts++ }
  async stopTask(t: string) { this.stopped.push(t) }
  async getContextUsage() { return { percentage: 1, totalTokens: 1, maxTokens: 100 } }
  async setModel() {}
}
const fakes: FakeQuery[] = []
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<any>; options: Opts }) => { const q = new FakeQuery(prompt, options); fakes.push(q); return q },
}))
const AGENT = { id: 'tester', name: 'tester', kind: 'standing', mode: 'active', dept: 'Test', role: 'tests', cwd: '.', writes: [], model: 'haiku', effort: 'low', boot: [] }
vi.mock('../server/config.ts', () => ({
  agent: (id: string) => (id === 'tester' ? AGENT : undefined), agents: () => [AGENT], agentsDoc: () => null,
  config: { agents: () => [AGENT], repos: () => [] },
}))

let R: typeof import('../server/chat/runner.ts')
let RS: typeof import('../server/restart.ts')
let hooks: typeof import('../server/hooks.ts')
let server: Server
let base = ''
beforeAll(async () => {
  const { Router } = await import('../server/http.ts')
  const chats = await import('../server/rooms/chats.ts')
  R = await import('../server/chat/runner.ts')
  RS = await import('../server/restart.ts')
  hooks = await import('../server/hooks.ts')
  const r = new Router()
  chats.register(r)
  server = createServer((req, res) => { void r.handle(req, res).then(ok => { if (!ok) { res.statusCode = 404; res.end() } }) })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { await R.stopAll(); server?.close() })

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))
const T0 = Date.now()
const LIVE = () => join(TMP, 'fundd-live.json')
const BOOT = () => join(TMP, 'fundd-boot.json')

/** the Restarter exactly as fundd.ts builds it, over the REAL restart holders (the chats room's);
 *  kill() is the taskkill: a dead fundd writes nothing more, whatever its hands do after it */
function fundd(exits: number[]) {
  const holders = hooks.restartHolders()
  let dead = false
  const R0 = new RS.Restarter({
    now: Date.now, started: T0 - 60 * 60_000, supervised: true,
    serverCommit: async () => Date.now() - 1_000,
    blockers: async () => (await Promise.all(holders.map(h => h.busy()))).flat(),
    live: () => holders.flatMap(h => h.live?.() ?? []),
    save: s => { if (!dead) writeFileSync(LIVE(), JSON.stringify(s)) },
    shutdown: async () => {},
    exit: c => { exits.push(c) },
    setTimer: fn => { queueMicrotask(fn); return 1 },   // the debounce, collapsed to a microtask
  })
  for (const h of holders) h.watch?.(() => R0.journal())
  return Object.assign(R0, { kill: () => { dead = true } })
}
const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() as any }
}

describe('B-0254 (1): a chat started through POST /api/chats and held mid-turn', () => {
  let id = ''
  const exits: number[] = []
  let F: ReturnType<typeof fundd>

  it('the restart and a stop both WAIT for it', async () => {
    F = fundd(exits)
    const r = await post('/api/chats', { agent: 'tester', prompt: 'work for a while' })
    expect(r.status).toBe(200)
    id = r.body.id
    await tick()
    expect(R.liveState(id)).toBe('live')
    expect(await F.tick()).toBe('waiting')                                  // new server code: waits
    expect(F.status.waitingOn).toEqual(['1 turn running'])
    expect(await F.leave(false)).toEqual({ left: false, waitingOn: ['1 turn running'] })   // prod.mjs --stop: refused
    expect(exits).toEqual([])
  })

  it('a fundd that ends WITHOUT the restart (a kill) has already journaled the running turn as cut', () => {
    const saved = JSON.parse(readFileSync(LIVE(), 'utf8'))
    expect(saved.reason).toBe(RS.JOURNAL)
    expect(saved.conversations).toEqual([{ id, cutOff: true }])
    expect(Date.now() - saved.savedAt).toBeLessThan(RS.LIVE_MAX_AGE_MS)
  })

  it('the next fundd reopens it with the cut note and continues it ONCE, as the cockpit - the 12:56:46Z restart would have found it', async () => {
    F.kill()                                  // the taskkill: fundd is gone mid-turn, nothing ran go()
    await R.stopAll()                         // ... and its agents with it
    await tick()
    expect(R.liveState(id)).toBe('closed')
    writeFileSync(BOOT(), JSON.stringify({ bootAt: Date.now() - 30 * 60_000 }))
    const n = fakes.length
    const r = await RS.restoreAtBoot({
      now: Date.now, pid: 1, bootFile: BOOT(), liveFile: LIVE(), sleep: async () => {},
      reopen: async (cid, o) => { for (const h of hooks.restartHolders()) if (h.reopen) return h.reopen(cid, o) },
      scan: (since, ex) => R.scanCut(since, ex),
    })
    expect(r).toMatchObject({ saved: 1, reopened: [id], skipped: null, continued: [id] })
    await tick()
    const ring = (await R.entries(id)).entries
    expect(ring.at(-2)).toMatchObject({ kind: 'system', content: RS.cutNote(RS.JOURNAL, true) })
    expect(ring.at(-1)!.kind).toBe('user')
    expect(ring.at(-1)!.content).toMatch(/^\[cockpit\] The cockpit restarted at \d\d:\d\dZ and cut your turn\. This is not a new instruction from the owner\./)
    expect(fakes.length).toBe(n + 1)                            // one new process, one message
    expect(fakes.at(-1)!.sent).toHaveLength(1)
    expect(R.liveState(id)).toBe('live')
    // cut AGAIN, in the middle of that auto-continue: saved as auto, and never continued a second time
    const saved = RS.savedList(R.liveList().filter(c => c.id === id))
    expect(saved).toEqual([{ id, cutOff: true, auto: true }])
    R.forget(id)
  })
})

describe('B-0254 (2): work a conversation holds between turns', () => {
  it('a turn its PROCESS starts (a wake-up, a task reporting back) is a running turn, never idle', async () => {
    const { id } = await R.start('tester')
    await tick()
    const q = fakes.at(-1)!
    expect(R.liveState(id)).toBe('idle')
    q.emit({ type: 'assistant', uuid: 'w1', parent_tool_use_id: null, message: { id: 'mw1', content: [{ type: 'text', text: 'the wake-up fired' }] } })
    await tick()
    expect(R.liveState(id)).toBe('live')
    expect(RS.busyReasons({ convs: R.liveList(), terminals: [] })).toContain('1 turn running')
    q.emit({ type: 'result', subtype: 'success', uuid: 'rw1', usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, total_cost_usd: 0 })
    await tick()
    expect(R.liveState(id)).toBe('idle')
    R.forget(id)
  })

  it('a background command holds the restart; a watcher and a wake-up do not, and are named to the agent on reopen', async () => {
    const exits: number[] = []
    const F = fundd(exits)
    const { id } = await R.start('tester')
    await tick()
    const q = fakes.at(-1)!
    q.emit({ type: 'system', subtype: 'background_tasks_changed', uuid: 'b1', session_id: 's', tasks: [
      { task_id: 't1', task_type: 'local_bash', description: 'npm run verify' },
      { task_id: 't2', task_type: 'monitor', description: 'watch the land queue', ambient: true },
    ] })
    // the wake-up is reported only by the Stop hook the launch contract installs
    await q.options.hooks!.Stop[0].hooks[0]({ hook_event_name: 'Stop', session_crons: [{ id: 'c1', schedule: '30 14 27 9 *', recurring: false, prompt: 'check the land queue' }] })
    await tick()
    expect(R.liveState(id)).toBe('idle')
    expect(await F.tick()).toBe('waiting')
    expect(F.status.waitingOn).toEqual(['1 conversation waiting on background work (local_bash "npm run verify")'])
    // the command finishes: the watcher and the wake-up alone do not hold
    q.emit({ type: 'system', subtype: 'background_tasks_changed', uuid: 'b2', session_id: 's', tasks: [{ task_id: 't2', task_type: 'monitor', description: 'watch the land queue', ambient: true }] })
    await tick()
    expect(await F.tick()).toBe('restarting')
    expect(exits).toEqual([RS.RESTART_CODE])
    const saved = JSON.parse(readFileSync(LIVE(), 'utf8'))
    expect(saved.reason).toBe('new server code')
    const lost = ['monitor "watch the land queue"', 'wake-up 30 14 27 9 * "check the land queue"']
    expect(saved.conversations).toEqual([{ id, cutOff: false, lost }])
    // the next fundd: the agent is told, in a message it answers, what did not carry over
    F.kill(); await R.stopAll(); await tick()
    writeFileSync(BOOT(), JSON.stringify({ bootAt: Date.now() - 30 * 60_000 }))
    const n = fakes.length
    await RS.restoreAtBoot({ now: Date.now, pid: 2, bootFile: BOOT(), liveFile: LIVE(), reopen: (cid, o) => R.reopen(cid, o) })
    await tick()
    expect(fakes.length).toBe(n + 1)
    const said = fakes.at(-1)!.sent.at(-1).message.content as string
    expect(said).toMatch(/^\[cockpit\] .*did not carry over/)
    for (const l of lost) expect(said).toContain(l)
    expect(R.liveState(id)).toBe('live')
  })
})

describe('B-0560: Stop spares a background subagent, and the restart waits for it', () => {
  // 2026-10-06 12:27Z: the owner pressed Stop four seconds into a message, three minutes after a background
  // subagent started. Reproduced against the real CLI (0.3.288): without perTaskStopAffordance an interrupt
  // empties background_tasks_changed and stops every task; with it the task runs on. No restart happened
  // between 11:19Z and 15:30Z; the idle reaper and the later reopen only found what Stop had already killed.
  const agentTask = { task_id: 'aeb834', task_type: 'local_agent', description: 'Research the L2 book history' }

  it('every seat boots declaring it: without it an interrupt kills the background work', async () => {
    const { id } = await R.start('tester')
    await tick()
    expect(fakes.at(-1)!.options.perTaskStopAffordance).toBe(true)
    await R.stop(id, true)
  })

  it('a background subagent holds the restart and the reaper, through a Stop', async () => {
    const exits: number[] = []
    const F = fundd(exits)
    await R.stopAll()                         // only this conversation is open
    const { id } = await R.start('tester')
    await tick()
    const q = fakes.at(-1)!
    q.emit({ type: 'system', subtype: 'background_tasks_changed', uuid: 'b1', session_id: 's', tasks: [agentTask] })
    await tick()
    expect(await F.tick()).toBe('waiting')
    expect(F.status.waitingOn.join(' ')).toContain('local_agent "Research the L2 book history"')
    // Stop on a running turn interrupts it; the declared option is what keeps the task alive in the CLI,
    // and the cockpit's own view of it does not drop it either
    await R.send(id, 'think about it for a while')
    await tick()
    expect(R.liveState(id)).toBe('live')
    expect((await R.stop(id)).was).toBe('interrupted')
    expect(q.interrupts).toBe(1)
    expect(await F.tick()).toBe('waiting')
    expect(R.reapIdle({ id, why: 'idle', idleMs: 9e9 })).toBe(false)
    // one task is stopped on its own, and only a task the process holds
    expect((await post(`/api/chats/${id}/tasks/aeb834/stop`, {})).status).toBe(200)
    expect(q.stopped).toEqual(['aeb834'])
    expect((await post(`/api/chats/${id}/tasks/nope/stop`, {})).status).toBe(404)
    expect(q.stopped).toEqual(['aeb834'])
    F.kill(); await R.stopAll(); await tick()
  })

  it('a reopen after a cut tells the agent a background agent can be resumed', () => {
    expect(RS.lostMessage(Date.now(), ['local_agent "Research the L2 book history"'])).toContain('resume it with SendMessage')
  })
})

describe('B-0254 (3): every cut says so', () => {
  it('an agent process that ends mid-turn, with nobody stopping it, leaves the note', async () => {
    const { id } = await R.start('tester', 'long job')
    await tick()
    expect(R.liveState(id)).toBe('live')
    fakes.at(-1)!.end()                      // the CLI died underneath the turn
    await tick()
    expect(R.liveState(id)).toBe('closed')
    expect((await R.entries(id)).entries.at(-1)).toMatchObject({ kind: 'system', content: R.PROCESS_CUT })
  })
})

describe('B-0254 (5): the boot scan finds a hard stop in the transcript', () => {
  // a Claude Code transcript as the CLI writes it: one JSON row per line, main chain only
  const row = (type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type, uuid: `u${Math.random().toString(36).slice(2)}`, timestamp: new Date().toISOString(), message: { role: type, content }, ...extra })
  const ask = row('user', 'build the thing')
  const said = (t: string) => row('assistant', [{ type: 'text', text: t }])
  const call = (name: string) => row('assistant', [{ type: 'tool_use', id: 'tu1', name, input: {} }])
  const result = row('user', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }])
  const DEAD = 999_999   // never a live pid (Windows pids are multiples of 4)
  async function conv(lines: string[], held: number | null = DEAD) {
    const { id } = await R.start('tester')
    await tick()
    const launch = await import('../server/chat/launch.ts')
    const store = await import('../server/chat/store.ts')
    const db = await import('../server/db.ts')
    const uuid = `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`
    const cwd = launch.agentCwd(AGENT as any)
    mkdirSync(launch.transcriptDir(cwd), { recursive: true })
    writeFileSync(launch.transcriptFile(cwd, uuid), lines.join('\n') + '\n')
    await R.stop(id, true)                                     // closed: only the transcript says what happened
    await tick()
    await db.settled()
    await db.ops.updateConversation(id, { transcript_uuid: uuid, cwd })
    expect(await store.transcriptPath(id)).toBe(launch.transcriptFile(cwd, uuid))
    // the row a fundd leaves for a hand it was running (dead pid = that fundd died holding it)
    if (held !== null) await db.ops.setPresence(`chat:${id}`, 'tester', { conversationId: id, doing: 'working', pid: held })
    return id
  }

  it('cut, answered, parked on the owner, interrupted on purpose and an auto-continue are told apart', async () => {
    const T = await import('../server/chat/transcripts.ts')
    const file = (lines: string[]) => { const f = join(TMP, `t-${Math.random().toString(36).slice(2)}.jsonl`); writeFileSync(f, lines.join('\n') + '\n'); return f }
    expect(T.transcriptCut(file([ask, call('Bash')]))).toEqual({ waiting: false, auto: false })              // a call with no result
    expect(T.transcriptCut(file([ask, call('Bash'), result]))).toEqual({ waiting: false, auto: false })      // a result never answered
    expect(T.transcriptCut(file([ask]))).toEqual({ waiting: false, auto: false })                            // a prompt never answered
    expect(T.transcriptCut(file([ask, call('Bash'), result, said('done')]))).toBeNull()                      // answered
    expect(T.transcriptCut(file([ask, call('AskUserQuestion')]))).toEqual({ waiting: true, auto: false })   // parked on the owner
    expect(T.transcriptCut(file([ask, call('Bash'), row('user', [{ type: 'text', text: '[Request interrupted by user for tool use]' }])]))).toBeNull()
    expect(T.transcriptCut(file([row('user', RS.continueMessage(Date.now(), [])), call('Bash')]))).toEqual({ waiting: false, auto: true })
  })

  it('scanCut: a hand a DEAD fundd was running, whose recent transcript ends mid-turn, is found - nothing else is', async () => {
    const cut = await conv([ask, call('Bash')])
    const done = await conv([ask, said('done')])
    const excluded = await conv([ask, call('Bash')])
    const byHand = await conv([ask, call('Bash')], null)            // adopted, no presence row: the owner's own terminal session
    const liveElsewhere = await conv([ask, call('Bash')], process.ppid || process.pid)   // a fundd that still runs holds it
    const hits = (await R.scanCut(Date.now() - RS.SCAN_WINDOW_MS, new Set([excluded]))).map(h => h.id)
    expect(hits).toContain(cut)
    expect(hits).not.toContain(done)
    expect(hits).not.toContain(excluded)
    expect(hits).not.toContain(byHand)
    expect(hits).not.toContain(liveElsewhere)
    expect((await R.scanCut(Date.now() + 60_000, new Set())).map(h => h.id)).not.toContain(cut)   // written before the window
  })
})
