import type { ChatPromptsRow } from '@fund/db'
import { now, ops } from '../db.ts'
import { secretLineReason } from '../../scripts/hooks/guard-lib.mjs'

// THE PROMPT RACK: the owner's saved prompts (ops.chat_prompts). Picking one only puts
// its text into the composer; nothing here sends. Owner-local (the ops store), never in the tree.

export type Prompt = { id: number; title: string; body: string; tags: string[]; created: number; updated: number }
export type PromptInput = { id?: unknown; title?: unknown; body?: unknown; tags?: unknown }

export const TITLE_MAX = 120
export const TAGS_MAX = 12
export const TAG_MAX = 32
export const BODY_MAX = 20_000

export class PromptError extends Error {}

/** lowercase, trimmed, inner spaces to '-', deduped, empty dropped, at most TAGS_MAX */
export function cleanTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : []
  const out: string[] = []
  for (const t of list) {
    if (typeof t !== 'string') continue
    const c = t.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, TAG_MAX)
    if (c && !out.includes(c)) out.push(c)
    if (out.length >= TAGS_MAX) break
  }
  return out
}

/** why a prompt body looks like it carries a credential, or null (the commit guard's own line rules) */
export function credentialReason(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const r = secretLineReason(line)
    if (r) return r
    // the guard's generic rule wants a QUOTED literal; a prompt is prose, so also an unquoted env-style one
    const m = ENV_ASSIGN.exec(line)
    if (m && /[A-Za-z]/.test(m[1]) && /[0-9]/.test(m[1])) return 'key-like assignment'
  }
  return null
}
const ENV_ASSIGN = /\b[A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_?KEY)[A-Z0-9_]*\s*[:=]\s*([A-Za-z0-9_\-/+=.]{20,})/i

const toPrompt = (r: ChatPromptsRow): Prompt => {
  // tags is jsonb (an array); anything else in a row shows no tags
  const tags = Array.isArray(r.tags) ? r.tags.filter((x): x is string => typeof x === 'string') : []
  return { id: r.id, title: r.title, body: r.body, tags, created: r.created, updated: r.updated }
}

/** every prompt, most recently updated first */
export async function list(): Promise<Prompt[]> {
  return (await ops.listPrompts()).map(toPrompt)
}

export async function get(id: number): Promise<Prompt | null> {
  if (!Number.isSafeInteger(id)) return null
  const r = await ops.get('chat_prompts', id)
  return r ? toPrompt(r) : null
}

/** insert (no id) or replace (id); throws PromptError on a bad input */
export async function upsert(input: PromptInput, ts = now()): Promise<Prompt> {
  const body = typeof input.body === 'string' ? input.body.replace(/\r\n/g, '\n').replace(/\s+$/, '') : ''
  if (!body.trim()) throw new PromptError('body required')
  if (body.length > BODY_MAX) throw new PromptError(`body over ${BODY_MAX} characters`)
  const title = typeof input.title === 'string' ? input.title.trim().replace(/\s+/g, ' ') : ''
  if (title.length > TITLE_MAX) throw new PromptError(`title over ${TITLE_MAX} characters`)
  const why = credentialReason(body) ?? credentialReason(title)
  if (why) throw new PromptError(`refused: looks like a credential (${why})`)
  // the tags keep the order the owner gave (cleanTags), so the row is written as-is, not through
  // ops.createPrompt / updatePrompt (which sort them)
  const tags = cleanTags(input.tags)
  if (input.id !== undefined && input.id !== null) {
    const id = Number(input.id)
    if (!Number.isInteger(id) || !(await get(id))) throw new PromptError('no such prompt')
    return toPrompt((await ops.update('chat_prompts', id, { title, body, tags, updated: ts }))!)
  }
  return toPrompt(await ops.insert('chat_prompts', { title, body, tags, created: ts, updated: ts }))
}

export async function remove(id: number): Promise<boolean> {
  if (!Number.isSafeInteger(id)) return false
  return (await ops.deletePrompt(id)) > 0
}
