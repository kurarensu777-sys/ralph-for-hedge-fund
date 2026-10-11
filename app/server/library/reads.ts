import { isAbsolute, relative } from 'node:path'
import { now, ops, settled } from '../db.ts'
import { HttpError } from '../http.ts'
import { FUND_ROOT, logicalLabPath, within } from '../paths.ts'
import type { AgentPull, BookUse, ReadTracking } from './types.ts'

// READ TRACKING. Two kinds of row land in ops.reads:
//   at_boot true   the launch contract loaded the book (server/chat/runner.ts, one row per boot book)
//   at_boot false  an agent PULLED it mid-work with the Read tool (scripts/hooks/read-hook.mjs -> POST /api/library/read)
// Only pulls count as reads here; a boot load is shown beside them, never summed into them.

export const WINDOW_MS = 30 * 86_400_000
/** a second Read of the same file by the same conversation inside this window is one read (paged reads) */
export const DEDUPE_MS = 60_000
let dedupe: Promise<unknown> = Promise.resolve()

/** every shelf home (app/library - the one library, the legacy root library/) and the lab
 *  (platform/lab, the legacy root lab/). scripts/hooks/read-hook.mjs carries
 *  the same pattern; test/library-plus.test.ts holds the two together. */
export const TRACKED = /^(library|lab|app\/library|platform\/lab)\/.+\.md$/i
const AGENT_ID = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * pure: a hook's path (absolute or fund-relative, either slash) -> the fund-relative path of a
 * tracked .md under a shelf home or the lab (TRACKED), or null. A lab file answers with its LOGICAL
 * path (lab/<desk>/..., paths.ts logicalLabPath), the spelling the Library serves it under.
 */
export function normalizeReadPath(raw: unknown, fundRoot: string): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) return null
  const s = raw.trim()
  let rel: string
  if (isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) {
    if (!within(s, fundRoot)) return null
    rel = relative(fundRoot, s)
  } else rel = s
  rel = rel.split('\\').join('/').replace(/^\.\//, '')
  if (rel.split('/').some(p => p === '..' || p === '')) return null
  return TRACKED.test(rel) ? logicalLabPath(rel) : null
}

export type ReadInput = { agent?: unknown; conversation?: unknown; path?: unknown }

/** record one pull; returns what happened so the hook's POST gets an honest answer */
export async function recordRead(b: ReadInput, fundRoot = FUND_ROOT): Promise<{ recorded: boolean; path: string; reason?: string }> {
  const path = normalizeReadPath(b?.path, fundRoot)
  if (!path) throw new HttpError(400, "path is not a .md under a shelf home (app/library) or the lab")
  if (typeof b.agent !== 'string' || !AGENT_ID.test(b.agent)) throw new HttpError(400, 'need agent')
  const conv = typeof b.conversation === 'string' && b.conversation.length <= 128 && b.conversation ? b.conversation : null
  const t = now()
  const agent = b.agent
  // one check-and-write at a time: two pages of the same Read arriving together are still one read
  return dedupe = dedupe.then(async () => {
    if (!(await ops.recordReadOnce(agent, path, { conversationId: conv, ts: t, dedupeMs: DEDUPE_MS }))) return { recorded: false, path, reason: 'same read inside 60 s' }
    return { recorded: true, path }
  }, () => ({ recorded: false, path, reason: 'an earlier record failed' }))
}

/** when pull tracking started (the first pull ever recorded); null = no pull has ever arrived */
export async function tracking(): Promise<ReadTracking> {
  await settled()
  const r = await ops.pullLedgerSpan()
  return { since: r.first, pulls: r.n }
}

/** per book: pulls in the last 30 days, the last pull, who pulled, and boot loads beside them */
export async function bookUse(at = now()): Promise<Map<string, BookUse>> {
  await settled()
  const since = at - WINDOW_MS
  const out = new Map<string, BookUse>()
  const get = (p: string) => {
    let u = out.get(p)
    if (!u) { u = { n30: 0, last: null, who: [], boots30: 0, lastBoot: null }; out.set(p, u) }
    return u
  }
  for (const r of await ops.readStatsByBook(since)) {
    const u = get(r.book_path)
    if (r.at_boot) { u.boots30 = r.n_since; u.lastBoot = r.last } else { u.n30 = r.n_since; u.last = r.last }
  }
  for (const r of await ops.pullersByBook(since)) get(r.book_path).who.push(r.agent_id)
  return out
}

/** per agent: the distinct books it pulled in the last 30 days (boot books are filtered by the caller) */
export async function agentPulls(at = now()): Promise<Map<string, AgentPull[]>> {
  await settled()
  const m = new Map<string, AgentPull[]>()
  for (const r of await ops.pullsByAgent(at - WINDOW_MS)) { const l = m.get(r.agent_id) ?? []; l.push({ path: r.book_path, n: r.n, last: r.last }); m.set(r.agent_id, l) }
  return m
}

/** the last pulls of one book, newest first (the drawer's list) */
export async function recentReads(path: string, limit = 12): Promise<{ ts: number; agent: string; conversation: string | null }[]> {
  await settled()
  return (await ops.listReads({ bookPath: path, pullsOnly: true, limit })).map(r => ({ ts: r.ts, agent: r.agent_id, conversation: r.conversation_id }))
}
