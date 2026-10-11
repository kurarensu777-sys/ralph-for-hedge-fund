import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BoardItem } from '../../../shared/types.ts'
import { api, useApi } from '../../lib/api.ts'

/** one filter shared by the Explorer, the Head and the Main (they are separate components) */
export type Filter = {
  owner: string                  // 'all' | 'you' | '-' (unassigned) | an agent id
  from: string                   // 'all' | 'agents' (anything an agent filed) | 'you' | an agent id
  auto: boolean                  // only items labelled auto
  kind: string                   // 'all' | a kind
  q: string
  only: '' | 'needs-you' | 'done-week' | 'backlog' | 'ready' | 'doing' | 'review'
}
export const ALL: Filter = { owner: 'all', from: 'all', auto: false, kind: 'all', q: '', only: '' }

const KEY = 'fundos.board.filter'
let cur: Filter = (() => {
  try { const raw = localStorage.getItem(KEY); return raw ? { ...ALL, ...JSON.parse(raw) } : ALL } catch { return ALL }
})()
const subs = new Set<() => void>()

export function setFilter(patch: Partial<Filter>) {
  cur = { ...cur, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(cur)) } catch { /* private window */ }
  subs.forEach(f => f())
}

export function useFilter(): Filter {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => cur)
}

export const COLUMNS: { id: BoardItem['status']; label: string; title: string }[] = [
  { id: 'needs-you', label: 'Needs you', title: 'Waiting on the owner: a question, an approval' },
  { id: 'backlog', label: 'Backlog', title: 'Filed, not yet ready to pick up' },
  { id: 'ready', label: 'Ready', title: 'Ready to pick up (what /next hands out)' },
  { id: 'doing', label: 'Doing', title: 'Someone is on it' },
  { id: 'review', label: 'Review', title: 'Not a parking lane: the loop sends each item to its owner agent in a fresh conversation, which closes it (done: a pushed commit, a green area) or returns it (ready, with what is missing)' },
  { id: 'done', label: 'Done', title: 'Finished' },
]
export const KINDS: BoardItem['kind'][] = ['todo', 'instruction', 'build', 'question', 'bug']
export const PRIORITIES: BoardItem['priority'][] = ['p0', 'p1', 'p2']

export type AgentLite = { id: string; name: string; dept: string; mode: string; kind: string }
/** one choosable answer on a needs-you item (server/board/store.ts Option) */
export type Option = { id: string; label: string; rec?: boolean; hand?: boolean; owner?: string; done?: boolean }
/** the optional fields the store added (absent on older items), plus the open blockers */
export type Extra = { blocked_by?: string[]; conversation?: string; blocked?: string[]; options?: Option[]; chosen?: string }

/** what the owner is offered: the item's own options, else Approve / Decline (the store's DEFAULT_OPTIONS) */
export const DEFAULT_OPTIONS: Option[] = [{ id: 'approve', label: 'Approve' }, { id: 'decline', label: 'Decline', done: true }]
export const offered = (i: Extra): Option[] => (i.options?.length ? i.options : DEFAULT_OPTIONS)
/** the by-hand option the owner picked and has not ticked yet, or null */
export const handWaiting = (i: BoardItem & Extra): Option | null => {
  if (i.status !== 'needs-you' || !i.chosen) return null
  const o = offered(i).find(x => x.id === i.chosen)
  return o?.hand ? o : null
}
export type Listed = BoardItem & Extra & { notes: number }
export type Full = BoardItem & Extra & { text: string; notes: { ts: string; who: string; text: string }[] }

export const AUTO = 'auto'
export const isAuto = (i: BoardItem) => i.labels.includes(AUTO)
export const filedByAgent = (i: BoardItem) => !!i.from && i.from !== 'you'

const WEEK = 7 * 86400_000

export function matches(i: BoardItem, f: Filter): boolean {
  if (f.owner !== 'all' && (f.owner === '-' ? i.owner !== '' : i.owner !== f.owner)) return false
  if (f.kind !== 'all' && i.kind !== f.kind) return false
  if (f.from && f.from !== 'all' && (f.from === 'agents' ? !filedByAgent(i) : i.from !== f.from)) return false
  if (f.auto && !isAuto(i)) return false
  if (f.only === 'done-week') { if (i.status !== 'done' || Date.now() - Date.parse(i.updated) > WEEK) return false }
  else if (f.only && i.status !== f.only) return false
  if (!textMatch(`${i.id} ${i.title} ${i.labels.join(' ')} ${i.owner} ${i.body}`, f.q)) return false
  return true
}

/** the pill's text filter, one rule for cards and suggestions: every word of q appears somewhere
 *  in the haystack, case-insensitive; an empty q matches everything */
export function textMatch(hay: string, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const h = hay.toLowerCase()
  return words.every(w => h.includes(w))
}

/** a suggestion under the same text filter: its title, quote and path (the ref and owner too) */
export const sugMatches = (s: { title: string; quote: string; path: string; ref: string; owner: string | null }, q: string) =>
  textMatch(`${s.title} ${s.quote} ${s.path} ${s.ref} ${s.owner ?? ''}`, q)

export const patchItem = (id: string, body: Record<string, unknown>) => api<Full>(`/api/board/${id}`, { method: 'PATCH', body })

/** start a conversation with the item's owner about it (the Chats room serves POST /api/chats) */
/** the board's own setting (GET /api/board/config, server/board/config.ts) */
export type BoardConfig = { auto: boolean; model: string | null; effort: string | null; max: number; perDay?: number; source: string | null }

/** start a conversation with the item's owner, on the board's model / effort when set (null = the agent's own) */
export async function startChat(item: BoardItem & { text?: string }, brain?: Pick<BoardConfig, 'model' | 'effort'> | null): Promise<string> {
  const text = (item.text ?? item.body).trim()
  const prompt = [
    `Board item ${item.id}: ${item.title}`,
    `Kind ${item.kind}, priority ${item.priority}, filed by ${item.from || 'you'}.`,
    text ? `\n${text.length > 4000 ? text.slice(0, 4000) + '\n[cut; read the whole item with: node app/scripts/board.mjs show ' + item.id + ']' : text}\n` : '',
    `Claim it first: node app/scripts/board.mjs claim ${item.id} --agent ${item.owner}`,
    `When done, move it to review and append a note with what you did:`,
    `  node app/scripts/board.mjs move ${item.id} review`,
    `  node app/scripts/board.mjs note ${item.id} "<what you did>" --who ${item.owner}`,
  ].join('\n')
  const r = await api<any>('/api/chats', { body: { agent: item.owner, prompt, title: `${item.id} ${item.title}`.slice(0, 120), ...(brain?.model ? { model: brain.model } : {}), ...(brain?.effort ? { effort: brain.effort } : {}) } })
  const id = r?.id ?? r?.conversation?.id ?? r?.chat?.id
  if (!id) throw new Error('chats returned no conversation id')
  return String(id)
}

/** progress a card can show honestly: done of total, and where the count came from */
export type Progress = { done: number; total: number; src: 'steps' | 'checklist' }

/** the item's own markdown checklist (`- [ ]` / `- [x]`), or null when it has none */
export function checklist(body: string): Progress | null {
  let done = 0, total = 0
  for (const m of body.matchAll(/^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+\S/gm)) { total++; if (m[1] !== ' ') done++ }
  return total ? { done, total, src: 'checklist' } : null
}

type TodoLite = { status: string }
type EntryLite = { action?: { type?: string; todos?: TodoLite[] } }
/** the owner conversation's own step list: its LAST todo list (TodoWrite), or null when it never wrote one */
export function convSteps(entries: EntryLite[] | null | undefined): Progress | null {
  for (let k = (entries?.length ?? 0) - 1; k >= 0; k--) {
    const t = entries![k].action
    if (t?.type === 'todo' && t.todos?.length) return { done: t.todos.filter(x => x.status === 'completed').length, total: t.todos.length, src: 'steps' }
  }
  return null
}

/** the conversation's steps win over the item's checklist; neither -> no bar */
export const progressOf = (steps: Progress | null, list: Progress | null): Progress | null => steps ?? list

/** fundd's auto-pickup as GET /api/board/auto reports it: only what the day count reads */
export type PickupStatus = { on: boolean; manual?: boolean; stopped: boolean; perDay?: number; today?: number; last: { at: string; error: string | null; result?: { held: string | null } | null } | null }

/**
 * The day's pickups against the cap, in the three honest states. `today` / `perDay` are absent from an
 * older fundd (a field a commit adds is absent for up to 30 min), so absent = unknown, never 0.
 * `held` is the reason the last tick gave, shown only when that tick said one.
 */
export type PickupReading = { state: 'unknown' } | { state: 'known'; today: number; perDay: number; full: boolean; held: string | null }
export function pickupReading(a: PickupStatus | null): PickupReading {
  if (!a || typeof a.today !== 'number' || typeof a.perDay !== 'number') return { state: 'unknown' }
  const held = !a.on ? 'auto-pickup is off in this fundd (FUND_BOARD_AUTO=0)' : a.manual ? 'manual: the board switch holds every pickup'
    : a.stopped ? 'floor/STOP exists' : a.last?.result?.held ?? null
  return { state: 'known', today: a.today, perDay: a.perDay, full: a.today >= a.perDay, held }
}

// ---------- a doing item nobody is working on ----------

/** a doing item younger than this has not been given up on: a start takes a moment to show */
export const NO_LIVE_MIN = 10
/** a hand-started item (no conversation named) is judged by its owner's chats only this long: past it an untouched doing item is flagged even while its owner is busy elsewhere */
export const NO_LIVE_HAND_MIN = 180
export type ChatLook = { id: string; agent: string; state: 'live' | 'waiting' | 'idle' | 'closed' }

/**
 * Is this doing item's work really under way? A session end closes the conversations it started and
 * nothing resets their items (B-0323 to B-0328 read doing for five days). `true` = doing with no live
 * or waiting conversation for over NO_LIVE_MIN minutes; `false` = fine, or not a doing item an agent
 * owns; `null` = cannot tell (the chat list has not answered), which draws nothing, never a flag.
 * An item that names its conversation is judged by that conversation; one that names none (a hand
 * start) by whether its owner agent has any conversation live or waiting, and once untouched for
 * NO_LIVE_HAND_MIN minutes it is flagged whatever its owner is doing (B-0323 to B-0328 hid behind a busy owner).
 */
export function noLiveConversation(i: Pick<BoardItem, 'status' | 'owner' | 'updated'> & { conversation?: string }, chats: ChatLook[] | null, now = Date.now()): boolean | null {
  if (i.status !== 'doing' || !i.owner || i.owner === 'you') return false
  const at = Date.parse(i.updated)
  if (!Number.isFinite(at)) return null
  if (now - at < NO_LIVE_MIN * 60_000) return false
  if (!chats) return null
  const working = (c: ChatLook) => c.state === 'live' || c.state === 'waiting'
  if (i.conversation) return !chats.some(c => c.id === i.conversation && working(c))
  return now - at >= NO_LIVE_HAND_MIN * 60_000 || !chats.some(c => c.agent === i.owner && working(c))
}

/** the clock, ticking each minute, so a flag appears when its grace runs out without any other event */
export function useMinute(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t) }, [])
  return now
}

/** the verdict for any item with its own chat read (the drawer; the lanes judge from the list they already hold) */
export function useNoLive(): (i: Parameters<typeof noLiveConversation>[0]) => boolean | null {
  const q = useApi<{ conversations: ChatLook[] }>('/api/chats?limit=1000', ['chat'])
  const now = useMinute()
  const chats = q.data?.conversations ?? null
  return i => noLiveConversation(i, chats, now)
}
