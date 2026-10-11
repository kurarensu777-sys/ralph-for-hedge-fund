import {
  AUTO_LABEL, CHOSE, UNDO_MS, appendNote, offered, byPriorityThenAge, chosenAt, listAllItems, listItems, openBlockers, readItem, splitBody, updateItem, withNote,
  isoNow, writeItem, type Item,
} from './store.ts'

/**
 * AUTO-PICKUP: fundd starts the work on its own.
 *
 * TWO KINDS OF POSTING (the owner, 2026-09-27). NOW work: an item an agent files for ANOTHER agent,
 * ready and labelled "auto" (`board.mjs add --now`) - the filer is instructing that agent to start,
 * so it runs without the owner's click. BACKLOG: everything else (the default status of a new item);
 * it waits until the owner or an agent moves it on.
 *
 * An item qualifies when ALL hold: status ready, label "auto", and one of: FILED BY ANOTHER AGENT on
 * the roster (now work), FILED BY THE OWNER (from: you, attested) or CHOSEN BY THE OWNER (an agent's
 * needs-you item whose option the owner picked, `chosen:`, attested); owner is an agent in the roster
 * whose mode is not dormant; nothing in its blocked_by still open. An agent's item for ITSELF never
 * starts itself, so no agent loops on its own work. What bounds an agent-to-agent chain is MAX_AUTO
 * (concurrency), MAX_AUTO_PER_DAY, the spend cap and floor/STOP; board.mjs refuses an agent that
 * signs as anyone but itself. `from: you` is only frontmatter, so it is never
 * trusted ON ITS OWN: the item must also be ATTESTED as the owner's (server/board/attest.ts - filed
 * or edited from the cockpit UI, or added to the fund repo by a commit with no Agent trailer). A
 * raw file an agent wrote with `from: you` is held, and holdReason says so. MAX_AUTO caps concurrency and MAX_AUTO_PER_DAY
 * caps how many pickups start in one UTC day; both bind unasked items only: an item with `asked_by` (an
 * agent's `board.mjs pickup`, the owner 2026-10-06) is exempt from both and sorts ahead of the rest, while
 * floor/STOP, Manual, blocked_by, a dormant or unknown owner and the spend cap still hold it. Each tick:
 *
 *   1. every running auto item (doing + auto + a conversation) is checked against the chats
 *      API; once that conversation's turn has ended (idle, closed or gone) and the item is
 *      still doing, it moves to review with a note.
 *   2. while floor/STOP is absent, the owner's board switch is on Auto (app/board/config.json,
 *      server/board/config.ts) and fewer than MAX_AUTO auto conversations are running, the
 *      best eligible item (priority, then age) is moved to doing with a note FIRST (so a second
 *      tick or a restart can never pick it twice), then the conversation is started and its id
 *      is written to the item's `conversation` field, on the board's model when one is set. A start that fails parks the item in
 *      needs-you with the reason, so a broken start is never retried every ten seconds.
 *
 * Pure apart from the deps, so the test drives it with the chats calls mocked.
 */

export const MAX_AUTO = 2
/** pickups started per UTC day by default (board.perDay in app/board/config.json overrides it), counted from fundd's own "auto: picked up" notes on the items */
export const MAX_AUTO_PER_DAY = 10
/** a conversation not yet seen working is only called ended after this long (boot takes a moment) */
export const GRACE_MS = 60_000
export const WHO = 'fundd'

export type ChatLook = 'live' | 'waiting' | 'idle' | 'closed' | 'gone' | 'unknown'

export type AutoDeps = {
  dir: string
  agents: () => { id: string; mode: string }[]
  stopped: () => boolean
  /** the owner's Manual switch (app/board/config.json "board".auto false): nothing is picked up; absent = auto */
  manual?: () => boolean
  /** how many pickups may run at once (the owner's box); absent = MAX_AUTO */
  max?: () => number
  /** how many pickups may start in one UTC day (the owner's setting, board.perDay); absent = MAX_AUTO_PER_DAY */
  perDay?: () => number
  /** is this `from: you` item really the owner's? (server/board/attest.ts) */
  attested: (i: Item) => boolean
  startChat: (agent: string, prompt: string, title: string) => Promise<string>
  chatState: (id: string) => Promise<ChatLook>
  now?: () => number
  changed?: (id: string, summary: string) => void
  /** may this agent spend now? (server/system/cap.ts; absent = always) */
  canSpend?: (agent: string) => boolean
}

export type TickResult = { picked: string[]; ended: string[]; failed: string[]; running: string[]; held: string | null; askedHeld: Record<string, string> }

export const isAuto = (i: Item) => i.labels.includes(AUTO_LABEL)
/** an agent asked for this item to start now (`board.mjs pickup`): exempt from MAX_AUTO and the day cap, sorted first */
export const isAsked = (i: Item) => !!i.asked_by?.trim()

/** why an item is NOT auto-pickable right now, or null when it is */
export function holdReason(i: Item, items: Item[], agents: { id: string; mode: string }[], attested: (i: Item) => boolean, canSpend: (agent: string) => boolean = () => true, now = Date.now()): string | null {
  if (!isAuto(i)) return 'not auto'
  if (i.status !== 'ready') return `status ${i.status}`
  if (!i.owner || i.owner === 'you') return 'no agent owner'
  // `asked_by` (board.mjs pickup) is who told this agent to start NOW, so it stands where the filer would: an
  // item the owner filed, or another agent did, starts on an agent's word when that agent asked for it
  const asker = i.asked_by?.trim() || ''
  const from = asker || i.from || 'you'
  const act = asker ? 'asked' : 'filed'
  const byOwner = from === 'you'
  // NOW WORK (the owner, 2026-09-27): an agent that files an item for ANOTHER agent, ready and
  // labelled auto (`board.mjs add --now`), is instructing it to start, and it starts without the
  // owner's click. Two holds stay: an agent's item for ITSELF (no agent restarts itself in a loop),
  // and a `from` that names no agent on the roster. The owner's own items, and an agent's item the
  // owner chose an option on, still need the owner's attested word.
  const agentNow = !byOwner && !i.chosen
  if (agentNow) {
    if (from === i.owner) return `${act} by ${from} for itself`
    if (!agents.some(a => a.id === from)) return `${act} by ${from}, not an agent on the roster`
  } else if (!attested(i)) return byOwner
    ? 'from: you is not attested (file or edit it in the cockpit, or commit it without an Agent trailer)'
    : `the choice ${i.chosen} is not attested (choose it in the Board room, or commit it without an Agent trailer)`
  const at = i.chosen ? chosenAt(i) : null
  if (at !== null && now - at < UNDO_MS + 5_000) return 'just chosen (the undo window)'
  const a = agents.find(x => x.id === i.owner)
  if (!a) return `no agent ${i.owner}`
  if (a.mode === 'dormant') return `${i.owner} is dormant`
  if (!canSpend(a.id)) return 'capped'
  const b = openBlockers(i, items)
  if (b.length) return `blocked by ${b.join(', ')}`
  return null
}

export function eligible(items: Item[], agents: { id: string; mode: string }[], attested: (i: Item) => boolean, canSpend?: (agent: string) => boolean, now = Date.now()): Item[] {
  return items.filter(i => holdReason(i, items, agents, attested, canSpend, now) === null)
    .sort((a, b) => Number(isAsked(b)) - Number(isAsked(a)) || byPriorityThenAge(a, b))
}

/** how many pickups fundd started since `sinceMs` (its "auto: picked up" notes, across every item) */
export function pickupsSince(items: Item[], sinceMs: number): number {
  let n = 0
  const re = new RegExp(String.raw`^### (\S+) - ${WHO}\s*\n+auto: picked up`, 'gm')
  for (const i of items) for (const m of i.body.matchAll(re)) { const t = Date.parse(m[1]); if (Number.isFinite(t) && t >= sinceMs) n++ }
  return n
}

/** auto items whose conversation fundd is tracking */
export const runningItems = (items: Item[]) => items.filter(i => i.status === 'doing' && isAuto(i) && !!i.conversation)

/** the brief the agent is started with */
export function briefFor(i: Item): string {
  const { text, notes } = splitBody(i.body)
  const pick = i.chosen ? offered(i).find(o => o.id === i.chosen) : undefined
  const said = [...notes].reverse().find(n => n.who.startsWith(CHOSE))
  return [
    ...(pick ? [`THE OWNER CHOSE: ${pick.label} (option ${pick.id}). That choice is the owner's word: carry it out, nothing else.${said?.text && said.text !== 'to ready' ? `\nHis note: ${said.text}` : ''}`] : []),
    `Board item ${i.id}: ${i.title}`,
    `Kind ${i.kind}, priority ${i.priority}, ${i.asked_by ? `filed by ${i.from || 'you'}, started on the request of ${i.asked_by}` : `filed by ${i.from || 'you'}`}. It was picked up AUTOMATICALLY: it is already yours and in doing.`,
    text ? `\n${text.length > 4000 ? text.slice(0, 4000) + `\n[cut; read the whole item with: node app/scripts/board.mjs show ${i.id}]` : text}\n` : '',
    `When done, move it to review and append a note with what you did and the sha of the pushed commit (the loop sends it to a fresh reviewer, who needs the commit):`,
    `  node app/scripts/board.mjs move ${i.id} review`,
    `  node app/scripts/board.mjs note ${i.id} "<what you did>" --who ${i.owner}`,
    `If you cannot do it, move it to needs-you with a note saying why, and give the owner his answers as options to click:`,
    `  node app/scripts/board.mjs options ${i.id} "a=<what he can pick>;b=<another>*"   (* your recommendation, ! he runs it by hand, ~ closes it)`,
    `When this turn ends, fundd moves an item still in doing to review.`,
  ].join('\n')
}

/** conversations seen working this fundd life, and when each pickup happened */
const seenWorking = new Set<string>()
const pickedAt = new Map<string, number>()
let inTick = false

/** test seam: forget the in-memory state */
export function resetAutoState() { seenWorking.clear(); pickedAt.clear(); inTick = false }

export async function tick(d: AutoDeps): Promise<TickResult> {
  const out: TickResult = { picked: [], ended: [], failed: [], running: [], held: null, askedHeld: {} }
  if (inTick) { out.held = 'tick in progress'; return out }
  inTick = true
  const now = d.now ?? Date.now
  const note = (id: string, s: string) => d.changed?.(id, s)
  try {
    // 1. finish what ended
    for (const i of runningItems(listItems(d.dir))) {
      const conv = i.conversation!
      const st = await d.chatState(conv)
      if (st === 'live' || st === 'waiting') { seenWorking.add(conv); out.running.push(i.id); continue }
      if (st === 'unknown') { out.running.push(i.id); continue }   // cannot tell: keep the slot
      const since = pickedAt.get(i.id) ?? Date.parse(i.updated)
      if (!seenWorking.has(conv) && Number.isFinite(since) && now() - since < GRACE_MS) { out.running.push(i.id); continue }
      const cur = readItem(d.dir, i.id)                              // re-read: the agent may have moved it
      if (cur.status !== 'doing' || cur.conversation !== conv) continue
      updateItem(d.dir, i.id, { status: 'review' })
      appendNote(d.dir, i.id, WHO, `auto: conversation ${conv} ended (${st}) with the item still in doing; moved to review`)
      seenWorking.delete(conv); pickedAt.delete(i.id)
      out.ended.push(i.id)
      note(i.id, `auto: ${conv} ended, status=review`)
    }

    // 2. pick up
    if (d.stopped()) { out.held = 'floor/STOP'; return out }
    if (d.manual?.()) { out.held = 'manual'; return out }
    const agents = d.agents()
    const cap = d.max?.() ?? MAX_AUTO
    let slots = cap - out.running.length
    const day0 = new Date(now()); day0.setUTCHours(0, 0, 0, 0)
    const perDay = d.perDay?.() ?? MAX_AUTO_PER_DAY
    let today = pickupsSince(listItems(d.dir), day0.getTime())
    // the two caps bind unasked items only: an agent's pickup request (`asked_by`) is the owner's standing
    // instruction (2026-10-06) and sorts first, so it never waits behind them
    const capHeld = () => slots <= 0 ? `${cap} running` : today >= perDay ? `${perDay} pickups today` : null
    for (const cand of eligible(listAllItems(d.dir), agents, d.attested, d.canSpend, now())) {
      if (!isAsked(cand) && capHeld()) break
      if (d.stopped()) { out.held = 'floor/STOP'; break }
      const cur = readItem(d.dir, cand.id)
      if (holdReason(cur, listAllItems(d.dir), agents, d.attested, d.canSpend, now()) !== null) continue
      // claim first, on disk, so nothing picks it twice
      const ts = isoNow()
      writeItem(d.dir, { ...cur, status: 'doing', updated: ts, body: withNote(cur.body, WHO, `auto: picked up for ${cur.owner}; starting a conversation`, ts).trim() })
      pickedAt.set(cur.id, now())
      try {
        const conv = await d.startChat(cur.owner, briefFor(cur), `${cur.id} ${cur.title}`.slice(0, 120))
        updateItem(d.dir, cur.id, { conversation: conv })
        appendNote(d.dir, cur.id, WHO, `auto: conversation ${conv} started`)
        out.picked.push(cur.id); out.running.push(cur.id); slots--; today++
        note(cur.id, `auto: picked up by ${cur.owner}, conversation ${conv}`)
      } catch (e: any) {
        pickedAt.delete(cur.id)
        updateItem(d.dir, cur.id, { status: 'needs-you' })
        appendNote(d.dir, cur.id, WHO, `auto: could not start a conversation with ${cur.owner}: ${String(e?.message ?? e).slice(0, 300)}`)
        out.failed.push(cur.id)
        note(cur.id, `auto: start failed, status=needs-you`)
      }
    }
    out.held ??= capHeld()
    // what still holds an asked item that did not start (a blocker, a dormant owner, a spent spend cap): the
    // pickup output names it, since the tick's own `held` is about the caps, which an asked item is exempt from
    const all = listAllItems(d.dir)
    for (const i of all) {
      if (!isAsked(i) || i.status !== 'ready' || !isAuto(i) || out.picked.includes(i.id)) continue
      const why = holdReason(i, all, agents, d.attested, d.canSpend, now())
      if (why) out.askedHeld[i.id] = why
    }
    return out
  } finally { inTick = false }
}

// ---------- the real chats calls (fundd talks to its own API, like any other client) ----------

/** `brain`: the board's model / effort for every conversation it starts (null each = the agent's own) */
export function chatsClient(base: string, brain: () => { model: string | null; effort: string | null } = () => ({ model: null, effort: null })) {
  return {
    async startChat(agent: string, prompt: string, title: string): Promise<string> {
      const { model, effort } = brain()
      const r = await fetch(`${base}/api/chats`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, prompt, title, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }), signal: AbortSignal.timeout(30_000),
      })
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error ?? j?.message ?? `chats answered ${r.status}`)
      const id = j?.id ?? j?.conversation?.id
      if (!id) throw new Error('chats returned no conversation id')
      return String(id)
    },
    async chatState(id: string): Promise<ChatLook> {
      try {
        const r = await fetch(`${base}/api/chats/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) })
        if (r.status === 404) return 'gone'
        if (!r.ok) return 'unknown'
        const j: any = await r.json()
        const s = j?.conversation?.state
        return s === 'live' || s === 'waiting' || s === 'idle' || s === 'closed' ? s : 'unknown'
      } catch { return 'unknown' }
    },
  }
}
