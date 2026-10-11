import { query as sql } from '@fund/db'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// THE CHAT ENGINE's state machine (server/chat/runner.ts) with the Agent SDK's `query` MOCKED:
// no conversation is ever started. Each fake query records the prompt stream it was handed and
// lets the test emit SDK messages into the runner's loop. The database, the data dir and the
// home dir (where transcripts live) all point at a throwaway folder.

const TMP = mkdtempSync(join(tmpdir(), 'chats-runner-'))
process.env.FUND_DATA_DIR = join(TMP, 'data')
process.env.USERPROFILE = join(TMP, 'home')
process.env.HOME = join(TMP, 'home')

type Opts = { abortController: AbortController; canUseTool: (n: string, i: Record<string, unknown>, o: { toolUseID: string }) => Promise<any>; resume?: string; resumeSessionAt?: string; forkSession?: boolean }

class FakeQuery {
  sent: any[] = []
  msgs: any[] = []
  done = false
  interrupts = 0
  models: string[] = []
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
  async interrupt() { this.interrupts++ }
  async getContextUsage() { return { percentage: 12, totalTokens: 120, maxTokens: 1000 } }
  async setModel(m: string) { this.models.push(m) }
}
const fakes: FakeQuery[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<any>; options: Opts }) => { const q = new FakeQuery(prompt, options); fakes.push(q); return q },
}))

const AGENTS: Record<string, any> = {
  tester: { id: 'tester', name: 'tester', kind: 'standing', mode: 'active', dept: 'Test', role: 'tests', cwd: '.', writes: [], model: 'haiku', effort: 'low', boot: [] },
  sleeper: { id: 'sleeper', name: 'sleeper', kind: 'standing', mode: 'dormant', dept: 'Test', role: 'sleeps', cwd: '.', writes: [], model: 'haiku', effort: 'low', boot: [] },
}
vi.mock('../server/config.ts', () => ({ agent: (id: string) => AGENTS[id], agents: () => Object.values(AGENTS), agentsDoc: () => null }))   // no roster doc: no spend ceiling

let R: typeof import('../server/chat/runner.ts')
let store: typeof import('../server/chat/store.ts')
let launch: typeof import('../server/chat/launch.ts')
let db: typeof import('../server/db.ts')

beforeAll(async () => {
  db = await import('../server/db.ts')
  R = await import('../server/chat/runner.ts')
  store = await import('../server/chat/store.ts')
  launch = await import('../server/chat/launch.ts')
})
afterAll(async () => { await R.stopAll() })

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))
const last = () => fakes[fakes.length - 1]
const turn = (q: FakeQuery, text: string, uuid: string, msgId: string) => {
  q.emit({ type: 'assistant', uuid, parent_tool_use_id: null, message: { id: msgId, content: [{ type: 'text', text }] } })
  q.emit({ type: 'result', subtype: 'success', uuid: `r-${uuid}`, usage: { input_tokens: 10, output_tokens: 2 }, modelUsage: { 'claude-haiku': { inputTokens: 10, outputTokens: 2 } }, total_cost_usd: 0.001 })
}

describe('runner: start, send, turn close', () => {
  let id = ''
  it('start with a prompt spawns ONE query, streams the owner message into it, and goes live', async () => {
    const n = fakes.length
    id = (await R.start('tester', 'Reply with the single word: ready')).id
    await tick()
    expect(fakes.length).toBe(n + 1)
    expect(last().sent).toHaveLength(1)
    expect(last().sent[0].message.content).toBe('Reply with the single word: ready')
    expect(R.liveState(id)).toBe('live')
    expect((await store.get(id))?.state).toBe('live')
    expect((await store.get(id))?.title).toMatch(/Reply with the single word/)
    const e = (await R.entries(id)).entries
    expect(e.map(x => x.kind)).toEqual(['user'])
  })

  it('a result closes the turn: idle, the answer in the ring, usage booked once', async () => {
    const q = last()
    q.emit({ type: 'system', subtype: 'init', model: 'claude-haiku', session_id: (await store.get(id))!.transcript })
    turn(q, 'ready', 'a1', 'm1')
    await tick()
    expect(R.liveState(id)).toBe('idle')
    expect((await R.entries(id)).entries.find(e => e.kind === 'assistant')?.content).toBe('ready')
    await db.settled()
    const u = (await sql<{ i: number; o: number }>('SELECT SUM(tokens_in)::int AS i, SUM(tokens_out)::int AS o FROM ops.usage WHERE conversation_id = $1', [id]))[0]
    expect([u.i, u.o]).toEqual([10, 2])
    expect(await store.get(id)).toMatchObject({ tokensIn: 10, tokensOut: 2 })       // the row's running totals move with it
    expect((await R.entries(id)).meta.contextPct).toBe(12)
  })

  it('a second send reuses the same query and carries its rewind point', async () => {
    const n = fakes.length
    await R.send(id, 'and again')
    await tick()
    expect(fakes.length).toBe(n)
    expect(last().sent).toHaveLength(2)
    const u = (await R.entries(id)).entries.filter(e => e.kind === 'user')
    expect(u[1].forkAt).toBe('a1')
    expect(R.liveState(id)).toBe('live')
  })

  it('a leading slash is sent as prose, never as a command', async () => {
    turn(last(), 'ok', 'a2', 'm2'); await tick()
    await R.send(id, '/clear everything')
    await tick()
    expect(last().sent.at(-1).message.content).toBe(' /clear everything')
    turn(last(), 'ok', 'a3', 'm3'); await tick()
  })

  it('/compact goes through the seat UNSPACED, only when idle, and names no title; other commands are refused', async () => {
    const title = (await store.get(id))!.title
    await R.command(id, '/compact')
    await tick()
    expect(last().sent.at(-1).message.content).toBe('/compact')
    expect((await store.get(id))!.title).toBe(title)
    await expect(R.command(id, '/compact')).rejects.toThrow('stop the running turn first')
    await expect(R.command(id, '/clear' as any)).rejects.toThrow('not a command this runs')
    turn(last(), 'compacted', 'a3c', 'm3c'); await tick()
    expect(R.liveState(id)).toBe('idle')
  })

  it('the tab light\'s red: a turn that ENDS on an error is failed, one answered past is not, unknown is null', async () => {
    expect(R.lastTurnFailed(id)).toBe(false)
    expect(R.lastTurnFailed('no-such-conversation')).toBe(null)
    await R.send(id, 'break')
    await tick()
    const q = last()
    q.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, uuid: 'r-bad', result: 'boom', usage: { input_tokens: 1, output_tokens: 0 }, modelUsage: {},
      permission_denials: [{ tool_use_id: 'tu-d', tool_name: 'Bash', tool_input: { command: 'git branch' } }] })
    await tick()
    expect(R.liveState(id)).toBe('idle')
    expect(R.lastTurnFailed(id)).toBe(true)
    await R.send(id, 'try again'); await tick()
    turn(last(), 'recovered', 'a3r', 'm3r'); await tick()
    expect(R.lastTurnFailed(id)).toBe(false)
    const e = (k: string, extra = {}) => ({ id: k, ts: 0, kind: k as any, content: '', ...extra })
    expect(R.turnFailed([e('user'), e('error'), e('system'), e('thinking'), e('tool')])).toBe(true)
    expect(R.turnFailed([e('user'), e('error'), e('assistant', { nested: true })])).toBe(true)
    expect(R.turnFailed([e('error'), e('user')])).toBe(false)
    expect(R.turnFailed([])).toBe(false)
  })

  it('soft stop mid-turn interrupts and leaves the process up; stop when idle ends it', async () => {
    await R.send(id, 'long job')
    await tick()
    const q = last()
    expect(await R.stop(id)).toEqual({ ok: true, was: 'interrupted' })
    expect(q.interrupts).toBe(1)
    expect(R.liveState(id)).toBe('idle')
    expect((await R.entries(id)).entries.at(-1)).toMatchObject({ kind: 'system', content: 'Interrupted' })
    expect(await R.stop(id)).toEqual({ ok: true, was: 'closed' })
    await tick()
    expect(R.liveState(id)).toBe('closed')
    expect((await store.get(id))?.state).toBe('closed')
    expect((await R.entries(id)).meta.live).toBe(false)
    expect((await R.entries(id)).entries.some(e => e.content === 'ready')).toBe(true)  // the closed ring is kept
  })

  it('an empty message and a dormant agent are refused', async () => {
    await expect(R.send(id, '   ')).rejects.toThrow(/empty/)
    await expect(R.start('sleeper', 'hi')).rejects.toThrow(/dormant/)
    await expect(R.start('nobody', 'hi')).rejects.toThrow(/no agent/)
  })
})

describe('runner: the decision seam (park / decide)', () => {
  it('AskUserQuestion parks as waiting with no timeout; an answer resumes it with the answers', async () => {
    const id = (await R.start('tester', 'ask me')).id
    await tick()
    const q = last()
    const p = q.options.canUseTool('AskUserQuestion', { questions: [{ question: 'Which?', header: 'h', options: [{ label: 'A' }, { label: 'B' }] }] }, { toolUseID: 'tu1' })
    await tick()
    expect(R.liveState(id)).toBe('waiting')
    expect(R.counts().waiting).toBe(1)
    const d = (await R.entries(id)).entries.find(e => e.kind === 'decision')!
    expect(d.decision?.questions?.[0].options.map(o => o.label)).toEqual(['A', 'B'])
    expect(() => R.decide(id, { toolUseId: 'nope', verdict: 'approve' })).toThrow(/nothing is waiting/)
    R.decide(id, { toolUseId: 'tu1', verdict: 'answer', answers: { 'Which?': 'B' } })
    const r = await p
    expect(r).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which?': 'B' } } })
    expect(R.liveState(id)).toBe('live')
    expect((await R.entries(id)).entries.find(e => e.kind === 'decision')?.decision?.settled).toMatchObject({ verdict: 'answered' })
    await R.stop(id, true)
  })

  it('a rejected plan is a deny carrying the note; an ordinary tool is allowed untouched', async () => {
    const id = (await R.start('tester', 'plan it')).id
    await tick()
    const q = last()
    expect(await q.options.canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tb' })).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    const p = q.options.canUseTool('ExitPlanMode', { plan: 'do x' }, { toolUseID: 'tp' })
    await tick()
    expect((await R.entries(id)).entries.find(e => e.kind === 'decision')?.decision?.plan).toBe('do x')
    R.decide(id, { toolUseId: 'tp', verdict: 'reject', note: 'smaller' })
    expect(await p).toEqual({ behavior: 'deny', message: 'smaller' })
    await R.stop(id, true)
  })

  it('a question still parked when the conversation ends is denied and marked lost', async () => {
    const id = (await R.start('tester', 'ask then die')).id
    await tick()
    const p = last().options.canUseTool('AskUserQuestion', { questions: [{ question: 'Q?', options: [{ label: 'x' }] }] }, { toolUseID: 'tl' })
    await tick()
    await R.stop(id, true)
    expect(await p).toMatchObject({ behavior: 'deny' })
    await tick()
    expect(R.liveState(id)).toBe('closed')
    expect((await R.entries(id)).entries.find(e => e.kind === 'decision')?.decision?.settled?.verdict).toBe('lost')
  })
})

describe('runner: rewind', () => {
  it('forks the transcript at the entry before the chosen message and hands its text back', async () => {
    const id = (await R.start('tester', 'first')).id
    await tick()
    turn(last(), 'one', 'b1', 'n1'); await tick()
    await R.send(id, 'second')
    await tick()
    const target = (await R.entries(id)).entries.filter(e => e.kind === 'user')[1]
    await expect(R.rewind(id, target.id)).rejects.toThrow(/stop the running turn/)
    turn(last(), 'two', 'b2', 'n2'); await tick()
    // the fork resumes a transcript that exists on disk
    const row = (await store.getRow(id))!
    const f = launch.transcriptFile(row.cwd!, row.transcript_uuid!)
    mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, '')
    const first = (await R.entries(id)).entries.find(e => e.kind === 'user')!
    await expect(R.rewind(id, first.id)).rejects.toThrow(/nothing before/)
    const n = fakes.length
    expect(await R.rewind(id, target.id)).toEqual({ text: 'second' })
    await tick()
    expect(fakes.length).toBe(n + 1)
    expect(last().options).toMatchObject({ resume: row.transcript_uuid, resumeSessionAt: 'b1', forkSession: true })
    expect((await R.entries(id)).entries.map(e => e.content)).toEqual(['first', 'one'])
    expect(R.liveState(id)).toBe('idle')
    await R.stop(id, true)
  })
})

describe('store: the conversation index', () => {
  it('lists newest first, finds by title or by indexed content, and forget hides a row for good', async () => {
    const a = await store.create(AGENTS.tester, 'alpha plan')
    await tick(5)
    const b = await store.create(AGENTS.tester, 'beta')
    await store.indexText(b.id, 'assistant', 'the funding cadence is per symbol')
    const ids = (await store.list({ agent: 'tester' })).map(c => c.id)
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id))
    expect((await store.list({ q: 'alpha' })).map(c => c.id)).toContain(a.id)
    const hit = (await store.list({ q: 'cadence' })).find(c => c.id === b.id)
    expect(hit?.snippet).toMatch(/cadence/)
    expect(await store.list({ q: '"unbalanced (' })).toBeInstanceOf(Array)   // punctuation is never FTS syntax
    await store.patch(a.id, { title: 'renamed', model: 'sonnet' })
    expect(await store.get(a.id)).toMatchObject({ title: 'renamed', model: 'sonnet' })
    await store.forget(a.id)
    expect(await store.get(a.id)).toBeNull()
    expect((await store.list({})).some(c => c.id === a.id)).toBe(false)
    await expect(R.send(a.id, 'hello')).rejects.toThrow(/no such conversation/)
  })

  it('searches by word PREFIX (search-as-you-type), ANDs the words, and previews the last message', async () => {
    const c = await store.create(AGENTS.tester, 'gamma')
    await store.indexText(c.id, 'user', 'first question')
    await store.indexText(c.id, 'assistant', 'the **settlement** interval is read per symbol', Date.now() + 1)
    expect((await store.list({ q: 'settl' })).map(x => x.id)).toContain(c.id)
    expect((await store.list({ q: 'settl interv' })).map(x => x.id)).toContain(c.id)
    expect((await store.list({ q: 'settl nowhere' })).map(x => x.id)).not.toContain(c.id)
    expect(store.prefixQuery('a-b "c" (d')).toBe('a:* & b:* & c:* & d:*')
    expect(store.prefixQuery('!!!')).toBe('')
    expect((await store.previews([c.id])).get(c.id)).toBe('the settlement interval is read per symbol')
    expect((await store.previews(['c-none'])).has('c-none')).toBe(false)
  })
})
