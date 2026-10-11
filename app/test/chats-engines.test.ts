import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent } from '../shared/types.ts'
import { CAPS, capsNote, dialId, engineOf, nearestEffort, bareModel } from '../shared/engines.ts'
import { DEEPSEEK_DECLARED, parseCodexCache, parseCodexState, parseGrokCache, readCodex, readDeepseek, readGrok } from '../server/chat/engines/catalog.ts'
import { haveKey, keyHome, noKeyLine, providerKey } from '../server/chat/engines/keys.ts'
import { landEffort } from '../server/chat/engines/land.ts'
import { readLedger, sessionOf, writeLedger } from '../server/chat/engines/ledger.ts'
import { adapt as grokAdapt, denyArgs, grokArgv, resultText } from '../server/chat/engines/grok.ts'
import { adapt as codexAdapt, codexArgv, unwrapShell, usageFromRollout } from '../server/chat/engines/codex.ts'
import { spawnForeign, spawnPlan, type ForeignState } from '../server/chat/engines/foreign.ts'
import { buildLaunch, foreignRefusal, SETTINGS_FILE } from '../server/chat/launch.ts'
import { newNormState, normalize } from '../server/chat/normalize.ts'
import { dialOf, landOnModel, landOnProvider, pressable } from '../src/rooms/chats/dial.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'engines-'))

// ---- the catalog: each provider's models and ladders READ from where the host says them

const GROK_CACHE = JSON.stringify({
  fetched_at: '2026-10-01T17:33:57Z',
  models: {
    'grok-4.7': { info: { id: 'grok-4.7', name: 'Grok 4.7', description: 'latest', hidden: false, supports_reasoning_effort: true, reasoning_efforts: [{ id: 'xhigh' }, { id: 'high' }, { id: 'medium' }, { id: 'low' }] } },
    'grok-fast': { info: { id: 'grok-fast', name: 'Grok Fast', hidden: false, supports_reasoning_effort: false, reasoning_efforts: [{ id: 'high' }] } },
    'grok-secret': { info: { id: 'grok-secret', name: 'Hidden', hidden: true, supports_reasoning_effort: false } },
  },
})

describe('provider catalog: parse', () => {
  it('Grok: one row per visible model, its OWN ladder (strongest first), none when it takes no effort', () => {
    const rows = parseGrokCache(GROK_CACHE)
    expect(rows.map(r => r.id)).toEqual(['grok-4.7', 'grok-fast'])
    expect(rows[0].efforts).toEqual(['xhigh', 'high', 'medium', 'low'])
    expect(rows[1].efforts, 'a model with no reasoning dial must not borrow a ladder').toEqual([])
    expect(parseGrokCache('not json')).toEqual([])
  })

  it('Codex: the roster sentence the desktop app caches, and the CLI models_cache, both give ladders', () => {
    const blob = JSON.stringify({ x: 'Models and supported reasoning efforts on the calling host: gpt-6-astra (the big one; supported reasoning efforts: low, medium, ultra, high), gpt-5.5 (older; supported reasoning efforts: low, high), tail' })
    const rows = parseCodexState(blob)
    expect(rows.map(r => r.id)).toEqual(['gpt-6-astra', 'gpt-5.5'])
    expect(rows[0].efforts).toEqual(['ultra', 'high', 'medium', 'low'])
    expect(rows[0].name).toBe('GPT-6 Astra')
    expect(parseCodexState('{}')).toEqual([])
    const cache = JSON.stringify({ models: [{ slug: 'gpt-x', display_name: 'GPT X', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }, { slug: 'gpt-hidden', visibility: 'hide' }] })
    expect(parseCodexCache(cache)).toEqual([{ id: 'gpt-x', name: 'GPT X', efforts: ['high', 'low'] }])
  })
})

describe('provider catalog: a provider that cannot run says so on its own row', () => {
  it('Grok: no CLI, not signed in, no list, then ready with prefixed ids', () => {
    const home = tmp()
    expect(readGrok(null, home)).toMatchObject({ id: 'grok', state: 'no-cli' })
    const noAuth = readGrok('grok', home)
    expect(noAuth).toMatchObject({ state: 'no-key' })
    expect(noAuth.note).toMatch(/grok login/)
    writeFileSync(join(home, 'auth.json'), '{}')
    expect(readGrok('grok', home)).toMatchObject({ state: 'unread' })
    writeFileSync(join(home, 'models_cache.json'), GROK_CACHE)
    const ok = readGrok('grok', home)
    expect(ok.state).toBe('ready')
    expect(ok.read.models.map(m => m.id)).toEqual(['grok:grok-4.7', 'grok:grok-fast'])
    expect(ok.read.models.every(m => engineOf(m.id) === 'grok')).toBe(true)
  })

  it('Codex: no CLI is its own state; a host with no list gets ONE default row, never a typed roster', () => {
    const home = tmp()
    expect(readCodex(null, home)).toMatchObject({ id: 'codex', state: 'no-cli' })
    const bare = readCodex('codex', home)
    expect(bare.state).toBe('ready')
    expect(bare.read.models.map(m => m.id)).toEqual(['codex:default'])
    expect(bare.note).toMatch(/no model list on this host/)
    writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify({ x: 'Models and supported reasoning efforts on the calling host: gpt-5.5 (m; supported reasoning efforts: low, high)' }))
    expect(readCodex('codex', home).read.models.map(m => m.id)).toEqual(['codex:gpt-5.5'])
  })

  it('DeepSeek: always listed; no key names the variable and the file; the key never appears in a read', async () => {
    const none = await readDeepseek(null)
    expect(none.state).toBe('no-key')
    expect(none.note).toMatch(/DEEPSEEK_API_KEY/)
    expect(none.read.models.map(m => m.id)).toEqual(DEEPSEEK_DECLARED.map(d => `deepseek:${d.id}`))

    const SECRET = 'sk-ds-do-not-print'
    let sent = ''
    const live = await readDeepseek(SECRET, async (_u, init) => { sent = init.headers.authorization; return { ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-v5' }] }) } })
    expect(sent).toBe(`Bearer ${SECRET}`)
    expect(live).toMatchObject({ state: 'ready', source: 'api' })
    expect(live.note).toMatch(/deepseek-v5/)                      // an id the declared rows do not know is said, not smoothed over
    expect(JSON.stringify(live)).not.toContain(SECRET)

    const gone = await readDeepseek(SECRET, async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-flash' }] }) }))
    expect(gone.read.models.map(m => m.id)).toEqual(['deepseek:deepseek-flash'])
    expect(gone.note).toMatch(/not listed by DeepSeek now: deepseek-v4-pro/)

    const bad = await readDeepseek(SECRET, async () => ({ ok: false, status: 401, json: async () => ({}) }))
    expect(bad.state).toBe('no-key')
    expect(bad.note).toMatch(/401/)
    const down = await readDeepseek(SECRET, async () => { throw new Error('ENOTFOUND') })
    expect(down.state).toBe('ready')
    expect(down.note).toMatch(/unreachable \(ENOTFOUND\)/)
    expect(JSON.stringify([bad, down])).not.toContain(SECRET)
  })

  it('a provider that cannot run is listed but not pressable', () => {
    expect(pressable(readGrok(null))).toBe(false)
    expect(pressable({ ...readGrok(null), state: 'ready' })).toBe(true)
  })
})

describe('provider keys', () => {
  const dotenv = (text: string | null) => { const root = tmp(); if (text !== null) writeFileSync(join(root, '.env'), text); return root }

  it('the machine env wins, then the root dotenv file; a key is only ever for the one provider that names it', () => {
    const root = dotenv(null)
    expect(providerKey('deepseek', {}, root), 'a missing file is no key').toBeNull()
    expect(haveKey('deepseek', {}, root)).toBe(false)
    writeFileSync(join(root, '.env'), 'DEEPSEEK_API_KEY=  sk-file  \n')
    expect(providerKey('deepseek', {}, root)).toBe('sk-file')
    expect(providerKey('deepseek', { DEEPSEEK_API_KEY: 'sk-env' }, root)).toBe('sk-env')
    expect(providerKey('grok', { DEEPSEEK_API_KEY: 'sk-env' }, root), 'Grok signs in through its own CLI: it has no key here').toBeNull()
    expect(providerKey('claude', {}, dotenv('DEEPSEEK_API_KEY=sk-file\n'))).toBeNull()
  })

  it('the dotenv parse: quotes, an empty value, comments and blanks, other variables ignored', () => {
    expect(providerKey('deepseek', {}, dotenv('DEEPSEEK_API_KEY="sk-quoted"\n'))).toBe('sk-quoted')
    expect(providerKey('deepseek', {}, dotenv("DEEPSEEK_API_KEY='sk-single'\r\n"))).toBe('sk-single')
    expect(providerKey('deepseek', {}, dotenv('DEEPSEEK_API_KEY=\n')), 'an empty value is no key').toBeNull()
    expect(providerKey('deepseek', {}, dotenv('DEEPSEEK_API_KEY=""\n'))).toBeNull()
    expect(providerKey('deepseek', {}, dotenv('# DEEPSEEK_API_KEY=sk-commented\n\n   \n')), 'a comment line is not a value').toBeNull()
    expect(providerKey('deepseek', {}, dotenv('OTHER=1\nDEEPSEEK_API_KEY=sk-b\nEXCHANGE_API_KEY=bn\n'))).toBe('sk-b')
    expect(providerKey('deepseek', {}, dotenv('XDEEPSEEK_API_KEY=sk-x\nDEEPSEEK_API_KEY_2=sk-y\n')), 'only the exact variable').toBeNull()
    expect(providerKey('deepseek', {}, dotenv('export DEEPSEEK_API_KEY=sk-exp\n'))).toBe('sk-exp')
    expect(providerKey('deepseek', {}, dotenv('DEEPSEEK_API_KEY=sk-a=b\n')), 'a value may hold =').toBe('sk-a=b')
  })

  it('the no-key line names the dotenv file and the variable, never a value', () => {
    const root = dotenv('DEEPSEEK_API_KEY=\n')
    const line = noKeyLine('deepseek', root)
    expect(line).toContain('DEEPSEEK_API_KEY')
    expect(line).toContain(join(root, '.env'))
    expect(keyHome('claude')).toBeNull()
  })
})

// ---- the key never reaches another provider's env

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'research', name: 'research', kind: 'standing', mode: 'active', dept: 'Research', role: 'Runs studies',
  cwd: 'platform/research', writes: ['platform/research/'], model: 'claude-opus-5-5[1m]', effort: 'max', boot: [], ...over,
})
const HOST = {
  PATH: 'C:\\bin', HOME: 'C:\\h', USERPROFILE: 'C:\\h',
  DEEPSEEK_API_KEY: 'sk-ds-SECRET', EXCHANGE_API_KEY: 'bn-SECRET', BROKER_PASSWORD: 'ib-SECRET',
  ANTHROPIC_API_KEY: 'sk-ant-SECRET', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-SECRET', XAI_API_KEY: 'xai-SECRET',
}
const launchOn = (model: string, env: Record<string, string | undefined> = HOST) =>
  buildLaunch({ agent: agent(), conversationId: 'c-test-9', uuid: '00000000-0000-4000-8000-000000000009', resume: false, model, env })
const holds = (env: Record<string, string | undefined>, secret: string) => Object.values(env).some(v => (v ?? '').includes(secret))

describe('credentials: a key reaches only its own provider', () => {
  it('a Claude hand holds no other provider key and no venue credential', () => {
    const l = launchOn('claude-opus-5-5[1m]')
    expect(l.engine).toBe('claude')
    expect(l.env.ANTHROPIC_API_KEY).toBe('sk-ant-SECRET')           // its own
    for (const s of ['sk-ds-SECRET', 'bn-SECRET', 'ib-SECRET', 'xai-SECRET']) expect(holds(l.env, s), s).toBe(false)
  })

  it('a Grok or Codex hand holds NO provider key at all: not DeepSeek, not xAI, not the owner\'s Anthropic one, not a venue', () => {
    for (const m of ['grok:grok-4.7', 'codex:gpt-5.5']) {
      const l = launchOn(m)
      for (const s of ['sk-ds-SECRET', 'bn-SECRET', 'ib-SECRET', 'sk-ant-SECRET', 'oauth-SECRET', 'xai-SECRET']) expect(holds(l.env, s), `${m} holds ${s}`).toBe(false)
      expect(l.env.PATH).toContain('C:\\bin')
      expect(l.env.FUND_AGENT).toBe('research')
    }
  })

  it('a DeepSeek hand holds the DeepSeek key as its token, the endpoint, every model slot pinned, and nothing else secret', () => {
    const l = launchOn('deepseek:deepseek-v4-pro')
    expect(l.engine).toBe('deepseek')
    expect(l.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ds-SECRET')
    expect(l.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(l.env.ANTHROPIC_API_KEY, 'an Anthropic key would outrank the token and go to DeepSeek').toBeUndefined()
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) expect(l.env[k], k).toBe('deepseek-v4-pro')
    expect(l.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1048576')
    for (const s of ['bn-SECRET', 'ib-SECRET', 'oauth-SECRET', 'xai-SECRET', 'sk-ant-SECRET']) expect(holds(l.env, s), s).toBe(false)
    expect((l.options as any).env).toBe(l.env)
  })

  it('a DeepSeek hand with no key refuses to boot and names what is missing', () => {
    const { DEEPSEEK_API_KEY: _k, ...noKey } = HOST
    const root = tmp()
    writeFileSync(join(root, '.env'), 'DEEPSEEK_API_KEY=\n')
    const boot = (model: string) => buildLaunch({ agent: agent(), conversationId: 'c-test-9', uuid: '00000000-0000-4000-8000-000000000009', resume: false, model, env: noKey, fundRoot: root })
    expect(() => boot('deepseek:deepseek-flash')).toThrow(/DEEPSEEK_API_KEY is not set.*\.env/)
  })

  it('a key that is only in the root dotenv file reaches a DeepSeek spawn and no Codex, Grok or Claude spawn, and no other line of the file reaches any', () => {
    const { DEEPSEEK_API_KEY: _k, EXCHANGE_API_KEY: _b, ...noKeys } = HOST
    const root = tmp()
    writeFileSync(join(root, '.env'), '# keys\nDEEPSEEK_API_KEY="sk-ds-FILE"\nEXCHANGE_API_KEY=bn-FILE\nBROKER_PASSWORD=ib-FILE\n')
    const on = (model: string) => buildLaunch({ agent: agent(), conversationId: 'c-test-9', uuid: '00000000-0000-4000-8000-000000000009', resume: false, model, env: noKeys, fundRoot: root })
    const ds = on('deepseek:deepseek-v4-pro')
    expect(ds.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ds-FILE')
    for (const s of ['bn-FILE', 'ib-FILE']) expect(holds(ds.env, s), `deepseek holds ${s}`).toBe(false)
    for (const m of ['codex:gpt-5.5', 'grok:grok-4.7', 'claude-opus-5-5[1m]']) {
      const l = on(m)
      for (const s of ['sk-ds-FILE', 'bn-FILE', 'ib-FILE']) expect(holds(l.env, s), `${m} holds ${s}`).toBe(false)
    }
    expect(process.env.DEEPSEEK_API_KEY, 'reading the file never loads it into the process env').not.toBe('sk-ds-FILE')
  })
})

describe('effort re-landing', () => {
  const CLAUDE = ['max', 'xhigh', 'high', 'medium', 'low']
  it('an effort off the new ladder lands on the nearest rung at or below it', () => {
    expect(nearestEffort(CLAUDE, 'ultra')).toBe('max')
    expect(nearestEffort(['xhigh', 'high', 'medium', 'low'], 'max')).toBe('xhigh')
    expect(nearestEffort(['max', 'high', 'low'], 'medium')).toBe('low')
    expect(nearestEffort(['max', 'high', 'low'], 'xhigh')).toBe('high')
    expect(nearestEffort(CLAUDE, 'high')).toBe('high')
    expect(nearestEffort([], 'high')).toBe('')
    expect(nearestEffort(['high', 'low'], 'none')).toBe('low')
  })

  it('the server lands an orphaned effort when the model changes, refuses one the model lacks, clears it on a model with no dial', () => {
    expect(landEffort(['max', 'high', 'low'], { modelChanged: true, asked: undefined, stored: 'xhigh' })).toEqual({ effort: 'high' })
    expect(landEffort(['max', 'high', 'low'], { modelChanged: true, asked: undefined, stored: 'high' })).toEqual({ effort: undefined })
    expect(landEffort(['max', 'high', 'low'], { modelChanged: false, asked: 'medium', stored: null })).toEqual({ error: 'takes effort max, high, low' })
    expect(landEffort([], { modelChanged: true, asked: undefined, stored: 'high' })).toEqual({ effort: null })
    expect(landEffort(undefined, { modelChanged: true, asked: 'high', stored: null })).toEqual({ effort: 'high' })
  })

  it('a launch lands the roster effort on the CLI model\'s own ladder (Grok has no max: it gets xhigh)', () => {
    const l = launchOn('deepseek:deepseek-flash')
    expect(l.effort).toBe('max')                               // DeepSeek's ladder reaches max
    const g = buildLaunch({ agent: agent({ effort: 'max' }), conversationId: 'c-t', uuid: 'u', resume: false, model: 'deepseek:deepseek-v4-pro', effort: 'xhigh', env: HOST })
    expect(g.effort).toBe('high')                              // xhigh is not on low/high/max: nearest at or below
  })

  it('the pills show the rung the model lands on, and a provider pick lands on that provider\'s model', () => {
    const grok = readGrok('grok', (() => { const h = tmp(); writeFileSync(join(h, 'auth.json'), '{}'); writeFileSync(join(h, 'models_cache.json'), GROK_CACHE); return h })())
    const ds = { ...grok, id: 'deepseek' as const, name: 'DeepSeek', read: { ...grok.read, models: DEEPSEEK_DECLARED.map(d => ({ id: dialId('deepseek', d.id), aliases: [], name: d.name, description: '', efforts: [...d.efforts] })) } }
    const claude = { ...grok, id: 'claude' as const, name: 'Claude', read: { ...grok.read, models: [{ id: 'claude-opus-5-5[1m]', aliases: ['opus'], name: 'Opus 5.5', description: '', efforts: CLAUDE_LADDER }] } }
    const all = [claude, ds, grok]
    expect(dialOf(all, 'grok:grok-4.7', null, 'max')).toMatchObject({ engine: 'grok', effort: 'xhigh', ladder: ['xhigh', 'high', 'medium', 'low'] })
    expect(dialOf(all, 'grok:grok-fast', 'high', 'max')).toMatchObject({ ladder: [], effort: '' })
    expect(dialOf(all, 'opus', null, 'high').model?.id, 'a stored alias resolves to its row').toBe('claude-opus-5-5[1m]')
    expect(dialOf(undefined, 'grok:grok-4.7', null, 'max').ladder, 'unloaded is unknown, not none').toBeNull()
    expect(landOnProvider(all, 'grok', 'claude-opus-5-5[1m]')).toBe('grok:grok-4.7')
    expect(landOnProvider(all, 'claude', 'claude-opus-5-5[1m]'), 'back to the roster\'s own Claude model clears the override').toBeNull()
    expect(landOnModel('claude-opus-5-5[1m]', 'claude-opus-5-5[1m]')).toBeNull()
    expect(landOnModel('grok:grok-fast', 'claude-opus-5-5[1m]')).toBe('grok:grok-fast')
  })
})
const CLAUDE_LADDER = ['max', 'xhigh', 'high', 'medium', 'low']

describe('engine ids and caps', () => {
  it('the prefix routes; a bare id is Claude; an unknown prefix is not an engine', () => {
    expect(engineOf('claude-opus-5-5[1m]')).toBe('claude')
    expect(engineOf('grok:grok-4.7')).toBe('grok')
    expect(engineOf('codex:gpt-5.5')).toBe('codex')
    expect(engineOf('deepseek:deepseek-flash')).toBe('deepseek')
    expect(engineOf('cursor:gpt-5')).toBe('claude')
    expect(engineOf(null)).toBe('claude')
    expect(bareModel('grok:grok-4.7')).toBe('grok-4.7')
    expect(bareModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
  })
  it('a CLI engine says what it cannot do: the sentence the pill shows', () => {
    expect(CAPS.grok.planMode).toBe(false)
    expect(capsNote('grok')).toMatch(/Grok has no plan mode, decision cards, pasted images/)
    expect(capsNote('claude')).toBe('')
    expect(capsNote('deepseek')).toMatch(/live model swap/)
  })
})

// ---- the trading guard

describe('the trading guard for a CLI engine', () => {
  it('refuses a seat whose folder is execution/ or the fund root, or that may write under execution/', () => {
    expect(foreignRefusal({ cwd: '.', writes: [] })).toMatch(/fund root/)
    expect(foreignRefusal({ cwd: '', writes: [] })).toMatch(/fund root/)
    expect(foreignRefusal({ cwd: 'execution', writes: [] })).toMatch(/execution/)
    expect(foreignRefusal({ cwd: 'execution/fundexec', writes: [] })).toMatch(/execution/)
    expect(foreignRefusal({ cwd: 'platform', writes: ['execution/'] })).toMatch(/write under execution/)
    expect(foreignRefusal({ cwd: 'platform', writes: ['./execution'] })).toMatch(/write under execution/)
    expect(foreignRefusal({ cwd: 'app', writes: ['app/'] })).toBeNull()
    expect(foreignRefusal({ cwd: 'platform/research', writes: ['platform/research/'] })).toBeNull()
    expect(foreignRefusal({ cwd: 'executioner', writes: [] }), 'a folder that merely starts with the word').toBeNull()
  })

  it('Grok is handed the fund\'s own deny list rule for rule (a PowerShell row as the Bash row it twins: Grok refuses the whole turn on a tool prefix it does not know); a missing file hands none', () => {
    const deny = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).permissions.deny as string[]
    const want = [...new Set(deny.map(r => r.replace(/^PowerShell\(/, 'Bash(')))]
    const args = denyArgs(SETTINGS_FILE)
    expect(args.filter((_, i) => i % 2 === 0).every(a => a === '--deny')).toBe(true)
    expect(args.filter((_, i) => i % 2 === 1)).toEqual(want)
    expect(args.some(a => a.startsWith('PowerShell('))).toBe(false)
    expect(deny.length > 100 && want.length > 50, 'the list under test is the real one').toBe(true)
    expect(denyArgs(join(tmp(), 'nope.json'))).toEqual([])
  })

  it('no engine is given an order-shaped or live-arming path: the argv carries the deny rules and no bypass-everything flag', () => {
    const g = grokArgv({ model: 'grok-4.7', effort: 'high', deny: ['--deny', 'Bash(*--live*)'], promptFile: 'p.txt' })
    expect(g).toContain('Bash(*--live*)')
    expect(g).toEqual(expect.arrayContaining(['--disallowed-tools', 'ask_user_question,enter_plan_mode,exit_plan_mode', '--no-plan']))
    const c = codexArgv({ model: 'gpt-5.5', effort: 'high', cwd: 'C:\\x' })
    expect(c).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(c.join(' ')).toContain('--sandbox workspace-write')
  })
})

// ---- the adapters: a CLI's stream in, SDK-shaped messages out, ONE normalizer after

const st = (over: Partial<ForeignState> = {}): ForeignState => ({ turn: 0, tag: 't1-', ...over })
const run = (msgs: any[], s: ForeignState, ad: (r: Record<string, unknown>, s: ForeignState) => any[]) => {
  const ns = newNormState()
  return msgs.flatMap(m => ad(m, s)).flatMap(m => normalize(m, ns))
}

describe('Grok adapter (frames as the CLI printed them, 1.0.46)', () => {
  const INIT = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'grok-4.7', apiKeySource: 'oauth', uuid: 'a' }
  const TOOL_TURN = [
    { type: 'assistant', message: { id: 'msg_0', role: 'assistant', model: 'grok-4.7', content: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }, { type: 'tool_use', id: 'call-1', name: 'run_terminal_command', input: { command: 'echo hi', description: 'say hi' } }], usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 50 } }, parent_tool_use_id: null, session_id: 'sess-1', uuid: 'u1' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: JSON.stringify({ type: 'Bash', output: [104, 105], output_for_prompt: 'exit: 0\nhi\n', exit_code: 0 }), is_error: false }] }, parent_tool_use_id: null, session_id: 'sess-1', uuid: 'u2' },
    { type: 'assistant', message: { id: 'msg_1', role: 'assistant', model: 'grok-4.7', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 150 } }, parent_tool_use_id: null, session_id: 'sess-1', uuid: 'u3' },
    { type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0.05, usage: { input_tokens: 110, output_tokens: 7 }, modelUsage: { 'grok-4.7': { inputTokens: 110, outputTokens: 7, cacheReadInputTokens: 200, cacheCreationInputTokens: 0, contextWindow: 256000 } }, session_id: 'sess-1', uuid: 'u4' },
  ]

  it('feeds the one normalizer: a command row with the real output, the answer, the turn close', () => {
    const s = st()
    const out = run([INIT, ...TOOL_TURN], s, grokAdapt)
    expect(s.sessionId).toBe('sess-1')
    expect(out.find(e => e.t === 'head'), 'a Grok session id must not move the conversation\'s Claude transcript head').toBeUndefined()
    const tool = out.filter(e => e.t === 'entry' && e.e.kind === 'tool')
    expect(tool[0]).toMatchObject({ e: { status: 'created', action: { type: 'command', verb: 'Bash', cmd: 'echo hi' } } })
    expect(tool[1]).toMatchObject({ e: { status: 'success', content: 'exit: 0\nhi\n' } })
    expect(out.some(e => e.t === 'entry' && e.e.kind === 'assistant' && e.e.content === 'Done.')).toBe(true)
    expect(out.some(e => e.t === 'meta' && (e.m as any).busy === false)).toBe(true)
  })

  it('message ids stay unique across turns (the CLI restarts them at msg_0 every process)', () => {
    const ids = (tag: string) => run(TOOL_TURN, st({ tag }), grokAdapt).filter(e => e.t === 'entry' && e.e.kind === 'assistant').map(e => (e as any).e.id)
    const a = ids('turn1-'), b = ids('turn2-')
    expect(a.length).toBeGreaterThan(0)
    expect(a.filter(x => b.includes(x)), 'turn 2 must not overwrite turn 1\'s rows').toEqual([])
  })

  it('usage is cumulative per hand (the runner diffs it), the gauge is the last request over the window', () => {
    const s = st()
    const r1 = grokAdapt(TOOL_TURN[3] as any, s)[0] as any
    const r2 = grokAdapt({ ...(TOOL_TURN[3] as any), total_cost_usd: 0.02 }, st({ ...s, cum: s.cum }))[0] as any
    expect(r1.total_cost_usd).toBeCloseTo(0.05)
    expect(r2.total_cost_usd).toBeCloseTo(0.07)
    expect(r2.modelUsage['grok-4.7'].inputTokens).toBe(220)
    grokAdapt(TOOL_TURN[2] as any, s)
    grokAdapt(TOOL_TURN[3] as any, s)
    expect(s.usage).toMatchObject({ totalTokens: 160, maxTokens: 256000 })
  })

  it('an error result keeps the CLI\'s own words', () => {
    const out = run([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['401 not signed in'], session_id: 's', uuid: 'e' }], st(), grokAdapt)
    expect(out.find(e => e.t === 'entry' && e.e.kind === 'error')).toMatchObject({ e: { content: '401 not signed in' } })
  })

  it('flattens a tool result blob to text', () => {
    expect(resultText(JSON.stringify({ type: 'ReadFile', FileContent: { content: '1|hello' } }))).toBe('1|hello')
    expect(resultText(JSON.stringify({ type: 'SearchReplace', EditsApplied: { tool_output_for_prompt_concise: 'updated' } }))).toBe('updated')
    expect(resultText('plain text')).toBe('plain text')
  })
})

describe('Codex adapter (the studio\'s recorded stream; not run against a live Codex here)', () => {
  it('thread, a command that starts and completes, a command that only completes, a message, a closing turn', () => {
    const s = st({ model: 'gpt-5.5' })
    const out = run([
      { type: 'thread.started', thread_id: 'thr-1' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: '/bin/zsh -lc "ls -la"' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: '/bin/zsh -lc "ls -la"', aggregated_output: 'a b', exit_code: 0 } },
      { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1 } },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'all done' } },
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 9 } },
    ], s, codexAdapt)
    expect(s.sessionId).toBe('thr-1')
    expect(out.find(e => e.t === 'head')).toBeUndefined()
    const tools = out.filter(e => e.t === 'entry' && e.e.kind === 'tool') as any[]
    expect(tools[0].e).toMatchObject({ status: 'created', action: { cmd: 'ls -la' } })    // the login-shell wrapper is unwrapped
    expect(tools.find(t => t.e.toolUseId === 'i2' && t.e.status === 'failed')).toBeTruthy()  // completed without a start: call + result together
    expect(out.some(e => e.t === 'entry' && e.e.kind === 'assistant' && e.e.content === 'all done')).toBe(true)
    expect(out.some(e => e.t === 'usage')).toBe(true)
    expect(out.some(e => e.t === 'meta' && (e.m as any).busy === false)).toBe(true)
  })

  it('a failed turn is an error row; usage accumulates; the unwrapper keeps a plain command', () => {
    const s = st({ model: 'm' })
    const r = (u: number) => codexAdapt({ type: 'turn.failed', usage: { input_tokens: u, output_tokens: 1 }, error: { message: 'rate limited' } }, s)[0] as any
    expect(r(10).result).toBe('rate limited')
    expect(r(5).modelUsage.m.inputTokens).toBe(15)
    expect(unwrapShell('git status')).toBe('git status')
  })

  it('the gauge reads the rollout\'s last request over the window, never the turn\'s summed usage', () => {
    const lines = ['{"payload":{"info":{"last_token_usage":{"input_tokens":1},"model_context_window":100}},"x":"token_count"}', '{"x":"token_count","payload":{"info":{"last_token_usage":{"input_tokens":20000},"model_context_window":258400}}}', 'torn {']
    expect(usageFromRollout(lines)).toMatchObject({ totalTokens: 20000, maxTokens: 258400 })
    expect(usageFromRollout(['nothing'])).toBeUndefined()
  })

  it('exec argv: resume is a subcommand right after exec, -C only on a fresh one, the default row passes no -m', () => {
    expect(codexArgv({ model: 'gpt-5.5', effort: 'high', cwd: 'C:\\x' }).slice(0, 4)).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox'])
    const r = codexArgv({ model: 'gpt-5.5', effort: 'high', resumeId: 'thr-1', cwd: 'C:\\x' })
    expect(r.slice(0, 3)).toEqual(['exec', 'resume', 'thr-1'])
    expect(r).not.toContain('-C')
    expect(codexArgv({ model: 'default', cwd: 'x' })).not.toContain('-m')
    expect(codexArgv({ model: 'default', cwd: 'x' }).join(' ')).not.toContain('model_reasoning_effort')
  })
})

// ---- the one-process-per-turn hand, driven by a fake CLI

const FAKE = join(tmp(), 'fake-cli.mjs')
const STARTED = join(tmp(), 'started')
writeFileSync(FAKE, `
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const mode = args.find(a => a.startsWith('mode='))?.slice(5) ?? 'ok'
let text = ''
const f = args.indexOf('--prompt-file')
if (f >= 0) text = readFileSync(args[f + 1], 'utf8')
else { for await (const c of process.stdin) text += c }
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
if (mode === 'crash') { process.stderr.write('401 Unauthorized: sign in'); process.exit(3) }
if (mode === 'hang') { out({ type: 'init', sid: 'S1' }); writeFileSync(args.find(a => a.startsWith('touch=')).slice(6), 'up'); setInterval(() => {}, 1000) }
else {
  out({ type: 'init', sid: 'S1' })
  out({ type: 'say', text: JSON.stringify({ args, text }) })
  out({ type: 'done' })
}
`)
const fakeAdapt = (raw: Record<string, unknown>, s: ForeignState): any[] => {
  if (raw.type === 'init') { s.sessionId = String(raw.sid); return [] }
  if (raw.type === 'say') return [{ type: 'assistant', uuid: `a${Math.random()}`, message: { id: `m${Math.random()}`, content: [{ type: 'text', text: String(raw.text) }] } }]
  if (raw.type === 'done') return [{ type: 'result', subtype: 'success', is_error: false, uuid: `r${Math.random()}`, result: '' }]
  return []
}
function hand(mode: string, over: Record<string, unknown> = {}) {
  const ac = new AbortController()
  const q: ((m: any) => void)[] = []
  const queue: any[] = []
  let wake: (() => void) | null = null
  const prompts = (async function* () { for (;;) { while (queue.length) { const m = queue.shift(); if (m === null) return; yield m } await new Promise<void>(r => { wake = r }) } })()
  const send = (t: string | null) => { queue.push(t === null ? null : { type: 'user', message: { role: 'user', content: t } }); wake?.() }
  void q
  const h = spawnForeign({ label: 'Fake', bin: process.execPath, cwd: tmpdir(), env: process.env as any, model: 'm', prompt: mode === 'file' ? 'file' : 'stdin', preamble: 'PERSONA', signal: ac.signal, adapt: fakeAdapt, argv: a => [FAKE, `mode=${mode === 'file' ? 'ok' : mode}`, `touch=${STARTED}`, ...(mode === 'file' ? ['--prompt-file', a.promptFile!] : []), ...(a.resumeId ? ['resume', a.resumeId] : [])], ...over }, prompts)
  return { h, send, ac }
}
async function until(it: AsyncIterator<any>, pred: (m: any) => boolean, max = 20): Promise<any[]> {
  const seen: any[] = []
  for (let i = 0; i < max; i++) { const n = await it.next(); if (n.done) break; seen.push(n.value); if (pred(n.value)) break }
  return seen
}
const said = (msgs: any[]) => JSON.parse(msgs.find(m => m.type === 'assistant').message.content[0].text)

describe('a foreign hand: one CLI process per turn', () => {
  it('turn 1 carries the persona and no resume; turn 2 resumes the CLI\'s own session with no persona', async () => {
    const { h, send, ac } = hand('ok')
    const it = h[Symbol.asyncIterator]()
    send('first')
    const t1 = await until(it, m => m.type === 'result')
    const a1 = said(t1)
    expect(a1.text).toBe('PERSONA\n\n---\n\nfirst')
    expect(a1.args).not.toContain('resume')
    expect(h.sessionId()).toBe('S1')
    send('second')
    const a2 = said(await until(it, m => m.type === 'result'))
    expect(a2.args).toEqual(expect.arrayContaining(['resume', 'S1']))
    expect(a2.text, 'a resumed session already holds the persona').toBe('second')
    ac.abort(); send(null)
  })

  it('a reopened conversation seeds the session: no persona, resume from the first turn', async () => {
    const { h, send, ac } = hand('ok', { seed: { sessionId: 'OLD' } })
    const it = h[Symbol.asyncIterator]()
    send('hello again')
    const a = said(await until(it, m => m.type === 'result'))
    expect(a.args).toEqual(expect.arrayContaining(['resume', 'OLD']))
    expect(a.text).toBe('hello again')
    ac.abort(); send(null)
  })

  it('a prompt file carries the text and is gone after the turn', async () => {
    const { h, send, ac } = hand('file')
    const it = h[Symbol.asyncIterator]()
    send('via file')
    const a = said(await until(it, m => m.type === 'result'))
    expect(a.text).toContain('via file')
    const path = a.args[a.args.indexOf('--prompt-file') + 1]
    void it.next()                                  // the loop's cleanup runs once the consumer asks for more
    await new Promise(r => setTimeout(r, 300))
    expect(() => readFileSync(path)).toThrow()
    ac.abort(); send(null)
  })

  it('a CLI that dies with nothing on stdout becomes an error result with its stderr, and the hand takes the next message', async () => {
    const { h, send, ac } = hand('crash')
    const it = h[Symbol.asyncIterator]()
    send('x')
    const t = await until(it, m => m.type === 'result')
    expect(t[t.length - 1]).toMatchObject({ is_error: true })
    expect(t[t.length - 1].result).toMatch(/Fake: 401 Unauthorized: sign in/)
    send('y')
    expect((await until(it, m => m.type === 'result')).pop()).toMatchObject({ is_error: true })
    ac.abort(); send(null)
  })

  it('a binary that is not there says so (never takes fundd down) and the loop stays alive', async () => {
    const { h, send, ac } = hand('ok', { bin: join(tmp(), 'no-such-cli-xyz') })
    const it = h[Symbol.asyncIterator]()
    send('x')
    const r = (await until(it, m => m.type === 'result')).pop()
    expect(r.is_error).toBe(true)
    expect(r.result).toMatch(/Fake: .*not available/)
    ac.abort(); send(null)
  })

  it('Stop ends the TURN with an error result the runner swallows; the next message runs a fresh process', async () => {
    const { h, send, ac } = hand('hang')
    const it = h[Symbol.asyncIterator]()
    send('slow')
    const turn = until(it, m => m.type === 'result')   // the runner is always iterating: the child exists once it pulls
    for (let i = 0; i < 200 && !existsSync(STARTED); i++) await new Promise(r => setTimeout(r, 50))   // the child is up (a loaded machine takes its time)
    expect(existsSync(STARTED)).toBe(true)
    await h.interrupt()
    const r = (await turn).pop()
    expect(r).toMatchObject({ is_error: true, result: 'Interrupted' })
    expect(h.sessionId()).toBe('S1')
    ac.abort(); send(null)
  })

  it('the controls a one-shot CLI cannot honour refuse in words', async () => {
    const { h, ac, send } = hand('ok')
    await expect(h.setModel('x')).rejects.toThrow(/next boot/)
    await expect(h.stopTask('t')).rejects.toThrow(/no background tasks/)
    await expect(h.getContextUsage()).rejects.toThrow(/no usage/)
    ac.abort(); send(null)
  })

  it('a .cmd shim is quoted for cmd.exe; anything else is spawned as is', () => {
    expect(spawnPlan('C:\\n\\codex.cmd', ['exec', '-c', 'a="b"', 'x y'], true)).toEqual({ cmd: 'C:\\n\\codex.cmd', args: ['exec', '-c', '"a=\\"b\\""', '"x y"'], shell: true })
    expect(spawnPlan('C:\\n\\codex.exe', ['x y'], true)).toEqual({ cmd: 'C:\\n\\codex.exe', args: ['x y'], shell: false })
    expect(spawnPlan('/usr/bin/codex', ['x'], false).shell).toBe(false)
  })
})

describe('the ledger of a conversation that runs on a CLI engine', () => {
  it('keeps the rows and each engine\'s own session id; a bad id is refused', () => {
    const dir = tmp()
    expect(readLedger('c-1', dir)).toBeNull()
    const entries = [{ id: 'u1', ts: 1, kind: 'user' as const, content: 'hi' }]
    writeLedger('c-1', { v: 1, engine: 'grok', sessions: { grok: 'g-1' }, entries }, dir)
    writeLedger('c-1', { v: 1, engine: 'codex', sessions: { ...readLedger('c-1', dir)!.sessions, codex: 'x-9' }, entries }, dir)
    expect(readLedger('c-1', dir)).toMatchObject({ engine: 'codex', entries })
    expect(sessionOf('c-1', 'grok', dir)).toBe('g-1')
    expect(sessionOf('c-1', 'codex', dir)).toBe('x-9')
    expect(() => writeLedger('../evil', { v: 1, sessions: {}, entries: [] }, dir)).toThrow(/not a conversation id/)
    mkdirSync(join(dir, 'x'), { recursive: true })
    writeFileSync(join(dir, 'c-2.json'), 'torn')
    expect(readLedger('c-2', dir)).toBeNull()
  })
})
