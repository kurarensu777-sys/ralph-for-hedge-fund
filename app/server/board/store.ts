import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent, BoardItem } from '../../shared/types.ts'

/**
 * The board's file store: one markdown file per item at <board>/B-0001.md.
 *
 *   ---
 *   title: "the title, JSON-quoted"
 *   status: backlog
 *   kind: todo
 *   owner: platform
 *   from: you
 *   priority: p2
 *   labels: [a, b]
 *   created: 2026-09-24T10:00:00Z
 *   updated: 2026-09-24T10:00:00Z
 *   blocked_by: [B-0003]          (optional: written only when non-empty)
 *   conversation: <chats id>      (optional: the auto-pickup conversation)
 *   asked_by: <agent>             (optional: the agent that asked the owner to start it now, `pickupItem`)
 *   ---
 *
 *   the body (the thinking)
 *
 *   ### 2026-09-24T11:00:00Z - platform
 *
 *   a note, newest last
 *
 * Pure node, no dependencies and only erasable TypeScript, so fundd AND the plain-node CLI
 * (scripts/board.mjs, node >= 23.6 strips the types) share exactly this code. Every write
 * is atomic: a temp file in the same folder, then a rename over the item.
 */

export const STATUSES = ['needs-you', 'backlog', 'ready', 'doing', 'review', 'done'] as const
export const KINDS = ['todo', 'instruction', 'build', 'question', 'bug'] as const
export const PRIORITIES = ['p0', 'p1', 'p2'] as const
const FIELDS = ['title', 'status', 'kind', 'owner', 'from', 'priority', 'labels', 'created', 'updated'] as const
/** the label that lets fundd pick an item up on its own */
export const AUTO_LABEL = 'auto'

/**
 * A board item plus the two OPTIONAL fields added 2026-09-24. Both are absent on disk (and on
 * the parsed object) when empty, so every file written before them reads back unchanged.
 */
export type Item = BoardItem & { blocked_by?: string[]; conversation?: string; asked_by?: string; options?: Option[]; chosen?: string }

/**
 * One choosable answer on a needs-you item (the owner, 2026-09-25: "when issues are submitted to
 * me on the board, it should be a choosable action"). `rec` = the filer's recommendation; `hand` =
 * the owner must do it himself (the label is the exact command); `owner` = who runs it once chosen
 * (default: the item's agent owner, else the agent that filed it); `done` = choosing it closes the
 * item (a "leave it" / no-op answer). On disk, in the frontmatter, one flow map per line:
 *
 *   options:
 *     - {id: rm, label: "git -C platform rm .claude/settings.json", rec: true, hand: true}
 *     - {id: law, label: "Write the exception into the law", owner: fund}
 *   chosen: rm                    (optional: the owner's pick, set by chooseItem)
 *
 * The block form (`- id: rm` then indented `label: ...` lines) reads too.
 */
export type Option = { id: string; label: string; rec?: boolean; hand?: boolean; owner?: string; done?: boolean }

export type Note = { ts: string; who: string; text: string }
export type BoardInput = Partial<Omit<Item, 'id' | 'created' | 'updated'>> & { created?: string }

/** an error a caller made on purpose (bad field, unknown id, refused claim) */
export class BoardError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export const ID_RE = /^B-\d{4,}$/
const FILE_RE = /^B-\d{4,}\.md$/
const NOTE_RE = /^### (\d{4}-\d\d-\d\dT\S+) - (.+)$/gm

export const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

// ---------- frontmatter ----------

function unquote(v: string): string {
  const s = v.trim()
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s) } catch { return s.slice(1, -1) }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'")
  return s
}

function parseList(v: string): string[] {
  const s = v.trim()
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
  return inner.split(',').map(x => unquote(x)).map(x => x.trim()).filter(Boolean)
}

/** labels are single tokens: no commas or brackets (they would break the one-line list) */
export function cleanLabels(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  const out: string[] = []
  for (const x of arr) {
    const t = String(x).replace(/[,[\]"'\r\n]/g, ' ').trim().replace(/\s+/g, '-')
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** split a file into its frontmatter map and the body; tolerant of CRLF and a BOM */
export function splitFrontmatter(raw: string): { fm: Record<string, string>; body: string; lines: string[] } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const fm: Record<string, string> = {}
  if (!text.startsWith('---\n')) return { fm, body: text, lines: [] }
  const end = text.indexOf('\n---', 4)
  if (end < 0) return { fm, body: text, lines: [] }
  const lines = text.slice(4, end).split('\n')
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line)
    if (m) fm[m[1]] = m[2]
  }
  const after = text.slice(end + 4).replace(/^[^\n]*\n/, '')
  return { fm, body: after.replace(/^\n+/, ''), lines }
}

/**
 * An unknown value still loads (as the default) so one bad file never hides the board, but it is
 * never SILENT: the first sighting of each (item, field, value) warns on stderr, naming the fix.
 */
const warned = new Set<string>()
function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], dflt: T, where = ''): T {
  if (v !== undefined && (allowed as readonly string[]).includes(v)) return v as T
  if (v !== undefined && where && !warned.has(`${where}=${v}`)) {
    warned.add(`${where}=${v}`)
    console.warn(`board: ${where} ${JSON.stringify(v)} is not one of ${allowed.join(' | ')}; read as ${dflt}`)
  }
  return dflt
}

/** blocked_by values: board ids only, deduplicated, never the item itself */
export function cleanBlockers(v: unknown, self?: string): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.replace(/^\s*\[|\]\s*$/g, '').split(/[,\s]+/) : []
  const out: string[] = []
  for (const x of arr) {
    const t = String(x).trim().toUpperCase()
    if (!t) continue
    if (!ID_RE.test(t)) throw new BoardError(400, `blocked_by takes board ids like B-0003 (got ${x})`)
    if (t !== self && !out.includes(t)) out.push(t)
  }
  return out
}

// ---------- options (the needs-you contract) ----------

export const OPTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
/** option ids that close the item when chosen, even without `done: true` */
const DONE_IDS = new Set(['leave', 'noop', 'no-op', 'none', 'decline'])
/** what an item with no options of its own offers: yes runs it, no closes it */
export const DEFAULT_OPTIONS: Option[] = [{ id: 'approve', label: 'Approve' }, { id: 'decline', label: 'Decline', done: true }]
/** how long the owner can take a choice back (and auto-pickup holds a fresh choice) */
export const UNDO_MS = 10_000

const truthy = (v: string | undefined) => v !== undefined && /^(true|yes|y|1)$/i.test(unquote(v))

/** `{a: 1, b: "x, y"}` -> {a: '1', b: '"x, y"'}; values stay raw (unquoted by the caller) */
export function parseFlowMap(src: string): Record<string, string> {
  const s = src.trim().replace(/^\{/, '').replace(/\}\s*$/, '')
  const out: Record<string, string> = {}
  let i = 0
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++
    const k0 = i
    while (i < s.length && s[i] !== ':') i++
    const key = s.slice(k0, i).trim()
    i++                                                         // the colon
    while (i < s.length && s[i] === ' ') i++
    let val = ''
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]; const v0 = i; i++
      while (i < s.length && s[i] !== q) { if (s[i] === '\\' && q === '"') i++; i++ }
      i++
      val = s.slice(v0, i)
    } else {
      const v0 = i
      while (i < s.length && s[i] !== ',') i++
      val = s.slice(v0, i).trim()
    }
    if (/^[A-Za-z_][\w-]*$/.test(key)) out[key] = val
  }
  return out
}

function toOption(r: Record<string, string>): Option | null {
  const id = r.id === undefined ? '' : unquote(r.id).trim()
  const label = r.label === undefined ? '' : unquote(r.label).replace(/[\r\n]+/g, ' ').trim()
  if (!OPTION_ID_RE.test(id) || !label) return null
  const owner = r.owner === undefined ? '' : unquote(r.owner).trim()
  return {
    id, label,
    ...(truthy(r.rec) ? { rec: true } : {}),
    ...(truthy(r.hand) ? { hand: true } : {}),
    ...(owner ? { owner } : {}),
    ...(truthy(r.done) ? { done: true } : {}),
  }
}

/** the `options:` block of a frontmatter (its raw lines); a bad entry is dropped with a warning, never silently */
export function parseOptions(lines: string[], where = ''): Option[] {
  const at = lines.findIndex(l => /^options:\s*(\[\s*\])?\s*$/.test(l))
  if (at < 0) return []
  const raw: Record<string, string>[] = []
  let cur: Record<string, string> | null = null
  for (const l of lines.slice(at + 1)) {
    if (!/^[\s-]/.test(l)) break                                // the next top-level key
    const t = l.trim()
    if (!t) continue
    const pair = (x: string) => { const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(x); if (m && cur) cur[m[1]] = m[2] }
    if (t.startsWith('-')) {
      cur = {}; raw.push(cur)
      const rest = t.slice(1).trim()
      if (rest.startsWith('{')) Object.assign(cur, parseFlowMap(rest))
      else if (rest) pair(rest)
    } else pair(t)
  }
  const out: Option[] = []
  for (const r of raw) {
    const o = toOption(r)
    const why = !o ? 'needs an id (letters, digits, - or _) and a label' : out.some(x => x.id === o.id) ? `repeats id ${o.id}` : ''
    if (why) {
      const key = `${where} option ${JSON.stringify(r)}`
      if (where && !warned.has(key)) { warned.add(key); console.warn(`board: ${where} option ${JSON.stringify(r)} ${why}; dropped`) }
      continue
    }
    out.push(o!)
  }
  return out
}

/** one option as its frontmatter line */
export function optionLine(o: Option): string {
  const parts = [`id: ${o.id}`, `label: ${JSON.stringify(o.label.replace(/[\r\n]+/g, ' ').trim())}`]
  if (o.rec) parts.push('rec: true')
  if (o.hand) parts.push('hand: true')
  if (o.owner) parts.push(`owner: ${scalar(o.owner)}`)
  if (o.done) parts.push('done: true')
  return `  - {${parts.join(', ')}}`
}

/**
 * The shell spec `id=label;id2=label2*`: `*` marks the recommendation, `!` a by-hand option (the
 * label is the command), `~` one that closes the item; ` @agent` before the marks names who runs it.
 */
export function parseOptionSpec(spec: string): Option[] {
  const out: Option[] = []
  for (const part of String(spec).split(';').map(x => x.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq <= 0) throw new BoardError(400, `option "${part}" is not id=label`)
    const id = part.slice(0, eq).trim()
    const m = /^(.*?)(?:\s+@([A-Za-z0-9_:.-]+))?\s*([*!~]*)$/.exec(part.slice(eq + 1).trim())!
    const label = m[1].trim(), marks = m[3] ?? ''
    if (!OPTION_ID_RE.test(id)) throw new BoardError(400, `option id "${id}" takes letters, digits, - and _ (at most 32)`)
    if (!label) throw new BoardError(400, `option ${id} has no label`)
    if (out.some(o => o.id === id)) throw new BoardError(400, `option id ${id} is given twice`)
    out.push({ id, label, ...(marks.includes('*') ? { rec: true } : {}), ...(marks.includes('!') ? { hand: true } : {}), ...(m[2] ? { owner: m[2] } : {}), ...(marks.includes('~') ? { done: true } : {}) })
  }
  if (out.filter(o => o.rec).length > 1) throw new BoardError(400, 'at most one option is the recommendation (*)')
  return out
}

/** options from a caller: a spec string, an array of objects, or nothing */
export function cleanOptions(v: unknown): Option[] {
  if (v === undefined || v === null || v === '' || v === 'none') return []
  if (typeof v === 'string') return parseOptionSpec(v)
  if (!Array.isArray(v)) throw new BoardError(400, 'options is a list of {id, label, rec?, hand?, owner?, done?} or an "id=label;id2=label2*" spec')
  const out: Option[] = []
  for (const x of v) {
    const r: Record<string, string> = {}
    for (const [k, val] of Object.entries(x ?? {})) r[k] = typeof val === 'string' ? JSON.stringify(val) : String(val)
    const o = toOption(r)
    if (!o) throw new BoardError(400, `option ${JSON.stringify(x)} needs an id (letters, digits, - or _) and a label`)
    if (out.some(y => y.id === o.id)) throw new BoardError(400, `option id ${o.id} is given twice`)
    out.push(o)
  }
  if (out.filter(o => o.rec).length > 1) throw new BoardError(400, 'at most one option is the recommendation')
  return out
}

/**
 * An agent that FILES a question for the owner gives him the answers to pick: a new needs-you item
 * from an agent carries options (board.mjs add and fundd's POST refuse it otherwise). Moving an
 * existing item to needs-you is not refused - the owner then sees Approve / Decline.
 */
export function requireOptions(input: { status?: unknown; from?: unknown; options?: unknown }) {
  const from = String(input.from ?? 'you').trim() || 'you'
  if (input.status !== 'needs-you' || from === 'you') return
  if (cleanOptions(input.options).length) return
  throw new BoardError(400, `a question for the owner carries its answers: add options (board.mjs add ... --options "a=label;b=label*", * = your recommendation, ! = he runs it by hand, ~ = closes it)`)
}

/** the options an owner is offered: the item's own, else Approve / Decline */
export const offered = (i: Item): Option[] => (i.options?.length ? i.options : DEFAULT_OPTIONS)
/** does choosing this close the item? */
export const closes = (o: Option) => !!o.done || DONE_IDS.has(o.id.toLowerCase())
const isAgentId = (x: string | undefined) => !!x && x !== 'you'

export function parseItem(raw: string, id: string): Item {
  const { fm, body, lines } = splitFrontmatter(raw)
  const s = (k: string) => (fm[k] === undefined ? undefined : unquote(fm[k]))
  const blocked = fm.blocked_by === undefined ? [] : parseList(fm.blocked_by).map(x => x.toUpperCase()).filter(x => ID_RE.test(x) && x !== id)
  const conv = s('conversation')?.trim() ?? ''
  const options = parseOptions(lines, id)
  const chosen = s('chosen')?.trim() ?? ''
  const asked = s('asked_by')?.trim() ?? ''
  return {
    ...(blocked.length ? { blocked_by: blocked } : {}),
    ...(conv ? { conversation: conv } : {}),
    ...(asked ? { asked_by: asked } : {}),
    ...(options.length ? { options } : {}),
    ...(chosen ? { chosen } : {}),
    id,
    title: s('title') ?? id,
    status: oneOf(s('status'), STATUSES, 'backlog', `${id} status`),
    kind: oneOf(s('kind'), KINDS, 'todo', `${id} kind`),
    owner: s('owner') ?? '',
    from: s('from') ?? '',
    priority: oneOf(s('priority'), PRIORITIES, 'p2', `${id} priority`),
    labels: fm.labels === undefined ? [] : parseList(fm.labels),
    created: s('created') ?? '',
    updated: s('updated') ?? s('created') ?? '',
    body: body.replace(/\s+$/, ''),
  }
}

/** a scalar value on one line: bare when it is a plain token, else JSON-quoted */
function scalar(v: string): string {
  return /^[A-Za-z0-9_.:@/+-]*$/.test(v) && v !== '' ? v : JSON.stringify(v)
}

export function serializeItem(item: Item): string {
  const lines = ['---']
  for (const k of FIELDS) {
    if (k === 'title') lines.push(`title: ${JSON.stringify(item.title.replace(/[\r\n]+/g, ' '))}`)
    else if (k === 'labels') lines.push(`labels: [${cleanLabels(item.labels).join(', ')}]`)
    else lines.push(`${k}: ${scalar(String(item[k] ?? ''))}`)
  }
  // the two optional fields, only when set: a file written before them stays byte-identical
  const blocked = (item.blocked_by ?? []).filter(x => ID_RE.test(x) && x !== item.id)
  if (blocked.length) lines.push(`blocked_by: [${blocked.join(', ')}]`)
  const conv = String(item.conversation ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (conv) lines.push(`conversation: ${scalar(conv)}`)
  const asked = String(item.asked_by ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (asked) lines.push(`asked_by: ${scalar(asked)}`)
  // the needs-you contract, only when set (same rule: an item without them stays byte-identical)
  if (item.options?.length) lines.push('options:', ...item.options.map(optionLine))
  const chosen = String(item.chosen ?? '').trim()
  if (chosen) lines.push(`chosen: ${scalar(chosen)}`)
  lines.push('---', '')
  const body = item.body.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  return lines.join('\n') + '\n' + (body ? body + '\n' : '')
}

/** the body split into the thinking and its notes thread (oldest first, as on disk) */
export function splitBody(body: string): { text: string; notes: Note[] } {
  const heads = [...body.matchAll(NOTE_RE)]
  if (heads.length === 0) return { text: body.trim(), notes: [] }
  const notes: Note[] = heads.map((m, i) => {
    const start = m.index! + m[0].length
    const end = i + 1 < heads.length ? heads[i + 1].index! : body.length
    return { ts: m[1], who: m[2].trim(), text: body.slice(start, end).trim() }
  })
  return { text: body.slice(0, heads[0].index).trim(), notes }
}

export function withNote(body: string, who: string, text: string, ts = isoNow()): string {
  const head = `### ${ts} - ${who.replace(/[\r\n]+/g, ' ').trim() || 'you'}`
  return `${body.replace(/\s+$/, '')}${body.trim() ? '\n\n' : ''}${head}\n\n${text.trim()}\n`
}

// ---------- the folder ----------

export function writeAtomic(file: string, content: string) {
  const tmp = join(file, '..', `.${file.split(/[\\/]/).pop()}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  writeFileSync(tmp, content)
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return } catch (e: any) {
      // Windows: a reader (the watcher, an editor) can hold the target for a moment
      if (i >= 8 || (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) {
        try { unlinkSync(tmp) } catch { /* gone */ }
        throw e
      }
      const until = Date.now() + 25 * (i + 1)
      while (Date.now() < until) { /* short spin: the rename must stay synchronous */ }
    }
  }
}

export function itemPath(dir: string, id: string) {
  if (!ID_RE.test(id)) throw new BoardError(400, `not a board id: ${id}`)
  return join(dir, `${id}.md`)
}

export function listItems(dir: string): Item[] {
  if (!existsSync(dir)) return []
  const out: Item[] = []
  for (const f of readdirSync(dir)) {
    if (!FILE_RE.test(f)) continue
    try { out.push(parseItem(readFileSync(join(dir, f), 'utf8'), f.slice(0, -3))) } catch { /* vanished mid-read */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
}

export function readItem(dir: string, id: string): Item {
  const file = itemPath(dir, id)
  if (!existsSync(file)) throw new BoardError(404, `no board item ${id}`)
  return parseItem(readFileSync(file, 'utf8'), id)
}

// ---- the archive. `board.mjs archive` (weekly, schedule.json board-archive) MOVES done items older
// than 14 days into <board>/done/, which the room's list and auto-pickup do not read. Everything that
// reasons about an id rather than about what to show - the next number, an item's blockers, a read by
// id, the loop's done count - must still see them, or the first archive run hands out a number twice
// and blocks forever every item whose blocker was archived (B-0079). done/ only ever holds done items.

/** the archive folder of a board */
export const archiveDir = (dir: string) => join(dir, 'done')

/** every item the board knows: the live ones, then the archived ones (all done) */
export function listAllItems(dir: string): Item[] {
  return [...listItems(dir), ...listItems(archiveDir(dir))]
}

/** an item by id, live or archived. An archived item is read-only: a write goes through readItem, which
 *  refuses it, so a note can never quietly bring an archived item back to the live board. */
export function readAnyItem(dir: string, id: string): Item {
  try { return readItem(dir, id) } catch (e) {
    if (!(e instanceof BoardError) || e.status !== 404) throw e
    const file = itemPath(archiveDir(dir), id)
    if (!existsSync(file)) throw e
    return parseItem(readFileSync(file, 'utf8'), id)
  }
}

/** put a file back exactly as it was (the undo of a choice), atomically */
export function writeRaw(dir: string, id: string, raw: string) {
  writeAtomic(itemPath(dir, id), raw)
}

export function writeItem(dir: string, item: Item) {
  writeAtomic(itemPath(dir, item.id), serializeItem(item))
}

function validate(patch: Record<string, unknown>) {
  if (patch.status !== undefined && !(STATUSES as readonly string[]).includes(String(patch.status))) throw new BoardError(400, `status must be one of ${STATUSES.join(' ')}`)
  if (patch.kind !== undefined && !(KINDS as readonly string[]).includes(String(patch.kind))) throw new BoardError(400, `kind must be one of ${KINDS.join(' ')}`)
  if (patch.priority !== undefined && !(PRIORITIES as readonly string[]).includes(String(patch.priority))) throw new BoardError(400, `priority must be one of ${PRIORITIES.join(' ')}`)
  if (patch.title !== undefined && !String(patch.title).trim()) throw new BoardError(400, 'title is empty')
}

/** create an item at the next free number; the number is reserved with an exclusive create */
export function createItem(dir: string, input: BoardInput): Item {
  if (!input.title || !String(input.title).trim()) throw new BoardError(400, 'title is required')
  validate(input as Record<string, unknown>)
  const options = cleanOptions(input.options)
  // every refusal happens BEFORE a number is reserved: a reservation is a file on disk, and one left
  // behind by a refused input is a blank item on the board for good (a bad blocked_by did exactly that)
  const wanted = cleanBlockers(input.blocked_by ?? [])
  mkdirSync(dir, { recursive: true })
  // the archive counts: an archived number is never handed out again (B-0079)
  let n = listAllItems(dir).reduce((m, i) => Math.max(m, Number(i.id.slice(2))), 0) + 1
  let id = ''
  for (;; n++) {
    id = `B-${String(n).padStart(4, '0')}`
    if (existsSync(join(archiveDir(dir), `${id}.md`))) continue
    try { closeSync(openSync(join(dir, `${id}.md`), 'wx')); break } catch (e: any) { if (e.code !== 'EEXIST') throw e }
  }
  const ts = isoNow()
  const blocked = wanted.filter(b => b !== id)
  const item: Item = {
    ...(blocked.length ? { blocked_by: blocked } : {}),
    ...(options.length ? { options } : {}),
    id,
    title: String(input.title).trim(),
    status: input.status ?? 'backlog',
    kind: input.kind ?? 'todo',
    owner: String(input.owner ?? '').trim(),
    from: String(input.from ?? 'you').trim() || 'you',
    priority: input.priority ?? 'p2',
    labels: cleanLabels(input.labels ?? []),
    created: input.created ?? ts,
    updated: ts,
    body: String(input.body ?? '').replace(/\r\n/g, '\n').trim(),
  }
  writeItem(dir, item)
  return item
}

/** change any fields (not the id, not created); `updated` is stamped */
export function updateItem(dir: string, id: string, patch: Record<string, unknown>): { item: Item; changed: string[] } {
  validate(patch)
  const item = readItem(dir, id)
  const changed: string[] = []
  const next: any = { ...item }
  for (const k of ['title', 'status', 'kind', 'owner', 'from', 'priority', 'labels', 'body'] as const) {
    if (patch[k] === undefined) continue
    const v = k === 'labels' ? cleanLabels(patch[k]) : k === 'body' ? String(patch[k]).replace(/\r\n/g, '\n').trim() : String(patch[k]).trim()
    if (JSON.stringify(v) !== JSON.stringify(next[k])) { next[k] = v; changed.push(k) }
  }
  // the two optional fields: absent when empty, so an old file is rewritten byte-for-byte the same
  if (patch.blocked_by !== undefined) {
    const v = cleanBlockers(patch.blocked_by, id)
    if (JSON.stringify(v) !== JSON.stringify(next.blocked_by ?? [])) { if (v.length) next.blocked_by = v; else delete next.blocked_by; changed.push('blocked_by') }
  }
  // a new owner is a new hand: whoever asked the old one to start does not start the new one
  if (changed.includes('owner') && next.asked_by) { delete next.asked_by; changed.push('asked_by') }
  if (patch.conversation !== undefined) {
    const v = String(patch.conversation ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (v !== (next.conversation ?? '')) { if (v) next.conversation = v; else delete next.conversation; changed.push('conversation') }
  }
  if (patch.options !== undefined) {
    const v = cleanOptions(patch.options)
    if (JSON.stringify(v) !== JSON.stringify(next.options ?? [])) { if (v.length) next.options = v; else delete next.options; changed.push('options') }
  }
  if (patch.chosen !== undefined) {
    const v = String(patch.chosen ?? '').trim()
    if (v && !offered(next).some((o: Option) => o.id === v)) throw new BoardError(400, `chosen: ${v} is not one of the item's options`)
    if (v !== (next.chosen ?? '')) { if (v) next.chosen = v; else delete next.chosen; changed.push('chosen') }
  }
  if (changed.length) { next.updated = isoNow(); writeItem(dir, next) }
  return { item: next, changed }
}

// ---------- the owner's choice ----------

export type Outcome = 'ready' | 'done' | 'hand'
export type Choice = { item: Item; option: Option; outcome: Outcome; before: string; after: string }

/** the heading every choice note carries: `### <ts> - owner chose: <label>` */
export const CHOSE = 'owner chose: '

/**
 * The owner picks one of a needs-you item's options. The pick is recorded as a note headed
 * `owner chose: <label>` (plus the owner's note), `chosen` is set, and the item moves on:
 *  - a closing option (`done`, or id leave / noop / decline) -> done;
 *  - a by-hand option (`hand`) -> stays needs-you, with a `- [ ] <command>` line the owner ticks
 *    (handDone) once he has run it;
 *  - anything else -> ready for whoever runs it (the option's `owner`, else the item's agent owner,
 *    else the agent that filed it), labelled `auto` when that is an agent, so board auto-pickup
 *    starts it like any ready item.
 * Refused unless the item is needs-you. Only the owner may call this: fundd's route admits the
 * cockpit alone and board.mjs refuses any FUND_AGENT. Returns the file before and after (undo).
 */
export function chooseItem(dir: string, id: string, optionId: string, note = '', ts = isoNow()): Choice {
  const file = itemPath(dir, id)
  if (!existsSync(file)) throw new BoardError(404, `no board item ${id}`)
  const before = readFileSync(file, 'utf8')
  const item = parseItem(before, id)
  if (item.status !== 'needs-you') throw new BoardError(409, `${id} is ${item.status}, not needs-you: nothing to choose`)
  const opts = offered(item)
  const option = opts.find(o => o.id === String(optionId ?? '').trim())
  if (!option) throw new BoardError(400, `${id}: option ${optionId || '(none)'} is not one of ${opts.map(o => o.id).join(' | ')}`)
  const outcome: Outcome = option.hand ? 'hand' : closes(option) ? 'done' : 'ready'
  const next: Item = { ...item, chosen: option.id, updated: ts }
  const text = [note.trim(), outcome === 'hand' ? `- [ ] ${option.label}` : ''].filter(Boolean).join('\n\n') || (outcome === 'done' ? 'closed' : outcome === 'ready' ? 'to ready' : '')
  next.body = withNote(item.body, `${CHOSE}${option.label}`, text, ts).trim()
  if (outcome === 'done') next.status = 'done'
  if (outcome === 'ready') {
    const runner = option.owner || (isAgentId(item.owner) ? item.owner : isAgentId(item.from) ? item.from : item.owner)
    next.status = 'ready'
    next.owner = runner
    if (isAgentId(runner) && !next.labels.includes(AUTO_LABEL)) next.labels = [...next.labels, AUTO_LABEL]
  }
  writeItem(dir, next)
  return { item: next, option, outcome, before, after: serializeItem(next) }
}

/** the owner ran a by-hand choice: its checklist line is ticked and the item is done */
export function handDone(dir: string, id: string, note = '', ts = isoNow()): Item {
  const item = readItem(dir, id)
  const option = item.chosen ? offered(item).find(o => o.id === item.chosen) : undefined
  if (item.status !== 'needs-you' || !option?.hand) throw new BoardError(409, `${id} has no by-hand choice waiting`)
  const line = `- [ ] ${option.label}`
  const at = item.body.lastIndexOf(line)
  const body = at < 0 ? item.body : item.body.slice(0, at) + `- [x] ${option.label}` + item.body.slice(at + line.length)
  const next: Item = { ...item, status: 'done', updated: ts, body: withNote(body, 'you', note.trim() || `done by hand: ${option.label}`, ts).trim() }
  writeItem(dir, next)
  return next
}

/** when the owner last chose on this item (its newest `owner chose:` note), or null */
export function chosenAt(i: Item): number | null {
  const notes = splitBody(i.body).notes.filter(n => n.who.startsWith(CHOSE))
  const t = notes.length ? Date.parse(notes[notes.length - 1].ts) : NaN
  return Number.isFinite(t) ? t : null
}

export function appendNote(dir: string, id: string, who: string, text: string): Item {
  if (!text || !String(text).trim()) throw new BoardError(400, 'note text is empty')
  const item = readItem(dir, id)
  const ts = isoNow()
  const next = { ...item, body: withNote(item.body, who, String(text), ts).trim(), updated: ts }
  writeItem(dir, next)
  return next
}

/** claim: owner = agent, status = doing, and a note. Refused while another agent is doing it. */
export function claimItem(dir: string, id: string, agent: string): Item {
  const who = String(agent ?? '').trim()
  if (!who) throw new BoardError(400, 'agent is required')
  const item = readItem(dir, id)
  if (item.status === 'doing' && item.owner && item.owner !== who) throw new BoardError(409, `${id} is being done by ${item.owner}`)
  if (item.status === 'done') throw new BoardError(409, `${id} is done`)
  const ts = isoNow()
  const was = item.owner ? `${item.owner}, ${item.status}` : `unassigned, ${item.status}`
  const next: Item = { ...item, owner: who, status: 'doing', updated: ts, body: withNote(item.body, who, `claimed (was ${was})`, ts).trim() }
  writeItem(dir, next)
  return next
}

/**
 * An agent asks the owner of an EXISTING item to start it now (the owner, 2026-10-04): ready, labelled
 * auto, `asked_by` the asker, and a note by the asker; fundd's next tick starts it (server/board/auto.ts
 * reads `asked_by` where it would read `from`). Refused: no asker (the owner uses the Board room), an
 * asker the roster does not know, the asker being the owner (an agent never starts itself), an owner
 * who is not an agent, and an item already doing, done or waiting on the owner. A blocked item is NOT
 * refused: it holds, and holdReason says so. `roster` = the agent ids; null skips the roster checks.
 */
export function pickupItem(dir: string, id: string, asker: string, why = '', roster: string[] | null = null): Item {
  const by = String(asker ?? '').trim()
  if (!by || by === 'you') throw new BoardError(403, 'only an agent asks for a pickup (the owner starts an item from the Board room)')
  if (roster && !roster.includes(by)) throw new BoardError(403, `${by} is not an agent on the roster`)
  const item = readItem(dir, id)
  if (!item.owner || item.owner === 'you') throw new BoardError(400, `${id} has no agent owner: assign one first`)
  if (roster && !roster.includes(item.owner)) throw new BoardError(400, `${id}: ${item.owner} is not an agent on the roster`)
  if (item.owner === by) throw new BoardError(400, `${id} is yours: ${by} does its own work in its own conversation, never by starting itself`)
  if (item.status === 'doing' || item.status === 'done' || item.status === 'needs-you') throw new BoardError(409, `${id} is ${item.status}: nothing to pick up`)
  const ts = isoNow()
  const note = `asked ${item.owner} to pick this up now${why.trim() ? `: ${why.trim()}` : ''}`
  const next: Item = {
    ...item, status: 'ready', asked_by: by, updated: ts,
    labels: item.labels.includes(AUTO_LABEL) ? item.labels : [...item.labels, AUTO_LABEL],
    body: withNote(item.body, by, note, ts).trim(),
  }
  writeItem(dir, next)
  return next
}

// ---------- queries ----------

const PRI_RANK: Record<string, number> = { p0: 0, p1: 1, p2: 2 }
const t = (s: string) => { const v = Date.parse(s); return Number.isFinite(v) ? v : Infinity }

/** priority first, then oldest first */
export function byPriorityThenAge(a: BoardItem, b: BoardItem) {
  return (PRI_RANK[a.priority] - PRI_RANK[b.priority]) || (t(a.created) - t(b.created)) || a.id.localeCompare(b.id, 'en', { numeric: true })
}

/**
 * The department an UNASSIGNED item belongs to, or null when nothing says: a `dept:<name>`
 * label wins, else the dept of the agent that filed it. Items the owner filed carry no dept
 * unless labelled, so they are open to everyone.
 */
export function itemDept(item: BoardItem, agents: Pick<Agent, 'id' | 'dept'>[]): string | null {
  const lab = item.labels.find(l => l.toLowerCase().startsWith('dept:'))
  if (lab) return lab.slice(5).toLowerCase()
  const from = agents.find(a => a.id === item.from)
  return from ? from.dept.toLowerCase() : null
}

/**
 * The best item for `agent` to pick up next, in tiers: (1) its OWN ready items, (2) unassigned
 * ready items in its dept, (3) unassigned ready items that name no dept. Within a tier:
 * priority, then age (oldest first). Items owned by someone else never qualify, and neither does
 * an item whose blocked_by still names an item that is not done.
 */
export function rankNext(items: Item[], agent: string, agents: Pick<Agent, 'id' | 'dept'>[]): Item[] {
  const dept = agents.find(a => a.id === agent)?.dept.toLowerCase() ?? null
  const tier = (i: BoardItem): number => {
    if (i.status !== 'ready') return -1
    if (openBlockers(i, items).length) return -1
    if (i.owner === agent) return 0
    if (i.owner) return -1
    const d = itemDept(i, agents)
    if (d !== null && dept !== null && d === dept) return 1
    if (d === null) return 2
    return -1
  }
  return items
    .map(i => ({ i, k: tier(i) }))
    .filter(x => x.k >= 0)
    .sort((a, b) => (a.k - b.k) || byPriorityThenAge(a.i, b.i))
    .map(x => x.i)
}

export type ListFilter = { status?: string | null; owner?: string | null; from?: string | null; q?: string | null }

/** true when an agent (not the owner, not nobody) filed the item */
export const filedByAgent = (i: BoardItem) => !!i.from && i.from !== 'you'

/**
 * The ids in an item's blocked_by that still block it: every one that is not done. An id that
 * names no item blocks too - an unknown is not a green light. Pass listAllItems(dir), not
 * listItems(dir): an archived blocker is done, and a live-only list reads it as unknown (B-0079).
 */
export function openBlockers(item: Item, items: Item[]): string[] {
  const byId = new Map(items.map(i => [i.id, i]))
  return (item.blocked_by ?? []).filter(b => byId.get(b)?.status !== 'done')
}

/** status: comma list; owner: an id, "you", or "-" for unassigned; from: an id, "you", or "agents" (any agent); q: words over id/title/body/labels */
export function filterItems(items: BoardItem[], f: ListFilter): BoardItem[] {
  const statuses = f.status ? f.status.split(',').map(s => s.trim()).filter(Boolean) : null
  const words = (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter(i => {
    if (statuses && !statuses.includes(i.status)) return false
    if (f.owner) { if (f.owner === '-' ? i.owner !== '' : i.owner !== f.owner) return false }
    if (f.from) { if (f.from === 'agents' ? !filedByAgent(i) : i.from !== f.from) return false }
    if (words.length) {
      const hay = `${i.id} ${i.title} ${i.labels.join(' ')} ${i.owner} ${i.from} ${i.body}`.toLowerCase()
      if (!words.every(w => hay.includes(w))) return false
    }
    return true
  })
}
