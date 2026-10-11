import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationsRow } from '@fund/db'
import type { Agent } from '../../shared/types.ts'
import { later, now, ops, settled } from '../db.ts'
import { FUND_ROOT } from '../paths.ts'
import { agentCwd, legacyCwds, transcriptDir, transcriptFile } from './launch.ts'
import { previewLine } from './preview.ts'
import { deriveTitle, transcriptTexts } from './transcripts.ts'
import type { ChatState, Conversation } from './types.ts'

// THE CONVERSATION INDEX, in the ops store (ops.conversations, ops.messages; database/ owns the
// schema). A conversation's `id` is stable forever; `transcript_uuid` is wherever its head is right
// now - the CLI forks the transcript on compaction and on a rewind, and the row follows it, so the
// pane never notices. Forgetting HIDES a row (forgotten) and keeps its uuid, so adoption never
// brings the same transcript back under a new id. The transcript itself is never deleted.
//
// Writes made from the runner's stream (state, head, usage, the search index) are QUEUED
// (db.later) so they land in the order they happened; every read here waits for that queue first,
// so a list fetched after a publish shows what the publish announced.

let ready: Promise<void> | null = null
/** once per process: fundd just started, nothing is running whatever the rows say from the last life */
function init(): Promise<void> {
  ready ??= (async () => {
    await ops.closeOpenConversations()
    await ops.clearPresencePrefix('chat:')
  })()
  return ready
}

export type Row = ConversationsRow

const toConv = (r: Row): Conversation => ({
  id: r.id, agent: r.agent_id, title: r.title, state: r.state as ChatState,
  startedAt: r.started_at, lastAt: r.last_at, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd,
  model: r.model, effort: r.effort, transcript: r.transcript_uuid,
})

export const mintId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export async function create(agent: Agent, title = ''): Promise<Conversation> {
  await init()
  const r = await ops.createConversation(mintId(), agent.id, { title, transcriptUuid: randomUUID(), state: 'closed', cwd: agentCwd(agent), startedAt: now() })
  return toConv(r)
}

export async function getRow(id: string): Promise<Row | null> {
  await init()
  await settled()
  return ops.getConversation(id, { includeForgotten: true })
}
export async function get(id: string): Promise<Conversation | null> {
  const r = await getRow(id)
  return r && !r.forgotten ? toConv(r) : null
}

// ---- queued writes (called from the runner's synchronous stream handling)

export const setState = (id: string, state: ChatState) => later('conversation state', () => ops.updateConversation(id, { state }))
export const advanceHead = (id: string, uuid: string) => later('conversation head', () => ops.updateConversation(id, { transcript_uuid: uuid, last_at: now() }))
export const setCwd = (id: string, cwd: string) => later('conversation cwd', () => ops.updateConversation(id, { cwd }))
export function touch(id: string, title?: string) {
  const t = now()
  return later('conversation touch', async () => {
    if (!title) return ops.updateConversation(id, { last_at: t })
    // a title is only ever filled once: the first message names the conversation
    await ops.touchConversation(id, { ts: t, title })
  })
}
export function patch(id: string, p: { title?: string; model?: string | null; effort?: string | null }) {
  const f: Partial<Row> = {}
  if (p.title !== undefined) f.title = p.title
  if (p.model !== undefined) f.model = p.model
  if (p.effort !== undefined) f.effort = p.effort
  return later('conversation patch', () => ops.updateConversation(id, f))
}
export const forget = (id: string) => later('conversation forget', () => ops.forgetConversation(id))
export function addUsage(id: string, agent: string, u: { model?: string; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; costUsd: number }) {
  const ts = now()
  return later('usage', () => ops.addUsage(id, agent, { model: u.model ?? null, tokensIn: u.tokensIn, tokensOut: u.tokensOut, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, costUsd: u.costUsd, ts }))
}
export function indexText(id: string, role: 'user' | 'assistant', text: string, ts = now()) {
  if (!text.trim()) return Promise.resolve(undefined)
  return later('message index', () => ops.indexMessage(id, role, text, { ts }))
}
export function presence(id: string, agent: string, doing: string | null, on: boolean) {
  const hand = `chat:${id}`
  if (!on) return later('presence', () => ops.clearPresence(hand))
  return later('presence', () => ops.setPresence(hand, agent, { conversationId: id, doing, pid: process.pid }))
}
/** the heartbeat of every hand still working (the runner's 30 s tick) */
export const heartbeat = (ids: string[]) => ids.length
  ? later('presence heartbeat', () => ops.heartbeatPresence(ids.map(id => `chat:${id}`), { ts: now() }))
  : Promise.resolve(undefined)

export async function transcriptPath(id: string): Promise<string | null> {
  const r = await getRow(id)
  if (!r?.transcript_uuid || !r.cwd) return null
  const f = transcriptFile(r.cwd, r.transcript_uuid)
  return existsSync(f) ? f : null
}

// ---- ADOPTION: every transcript already under ~/.claude/projects for an agent's folder gets a
// row, so conversations begun before this cockpit (or in a terminal) show in history and can be
// resumed like any other. Several dashboard agents share one cwd (platform/app); a transcript found
// there is attributed to the FIRST agent in roster order with that cwd - the transcript itself does
// not say which agent held it.
let lastAdopt = 0
let adopting: Promise<void> | null = null
export async function adopt(agents: Agent[], force = false): Promise<void> {
  await init()
  if (adopting) return adopting
  if (!force && Date.now() - lastAdopt < 20_000) return
  lastAdopt = Date.now()
  adopting = (async () => {
    const seen = new Set<string>()
    const known = await ops.knownTranscripts()
    for (const a of agents) {
      let here: string
      try { here = agentCwd(a) } catch { continue }
      // the agent's cwd now, then the cwds it replaced at the 2026-09-24 cut-over (history). A row
      // keeps the cwd its transcript is filed under; the runner moves it forward on resume.
      for (const cwd of [here, ...legacyCwds(a.cwd).map(l => join(FUND_ROOT, l))]) {
        const dir = transcriptDir(cwd)
        if (seen.has(dir.toLowerCase()) || !existsSync(dir)) continue
        seen.add(dir.toLowerCase())
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.jsonl')) continue
          const uuid = f.slice(0, -6)
          if (known.has(uuid)) continue
          const file = join(dir, f)
          let st
          try { st = statSync(file) } catch { continue }
          const title = deriveTitle(file)
          if (!title) continue          // nobody ever spoke in it: nothing to go back to
          await ops.insert('conversations', { id: mintId(), agent_id: a.id, title, transcript_uuid: uuid, state: 'closed', cwd,
            started_at: Math.round(st.birthtimeMs || st.mtimeMs), last_at: Math.round(st.mtimeMs) })
          known.add(uuid)
        }
      }
    }
    scheduleIndex()
  })().finally(() => { adopting = null })
  return adopting
}

// The search index for adopted transcripts, built in the background one file per tick so a
// 25 MB transcript never stalls the daemon's event loop for long.
let indexing = false
function scheduleIndex() {
  if (indexing) return
  indexing = true
  const step = async () => {
    let r: { id: string; cwd: string; transcript_uuid: string } | undefined
    try {
      r = (await ops.nextUnindexedConversation()) ?? undefined
    } catch (e) { console.error('[chats] index', (e as Error).message); indexing = false; return }
    if (!r) { indexing = false; return }
    const f = transcriptFile(r.cwd, r.transcript_uuid)
    try {
      if (existsSync(f)) await ops.replaceMessages(r.id, transcriptTexts(f).filter(x => x.text.trim()))
    } catch (e) { console.error('[chats] index', r.id, (e as Error).message) }
    try { await ops.updateConversation(r.id, { indexed: true }) } catch (e) { console.error('[chats] index', (e as Error).message); indexing = false; return }
    setTimeout(() => void step(), 50)
  }
  setTimeout(() => void step(), 200)
}
/** a live conversation's own messages are indexed as they happen; mark it so adoption skips it */
export const markIndexed = (id: string) => later('conversation indexed', () => ops.updateConversation(id, { indexed: true }))

/** each conversation's LAST indexed message (either role) as one preview line; a conversation with
 *  none (or whose last message has no printable line) is absent from the map, so the landing prints
 *  no line rather than a placeholder */
export async function previews(ids: string[]): Promise<Map<string, string>> {
  await init()
  await settled()
  const out = new Map<string, string>()
  for (const [id, text] of await ops.lastMessages(ids)) { const p = previewLine(text); if (p) out.set(id, p) }
  return out
}

/** the search words as a prefix tsquery: every run of letters/digits a `word:*` term, all ANDed;
 *  nothing the owner types can become tsquery syntax. '' when there is no word at all. */
export function prefixQuery(q: string): string {
  return ops.prefixWords(q).map(w => `${w}:*`).join(' & ')
}

export async function list(o: { agent?: string; q?: string; limit?: number }): Promise<(Conversation & { snippet?: string })[]> {
  await init()
  await settled()
  const limit = Math.min(Math.max(o.limit ?? 200, 1), 1000)
  const q = (o.q ?? '').trim()
  if (!q) return (await ops.listConversations({ agent: o.agent, limit })).map(toConv)
  // Content search (ops.messages, word prefixes) OR title match.
  const hits = new Map<string, string>()
  for (const h of await ops.searchMessagesPrefix(q, { limit: 400 })) if (!hits.has(h.conversation_id)) hits.set(h.conversation_id, h.snippet)
  const rows = await ops.listConversations({ agent: o.agent, limit: 2000 })
  const ql = q.toLowerCase()
  return rows.filter(r => hits.has(r.id) || r.title.toLowerCase().includes(ql)).slice(0, limit)
    .map(r => ({ ...toConv(r), ...(hits.has(r.id) ? { snippet: hits.get(r.id) } : {}) }))
}
