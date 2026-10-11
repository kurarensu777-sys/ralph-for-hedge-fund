import { tmpdir } from 'node:os'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import type { PermittedModel, PermittedRead } from '../../shared/models.ts'
import { agentEnv } from './env.ts'

// THE ONE READER of the models this account may run: Claude Code's own `supportedModels()`, asked
// through a throwaway Agent SDK session that never sends a prompt (the init handshake answers it: no
// API call, no tokens; ~1 s measured 2026-09-26). Cached in memory; a failed read keeps the last good
// list and names why. Every picker, every PATCH and the scheduler check against this and nothing else.

const TTL_MS = 60 * 60_000
const RETRY_MS = 60_000                      // a failed read is not re-asked on every click
const TIMEOUT_MS = 30_000

let cache: PermittedRead = { models: [], at: null, error: null }
let inflight: Promise<PermittedRead> | null = null

/** the SDK's rows -> one row per EXACT id (resolvedModel, else value), aliases folded in, SDK order kept */
export function fromInfo(rows: readonly ModelInfo[]): PermittedModel[] {
  const out: PermittedModel[] = []
  for (const r of rows) {
    const id = (r.resolvedModel || r.value || '').trim()
    if (!id) continue
    const efforts = r.supportsEffort === false ? [] : [...(r.supportedEffortLevels ?? [])]
    // Claude Code 2.1.281 led the description with the model's name ("Opus 5.5 with 1M context · Best for ...");
    // 2.1.288 names it in displayName ("Sonnet 5.5") and keeps the description to the tagline, except on the
    // `default` row, whose displayName is "Default (recommended)" and whose description is the model's name
    const desc = String(r.description ?? '')
    const [lead, ...rest] = desc.split(' · ')
    const named = rest.length > 0
    const viaDefault = r.value === 'default' && !named
    const name = (named ? lead : viaDefault ? desc : r.displayName) || desc || id
    const description = named ? rest.join(' · ') : viaDefault ? '' : desc
    const have = out.find(m => m.id === id)
    if (have) {
      if (!have.aliases.includes(r.value)) have.aliases.push(r.value)
      if (!have.description && description) Object.assign(have, { name, description })   // the model's own row names it better
      continue
    }
    out.push({ id, aliases: r.value && r.value !== id ? [r.value] : [], name, description, efforts })
  }
  return out
}

async function ask(): Promise<ModelInfo[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  async function* idle() { await held }                       // a prompt stream that never speaks
  const q = query({ prompt: idle() as AsyncIterable<any>, options: { cwd: tmpdir(), env: agentEnv(process.env), settingSources: [], persistSession: false, tools: [] } as any })
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`Claude Code did not answer in ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS) }),
    ])
  } finally {
    clearTimeout(timer); release()
    try { (q as any).close?.() } catch { /* already gone */ }
  }
}

/** the permitted list: cached for an hour (a failure for a minute), `force` asks again now; never throws (a failure is in `.error`) */
export async function readPermitted(force = false, asker: () => Promise<ModelInfo[]> = ask): Promise<PermittedRead> {
  if (!force && cache.at !== null && Date.now() - cache.at < (cache.error ? RETRY_MS : TTL_MS)) return cache
  inflight ??= (async () => {
    try {
      const models = fromInfo(await asker())
      cache = models.length ? { models, at: Date.now(), error: null } : { ...cache, at: Date.now(), error: 'Claude Code returned no models' }
    } catch (e) {
      cache = { ...cache, at: Date.now(), error: (e as Error).message || String(e) }
    }
    return cache
  })().finally(() => { inflight = null })
  return inflight
}

/** the last read, without asking (the launch is synchronous) */
export const permittedNow = (): PermittedRead => cache

/** test seam: put a read in place */
export function setPermitted(r: PermittedRead) { cache = r }

/** an alias a stored conversation still holds -> the exact id it resolves to today; anything else as written */
export function exactOf(m: string): string {
  return cache.models.find(x => x.aliases.includes(m))?.id ?? m
}

/** refuse a model Claude Code does not permit - or any model at all while the list cannot be read (say why) */
export async function checkModel(id: string): Promise<PermittedModel> {
  const r = await readPermitted()
  const m = r.models.find(x => x.id === id)
  if (m) return m
  if (!r.models.length) throw new Error(`cannot check the model: Claude Code's permitted list is unreadable (${r.error ?? 'never read'})`)
  throw new Error(`${id} is not on Claude Code's permitted list: ${r.models.map(x => x.id).join(', ')}`)
}

/** refuse an effort the model does not take */
export function checkEffort(m: PermittedModel, effort: string) {
  if (!m.efforts.length) throw new Error(`${m.id} takes no effort level`)
  if (!m.efforts.includes(effort)) throw new Error(`${m.id} takes effort ${m.efforts.join(', ')}`)
}
