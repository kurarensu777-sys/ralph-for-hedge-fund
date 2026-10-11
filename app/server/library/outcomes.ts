import { splitRef } from '../../shared/bookmeta.ts'
import type { Agent, Book, Shelf } from '../../shared/types.ts'
import { ops, type Queryable } from '../db.ts'
import { HttpError } from '../http.ts'
import { readConfig } from '../loop/config.ts'
import { readLedger } from '../loop/engine.ts'
import { unreadDrafts } from '../loop/rules.ts'
import { DEDUPE_MS } from './reads.ts'
import type { BookMark, BookOutcome, LibOutcomes, Outcome, RetireRow } from './types.ts'

// HELPFUL / HARMFUL. A book's record is the conversations that PULLED it (Read tool mid-work,
// at_boot = 0), graded by what happened in that conversation:
//   harmful  the conversation was reverted (the Chats revert event), logged an error event, or one
//            of its commits was later reverted by a loop revert
//   helpful  it landed a commit that is still unreverted 7 days later
//   neutral  everything else (a commit younger than 7 days is not known yet)
// Correlation, not cause: a book pulled in a bad session is not proven bad. So the retire queue
// asks for n >= 3 AND a harmful rate above the base rate of every conversation, and retiring is
// the owner's call, never automatic.

export const MIN_N = 3
export const SETTLE_MS = 7 * 86_400_000

export type Graded = { outcome: Outcome; why: string }

/** every conversation the cockpit knows, graded */
export async function gradeConversations(d: Queryable, at: number): Promise<Map<string, Graded>> {
  const ids = new Set<string>()
  for (const id of await ops.listConversationIds(d)) ids.add(id)
  for (const id of await ops.conversationsWithPulls(d)) ids.add(id)
  const reverted = new Set(await ops.revertedConversations(d))
  const errors = await ops.errorCountsByConversation(d)
  // a commit is loop-reverted when a later LOOP commit in the same repo is `Revert "<its subject>"`
  const commits = (await ops.commitSubjects(d)).map(c => ({ repo: c.repo, sha: c.sha, ts: c.ts, subject: c.subject, conv: c.conversation_id, loop: c.loop_change }))
  const key = (repo: string, subject: string) => `${repo}|${subject}`
  const loopReverts = new Map<string, number[]>()
  for (const c of commits) {
    const m = /^Revert "(.*)"$/.exec(c.subject)
    if (m && c.loop) { const k = key(c.repo, m[1]); loopReverts.set(k, [...(loopReverts.get(k) ?? []), c.ts]) }
  }
  const byConv = new Map<string, { undone: number; settled: number }>()
  for (const c of commits) {
    if (!c.conv) continue
    ids.add(c.conv)
    const x = byConv.get(c.conv) ?? { undone: 0, settled: 0 }
    if ((loopReverts.get(key(c.repo, c.subject)) ?? []).some(t => t >= c.ts)) x.undone++
    else if (c.ts <= at - SETTLE_MS) x.settled++
    byConv.set(c.conv, x)
  }
  const out = new Map<string, Graded>()
  for (const id of ids) {
    const c = byConv.get(id)
    const e = errors.get(id) ?? 0
    if (reverted.has(id)) out.set(id, { outcome: 'harmful', why: 'reverted' })
    else if (e > 0) out.set(id, { outcome: 'harmful', why: `${e} error${e === 1 ? '' : 's'}` })
    else if (c?.undone) out.set(id, { outcome: 'harmful', why: `${c.undone} commit${c.undone === 1 ? '' : 's'} loop-reverted` })
    else if (c?.settled) out.set(id, { outcome: 'helpful', why: `${c.settled} commit${c.settled === 1 ? '' : 's'} standing after 7 days` })
    else out.set(id, { outcome: 'neutral', why: '' })
  }
  return out
}

/** per book: pulls (a conversation paging one book inside 60 s is one pull), sessions n, graded */
export async function bookOutcomes(d: Queryable, graded: Map<string, Graded>): Promise<Map<string, BookOutcome>> {
  const rows = (await ops.listPulls(d)).map(r => ({ p: r.book_path, c: r.conversation_id, ts: r.ts }))
  const acc = new Map<string, { pulls: number; convs: Set<string> }>()
  let prev: { p: string; c: string; ts: number } | null = null
  for (const r of rows) {
    const a = acc.get(r.p) ?? { pulls: 0, convs: new Set<string>() }
    const paged = !!prev && prev.p === r.p && prev.c === r.c && r.ts - prev.ts < DEDUPE_MS
    if (!paged) a.pulls++
    a.convs.add(r.c)
    acc.set(r.p, a)
    prev = r
  }
  const out = new Map<string, BookOutcome>()
  for (const [p, a] of acc) {
    let helpful = 0, harmful = 0
    for (const c of a.convs) { const g = graded.get(c)?.outcome; if (g === 'helpful') helpful++; else if (g === 'harmful') harmful++ }
    const n = a.convs.size
    out.set(p, { pulls: a.pulls, n, helpful, harmful, net: n ? (helpful - harmful) / n : null })
  }
  return out
}

/** the harmful rate across every conversation; null when there are none */
export function baseRate(graded: Map<string, Graded>): number | null {
  if (!graded.size) return null
  let h = 0
  for (const g of graded.values()) if (g.outcome === 'harmful') h++
  return h / graded.size
}

/** pure: the harm half of the queue - net below 0 at n >= min, harmful rate above the base */
export function harmCandidates(per: Map<string, BookOutcome>, base: number | null, min = MIN_N): string[] {
  if (base === null) return []
  const out: string[] = []
  for (const [p, o] of per) if (o.n >= min && o.net !== null && o.net < 0 && o.harmful / o.n > base) out.push(p)
  return out
}

/** boot_json is jsonb (an array); a text row from before still parses; anything else is no list */
const safeList = (v: unknown): string[] => {
  try { const x = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(x) ? x.map(String) : [] } catch { return [] }
}

export async function marks(d: Queryable): Promise<Map<string, BookMark & { boot: string[] }>> {
  const rows = await ops.listBookMarks({}, d)
  return new Map(rows.map(r => [r.path, { state: 'cold' as const, n: r.n, ts: r.ts, note: r.note, boot: safeList(r.boot_json) }]))
}

export type OutcomeCtx = { db: Queryable; books: Book[]; agents: Agent[]; shelves: Shelf[]; configFiles: string[]; now: number }

export async function outcomes(c: OutcomeCtx): Promise<LibOutcomes> {
  const graded = await gradeConversations(c.db, c.now)
  const per = await bookOutcomes(c.db, graded)
  const base = baseRate(graded)
  const cold = await marks(c.db)
  const ledger = await readLedger(c.db)
  const byPath = new Map(c.books.map(b => [b.path, b]))
  const blank: BookOutcome = { pulls: 0, n: 0, helpful: 0, harmful: 0, net: null }
  const row = (p: string, reason: RetireRow['reason'], why: string): RetireRow | null => {
    const b = byPath.get(p)
    if (!b || cold.has(p)) return null
    return { ...(per.get(p) ?? blank), path: p, title: b.title, shelf: b.shelf, reason, why }
  }
  const queue: RetireRow[] = []
  for (const p of harmCandidates(per, base)) {
    const o = per.get(p)!
    const r = row(p, 'harm', `${o.harmful} of ${o.n} sessions harmful, base ${Math.round((base ?? 0) * 100)}%`)
    if (r) queue.push(r)
  }
  // the unread half is the Loop's own rule, reused as is. No open proposals are passed: this queue
  // lists every unread book, whether or not a Loop proposal already names it.
  let unreadNote: string | null = null
  try {
    const cfg = readConfig(c.configFiles)
    const un = unreadDrafts(c.books, c.agents, ledger, c.now, cfg.unreadLedgerDays, [], c.shelves)
    unreadNote = un.note
    const seen = new Set(queue.map(q => q.path))
    for (const dr of un.drafts) for (const p of dr.target) {
      if (seen.has(p)) continue
      const r = row(p, 'unread', dr.why)
      if (r) { queue.push(r); seen.add(p) }
    }
  } catch (e) { unreadNote = `unread: ${(e as Error).message}` }
  queue.sort((a, b) => a.reason !== b.reason ? (a.reason === 'harm' ? -1 : 1) : ((a.net ?? 0) - (b.net ?? 0)) || a.path.localeCompare(b.path))
  let harmful = 0, helpful = 0
  for (const g of graded.values()) { if (g.outcome === 'harmful') harmful++; else if (g.outcome === 'helpful') helpful++ }
  return {
    books: Object.fromEntries(per), sessions: graded.size, harmful, helpful, base, min: MIN_N, queue,
    cold: [...cold].map(([path, m]) => ({ path, title: byPath.get(path)?.title ?? path, n: m.n, ts: m.ts, note: m.note })).sort((a, b) => b.ts - a.ts),
    unreadNote,
  }
}

// ---- retire / unretire: boot lists only; the book file is never touched ----

export type Toggle = (agents: Agent[], id: string, path: string, on: boolean) => { agents: Agent[]; changed: boolean }

/**
 * pure: `path` out of every boot list, through the same toggle the boot PATCH uses. A chapter of the book
 * (`<path>#<slug>`, B-0347) boots the book too, so it goes with it. `from` = the agents it left;
 * `entries` = what to put back, per agent: `<agent>` for the whole book, `<agent>|<slug>` for a chapter.
 */
export function withoutBoot(agents: Agent[], path: string, toggle: Toggle): { agents: Agent[]; from: string[]; entries: string[] } {
  let cur = agents
  const from: string[] = [], entries: string[] = []
  for (const a of agents) {
    for (const ref of (a.boot ?? []).filter(r => splitRef(r).path === path)) {
      const r = toggle(cur, a.id, ref, false)
      if (!r.changed) continue
      cur = r.agents
      if (!from.includes(a.id)) from.push(a.id)
      const slug = splitRef(ref).slug
      entries.push(slug ? `${a.id}|${slug}` : a.id)
    }
  }
  return { agents: cur, from, entries }
}

/** pure: put `path` (or its chapters, per `entries` as withoutBoot wrote them) back in the named agents' boot lists (agents that no longer exist are skipped) */
export function withBoot(agents: Agent[], path: string, entries: string[], toggle: Toggle): { agents: Agent[]; to: string[] } {
  let cur = agents
  const to: string[] = []
  for (const e of entries) {
    const [id, slug] = e.split('|')
    if (!cur.some(a => a.id === id)) continue
    const r = toggle(cur, id, slug ? `${path}#${slug}` : path, true)
    if (r.changed) { cur = r.agents; if (!to.includes(id)) to.push(id) }
  }
  return { agents: cur, to }
}

/** mark a book cold; a second retire updates n / ts / note and KEEPS the boot lists the first one took it out of */
export async function markCold(d: Queryable, path: string, n: number, note: string | null, boot: string[], at: number) {
  await ops.upsert('book_marks', { path, state: 'cold', n, ts: at, note, boot_json: boot }, { update: ['n', 'ts', 'note'] }, d)
}

/** drop the mark; returns the agents that booted with it when it was retired */
export async function unmark(d: Queryable, path: string): Promise<string[]> {
  const r = await ops.getBookMark(path, d)
  if (!r) throw new HttpError(404, `${path} is not retired`)
  await ops.dropBookMark(path, d)
  return safeList(r.boot_json)
}
