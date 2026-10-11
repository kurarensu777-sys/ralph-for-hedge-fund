import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { PermittedModel, PermittedRead } from '../../../shared/models.ts'
import { bareModel, dialId, engineOf, sortEfforts, type EngineId, type ProviderRead } from '../../../shared/engines.ts'
import { readPermitted } from '../models.ts'
import { haveKey, keyHome, noKeyLine, providerKey } from './keys.ts'

// THE PROVIDER CATALOG: for each engine, which models this machine may run and each model's OWN effort ladder,
// as the same PermittedRead shape the Claude reader (../models.ts, the one reader of Claude's list) returns.
// Claude is never typed here: its rows are whatever Claude Code says. The others are read from the host where
// the host says anything (Codex's roster, Grok's model cache), and DeepSeek, which has no roster file, is two
// declared rows checked against its own /models whenever a key is on hand. Every row's id carries its engine
// prefix (shared/engines.ts), so one id is one model on one engine everywhere it is stored.

const TTL_MS = 10 * 60_000

// ---- finding a CLI without running it
export function findBin(name: string, env: Record<string, string | undefined> = process.env, extra: string[] = []): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const path = env.PATH ?? env.Path ?? ''
  for (const dir of [...path.split(delimiter).filter(Boolean), ...extra]) for (const x of exts) {
    const p = join(dir, name + x)
    if (existsSync(p)) return p
  }
  return null
}
export const GROK_HOME = () => process.env.GROK_HOME || join(homedir(), '.grok')
export const CODEX_HOME = () => process.env.CODEX_HOME || join(homedir(), '.codex')
export const grokBin = (env: Record<string, string | undefined> = process.env) => findBin('grok', env, [join(GROK_HOME(), 'bin')])
export const codexBin = (env: Record<string, string | undefined> = process.env) => findBin('codex', env)

const empty = (error: string | null): PermittedRead => ({ models: [], at: null, error })
const row = (engine: EngineId, bare: string, name: string, efforts: string[], description = ''): PermittedModel =>
  ({ id: dialId(engine, bare), aliases: [], name, description, efforts })

// ---- DeepSeek. No roster file exists, so the rows are declared. Read 2026-10-06 [1] from DeepSeek's own docs
// (api-docs.deepseek.com, list-models): two ids, both 1,048,576 tokens of context, reasoning_effort low / high / max,
// default high. The ids are checked against GET https://api.deepseek.com/models whenever a key is on hand, and a
// disagreement is said on the provider, not smoothed over. The key goes to that one host and no other.
export const DEEPSEEK_DECLARED = [
  { id: 'deepseek-flash', name: 'V4.1 Flash', efforts: ['max', 'high', 'low'] },
  { id: 'deepseek-v4-pro', name: 'V4 Pro', efforts: ['max', 'high', 'low'] },
] as const
export const DEEPSEEK_DATED = 'declared 2026-10-06'
export const DEEPSEEK_URL = 'https://api.deepseek.com'

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>
export async function readDeepseek(key: string | null, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<ProviderRead> {
  const rows = DEEPSEEK_DECLARED.map(d => row('deepseek', d.id, d.name, [...d.efforts]))
  const home = keyHome('deepseek')!
  const base = { id: 'deepseek' as const, name: 'DeepSeek' }
  if (!key) return { ...base, state: 'no-key', note: noKeyLine('deepseek'), source: DEEPSEEK_DATED, read: { models: rows, at: Date.now(), error: null } }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 8000)
  try {
    const res = await fetcher(`${DEEPSEEK_URL}/models`, { headers: { authorization: `Bearer ${key}` }, signal: ctl.signal })
    if (res.status === 401) return { ...base, state: 'no-key', note: `DeepSeek answered 401: the key in ${home.env} (machine env or ${home.file}) is not accepted`, source: DEEPSEEK_DATED, read: { models: rows, at: Date.now(), error: null } }
    if (!res.ok) return { ...base, state: 'ready', note: `DeepSeek /models answered ${res.status}; showing the ${DEEPSEEK_DATED} rows`, source: DEEPSEEK_DATED, read: { models: rows, at: Date.now(), error: null } }
    const live: string[] = ((await res.json())?.data ?? []).map((m: any) => String(m?.id ?? '')).filter(Boolean)
    const have = rows.filter(r => live.includes(bareModel(r.id)))
    const gone = rows.filter(r => !live.includes(bareModel(r.id))).map(r => bareModel(r.id))
    const fresh = live.filter(id => !DEEPSEEK_DECLARED.some(d => d.id === id) && !/^deepseek-(chat|reasoner)$/.test(id))
    const note = [gone.length && `not listed by DeepSeek now: ${gone.join(', ')}`, fresh.length && `listed by DeepSeek but not declared here (no ladder known): ${fresh.join(', ')}`].filter(Boolean).join('; ') || null
    return { ...base, state: 'ready', note, source: 'api', read: { models: have, at: Date.now(), error: have.length ? null : 'DeepSeek /models lists none of the declared ids' } }
  } catch (e) {
    return { ...base, state: 'ready', note: `DeepSeek /models unreachable (${(e as Error).message}); showing the ${DEEPSEEK_DATED} rows`, source: DEEPSEEK_DATED, read: { models: rows, at: Date.now(), error: null } }
  } finally { clearTimeout(timer) }
}

// ---- Codex. Its roster and each model's ladder live in one sentence the desktop app caches; that sentence is
// authoritative for THIS host (what the machine will accept):
//   "gpt-6-astra (...; supported reasoning efforts: low, medium, high, xhigh, max, ultra), ..."
// The CLI's own models_cache.json is the second source. A host that has neither gets ONE row, `default`: no -m is
// passed and Codex picks its own, because a model list typed here would be a guess about someone else's account.
export const CODEX_DEFAULT = 'default'
function prettyCodex(id: string): string {
  const parts = id.split('-')
  if (parts[0].toLowerCase() !== 'gpt' || parts.length < 2) return id
  const rest = parts.slice(2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
  return `GPT-${parts[1]}${rest ? ' ' + rest : ''}`
}
type Parsed = { id: string; name: string; efforts: string[] }
export function parseCodexState(blob: string): Parsed[] {
  const hit = blob.match(/Models and supported reasoning efforts on the calling host: ([^"]+)/)
  if (!hit) return []
  const out: Parsed[] = []
  const re = /([a-z0-9.\-]+) \([^;]*; supported reasoning efforts: ([^)]+)\)/g
  for (let m = re.exec(hit[1]); m; m = re.exec(hit[1])) out.push({ id: m[1], name: prettyCodex(m[1]), efforts: sortEfforts(m[2].split(',').map(s => s.trim()).filter(Boolean)) })
  return out
}
export function parseCodexCache(blob: string): Parsed[] {
  let doc: any
  try { doc = JSON.parse(blob) } catch { return [] }
  const list: any[] = Array.isArray(doc?.models) ? doc.models : []
  return list.filter(m => m?.slug && m.visibility !== 'hide' && m.visibility !== 'none').map(m => ({
    id: String(m.slug), name: String(m.display_name || prettyCodex(String(m.slug))),
    efforts: sortEfforts((Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []).map((l: any) => String(l?.effort ?? l ?? '')).filter(Boolean)),
  }))
}
export function readCodex(bin: string | null = codexBin(), home = CODEX_HOME()): ProviderRead {
  const base = { id: 'codex' as const, name: 'Codex' }
  if (!bin) return { ...base, state: 'no-cli', note: '`codex` is not on PATH: install the Codex CLI and sign in', source: 'none', read: empty('codex is not installed') }
  const tryFile = (f: string, parse: (s: string) => Parsed[]) => { try { return existsSync(f) ? parse(readFileSync(f, 'utf8')) : [] } catch { return [] } }
  let rows = tryFile(join(home, '.codex-global-state.json'), parseCodexState), source = 'host file (.codex-global-state.json)'
  if (!rows.length) { rows = tryFile(join(home, 'models_cache.json'), parseCodexCache); source = 'host file (models_cache.json)' }
  if (!rows.length) return { ...base, state: 'ready', note: 'no model list on this host: Codex runs its own default model and effort', source: 'none', read: { models: [row('codex', CODEX_DEFAULT, 'Default', [])], at: Date.now(), error: null } }
  return { ...base, state: 'ready', note: null, source, read: { models: rows.map(r => row('codex', r.id, r.name, r.efforts)), at: Date.now(), error: null } }
}

// ---- Grok (the Grok Build CLI). Its model list and per-model reasoning ladder are in the cache the CLI keeps,
// ~/.grok/models_cache.json (fetched from its own service, per account): info.reasoning_efforts[].id when
// info.supports_reasoning_effort, else the model takes none. Signed in = ~/.grok/auth.json exists.
export function parseGrokCache(blob: string): (Parsed & { description: string })[] {
  let doc: any
  try { doc = JSON.parse(blob) } catch { return [] }
  const out: (Parsed & { description: string })[] = []
  for (const [key, v] of Object.entries<any>(doc?.models ?? {})) {
    const info = v?.info
    if (!info || info.hidden) continue
    const efforts = info.supports_reasoning_effort ? sortEfforts((Array.isArray(info.reasoning_efforts) ? info.reasoning_efforts : []).map((e: any) => String(e?.id ?? e?.value ?? '')).filter(Boolean)) : []
    out.push({ id: String(info.id || info.model || key), name: String(info.name || info.id || key), efforts, description: String(info.description ?? '') })
  }
  return out
}
export function readGrok(bin: string | null = grokBin(), home = GROK_HOME()): ProviderRead {
  const base = { id: 'grok' as const, name: 'Grok' }
  if (!bin) return { ...base, state: 'no-cli', note: '`grok` is not on PATH (the Grok Build CLI installs to ~/.grok/bin)', source: 'none', read: empty('grok is not installed') }
  if (!existsSync(join(home, 'auth.json'))) return { ...base, state: 'no-key', note: 'Grok is not signed in: run `grok login`', source: 'none', read: empty('grok is not signed in') }
  const f = join(home, 'models_cache.json')
  let rows: ReturnType<typeof parseGrokCache> = []
  try { rows = existsSync(f) ? parseGrokCache(readFileSync(f, 'utf8')) : [] } catch { rows = [] }
  if (!rows.length) return { ...base, state: 'unread', note: 'Grok has not written its model list (~/.grok/models_cache.json): run `grok models` once, signed in', source: 'none', read: empty('no models_cache.json') }
  return { ...base, state: 'ready', note: null, source: 'host file (models_cache.json)', read: { models: rows.map(r => row('grok', r.id, r.name, r.efforts, r.description)), at: Date.now(), error: null } }
}

// ---- Claude: the one reader, wrapped
async function readClaude(force: boolean): Promise<ProviderRead> {
  const read = await readPermitted(force)
  return { id: 'claude', name: 'Claude', state: read.models.length ? 'ready' : 'unread', note: read.error, source: 'claude-code', read }
}

let cache: { at: number; rest: ProviderRead[] } | null = null
/** every provider the chat box offers, always all four: one with no key or no CLI says so on its own row */
export async function providers(force = false, deps: { deepseekFetch?: Fetcher; env?: Record<string, string | undefined> } = {}): Promise<ProviderRead[]> {
  const claude = await readClaude(force)
  if (!force && !deps.deepseekFetch && !deps.env && cache && Date.now() - cache.at < TTL_MS) return [claude, ...cache.rest]
  const env = deps.env ?? process.env
  const rest = [readCodex(codexBin(env)), await readDeepseek(providerKey('deepseek', env), deps.deepseekFetch), readGrok(grokBin(env))]
  if (!deps.deepseekFetch && !deps.env) cache = { at: Date.now(), rest }
  return [claude, ...rest]
}
export const forgetProviders = () => { cache = null }
/** the last read of every provider but Claude, without asking (a launch is synchronous): [] before the first read */
export const providersNow = (): ProviderRead[] => cache?.rest ?? []

export type Dial = { engine: EngineId; model: PermittedModel; provider: ProviderRead }
/** refuse a model no provider offers, or one whose provider cannot run here (the line says what is missing) */
export async function checkDial(id: string): Promise<Dial> {
  const engine = engineOf(id)
  const provider = (await providers()).find(p => p.id === engine)!
  if (provider.state === 'no-key' || provider.state === 'no-cli') throw new Error(`${provider.name} cannot run here: ${provider.note ?? provider.state}`)
  const model = provider.read.models.find(m => m.id === id)
  if (model) return { engine, model, provider }
  if (!provider.read.models.length) throw new Error(`cannot check the model: ${provider.name}'s list is unreadable (${provider.read.error ?? provider.note ?? 'never read'})`)
  throw new Error(`${id} is not on ${provider.name}'s list: ${provider.read.models.map(m => m.id).join(', ')}`)
}

/** is the provider's CLI or key there NOW (not the cached read)? the line says what is missing; null = it can spawn */
export function spawnBlock(engine: EngineId, env: Record<string, string | undefined> = process.env): string | null {
  if (engine === 'claude') return null
  if (engine === 'deepseek') return haveKey('deepseek', env) ? null : noKeyLine('deepseek')
  if (engine === 'codex') return codexBin(env) ? null : '`codex` is not on PATH'
  return grokBin(env) ? null : '`grok` is not on PATH'
}
