import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// THE ENGINE SEAM THROUGH THE RUNNER (server/chat/runner.ts) with the Agent SDK MOCKED and a FAKE `grok` on PATH:
// a conversation picks a provider by its model id, the right hand boots, the owner sees the rows, a switch reboots
// the hand and says so, and a provider that cannot run says why instead of failing at the first token.
// The fake grok prints the Anthropic-wire NDJSON the real one does (captured from grok 1.0.46) and echoes its argv.

const TMP = mkdtempSync(join(tmpdir(), 'chats-engines-runner-'))
// the provider key's dotenv file is looked for in an empty scratch root, never the live fund's: the machine env is the only key a test has
vi.mock('../server/chat/engines/keys.ts', async importOriginal => {
  const k = await importOriginal<typeof import('../server/chat/engines/keys.ts')>()
  const root = mkdtempSync(join(tmpdir(), 'chats-engines-noroot-'))
  return {
    ...k,
    keyHome: (e: any, r = root) => k.keyHome(e, r),
    noKeyLine: (e: any, r = root) => k.noKeyLine(e, r),
    providerKey: (e: any, env: any = process.env, r = root) => k.providerKey(e, env, r),
    haveKey: (e: any, env?: any, r = root) => k.haveKey(e, env, r),
  }
})
process.env.FUND_DATA_DIR = join(TMP, 'data')
process.env.USERPROFILE = join(TMP, 'home')
process.env.HOME = join(TMP, 'home')
const GROK_HOME = join(TMP, 'grok-home')
process.env.GROK_HOME = GROK_HOME
mkdirSync(GROK_HOME, { recursive: true })
writeFileSync(join(GROK_HOME, 'auth.json'), '{}')
writeFileSync(join(GROK_HOME, 'models_cache.json'), JSON.stringify({ models: { 'grok-4.7': { info: { id: 'grok-4.7', name: 'Grok 4.7', supports_reasoning_effort: true, reasoning_efforts: [{ id: 'xhigh' }, { id: 'high' }, { id: 'low' }] } } } }))
const BIN = join(TMP, 'bin')
mkdirSync(BIN, { recursive: true })
writeFileSync(join(BIN, 'fake-grok.mjs'), `
import { readFileSync } from 'node:fs'
const a = process.argv.slice(2)
const text = readFileSync(a[a.indexOf('--prompt-file') + 1], 'utf8')
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
const sid = a.includes('--resume') ? a[a.indexOf('--resume') + 1] : 'fake-session-1'
out({ type: 'system', subtype: 'init', session_id: sid, model: 'grok-4.7', uuid: 'i' })
out({ type: 'assistant', message: { id: 'msg_0', role: 'assistant', model: 'grok-4.7', content: [{ type: 'text', text: JSON.stringify({ a: a.filter(x => !x.startsWith('Bash(') && !x.startsWith('Read(') && !x.startsWith('Edit(') && !x.startsWith('Write(')), denies: a.filter(x => /^(Bash|Read|Edit|Write)\\(/.test(x)).length, text }) }], usage: { input_tokens: 100, output_tokens: 5 } }, parent_tool_use_id: null, session_id: sid, uuid: 'a' })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 5 }, modelUsage: { 'grok-4.7': { inputTokens: 100, outputTokens: 5, contextWindow: 256000 } }, session_id: sid, uuid: 'r' })
`)
if (process.platform === 'win32') writeFileSync(join(BIN, 'grok.cmd'), '@node "%~dp0fake-grok.mjs" %*\r\n')
else { writeFileSync(join(BIN, 'grok'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-grok.mjs" "$@"\n', { mode: 0o755 }) }
const REAL_PATH = process.env.PATH ?? ''
process.env.PATH = BIN + delimiter + REAL_PATH

type Opts = { abortController: AbortController; env: Record<string, string | undefined>; model: string; effort?: string; resume?: string }
class FakeQuery {
  sent: any[] = []
  msgs: any[] = []
  done = false
  private wake: (() => void) | null = null
  constructor(readonly prompt: AsyncIterable<any>, readonly options: Opts) {
    void (async () => { for await (const m of prompt) this.sent.push(m) })()
    options.abortController.signal.addEventListener('abort', () => { this.done = true; this.poke() })
  }
  emit(m: any) { this.msgs.push(m); this.poke() }
  private poke() { const w = this.wake; this.wake = null; w?.() }
  async *[Symbol.asyncIterator]() { for (;;) { while (this.msgs.length) yield this.msgs.shift(); if (this.done) return; await new Promise<void>(r => { this.wake = r }) } }
  async interrupt() { /* */ }
  async getContextUsage() { return { percentage: 5, totalTokens: 50, maxTokens: 1000 } }
  async setModel() { /* */ }
  async stopTask() { /* */ }
}
const fakes: FakeQuery[] = []
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: ({ prompt, options }: { prompt: AsyncIterable<any>; options: Opts }) => { const q = new FakeQuery(prompt, options); fakes.push(q); return q } }))

const AGENTS: Record<string, any> = {
  tester: { id: 'tester', name: 'tester', kind: 'standing', mode: 'active', dept: 'Test', role: 'tests', cwd: 'app', writes: ['app/'], model: 'claude-haiku-4-5', effort: 'max', boot: [] },
  ceo: { id: 'ceo', name: 'ceo', kind: 'standing', mode: 'active', dept: 'Test', role: 'root', cwd: '.', writes: [], model: 'claude-haiku-4-5', effort: 'max', boot: [] },
}
vi.mock('../server/config.ts', () => ({ agent: (id: string) => AGENTS[id], agents: () => Object.values(AGENTS), agentsDoc: () => null, config: { agents: () => Object.values(AGENTS), repos: () => [] } }))

let R: typeof import('../server/chat/runner.ts')
let models: typeof import('../server/chat/models.ts')
let store: typeof import('../server/chat/store.ts')
let ledger: typeof import('../server/chat/engines/ledger.ts')

const routes: Record<string, (ctx: any) => any> = {}
const call = async (key: string, params: Record<string, string> = {}, body: unknown = {}, query: Record<string, string> = {}) => {
  try { return { status: 200, body: await routes[key]({ params, body: async () => body, query: new URLSearchParams(query) }) } }
  catch (e: any) { return { status: e.status ?? 500, body: { error: e.message } } }
}
beforeAll(async () => {
  delete process.env.DEEPSEEK_API_KEY
  vi.doMock('../server/events.ts', () => ({ publish: () => {} }))
  const rec = (m: string) => (p: string, h: any) => { routes[`${m} ${p}`] = h }
  const room = await import('../server/rooms/chats.ts')
  room.register({ get: rec('GET'), post: rec('POST'), patch: rec('PATCH'), delete: rec('DELETE'), ws: () => {} } as any)
  R = await import('../server/chat/runner.ts')
  models = await import('../server/chat/models.ts')
  store = await import('../server/chat/store.ts')
  ledger = await import('../server/chat/engines/ledger.ts')
  models.setPermitted({ at: Date.now(), error: null, models: [{ id: 'claude-haiku-4-5', aliases: [], name: 'Haiku 4.5', description: '', efforts: [] }, { id: 'claude-opus-5-5[1m]', aliases: [], name: 'Opus 5.5', description: '', efforts: ['max', 'high', 'low'] }] })
})
afterAll(async () => { await R.stopAll() })

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms))
async function settle(id: string, tries = 100) {
  for (let i = 0; i < tries; i++) { await tick(60); const e = await R.entries(id); if (!e.meta.busy && e.entries.some(x => x.kind === 'assistant')) return e }
  throw new Error('turn never closed: ' + JSON.stringify((await R.entries(id)).entries.map(x => [x.kind, x.content.slice(0, 80)])))
}
const said = (e: { entries: { kind: string; content: string }[] }, nth = -1) => JSON.parse(e.entries.filter(x => x.kind === 'assistant').at(nth)!.content)

describe('a conversation on Grok, through the runner', () => {
  let id = ''
  it('boots the Grok hand: prompt file, model, the ladder-landed effort, the fund deny rules; the owner sees the answer; usage is booked', async () => {
    const n = fakes.length
    id = (await R.start('tester', 'ping', undefined, { model: 'grok:grok-4.7', effort: null })).id
    const e = await settle(id)
    expect(fakes.length, 'no SDK query for a CLI engine').toBe(n)
    expect(e.meta.engine).toBe('grok')
    const a = said(e)
    expect(a.a).toEqual(expect.arrayContaining(['-m', 'grok-4.7', '--output-format', 'streaming-messages-json', '--permission-mode', 'bypassPermissions', '--no-plan']))
    expect(a.a[a.a.indexOf('--reasoning-effort') + 1], 'the roster says max; Grok\'s ladder tops out at xhigh').toBe('xhigh')
    expect(a.a).not.toContain('--resume')
    expect(a.denies, 'the fund\'s deny list rides along').toBeGreaterThan(50)
    expect(a.text, 'a fresh session gets the persona first').toMatch(/^# You are tester \(tester\)/)
    expect(a.text).toMatch(/ping$/)
    expect(e.entries.map(x => x.kind)).toEqual(['user', 'assistant'])
    expect(e.entries[0].forkAt, 'a Grok session is not a Claude transcript: no rewind point').toBeUndefined()
    expect(e.meta.contextPct).toBeCloseTo(0.04, 1)
    const row = await store.get(id)
    expect(row?.model).toBe('grok:grok-4.7')
    expect(row?.transcript, 'the Claude transcript head is not moved by a Grok session id').not.toBe('fake-session-1')
  })

  it('keeps the rows and the CLI session in the ledger; the second turn resumes that session with no persona', async () => {
    expect(ledger.sessionOf(id, 'grok')).toBe('fake-session-1')
    await R.send(id, 'again')
    const e = await (async () => { for (let i = 0; i < 100; i++) { await tick(60); const x = await R.entries(id); if (!x.meta.busy && x.entries.filter(y => y.kind === 'assistant').length === 2) return x } throw new Error('no second turn') })()
    const a = said(e)
    expect(a.a).toEqual(expect.arrayContaining(['--resume', 'fake-session-1']))
    expect(a.text).toBe('again')
    expect(ledger.readLedger(id)?.entries.filter(x => x.kind === 'assistant')).toHaveLength(2)
  })

  it('refuses a picture a CLI engine cannot take, and /compact it cannot run, in words', async () => {
    await expect(R.send(id, 'look', [{ data: 'data:image/png;base64,AAAA' }])).rejects.toThrow(/Grok takes no pasted images/)
    await expect(R.command(id, '/compact')).rejects.toThrow(/Grok compacts its own context/)
    expect(R.liveEngine(id)).toBe('grok')
  })

  it('a model change on a busy CLI hand is refused until the turn ends; rewind is refused', async () => {
    await R.send(id, 'third')
    await expect(R.patch(id, { model: 'grok:grok-4.7' })).rejects.toThrow(/between turns/)
    await settleN(id, 3)
    const user = (await R.entries(id)).entries.find(x => x.kind === 'user')!
    await expect(R.rewind(id, user.id)).rejects.toThrow(/keeps its own session/)
  })

  it('switching provider reboots the hand on the other engine, says so, and keeps every row', async () => {
    const n = fakes.length
    const before = (await R.entries(id)).entries.length
    expect(await R.patch(id, { model: null })).toMatchObject({ applied: 'now' })   // back to the roster's own Claude model
    await tick(100)
    expect(fakes.length).toBe(n + 1)
    expect(R.liveEngine(id)).toBe('claude')
    const e = await R.entries(id)
    expect(e.entries.length).toBeGreaterThan(before)
    const note = e.entries.find(x => x.kind === 'system' && /Switched from Grok to Claude/.test(x.content))
    expect(note?.content).toMatch(/does not carry Grok's context/)
    expect(e.entries.filter(x => x.kind === 'assistant').length, 'the Grok rows stay on screen').toBe(3)
    const row = await store.get(id)
    expect(row?.transcript, 'a Claude hand after a Grok one starts a new session').not.toBe(fakes[n].options.resume)
    expect(fakes[n].options.env.GROK_HOME ?? 'x').toBeDefined()
  })
})

async function settleN(id: string, n: number) {
  for (let i = 0; i < 100; i++) { await tick(60); const x = await R.entries(id); if (!x.meta.busy && x.entries.filter(y => y.kind === 'assistant').length === n) return x }
  throw new Error('turn never closed')
}

describe('a provider that cannot run says why, before the first token', () => {
  it('Grok with no CLI on PATH', async () => {
    const was = process.env.PATH
    const home = process.env.GROK_HOME
    process.env.PATH = ''
    process.env.GROK_HOME = join(TMP, 'nowhere')
    try { await expect(R.start('tester', 'x', undefined, { model: 'grok:grok-4.7', effort: null })).rejects.toThrow(/Grok cannot run here: `grok` is not on PATH/) }
    finally { process.env.PATH = was; process.env.GROK_HOME = home }
  })

  it('DeepSeek with no key names the variable and the file; with a key it is the SAME SDK hand on DeepSeek\'s endpoint, and the key is in that spawn only', async () => {
    const prev = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      await expect(R.start('tester', 'x', undefined, { model: 'deepseek:deepseek-flash', effort: null })).rejects.toThrow(/DeepSeek cannot run here: DEEPSEEK_API_KEY is not set/)
      process.env.DEEPSEEK_API_KEY = 'sk-ds-RUNNER-SECRET'
      process.env.EXCHANGE_API_KEY = 'bn-RUNNER-SECRET'
      const n = fakes.length
      const id = (await R.start('tester', 'hello', undefined, { model: 'deepseek:deepseek-flash', effort: null })).id
      await tick(80)
      expect(fakes.length).toBe(n + 1)
      const o = fakes[n].options as any
      expect(o.model).toBe('deepseek-flash')
      expect(o.effort).toBe('max')
      expect(o.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ds-RUNNER-SECRET')
      expect(o.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
      expect(JSON.stringify(o.env)).not.toContain('bn-RUNNER-SECRET')
      expect(R.liveEngine(id)).toBe('deepseek')
      await R.stop(id, true)
      // and a Claude hand started now holds neither
      const m = fakes.length
      const cid = (await R.start('tester', 'hi')).id
      await tick(80)
      expect(JSON.stringify((fakes[m].options as any).env)).not.toContain('sk-ds-RUNNER-SECRET')
      await R.stop(cid, true)
    } finally { delete process.env.EXCHANGE_API_KEY; if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev; else delete process.env.DEEPSEEK_API_KEY }
  })

  it('a seat whose folder holds execution/ never gets a CLI engine', async () => {
    await expect(R.start('ceo', 'x', undefined, { model: 'grok:grok-4.7', effort: null })).rejects.toThrow(/Grok will not take the ceo seat: its folder is the fund root/)
  })
})

describe('the ledger is what a closed CLI conversation reads back', () => {
  it('a conversation closed and read after the process is gone shows the same rows', async () => {
    const id = (await R.start('tester', 'remember me', undefined, { model: 'grok:grok-4.7', effort: null })).id
    await settle(id)
    await R.stop(id, true)
    await tick(100)
    expect(existsSync(join(TMP, 'data', 'foreign', `${id}.json`))).toBe(true)
    const disk = JSON.parse(readFileSync(join(TMP, 'data', 'foreign', `${id}.json`), 'utf8'))
    expect(disk.sessions.grok).toBe('fake-session-1')
    expect(disk.engine).toBe('grok')
    const e = await R.entries(id)
    expect(e.meta.live).toBe(false)
    expect(e.entries.map(x => x.kind)).toEqual(['user', 'assistant'])
  })
})

describe('the routes the pills use', () => {
  it('GET /api/chats/providers lists all four, each with its state, models and ladders', async () => {
    const r = await call('GET /api/chats/providers')
    const by = Object.fromEntries(r.body.providers.map((p: any) => [p.id, p]))
    expect(Object.keys(by)).toEqual(['claude', 'codex', 'deepseek', 'grok'])
    expect(by.claude.state).toBe('ready')
    expect(by.grok.state).toBe('ready')
    expect(by.grok.read.models[0]).toMatchObject({ id: 'grok:grok-4.7', efforts: ['xhigh', 'high', 'low'] })
    expect(by.deepseek.state).toBe('no-key')
    expect(by.deepseek.note).toMatch(/DEEPSEEK_API_KEY/)
    expect(by.deepseek.read.models.map((m: any) => m.id)).toEqual(['deepseek:deepseek-flash', 'deepseek:deepseek-v4-pro'])
    expect(JSON.stringify(r.body)).not.toMatch(/sk-/)
  })

  it('PATCH refuses a provider that cannot run, an effort off the model ladder, and lands an orphaned effort on the new ladder', async () => {
    const id = (await R.start('tester', 'hi', undefined, { model: 'claude-opus-5-5[1m]', effort: 'max' })).id
    await tick(80)
    const ds = await call('PATCH /api/chats/:id', { id }, { model: 'deepseek:deepseek-flash' })
    expect(ds.status).toBe(400)
    expect(ds.body.error).toMatch(/DeepSeek cannot run here: DEEPSEEK_API_KEY is not set/)
    expect((await call('PATCH /api/chats/:id', { id }, { model: 'codex:default' })).body.error).toMatch(/Codex cannot run here: `codex` is not on PATH/)
    const off = await call('PATCH /api/chats/:id', { id }, { model: 'grok:grok-4.7', effort: 'max' })
    expect(off.status).toBe(400)
    expect(off.body.error).toBe('grok:grok-4.7 takes effort xhigh, high, low')
    await R.stop(id, true)
    await tick(60)
    const ok = await call('PATCH /api/chats/:id', { id }, { model: 'grok:grok-4.7' })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ model: 'grok:grok-4.7', effort: 'xhigh', effective: 'xhigh' })   // the stored max had no rung on Grok's ladder: the server's answer wins
    expect((await store.get(id))).toMatchObject({ model: 'grok:grok-4.7', effort: 'xhigh' })
  })

  it('a provider switch on a running turn is a 409 that says why, and changes nothing', async () => {
    const id = (await R.start('tester', 'ping', undefined, { model: 'grok:grok-4.7', effort: 'low' })).id
    const r = await call('PATCH /api/chats/:id', { id }, { model: null })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/Grok changes model between turns: stop the running turn first/)
    expect((await store.get(id))?.model).toBe('grok:grok-4.7')
    await settle(id)
  })
})
