import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CEO_PRIORITIES, CEO_STATUSES, type CeoItem } from '../../shared/ceo.ts'
import { BoardError, isoNow, splitBody, splitFrontmatter, withNote, writeAtomic } from './store.ts'

/**
 * The CEO board: the owner's own list, one markdown file per issue at <board>/ceo/C-0001.md. A
 * folder of its own beside the agents' board, as the debt scanner's suggestions are a store of
 * their own: the agents' board, auto-pickup and `board.mjs list` read B-NNNN.md in <board>/ only
 * and never see this folder.
 *
 *   ---
 *   title: "the title, JSON-quoted"
 *   status: open            (open | done)
 *   priority: p2
 *   due: 2026-10-07         (optional)
 *   agent: research         (the agent whose chat this issue gets; picked when the owner files it)
 *   conversation: c-0812    (the issue's ONE chat; set the first time it is opened)
 *   from: you               (or the agent the owner told to file it)
 *   told: "the owner's words"   (only when an agent filed it)
 *   created / updated
 *   ---
 *   the body, then notes as on the agents' board
 *
 * Only the cockpit files and edits here (server/rooms/board.ts); an agent files only when the
 * owner told it to, and the words are kept on the issue (`told`) so a filing nobody asked for shows.
 */

export const CEO_ID_RE = /^C-\d{4,}$/
const FILE_RE = /^C-\d{4,}\.md$/
const DAY_RE = /^\d{4}-\d\d-\d\d$/

export type CeoInput = { title?: unknown; priority?: unknown; due?: unknown; agent?: unknown; body?: unknown; from?: unknown; told?: unknown }

const unq = (v: string): string => {
  const s = v.trim()
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) { try { return JSON.parse(s) } catch { return s.slice(1, -1) } }
  return s
}
const bare = (v: string) => (/^[A-Za-z0-9_.:@/+-]+$/.test(v) ? v : JSON.stringify(v))
const oneLine = (v: unknown) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim()

export function parseCeo(raw: string, id: string): CeoItem {
  const { fm, body } = splitFrontmatter(raw)
  const s = (k: string) => (fm[k] === undefined ? '' : unq(fm[k]))
  const due = s('due')
  return {
    id,
    title: s('title') || id,
    status: (CEO_STATUSES as readonly string[]).includes(s('status')) ? s('status') as CeoItem['status'] : 'open',
    priority: (CEO_PRIORITIES as readonly string[]).includes(s('priority')) ? s('priority') as CeoItem['priority'] : 'p2',
    due: DAY_RE.test(due) ? due : '',
    agent: s('agent'),
    conversation: s('conversation'),
    from: s('from') || 'you',
    told: s('told'),
    created: s('created'),
    updated: s('updated') || s('created'),
    body: body.replace(/\s+$/, ''),
  }
}

export function serializeCeo(i: CeoItem): string {
  const lines = ['---', `title: ${JSON.stringify(oneLine(i.title))}`, `status: ${i.status}`, `priority: ${i.priority}`]
  if (i.due) lines.push(`due: ${i.due}`)
  if (i.agent) lines.push(`agent: ${bare(i.agent)}`)
  if (i.conversation) lines.push(`conversation: ${bare(i.conversation)}`)
  lines.push(`from: ${bare(i.from || 'you')}`)
  if (i.told) lines.push(`told: ${JSON.stringify(oneLine(i.told))}`)
  lines.push(`created: ${i.created}`, `updated: ${i.updated}`, '---', '')
  const body = i.body.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  return lines.join('\n') + '\n' + (body ? body + '\n' : '')
}

export function ceoPath(dir: string, id: string) {
  if (!CEO_ID_RE.test(id)) throw new BoardError(400, `not a CEO issue id: ${id}`)
  return join(dir, `${id}.md`)
}

export function listCeo(dir: string): CeoItem[] {
  if (!existsSync(dir)) return []
  const out: CeoItem[] = []
  for (const f of readdirSync(dir)) {
    if (!FILE_RE.test(f)) continue
    try { out.push(parseCeo(readFileSync(join(dir, f), 'utf8'), f.slice(0, -3))) } catch { /* vanished mid-read */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
}

export function readCeo(dir: string, id: string): CeoItem {
  const file = ceoPath(dir, id)
  if (!existsSync(file)) throw new BoardError(404, `no CEO issue ${id}`)
  return parseCeo(readFileSync(file, 'utf8'), id)
}

const writeCeo = (dir: string, i: CeoItem) => writeAtomic(ceoPath(dir, i.id), serializeCeo(i))

function check(input: CeoInput) {
  if (input.priority !== undefined && !(CEO_PRIORITIES as readonly string[]).includes(String(input.priority))) throw new BoardError(400, `priority must be one of ${CEO_PRIORITIES.join(' ')}`)
  if (input.due !== undefined && String(input.due) !== '' && !DAY_RE.test(String(input.due))) throw new BoardError(400, 'due is a date like 2026-10-07, or empty')
}

/** file an issue at the next free number (reserved with an exclusive create) */
export function createCeo(dir: string, input: CeoInput): CeoItem {
  const title = oneLine(input.title)
  if (!title) throw new BoardError(400, 'title is required')
  check(input)
  mkdirSync(dir, { recursive: true })
  let n = listCeo(dir).reduce((m, i) => Math.max(m, Number(i.id.slice(2))), 0) + 1
  let id = ''
  for (;; n++) {
    id = `C-${String(n).padStart(4, '0')}`
    try { closeSync(openSync(join(dir, `${id}.md`), 'wx')); break } catch (e: any) { if (e.code !== 'EEXIST') throw e }
  }
  const ts = isoNow()
  const item: CeoItem = {
    id, title, status: 'open', priority: (input.priority as CeoItem['priority']) ?? 'p2', due: String(input.due ?? ''),
    agent: oneLine(input.agent), conversation: '', from: oneLine(input.from) || 'you', told: oneLine(input.told),
    created: ts, updated: ts, body: String(input.body ?? '').replace(/\r\n/g, '\n').trim(),
  }
  writeCeo(dir, item)
  return item
}

/** change title / status / priority / due / agent / body. The agent is fixed once the issue has its
 *  chat: one chat per issue, with the agent it was opened with. */
export function updateCeo(dir: string, id: string, patch: CeoInput & { status?: unknown }): { item: CeoItem; changed: string[] } {
  check(patch)
  if (patch.status !== undefined && !(CEO_STATUSES as readonly string[]).includes(String(patch.status))) throw new BoardError(400, `status must be one of ${CEO_STATUSES.join(' ')}`)
  if (patch.title !== undefined && !oneLine(patch.title)) throw new BoardError(400, 'title is empty')
  const cur = readCeo(dir, id)
  const next: CeoItem = { ...cur }
  const changed: string[] = []
  const set = <K extends 'title' | 'status' | 'priority' | 'due' | 'agent' | 'body'>(k: K, v: CeoItem[K]) => { if (v !== next[k]) { next[k] = v; changed.push(k) } }
  if (patch.title !== undefined) set('title', oneLine(patch.title))
  if (patch.status !== undefined) set('status', String(patch.status) as CeoItem['status'])
  if (patch.priority !== undefined) set('priority', String(patch.priority) as CeoItem['priority'])
  if (patch.due !== undefined) set('due', String(patch.due))
  if (patch.body !== undefined) set('body', String(patch.body).replace(/\r\n/g, '\n').trim())
  if (patch.agent !== undefined) {
    const a = oneLine(patch.agent)
    if (a !== cur.agent && cur.conversation) throw new BoardError(409, `${id} already has its chat with ${cur.agent}: one chat per issue, so its agent stays (bring another agent in inside that chat)`)
    set('agent', a)
  }
  if (changed.length) { next.updated = isoNow(); writeCeo(dir, next) }
  return { item: next, changed }
}

/** record the issue's chat; the old id (a chat that no longer exists) is kept in the notes */
export function setConversation(dir: string, id: string, conversation: string): CeoItem {
  const cur = readCeo(dir, id)
  const body = cur.conversation && cur.conversation !== conversation
    ? withNote(cur.body, 'you', `chat ${cur.conversation} no longer exists; a new chat ${conversation} replaced it`) : cur.body
  const next = { ...cur, conversation, body, updated: isoNow() }
  writeCeo(dir, next)
  return next
}

export function noteCeo(dir: string, id: string, who: string, text: string): CeoItem {
  if (!text.trim()) throw new BoardError(400, 'a note needs text')
  const cur = readCeo(dir, id)
  const next = { ...cur, body: withNote(cur.body, who, text), updated: isoNow() }
  writeCeo(dir, next)
  return next
}

export const ceoParts = (i: CeoItem) => { const { text, notes } = splitBody(i.body); return { ...i, text, notes } }
export const ceoBrief = (i: CeoItem) => ({ ...i, notes: splitBody(i.body).notes.length })

/** who may file: the cockpit (the owner), or an agent the owner told, with the words kept. The one
 *  place the rule lives; the route and `board.mjs ceo add` both call it. Unenforced beyond this:
 *  an agent that invents the words, or calls the local API and names itself, gets through. */
export function ceoFiler(opts: { fromCockpit: boolean; asAgent?: string; told?: unknown }): { from: string; told: string } {
  if (opts.fromCockpit) return { from: 'you', told: '' }
  const told = oneLine(opts.told)
  const agent = oneLine(opts.asAgent)
  if (!told || !agent || agent === 'you') throw new BoardError(403, "the CEO board is the owner's: an agent files here only when the owner told it to, with the owner's words (--told \"...\")")
  return { from: agent, told }
}

/** the first message of an issue's chat: what it is, and that the list itself is the owner's */
export function ceoPrompt(i: CeoItem): string {
  const text = splitBody(i.body).text
  return [
    `CEO issue ${i.id}: ${i.title}`,
    `The owner opened this chat to work this issue with you. Priority ${i.priority}${i.due ? `, due ${i.due}` : ''}.`,
    text ? `\n${text.length > 4000 ? text.slice(0, 4000) + '\n[cut]' : text}\n` : '',
    'The issue is on the owner\'s own board: do not edit it and do not file items there. Work it here, in this chat. File ordinary board items for other agents as usual.',
  ].filter(Boolean).join('\n')
}

// ---- the issue's one chat ----

export type ChatsApi = { startChat(agent: string, prompt: string, title: string): Promise<string>; chatState(id: string): Promise<string> }
const locks = new Map<string, Promise<unknown>>()

/**
 * Open the issue's chat: the first call starts it with the issue's agent and records the id on the issue;
 * every later call answers that same id. Calls for one issue run one at a time, so a double click cannot
 * start two. A recorded chat that no longer exists answers 410 (the caller may ask again with fresh: true,
 * which starts a new one and notes the old id). `agent` picks the agent only while there is no chat yet.
 */
export function ensureChat(dir: string, id: string, chats: ChatsApi, opt: { agent?: string; fresh?: boolean } = {}): Promise<{ conversation: string; started: boolean }> {
  const run = async () => {
    let item = readCeo(dir, id)
    if (opt.agent !== undefined && !item.conversation) item = updateCeo(dir, id, { agent: opt.agent }).item
    if (!item.agent) throw new BoardError(409, `${id} has no agent yet: pick one to chat with`)
    if (item.conversation && !opt.fresh) {
      if ((await chats.chatState(item.conversation)) === 'gone') throw new BoardError(410, `chat ${item.conversation} no longer exists`)
      return { conversation: item.conversation, started: false }
    }
    const conversation = await chats.startChat(item.agent, ceoPrompt(item), `${item.id} ${item.title}`.slice(0, 120))
    setConversation(dir, id, conversation)
    return { conversation, started: true }
  }
  const prev = locks.get(id) ?? Promise.resolve()
  const mine = prev.then(run, run)
  locks.set(id, mine.catch(() => undefined))
  return mine
}
