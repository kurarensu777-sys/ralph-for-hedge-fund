import { mkdirSync, watch } from 'node:fs'
import type { ServiceGroup } from '../../shared/types.ts'
import { logEvent } from '../db.ts'
import { publish } from '../events.ts'
import { onSummary } from '../hooks.ts'
import { HttpError, type Router } from '../http.ts'
import { BOARD_CONFIG_FILE, BOARD_DIR, CEO_DIR, FUND_ROOT, PORT } from '../paths.ts'
import { floorStopped } from '../system/floor.ts'
import { MAX_AUTO_CEILING, MAX_AUTO_PER_DAY_CEILING, readConfig as readBoardConfig, writeConfig as writeBoardConfig } from '../board/config.ts'
import { checkEffort, checkModel } from '../chat/models.ts'
import { commitPaths, repoOf } from '../loop/gitops.ts'
import { serial } from '../loop/engine.ts'
import { config } from '../config.ts'
import {
  BoardError, UNDO_MS, appendNote, byPriorityThenAge, chooseItem, claimItem, createItem, filterItems, handDone, itemPath, listItems, pickupItem, requireOptions, writeRaw,
  listAllItems, openBlockers, rankNext, readAnyItem, readItem, splitBody, updateItem, type Item,
} from '../board/store.ts'
import { ceoBrief, ceoFiler, ceoParts, createCeo, ensureChat, listCeo, noteCeo, readCeo, updateCeo } from '../board/ceo.ts'
import { attest, attestChoice, attestedFn, loadAttest, restoreAttest, snapshotAttest } from '../board/attest.ts'
import { readFileSync } from 'node:fs'
import { allowedOrigin, allowedPorts } from '../gate.ts'
import { chatsClient, eligible, holdReason, isAuto, pickupsSince, runningItems, tick, type TickResult } from '../board/auto.ts'
import { DebtError, dismiss, lastScan, listSuggested, saveScan, scan, start as startSuggestion, type ScanResult } from '../board/debt.ts'
import { spendable } from '../system/cap.ts'
import { bookRoots, lessons as bookLessons } from '../loop/sources.ts'

/**
 * ROOM: board - the one to-do system for the owner and every agent. The items are files in
 * app/board/ (see server/board/store.ts); this module serves them under /api/board/,
 * logs every change it makes, and watches the folder so a write from the CLI or an editor
 * reaches every open tab too.
 */

/** ids fundd itself just wrote, so the watcher does not log them a second time */
const selfWrites = new Map<string, number>()

function changed(id: string, summary: string, who?: string) {
  selfWrites.set(id, Date.now())
  logEvent('board', `${id} ${summary}`, { agent: who && who !== 'you' ? who : undefined })
  publish('board', { id })
}

function guard<T>(fn: () => T): T {
  try { return fn() } catch (e) { throw asHttp(e) }
}
async function guardAsync<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (e) { throw asHttp(e) }
}
const asHttp = (e: unknown) => (e instanceof BoardError || e instanceof DebtError ? new HttpError(e.status, e.message) : e)

/** the item plus its thinking and notes split out, for the drawer; `blocked` = open blockers */
function full(item: Item, all: Item[] = listAllItems(BOARD_DIR)) {
  const { text, notes } = splitBody(item.body)
  return { ...item, text, notes, blocked: openBlockers(item, all) }
}

const brief = (i: Item, all: Item[]) => ({ ...i, notes: splitBody(i.body).notes.length, blocked: openBlockers(i, all) })

/** the last choice per item, for its undo: the file before and after, and the attestation rows before */
const undoable = new Map<string, { before: string; after: string; at: number; rows: ReturnType<typeof snapshotAttest> }>()
/** the button's 10 s plus the round trip */
const UNDO_GRACE_MS = 3_000

// ---------- auto-pickup (server/board/auto.ts) ----------

const AUTO_ON = process.env.FUND_BOARD_AUTO !== '0'
const AUTO_EVERY_MS = 10_000
let lastTick: { at: string; result: TickResult | null; error: string | null } | null = null
const attested = attestedFn(FUND_ROOT, BOARD_DIR)

/** a request the cockpit UI sent (a browser sets Origin; curl, board.mjs and agents send none) */
const fromCockpit = (req: import('node:http').IncomingMessage) =>
  typeof req.headers.origin === 'string' && allowedOrigin(req.headers.origin, allowedPorts())

/** today's spend of every roster agent, read once, as the synchronous predicate auto.ts takes */
const spendNow = () => spendable(config.agents().map(a => a.id))

const autoDeps = async () => ({
  dir: BOARD_DIR,
  agents: () => config.agents().map(a => ({ id: a.id, mode: a.mode })),
  stopped: () => floorStopped(),
  manual: () => !readBoardConfig(BOARD_CONFIG_FILE).auto,
  max: () => readBoardConfig(BOARD_CONFIG_FILE).max,
  perDay: () => readBoardConfig(BOARD_CONFIG_FILE).perDay,
  attested,
  canSpend: await spendNow(),
  ...chatsClient(`http://127.0.0.1:${PORT}`, () => readBoardConfig(BOARD_CONFIG_FILE)),
  changed: (id: string, summary: string) => changed(id, summary, 'fundd'),
})

async function autoTick() {
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  try {
    await loadAttest()
    const result = await tick(await autoDeps())
    if (result.held !== 'tick in progress') lastTick = { at, result, error: null }
    return result
  } catch (e: any) {
    lastTick = { at, result: null, error: String(e?.message ?? e) }
    console.error('[board] auto tick:', e)
    return null
  }
}

/** 00:00 UTC today: the day the pickup cap counts (server/board/auto.ts) */
const utcDayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime() }

async function autoStatus() {
  const items = listAllItems(BOARD_DIR)
  const agents = config.agents().map(a => ({ id: a.id, mode: a.mode }))
  await loadAttest()
  const canSpend = await spendNow()
  const cfg = readBoardConfig(BOARD_CONFIG_FILE)
  return {
    on: AUTO_ON,
    manual: !cfg.auto,
    model: cfg.model,
    effort: cfg.effort,
    max: cfg.max,
    perDay: cfg.perDay,
    today: pickupsSince(listItems(BOARD_DIR), utcDayStart()),
    everyS: AUTO_EVERY_MS / 1000,
    stopped: floorStopped(),
    running: runningItems(items).map(i => ({ id: i.id, owner: i.owner, conversation: i.conversation })),
    eligible: eligible(items, agents, attested, canSpend).map(i => i.id),
    held: items.filter(i => isAuto(i) && i.status !== 'done' && i.status !== 'doing')
      .map(i => ({ id: i.id, reason: holdReason(i, items, agents, attested, canSpend) })).filter(x => x.reason),
    last: lastTick,
  }
}

// ---------- the debt scanner (server/board/debt.ts): suggestions in the ops store, never in board/ ----------

const DEBT_EVERY_MS = 60 * 60_000
let scanning: Promise<ScanResult> | null = null

function runScan(): Promise<ScanResult> {
  if (scanning) return scanning
  scanning = (async () => {
    const agents = config.agents().map(a => ({ id: a.id, cwd: a.cwd, writes: a.writes }))
    const roots = bookRoots(config.repos(), config.shelves().flatMap(s => s.roots))
    const r = await scan({
      root: FUND_ROOT, agents,
      // a partial git answer could hide the book that breaks a streak: any error = unknown
      lessons: async since => { const x = await bookLessons(FUND_ROOT, roots, since); return x.errors.length ? null : x.lessons },
    })
    await saveScan(r)
    publish('board:suggested', { found: r.findings.length })
    return r
  })().finally(() => { scanning = null })
  return scanning
}

async function suggested() {
  const last = await lastScan()
  return { suggestions: await listSuggested(), scan: last, scanning: scanning !== null, everyS: DEBT_EVERY_MS / 1000 }
}

export function register(r: Router) {
  mkdirSync(BOARD_DIR, { recursive: true })
  mkdirSync(CEO_DIR, { recursive: true })
  watchBoard()
  watchCeo()
  loadAttest().catch(e => console.error('[board] attestations not loaded:', (e as Error).message))

  // ---- suggested (debt), registered before /:id ----
  r.get('/api/board/suggested', () => suggested())
  r.post('/api/board/suggested/scan', async () => {
    const res = await runScan()
    logEvent('board', `debt scan: ${res.findings.length} found in ${res.files} files${res.capped ? ' (capped)' : ''}${res.errors.length ? `, ${res.errors.length} error(s)` : ''}`)
    return suggested()
  })
  r.post('/api/board/suggested/:fp/dismiss', async ({ params }) => {
    const s = await guardAsync(() => dismiss(params.fp))
    logEvent('board', `suggestion dismissed: ${s.title} (${s.ref})`, { payload: { fp: s.fp, path: s.path } })
    publish('board:suggested', { dismissed: s.fp })
    return suggested()
  })
  r.post('/api/board/suggested/:fp/start', async ({ params, req }) => {
    const { item, suggestion } = await guardAsync(() => startSuggestion(params.fp, BOARD_DIR))
    if (fromCockpit(req)) attest(item, 'cockpit suggestion start')
    changed(item.id, `filed by you from a suggestion (${suggestion.ref}): ${item.title}`, 'you')
    publish('board:suggested', { started: suggestion.fp, id: item.id })
    return { item: full(item), ...(await suggested()) }
  })

  r.get('/api/board', ({ query }) => {
    const live = listItems(BOARD_DIR)                     // what the room lists: the archive stays out of it
    const all = listAllItems(BOARD_DIR)                   // what blockers are read against: archived ones are done
    const items = filterItems(live, { status: query.get('status'), owner: query.get('owner'), from: query.get('from'), q: query.get('q') })
    return { items: items.sort(byPriorityThenAge).map(i => brief(i, all)) }
  })

  r.get('/api/board/agents', () => ({
    agents: config.agents().map(a => ({ id: a.id, name: a.name, dept: a.dept, mode: a.mode, kind: a.kind })),
  }))

  // registered before /:id so "next" / "auto" are never read as an id
  r.get('/api/board/auto', () => autoStatus())
  // the owner's switches (the room's head): Auto / Manual pickup, and the model + effort every
  // conversation the board starts boots on (null = the owner agent's own); committed as the owner's edit
  r.get('/api/board/config', () => readBoardConfig(BOARD_CONFIG_FILE))
  r.post('/api/board/config', async ({ body }) => {
    const b = (await body().catch(() => ({}))) ?? {}
    const patch: { auto?: boolean; model?: string | null; effort?: string | null; max?: number; perDay?: number } = {}
    if (b.max !== undefined) {
      if (typeof b.max !== 'number' || !Number.isInteger(b.max) || b.max < 1 || b.max > MAX_AUTO_CEILING) throw new HttpError(400, `max is a whole number from 1 to ${MAX_AUTO_CEILING}`)
      patch.max = b.max
    }
    if (b.perDay !== undefined) {
      if (typeof b.perDay !== 'number' || !Number.isInteger(b.perDay) || b.perDay < 1 || b.perDay > MAX_AUTO_PER_DAY_CEILING) throw new HttpError(400, `perDay is a whole number from 1 to ${MAX_AUTO_PER_DAY_CEILING}`)
      patch.perDay = b.perDay
    }
    if (b.auto !== undefined) {
      if (typeof b.auto !== 'boolean') throw new HttpError(400, 'auto is true or false')
      patch.auto = b.auto
    }
    if (b.model !== undefined) {
      if (b.model !== null && typeof b.model !== 'string') throw new HttpError(400, 'model is an exact id or null')
      patch.model = b.model || null
    }
    if (b.effort !== undefined) {
      if (b.effort !== null && typeof b.effort !== 'string') throw new HttpError(400, 'effort is a level or null')
      patch.effort = b.effort || null
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to set: auto, model, effort, max or perDay')
    const cur = readBoardConfig(BOARD_CONFIG_FILE)
    const model = patch.model !== undefined ? patch.model : cur.model
    if (model) {
      const pm = await checkModel(model).catch(e => { throw new HttpError(400, e.message) })
      // a model that takes no effort clears it; otherwise the effort must be one it takes
      if (!pm.efforts.length) patch.effort = null
      else { const eff = patch.effort !== undefined ? patch.effort : cur.effort; if (eff) { try { checkEffort(pm, eff) } catch (e) { throw new HttpError(400, (e as Error).message) } } }
    }
    const cfg = await serial(FUND_ROOT, async () => {
      writeBoardConfig(BOARD_CONFIG_FILE, patch)
      const rel = 'app/board/config.json'
      const { repo, prefix } = repoOf(FUND_ROOT, rel)
      const what = [patch.auto !== undefined ? (patch.auto ? 'auto' : 'manual') : '', patch.model !== undefined ? `model ${patch.model ?? 'agent'}` : '', patch.effort !== undefined ? `effort ${patch.effort ?? 'agent'}` : '', patch.max !== undefined ? `${patch.max} at once` : '', patch.perDay !== undefined ? `${patch.perDay} a day` : ''].filter(Boolean).join(', ')
      try { await commitPaths(repo, [rel.slice(prefix.length)], `board (owner): ${what}`, `Agent: owner\nBoard-Config: ${Object.keys(patch).join(',')}`) }
      catch (e) { console.error('[board] config commit', (e as Error).message) }
      return readBoardConfig(BOARD_CONFIG_FILE)
    })
    publish('board', { config: true })
    if (cfg.auto && AUTO_ON) setTimeout(() => { void autoTick() }, 500).unref()
    return cfg
  })
  r.post('/api/board/auto/tick', async () => {
    if (!AUTO_ON) throw new HttpError(409, 'auto-pickup is off (FUND_BOARD_AUTO=0)')
    const result = await autoTick()
    return { result, status: autoStatus() }
  })

  r.get('/api/board/next', ({ query }) => {
    const agent = (query.get('agent') ?? '').trim()
    if (!agent) throw new HttpError(400, 'agent is required')
    const ranked = rankNext(listAllItems(BOARD_DIR), agent, config.agents())
    return { agent, item: ranked[0] ? full(ranked[0]) : null, queue: ranked.slice(1, 6).map(i => i.id) }
  })

  // ---- the CEO board (server/board/ceo.ts): the owner's own list, registered before /:id ----
  const ceoChanged = (id: string, summary: string, who = 'you') => { logEvent('board', `${id} ${summary}`, { agent: who !== 'you' ? who : undefined }); publish('board', { ceo: id }) }
  const ceoOwner = (req: import('node:http').IncomingMessage) => {
    if (!fromCockpit(req)) throw new HttpError(403, "the CEO board is the owner's: only the cockpit edits it")
  }
  const rosterAgent = (v: unknown): string => {
    const a = typeof v === 'string' ? v.trim() : ''
    if (a && !config.agents().some(x => x.id === a)) throw new HttpError(400, `no agent ${a} in the roster`)
    return a
  }
  r.get('/api/board/ceo', () => ({ items: listCeo(CEO_DIR).map(ceoBrief) }))
  r.get('/api/board/ceo/:id', ({ params }) => guard(() => ceoParts(readCeo(CEO_DIR, params.id))))
  r.post('/api/board/ceo', async ({ body, req }) => {
    const b = (await body()) ?? {}
    const who = guard(() => ceoFiler({ fromCockpit: fromCockpit(req), asAgent: b.from, told: b.told }))
    const item = guard(() => createCeo(CEO_DIR, { ...b, agent: rosterAgent(b.agent), from: who.from, told: who.told }))
    ceoChanged(item.id, `filed by ${item.from}${item.told ? ` (told: ${item.told})` : ''}: ${item.title}`, item.from)
    return ceoParts(item)
  })
  r.patch('/api/board/ceo/:id', async ({ params, body, req }) => {
    ceoOwner(req)
    const b = (await body()) ?? {}
    if (b.agent !== undefined) b.agent = rosterAgent(b.agent)
    const { item, changed: keys } = guard(() => updateCeo(CEO_DIR, params.id, b))
    if (keys.length) ceoChanged(item.id, keys.map(k => (k === 'status' || k === 'priority' || k === 'agent' || k === 'due' ? `${k}=${(item as any)[k] || '-'}` : k)).join(' '))
    return ceoParts(item)
  })
  r.post('/api/board/ceo/:id/note', async ({ params, body, req }) => {
    ceoOwner(req)
    const b = (await body()) ?? {}
    const item = guard(() => noteCeo(CEO_DIR, params.id, 'you', String(b.text ?? '')))
    ceoChanged(item.id, 'note by you')
    return ceoParts(item)
  })
  // THE issue's one chat (server/board/ceo.ts ensureChat): the first press starts it, every later press answers the same id
  r.post('/api/board/ceo/:id/chat', async ({ params, body, req }) => {
    ceoOwner(req)
    const b = (await body().catch(() => ({}))) ?? {}
    const agent = b.agent !== undefined ? rosterAgent(b.agent) : undefined
    const r = await guardAsync(() => ensureChat(CEO_DIR, params.id, chatsClient(`http://127.0.0.1:${PORT}`), { agent, fresh: b.fresh === true }))
    if (r.started) ceoChanged(params.id, `chat ${r.conversation} started`)
    return r
  })

  r.get('/api/board/:id', ({ params }) => guard(() => full(readAnyItem(BOARD_DIR, params.id))))

  r.post('/api/board', async ({ body, req }) => {
    const b = await body()
    // an agent's question for the owner carries its options (the cockpit's own New form is the owner's)
    if (!fromCockpit(req)) guard(() => requireOptions({ from: 'you', ...(b ?? {}) }))
    const item = guard(() => createItem(BOARD_DIR, b ?? {}))
    if (fromCockpit(req)) attest(item, 'cockpit POST')
    changed(item.id, `filed by ${item.from}: ${item.title}`, item.from)
    return full(item)
  })

  r.patch('/api/board/:id', async ({ params, body, req }) => {
    const b = (await body()) ?? {}
    const who = typeof b.who === 'string' && b.who.trim() ? b.who.trim() : 'you'
    delete b.who
    if (b.chosen !== undefined) throw new HttpError(400, 'chosen is set by POST /api/board/:id/choose (the owner pick), never by a patch')
    const { item, changed: keys } = guard(() => updateItem(BOARD_DIR, params.id, b))
    if (who === 'you' && fromCockpit(req)) attest(item, 'cockpit PATCH')
    if (keys.length) changed(item.id, keys.map(k => (k === 'status' || k === 'owner' || k === 'priority' ? `${k}=${(item as any)[k] || '-'}` : k)).join(' '), who)
    return full(item)
  })

  r.post('/api/board/:id/note', async ({ params, body }) => {
    const b = (await body()) ?? {}
    const who = String(b.who ?? 'you').trim() || 'you'
    const item = guard(() => appendNote(BOARD_DIR, params.id, who, String(b.text ?? '')))
    changed(item.id, `note by ${who}`, who)
    return full(item)
  })

  r.post('/api/board/:id/claim', async ({ params, body }) => {
    const b = (await body()) ?? {}
    const agent = String(b.agent ?? '').trim()
    const item = guard(() => claimItem(BOARD_DIR, params.id, agent))
    changed(item.id, `claimed by ${agent}`, agent)
    return full(item)
  })

  // An agent asks the item's owner to start an EXISTING item now (server/board/store.ts pickupItem): ready +
  // auto + asked_by, then a tick, so it starts in this moment when no bound holds it. {by: <agent>, note?}.
  r.post('/api/board/:id/pickup', async ({ params, body }) => {
    const b = (await body()) ?? {}
    const by = String(b.by ?? '').trim()
    const item = guard(() => pickupItem(BOARD_DIR, params.id, by, typeof b.note === 'string' ? b.note : '', config.agents().map(a => a.id)))
    changed(item.id, `${by} asked ${item.owner} to pick it up now`, by)
    const result = AUTO_ON ? await autoTick() : null
    const picked = !!result?.picked.includes(item.id)
    // when it did not start: what holds THIS item (a blocker, the dormant owner, a cap), else what held the tick (STOP, Manual, a count)
    await loadAttest()
    const why = picked ? null : AUTO_ON
      ? holdReason(readItem(BOARD_DIR, item.id), listAllItems(BOARD_DIR), config.agents().map(a => ({ id: a.id, mode: a.mode })), attested, await spendNow()) ?? result?.held ?? 'waits for the next tick'
      : 'auto-pickup is off in this fundd (FUND_BOARD_AUTO=0)'
    return { item: full(readAnyItem(BOARD_DIR, item.id)), picked, why }
  })

  // ---- the owner's choice (the needs-you contract; server/board/store.ts chooseItem) ----
  // Owner-only: the cockpit's own Origin is the same attestation a Board room save carries, so
  // the pick counts as the owner's word (auto-pickup may then run an item an agent filed).
  const ownerOnly = (req: import('node:http').IncomingMessage) => {
    if (!fromCockpit(req)) throw new HttpError(403, 'only the owner chooses, from the Board room (board.mjs choose from his own shell)')
  }

  r.post('/api/board/:id/choose', async ({ params, body, req }) => {
    ownerOnly(req)
    const b = (await body()) ?? {}
    await loadAttest()
    const rows = snapshotAttest(params.id)
    const c = guard(() => chooseItem(BOARD_DIR, params.id, String(b.option ?? ''), typeof b.note === 'string' ? b.note : ''))
    attest(c.item, 'cockpit choose')
    attestChoice(c.item, 'cockpit choose')
    for (const [k, v] of undoable) if (Date.now() - v.at > UNDO_MS + UNDO_GRACE_MS) undoable.delete(k)
    undoable.set(c.item.id, { before: c.before, after: c.after, at: Date.now(), rows })
    changed(c.item.id, `owner chose ${c.option.id}: status=${c.item.status}${c.outcome === 'ready' ? ` owner=${c.item.owner || '-'}` : ''}`, 'you')
    return { item: full(c.item), option: c.option, outcome: c.outcome, undoMs: UNDO_MS }
  })

  r.post('/api/board/:id/undo', async ({ params, req }) => {
    ownerOnly(req)
    const u = undoable.get(params.id)
    if (!u || Date.now() - u.at > UNDO_MS + UNDO_GRACE_MS) throw new HttpError(409, `${params.id}: nothing to undo (a choice can be taken back for ${UNDO_MS / 1000} s)`)
    const file = guard(() => itemPath(BOARD_DIR, params.id))
    let now = ''
    try { now = readFileSync(file, 'utf8') } catch { /* gone */ }
    if (now !== u.after) throw new HttpError(409, `${params.id} changed since the choice; undo refused`)
    writeRaw(BOARD_DIR, params.id, u.before)
    restoreAttest(params.id, u.rows)
    undoable.delete(params.id)
    changed(params.id, 'owner undid the choice', 'you')
    return full(readItem(BOARD_DIR, params.id))
  })

  r.post('/api/board/:id/hand-done', async ({ params, body, req }) => {
    ownerOnly(req)
    const b = (await body()) ?? {}
    const item = guard(() => handDone(BOARD_DIR, params.id, typeof b.note === 'string' ? b.note : ''))
    changed(item.id, 'owner did it by hand: status=done', 'you')
    return full(item)
  })

  onSummary(() => ({ needsYou: listItems(BOARD_DIR).filter(i => i.status === 'needs-you').length }))

  // the debt scan: shortly after boot, then every hour (and on demand: POST /api/board/suggested/scan)
  const scanQuiet = () => { runScan().catch(e => console.error('[board] debt scan:', e)) }
  setTimeout(scanQuiet, 15_000).unref()
  setInterval(scanQuiet, DEBT_EVERY_MS).unref()

  if (AUTO_ON) {
    // first look a little after boot (the chats room must be listening), then every 10 s
    setTimeout(() => { void autoTick() }, 5_000).unref()
    setInterval(() => { void autoTick() }, AUTO_EVERY_MS).unref()
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
const pending = new Set<string>()

function watchBoard() {
  try {
    watch(BOARD_DIR, (_e, name) => {
      const f = String(name ?? '')
      if (!/^B-\d{4,}\.md$/.test(f)) return
      pending.add(f.slice(0, -3))
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const now = Date.now()
        for (const id of pending) {
          const mine = selfWrites.get(id)
          if (mine === undefined || now - mine > 2000) logEvent('board', `${id} changed on disk`)
        }
        for (const [id, ts] of selfWrites) if (now - ts > 5000) selfWrites.delete(id)
        pending.clear()
        publish('board')
      }, 150)
    })
  } catch { /* no folder: the list renders empty */ }
}

/** the CEO folder: a write from an editor or `board.mjs ceo add` reaches every open tab */
function watchCeo() {
  let t: ReturnType<typeof setTimeout> | null = null
  try {
    watch(CEO_DIR, (_e, name) => {
      if (!/^C-d{4,}.md$/.test(String(name ?? ''))) return
      if (t) clearTimeout(t)
      t = setTimeout(() => { t = null; publish('board', { ceo: true }) }, 150)
    })
  } catch { /* no folder: the lane renders empty */ }
}

/** the services rail: what is waiting on the owner, and what is being worked */
export async function services(): Promise<ServiceGroup | null> {
  const items = listItems(BOARD_DIR)
  const needs = items.filter(i => i.status === 'needs-you').length
  const doing = items.filter(i => i.status === 'doing').length
  const review = items.filter(i => i.status === 'review').length
  return {
    id: 'board', label: 'Board', rows: [
      { id: 'board-needs', label: 'needs you', status: needs ? 'warn' : 'ok', reading: String(needs), room: 'board', target: 'view:needs-you' },
      { id: 'board-doing', label: 'doing', status: 'ok', reading: String(doing), room: 'board', target: 'view:doing' },
      { id: 'board-review', label: 'review', status: 'ok', reading: String(review), room: 'board', target: 'view:review' },
    ],
  }
}
