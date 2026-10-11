import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { query, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from '../../shared/types.ts'
import { later, logEvent, now, ops } from '../db.ts'
import { publish } from '../events.ts'
import { turnDone } from '../hooks.ts'
import * as bg from './background.ts'
import { continueMessage, lostMessage, type Reopen, type ScanHit } from '../restart.ts'
import { isCockpitMessage } from '../../shared/cockpitmsg.ts'
import { DATA_DIR, within } from '../paths.ts'
import { agent as configAgent } from '../config.ts'
import { agentCwd, buildLaunch, foreignRefusal, isLegacyCwd, SETTINGS_FILE, transcriptDir, transcriptFile } from './launch.ts'
import { CAPS, ENGINE_LABEL, engineOf, type EngineId } from '../../shared/engines.ts'
import { codexBin, grokBin, providers, spawnBlock } from './engines/catalog.ts'
import { spawnCodex } from './engines/codex.ts'
import { denyArgs, spawnGrok } from './engines/grok.ts'
import { readLedger, sessionOf, writeLedger } from './engines/ledger.ts'
import type { EngineHand, ForeignHand } from './engines/types.ts'
import { recordBoot, recordBoundary, recordStart } from './law.ts'
import { observe as observePlan } from './planlimit.ts'
import { newNormState, normalize, type NormState, type Tok, type Usage } from './normalize.ts'
import { dividerText, rereadContext } from './reread.ts'
import { isActivity, reapNote, type HandView, type Reap } from './reaper.ts'
import { spendGate } from '../system/cap.ts'
import * as store from './store.ts'
import { titleOf, transcriptCut, transcriptEntries } from './transcripts.ts'
import type { ChatMeta, ChatState, Decision, Entry } from './types.ts'
import { progressOf, type Progress } from './progress.ts'

// THE CHAT ENGINE (ported from machine/server/agent.ts). One Agent SDK `query` per conversation,
// a child of fundd, so a UI reload never touches it. Input is a streaming async iterable (the
// queue below); output is normalized into feed entries, kept in a ring and published as deltas
// on `chat:<id>` over the ONE event stream. A list-level change publishes `chat`.

const RING = 400
const ATTACH_DIR = join(DATA_DIR, 'attach')
export const IMG_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

type Hand = {
  id: string
  agent: Agent
  uuid: string
  q: EngineHand
  engine: EngineId
  foreign: ForeignHand | null       // set for a CLI engine (Codex, Grok): one process per turn, its session id kept in the ledger
  ledgered: boolean                 // this conversation has crossed engines: its record is the ledger (engines/ledger.ts), not a Claude transcript
  abort: AbortController
  push: (m: SDKUserMessage | null) => void
  st: NormState
  ring: Entry[]
  meta: ChatMeta
  interrupted: boolean
  resumed: boolean
  baseline: Tok | null              // the cumulative usage already accounted for in this process
  parked: Map<string, { entryId: string; decide: (r: PermissionResult) => void }>
  flush: ReturnType<typeof setTimeout> | null
  pendingStream: Map<string, Entry>
  lastActive: number                // when it last did anything: a turn started or ended, a message came in (the idle reaper, reaper.ts)
}

const HANDS = new Map<string, Hand>()

// ---- the wire
const pub = (id: string, d: unknown) => publish(`chat:${id}`, d)

// Streaming deltas arrive per token; the one event stream carries every room's traffic, so a
// streaming block is coalesced to at most one frame per 80ms. Final entries go out at once.
function put(h: Hand, e: Entry) {
  const i = h.ring.findIndex(x => x.id === e.id)
  if (i >= 0) h.ring[i] = e
  else { h.ring.push(e); if (h.ring.length > RING) h.ring.shift() }
  if (e.streaming) {
    h.pendingStream.set(e.id, e)
    if (!h.flush) h.flush = setTimeout(() => { h.flush = null; for (const x of h.pendingStream.values()) pub(h.id, { t: 'entry', e: x }); h.pendingStream.clear() }, 80)
    return
  }
  h.pendingStream.delete(e.id)
  pub(h.id, { t: 'entry', e })
  track(h)
}
const sysEntry = (h: Hand, content: string) => put(h, { id: `s:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), kind: 'system', content })

function stateOf(h: Hand | undefined): ChatState {
  if (!h) return 'closed'
  if (h.meta.waiting) return 'waiting'
  if (h.meta.busy) return 'live'
  return 'idle'
}

function setMeta(h: Hand, m: Partial<ChatMeta>) {
  const before = stateOf(h)
  h.lastActive = Date.now()
  Object.assign(h.meta, m)
  pub(h.id, { t: 'meta', m: h.meta })
  track(h)
  const after = stateOf(h)
  if (before !== after) onState(h.id, h, after)
}

// ---- the turn's progress (progress.ts): the light in each tab. One per conversation this fundd ran,
// an ended turn's kept after its hand closes (the tab stays lit until the owner looks); a change goes
// out as 'chat:progress' and the strip refetches GET /api/chats/progress
const PROGRESS = new Map<string, Progress>()
const PROGRESS_CAP = 300
function track(h: Hand) {
  const p = progressOf(h.ring, h.meta)
  const was = PROGRESS.get(h.id)
  if (JSON.stringify(p) === JSON.stringify(was ?? null)) return
  if (p) PROGRESS.set(h.id, p)
  else PROGRESS.delete(h.id)
  if (PROGRESS.size > PROGRESS_CAP) {
    const old = [...PROGRESS].filter(([, x]) => x.kind !== 'work' && x.kind !== 'ask').sort((a, b) => a[1].at - b[1].at)
    for (const [id] of old.slice(0, PROGRESS.size - PROGRESS_CAP)) PROGRESS.delete(id)
  }
  publish('chat:progress', { id: h.id })
}
/** every conversation's turn progress this fundd holds, by id */
export const progressList = (): Record<string, Progress> => Object.fromEntries(PROGRESS)

function onState(id: string, h: Hand | undefined, s: ChatState) {
  liveChanged()   // the journal (restart.ts) follows every flip, a hand opening and closing included
  void store.setState(id, s)
  if (h) void store.presence(id, h.agent.id, s === 'live' ? 'working' : s === 'waiting' ? 'waiting on the owner' : null, s === 'live' || s === 'waiting')
  else void store.presence(id, '', null, false)
  // agent + note ride along so the UI can raise a desktop notification without a second fetch
  publish('chat', { id, state: s, ...(h ? { agent: h.agent.name } : {}), ...(s === 'waiting' && h ? { note: waitingNote(h) } : {}) })
}

/** the first line of what the conversation is waiting on (the parked question or plan) */
function waitingNote(h: Hand): string {
  // park() puts the decision entry before it flips `waiting`, so the newest unsettled one is it
  for (let i = h.ring.length - 1; i >= 0; i--) {
    const d = h.ring[i].decision
    if (d && !d.settled) return firstLine(d.kind === 'plan' ? (d.plan || 'a plan is waiting') : (d.questions?.[0]?.question ?? 'a question is waiting')) || 'waiting on you'
  }
  return 'waiting on you'
}
export const firstLine = (t: string) => (t.split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '').slice(0, 160)
/** the first line of the last top-level assistant message in the ring */
export function lastSaid(ring: Entry[]): string {
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i]
    if (e.kind === 'user') break
    if (e.kind === 'assistant' && !e.nested && e.content.trim()) return firstLine(e.content)
  }
  return ''
}

// ---- the decision seam. Under bypassPermissions the SDK auto-approves every tool BEFORE
// canUseTool is consulted, so an ordinary tool never reaches here; AskUserQuestion and
// ExitPlanMode are the calls that genuinely wait on a human, and if the CLI routes one here it is
// parked with NO timeout - a gate that opens when nobody is looking is not a gate.
function park(h: Hand, kind: Decision['kind'], toolUseId: string, input: Record<string, unknown>): Promise<PermissionResult> {
  const d: Decision = { kind, toolUseId }
  if (kind === 'plan') d.plan = typeof input.plan === 'string' ? input.plan : ''
  else d.questions = (Array.isArray(input.questions) ? input.questions : []).map((q: any) => ({
    question: String(q?.question ?? ''), header: String(q?.header ?? ''), multiSelect: !!q?.multiSelect,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({ label: String(o?.label ?? ''), ...(o?.description ? { description: String(o.description) } : {}) })),
  })).filter(q => q.question && q.options.length)
  const entryId = `d:${toolUseId}`
  put(h, { id: entryId, ts: Date.now(), kind: 'decision', content: '', decision: d })
  logEvent('ask', kind === 'plan' ? 'a plan is waiting for the owner' : (d.questions?.[0]?.question ?? 'a question for the owner').slice(0, 200), { agent: h.agent.id, conversation: h.id })
  setMeta(h, { waiting: true, phase: 'awaiting' })
  return new Promise<PermissionResult>(resolve => {
    h.parked.set(toolUseId, { entryId, decide: r => {
      h.parked.delete(toolUseId)
      setMeta(h, { waiting: h.parked.size > 0, phase: 'working' })
      resolve(r)
    } })
  })
}
function settle(h: Hand, entryId: string, settled: NonNullable<Decision['settled']>) {
  const cur = h.ring.find(e => e.id === entryId)
  if (cur?.decision) put(h, { ...cur, decision: { ...cur.decision, settled } })
}

// ---- spawn
// A spawn reads the row first (async), so two sends racing on a closed conversation would boot it
// twice: the first spawn in flight is shared.
const SPAWNING = new Map<string, Promise<Hand>>()
function spawn(id: string, opts: { resumeAt?: string; ring?: Entry[] } = {}): Promise<Hand> {
  const busy = SPAWNING.get(id)
  if (busy) return busy
  const p = spawnNow(id, opts).finally(() => SPAWNING.delete(id))
  SPAWNING.set(id, p)
  return p
}
async function spawnNow(id: string, opts: { resumeAt?: string; ring?: Entry[] }): Promise<Hand> {
  const row = await store.getRow(id)
  if (!row || row.forgotten) throw new Error('no such conversation')
  const a = configAgent(row.agent_id)
  if (!a) throw new Error(`agent ${row.agent_id} is not in the roster`)
  const uuid = row.transcript_uuid ?? ''
  let cwdAbs = row.cwd ?? ''
  // A conversation filed under a RETIRED cwd (crypto/, desks/, machine/ - before the 2026-09-24
  // cut-over; repos/ - before 2026-09-25) resumes in the agent's cwd NOW: its transcript is copied under the new slug (the
  // original stays where it was) and the row moves forward, so the agent never wakes in a dead tree.
  if (uuid && cwdAbs && isLegacyCwd(cwdAbs)) {
    try {
      const here = agentCwd(a)
      const from = transcriptFile(cwdAbs, uuid), to = transcriptFile(here, uuid)
      if (existsSync(from) && !existsSync(to)) { mkdirSync(transcriptDir(here), { recursive: true }); copyFileSync(from, to) }
      if (existsSync(to)) { void store.setCwd(id, here); cwdAbs = here }
    } catch { /* leave it: it resumes fresh rather than not at all */ }
  }
  const engine = engineOf(row.model || a.model)
  const foreignEngine = engine === 'codex' || engine === 'grok'
  const sdkEngine = (e: EngineId) => e === 'claude' || e === 'deepseek'
  if (engine !== 'claude') {
    // a provider with no key or no CLI says so, naming what is missing: never a silent failure at the first token
    const block = spawnBlock(engine)
    if (block) throw new Error(`${ENGINE_LABEL[engine]} cannot run here: ${block}`)
    if (foreignEngine) { const no = foreignRefusal(a); if (no) throw new Error(`${ENGINE_LABEL[engine]} will not take the ${a.name} seat: ${no}`) }
    await providers()    // warms the sync read buildLaunch takes a CLI model's effort ladder from
  }
  // Each provider keeps its own memory of a conversation (a Claude transcript, a Codex thread, a Grok session). A hand
  // on a different engine than the last one starts that engine's session: the Claude-side head moves to a new uuid
  // (the old transcript stays on disk), and the screen keeps every row either way (the ledger).
  const ledger = readLedger(id)
  const hasTranscript = !!uuid && !!cwdAbs && existsSync(transcriptFile(cwdAbs, uuid))
  const lastEngine: EngineId = ledger?.engine ?? 'claude'
  const crossed = lastEngine !== engine && (!!ledger || hasTranscript)
  let head = uuid
  if (crossed && sdkEngine(engine)) { head = randomUUID(); void store.advanceHead(id, head) }
  const resume = sdkEngine(engine) && !crossed && hasTranscript
  const launch = buildLaunch({ agent: a, conversationId: id, uuid: head, resume, model: row.model, effort: row.effort, resumeAt: opts.resumeAt })
  if (!row.cwd) void store.setCwd(id, launch.cwd)

  const pending: (SDKUserMessage | null)[] = []
  let wake: (() => void) | undefined
  const pump = async function* () {
    for (;;) {
      if (!pending.length) await new Promise<void>(r => { wake = r })
      while (pending.length) {
        const m = pending.shift()
        if (m === null || m === undefined) return
        yield m
      }
    }
  }
  const push = (m: SDKUserMessage | null) => { pending.push(m); wake?.(); wake = undefined }
  const abort = new AbortController()
  let hand!: Hand
  const options = {
    ...launch.options,
    abortController: abort,
    canUseTool: async (name: string, input: Record<string, unknown>, o: { toolUseID: string }): Promise<PermissionResult> => {
      if (name === 'ExitPlanMode') return park(hand, 'plan', o.toolUseID, input)
      if (name === 'AskUserQuestion') return park(hand, 'ask', o.toolUseID, input)
      return { behavior: 'allow', updatedInput: input }
    },
  }

  let ring = opts.ring
  if (!ring && ledger) ring = ledger.entries.slice(-RING)
  else if (!ring && hasTranscript) { try { ring = transcriptEntries(transcriptFile(cwdAbs, uuid), RING).entries } catch { ring = [] } }
  let q: EngineHand, foreign: ForeignHand | null = null
  if (foreignEngine) {
    // the CLI's own session id (kept in the ledger) is what resume takes; none = a fresh session, which gets the preamble
    const common = { cwd: launch.cwd, env: launch.env, model: launch.bare, effort: launch.effort || undefined, resumeId: sessionOf(id, engine), preamble: launch.preamble, signal: abort.signal, prompts: pump() }
    foreign = engine === 'grok'
      ? spawnGrok({ ...common, bin: grokBin(launch.env)!, deny: denyArgs(SETTINGS_FILE) })
      : spawnCodex({ ...common, bin: codexBin(launch.env)! })
    q = foreign
  } else q = query({ prompt: pump(), options })
  const st = newNormState()
  const h: Hand = hand = {
    id, agent: a, uuid: head, q, engine, foreign, ledgered: engine !== 'claude' || !!ledger, abort, push, st,
    ring: ring ?? [], meta: { live: true, busy: false, waiting: false, engine },
    interrupted: false, resumed: resume, baseline: null, parked: new Map(), flush: null, pendingStream: new Map(), lastActive: Date.now(),
  }
  // the rewind point for the next send, when this hand resumed an existing transcript
  if (resume && !opts.resumeAt) { try { st.lastUuid = transcriptEntries(transcriptFile(cwdAbs, uuid), 1).lastUuid } catch { /* none */ } }
  if (opts.resumeAt) st.lastUuid = opts.resumeAt
  HANDS.set(id, h)
  bg.clear(id)   // background work is per process: this one holds none yet
  void store.markIndexed(id)
  // one reads row per boot book - the boot list IS a read, at every boot
  const bootAt = now()
  const booted = launch.books.filter(b => b.text !== null).map(b => b.path)
  void later('boot reads', async () => { for (const p of booted) await ops.recordRead(a.id, p, { conversationId: id, atBoot: true, ts: bootAt }) })
  // the loaded-law manifest: the brief and the boot books ride in systemPrompt.append (queued, in order)
  void recordStart(id, a.id, launch.cwd)
  void recordBoot(id, a.id, [launch.brief.path, ...launch.books.map(b => b.path)])
  pub(id, { t: 'meta', m: h.meta })
  onState(id, h, 'idle')
  if (crossed) sysEntry(h, `Switched from ${ENGINE_LABEL[lastEngine]} to ${ENGINE_LABEL[engine]}. ${ENGINE_LABEL[engine]} does not carry ${ENGINE_LABEL[lastEngine]}'s context: it starts from its own session (new, or its own earlier one), and the rows above stay for you.`)
  console.log(`[chats] boot ${a.id} ${id}${resume ? ' (resume)' : ''}${opts.resumeAt ? ` at ${opts.resumeAt}` : ''}`)

  void (async () => {
    try {
      for await (const m of h.q) {
        const stopped = h.interrupted
        let closed = false
        const sm = m as any
        // every message from the process is activity for the idle reaper (B-0609): background work that ends
        // starts a turn the process has not yet announced, and the hand must not look as old as its last turn
        if (isActivity(sm.type)) h.lastActive = Date.now()
        if (sm.type === 'system' && sm.subtype === 'init' && h.foreign) saveLedger(h)   // the CLI's session id is known now: a crash must not lose what resumes it
        if (sm.type === 'system' && sm.subtype === 'background_tasks_changed') bg.setTasks(id, sm.tasks)
        else if (sm.type === 'rate_limit_event') observePlan(sm.rate_limit_info)
        // a turn the PROCESS started (a wake-up firing, a background task reporting back) never went
        // through send(): the model answering is what says it runs, so a restart never cuts it as idle
        else if (!h.meta.busy && !stopped && (m.type === 'assistant' || m.type === 'stream_event') && !sm.parent_tool_use_id) setMeta(h, { busy: true, phase: 'working' })
        for (const em of normalize(m, h.st)) {
          if (em.t === 'entry') {
            if (stopped && em.e.kind === 'error') continue
            if (em.e.meta?.compact) em.e = await compactDivider(h, em.e)
            put(h, em.e)
            if (!em.e.streaming) record(h, em.e)
          } else if (em.t === 'meta') {
            setMeta(h, em.m)
            if (em.m.busy === false) closed = true
          } else if (em.t === 'head') {
            if (em.uuid !== h.uuid) { h.uuid = em.uuid; void store.advanceHead(id, em.uuid) }
          } else if (em.t === 'usage') {
            usage(h, em.u)
          }
        }
        if (closed) {
          h.interrupted = false
          for (const e of h.ring) if (e.streaming) put(h, { ...e, streaming: false })
          void refreshContext(h)
          saveLedger(h)
          publish('chat', { id, turn: 'done', agent: a.name, note: lastSaid(h.ring) || 'turn finished' })
        }
      }
    } catch (e: any) {
      if (!abort.signal.aborted) {
        const msg = String(e?.message ?? e)
        put(h, { id: `e:${Date.now()}`, ts: Date.now(), kind: 'error', content: msg })
        logEvent('error', msg.slice(0, 300), { agent: a.id, conversation: id })
      }
    } finally {
      // every cut says so (B-0254): the agent's process ended while a turn ran, and nobody ended it
      if (!abort.signal.aborted && h.meta.busy) {
        sysEntry(h, PROCESS_CUT)
        void logEvent('turn', 'cut off: the agent process ended mid-turn', { agent: a.id, conversation: id })
      }
      for (const [tid, p] of h.parked) {
        settle(h, p.entryId, { verdict: 'lost', note: 'the conversation ended before it was answered' })
        h.parked.delete(tid)
        p.decide({ behavior: 'deny', message: 'the conversation ended' })
      }
      if (h.flush) { clearTimeout(h.flush); h.flush = null }
      saveLedger(h)
      const successor = HANDS.get(id)
      if (!successor || successor === h) {
        HANDS.delete(id)
        CLOSED_RINGS.set(id, h.ring.filter(e => !e.streaming))
        h.meta = { ...h.meta, live: false, busy: false, waiting: false, phase: undefined }
        pub(id, { t: 'meta', m: h.meta })
        track(h)
        onState(id, undefined, 'closed')
      }
    }
  })()
  return h
}

/** a conversation that runs on a CLI engine, or has crossed engines, is kept in the ledger: the rows as the screen showed
 *  them and the session id each CLI resumes by (engines/ledger.ts) */
function saveLedger(h: Hand) {
  if (!h.ledgered) return
  try {
    const sid = h.foreign?.sessionId()
    const prev = readLedger(h.id)
    writeLedger(h.id, { v: 1, engine: h.engine, sessions: { ...(prev?.sessions ?? {}), ...(sid ? { [h.engine]: sid } : {}) }, entries: h.ring.filter(e => !e.streaming) })
  } catch (e) { console.error('[chats] ledger', h.id, (e as Error).message) }
}

/**
 * A compaction boundary: mark it in the law manifest (files loaded before it must reappear) and
 * rewrite the ONE divider to what the SessionStart 'compact' hook puts back - the same pure
 * function over the same rows, so the count on screen is the count restored.
 */
export async function compactDivider(h: { id: string; agent: { id: string } }, e: Entry): Promise<Entry> {
  await recordBoundary(h.id, h.agent.id, e.ts)   // queued; a failed record is logged, never thrown
  try {
    const r = await rereadContext(h.id)
    const by = (s: string) => r.books.filter(b => b.state === s)
    return {
      ...e, content: dividerText(r),
      meta: { ...e.meta, books: by('restored').map(b => b.title), listed: by('listed').map(b => b.path), missing: by('missing').map(b => b.path) },
    }
  } catch { return e }
}

// The ring of a hand that ended, so reopening a conversation in the same fundd life shows exactly
// what was on screen (a transcript re-read loses streaming-only detail and is slower).
const CLOSED_RINGS = new Map<string, Entry[]>()

function record(h: Hand, e: Entry) {
  if (e.kind === 'assistant' && !e.nested) void store.indexText(h.id, 'assistant', e.content)
  else if (e.kind === 'tool' && e.status === 'created' && !e.nested && e.action)
    logEvent('tool', `${e.action.verb} ${e.action.target ?? ''}`.trim().slice(0, 200), { agent: h.agent.id, conversation: h.id })
  else if (e.kind === 'error') logEvent('error', e.content.slice(0, 300), { agent: h.agent.id, conversation: h.id })
}

// Per-turn accounting. modelUsage + total_cost_usd are cumulative per process, so each result is
// diffed against the last. A RESUMED process starts from the totals its transcript saved (so its
// first result already carries the earlier turns): that first turn books its own per-turn tokens
// and no cost - an unknown split is recorded as nothing rather than as yesterday's spend.
function usage(h: Hand, u: Usage) {
  let d: Tok
  if (!h.baseline && h.resumed) d = { ...u.turn, costUsd: 0 }
  else {
    const b = h.baseline ?? { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
    d = {
      tokensIn: Math.max(0, u.total.tokensIn - b.tokensIn), tokensOut: Math.max(0, u.total.tokensOut - b.tokensOut),
      cacheRead: Math.max(0, u.total.cacheRead - b.cacheRead), cacheWrite: Math.max(0, u.total.cacheWrite - b.cacheWrite),
      costUsd: Math.max(0, u.total.costUsd - b.costUsd),
    }
  }
  h.baseline = u.total
  void store.addUsage(h.id, h.agent.id, { model: u.model, ...d })
  logEvent('turn', `turn done - ${d.tokensIn + d.cacheRead + d.cacheWrite} in / ${d.tokensOut} out${d.costUsd ? ` / $${d.costUsd.toFixed(4)}` : ''}`, { agent: h.agent.id, conversation: h.id, payload: d })
  turnDone(h.id)
}

async function refreshContext(h: Hand) {
  try {
    const u = await h.q.getContextUsage({ detail: 'summary' })
    setMeta(h, { contextPct: u.percentage, contextTokens: u.totalTokens, maxTokens: u.maxTokens })
  } catch { /* mid-turn or already gone */ }
}

async function ensure(id: string): Promise<Hand> {
  return HANDS.get(id) ?? spawn(id)
}

// ---- the public surface (server/rooms/chats.ts calls these)

export async function start(agentId: string, prompt?: string, title?: string, brain?: { model?: string | null; effort?: string | null }): Promise<{ id: string }> {
  const a = configAgent(agentId)
  if (!a) throw new Error(`no agent ${agentId}`)
  if (a.mode === 'dormant') throw new Error(`${a.name} is dormant`)
  await spendGate(a.id)
  const c = await store.create(a, title?.trim() || '')
  if (brain?.model || brain?.effort) await store.patch(c.id, { model: brain.model || null, effort: brain.effort || null })
  publish('chat', { id: c.id, state: 'closed' })
  try {
    if (prompt?.trim()) await send(c.id, prompt)
    else await spawn(c.id)
  } catch (e) { await store.forget(c.id); publish('chat', { id: c.id }); throw e }
  return { id: c.id }
}

export type Image = { name?: string; data: string; media_type?: string }

/** the ONE slash command a seat may take from the cockpit (B-0021): a compaction on demand */
export const COMMANDS = ['/compact'] as const
export type Command = typeof COMMANDS[number]

/** run a whitelisted slash command in the conversation (send() spaces a leading slash so chat never runs one) */
export async function command(id: string, cmd: Command) {
  if (!(COMMANDS as readonly string[]).includes(cmd)) throw new Error(`not a command this runs: ${cmd}`)
  const h = HANDS.get(id)
  if (h?.meta.busy) throw new Error('stop the running turn first')
  if (h && !CAPS[h.engine].compact) throw new Error(`${ENGINE_LABEL[h.engine]} compacts its own context: the cockpit cannot run /compact there`)
  await send(id, cmd, [], true)
}

export async function send(id: string, raw: string, images: Image[] = [], asCommand = false) {
  const c = await store.get(id)
  if (!c) throw new Error('no such conversation')
  const a = configAgent(c.agent)
  if (a?.mode === 'dormant') throw new Error(`${a.name} is dormant`)
  if (a) await spendGate(a.id)
  const live = HANDS.get(id)
  if (images.length && live && !CAPS[live.engine].images) throw new Error(`${ENGINE_LABEL[live.engine]} takes no pasted images here: remove the picture or switch provider`)
  const stored = images.map(img => saveImage(id, img))
  if (!raw.trim() && !stored.length) throw new Error('empty')
  // A leading slash would run as a command in headless mode; chat is natural language.
  const text = !asCommand && /^\s*\//.test(raw) ? ' ' + raw.trimStart() : raw
  const h = await ensure(id)
  void store.touch(id, raw.trim() && !asCommand ? titleOf(raw) : undefined)
  put(h, {
    id: `u:${Date.now()}:${h.ring.length}`, ts: Date.now(), kind: 'user', content: raw,
    ...(stored.length ? { images: stored.map(s => `/api/chats/${id}/attach/${encodeURIComponent(s.file)}`) } : {}),
    ...(h.st.lastUuid && !h.foreign ? { forkAt: h.st.lastUuid } : {}),
  })
  if (!asCommand) void store.indexText(id, 'user', raw)
  setMeta(h, { busy: true, phase: 'requesting' })
  const content: any = stored.length
    ? [...stored.map(s => ({ type: 'image', source: { type: 'base64', media_type: s.mime, data: s.data } })), ...(text.trim() ? [{ type: 'text', text }] : [])]
    : text
  h.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content } } as SDKUserMessage)
  publish('chat', { id, sent: true })
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const SAFE_ID_FILE = /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9]{1,8}$/

function saveImage(id: string, img: Image): { file: string; mime: string; data: string } {
  const m = /^data:([a-z/+.-]+);base64,(.*)$/s.exec(img.data)
  const mime = (m?.[1] ?? img.media_type ?? 'image/png').toLowerCase()
  const data = m?.[2] ?? img.data
  const ext = Object.entries(IMG_MIME).find(([, v]) => v === mime)?.[0]
  if (!ext) throw new Error(`not an image type this accepts: ${mime}`)
  const file = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`
  const dir = join(ATTACH_DIR, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), Buffer.from(data, 'base64'))
  return { file, mime, data }
}

/** A stored attachment. Both halves of the path are checked: `id` must be a conversation this
 * store knows (a strict id shape first, so a decoded `../x` never reaches join), `file` a bare
 * name, and the resolved path must stay inside ATTACH_DIR. */
export async function attachment(id: string, file: string): Promise<{ mime: string; buf: Buffer } | null> {
  if (!SAFE_ID.test(id) || !SAFE_ID_FILE.test(file) || file !== basename(file)) return null
  if (!(await store.getRow(id))) return null
  const mime = IMG_MIME[(file.split('.').pop() ?? '').toLowerCase()]
  const p = join(ATTACH_DIR, id, file)
  if (!mime || !within(p, ATTACH_DIR) || !existsSync(p)) return null
  return { mime, buf: readFileSync(p) }
}

/** stop = interrupt the open turn; hard (or nothing running) = end the process */
export async function stop(id: string, hard = false) {
  const h = HANDS.get(id)
  if (!h) return { ok: true, was: 'closed' }
  if (!hard && h.meta.busy) {
    h.interrupted = true
    try { await h.q.interrupt() } catch (e) { h.interrupted = false; throw e }
    setMeta(h, { busy: false, phase: undefined })
    sysEntry(h, 'Interrupted')
    return { ok: true, was: 'interrupted' }
  }
  close(id, hard && h.meta.busy ? 'Stopped' : undefined)
  return { ok: true, was: 'closed' }
}

/**
 * stop ONE background command or subagent the conversation's process holds. Stop (stop() above) no longer does:
 * launch.ts declares perTaskStopAffordance, so an interrupt spares them (B-0560). A hard stop still ends them all.
 */
export async function stopTask(id: string, taskId: string) {
  const h = HANDS.get(id)
  if (!h || !bg.holds(id, taskId)) return { ok: false as const, error: 'that conversation holds no such background task' }
  await h.q.stopTask(taskId)
  return { ok: true as const }
}

function close(id: string, why?: string) {
  const h = HANDS.get(id)
  if (!h) return
  if (why) sysEntry(h, why)
  h.push(null)
  h.abort.abort()
}

export async function stopAll() {
  for (const id of [...HANDS.keys()]) close(id, HANDS.get(id)?.meta.busy ? 'Stopped (STOP pressed)' : undefined)
}

export function forget(id: string) {
  close(id)
  void store.forget(id)
  CLOSED_RINGS.delete(id)
  if (PROGRESS.delete(id)) publish('chat:progress', { id })
  publish('chat', { id, forgotten: true })
}

export async function patch(id: string, p: { title?: string; model?: string | null; effort?: string | null }): Promise<{ applied: string }> {
  // a provider switch reboots the hand, and so does a model change on any engine but Claude's own live swap:
  // neither can land inside a running turn
  const live = HANDS.get(id)
  if (live?.meta.busy && p.model !== undefined) {
    const row = await store.getRow(id)
    const next = engineOf(p.model || configAgent(row?.agent_id ?? '')?.model)
    if (next !== live.engine || live.engine !== 'claude') throw new Error(`${ENGINE_LABEL[live.engine]} changes model between turns: stop the running turn first`)
  }
  await store.patch(id, p)
  publish('chat', { id })
  if (p.model === undefined && p.effort === undefined) return { applied: 'now' }
  const h = HANDS.get(id)
  if (!h) return { applied: 'at the next message' }
  if (!h.meta.busy) {
    // idle: a quiet respawn lands both knobs now; the transcript resumes where it stood
    const ring = h.ring.filter(e => !e.streaming)
    HANDS.delete(id)
    h.push(null); h.abort.abort()
    await spawn(id, { ring })
    return { applied: 'now' }
  }
  if (p.model && h.engine === 'claude') void h.q.setModel(p.model).catch(() => { /* mid-turn refusal: the row still holds */ })
  return { applied: p.model ? 'model now, effort at the next boot' : 'at the next boot' }
}

export function decide(id: string, b: { toolUseId?: string; verdict?: string; answers?: Record<string, string>; note?: string }) {
  const h = HANDS.get(id)
  const parked = h?.parked.get(String(b.toolUseId ?? ''))
  if (!h || !parked) throw new Error('nothing is waiting on that')
  const cur = h.ring.find(e => e.id === parked.entryId)
  if (b.verdict === 'approve') { settle(h, parked.entryId, { verdict: 'approved' }); parked.decide({ behavior: 'allow', updatedInput: {} }) }
  else if (b.verdict === 'reject') {
    const note = String(b.note ?? '').slice(0, 4000)
    settle(h, parked.entryId, { verdict: 'rejected', ...(note ? { note } : {}) })
    parked.decide({ behavior: 'deny', message: note || 'Not yet - keep planning.' })
  } else if (b.verdict === 'answer') {
    const answers: Record<string, string> = {}
    for (const [k, v] of Object.entries(b.answers ?? {})) if (typeof v === 'string' && v) answers[k] = v
    settle(h, parked.entryId, { verdict: 'answered', answers })
    parked.decide({ behavior: 'allow', updatedInput: { questions: cur?.decision?.questions ?? [], answers } })
  } else throw new Error('bad verdict')
}

/**
 * REWIND: resume the transcript only up to the chain entry that preceded a given owner message,
 * FORKED (the SDK's resumeSessionAt + forkSession), so the old branch stays on disk untouched.
 * Returns that message's text so the composer can offer it again.
 */
export async function rewind(id: string, entryId: string): Promise<{ text: string }> {
  const h = HANDS.get(id)
  const ring = h?.ring ?? (await entries(id)).entries
  const i = ring.findIndex(e => e.id === entryId)
  const e = ring[i]
  if (!e || e.kind !== 'user') throw new Error('rewind needs one of your own messages')
  if (h?.foreign) throw new Error(`${ENGINE_LABEL[h.engine]} keeps its own session: rewind needs a Claude transcript`)
  if (!e.forkAt) throw new Error('nothing before this message to rewind to - start a new conversation')
  if (h?.meta.busy) throw new Error('stop the running turn first')
  if (h) { HANDS.delete(id); h.push(null); h.abort.abort() }
  // the fork needs the transcript the entry came from; the head recorded now is still that one
  const nh = await spawn(id, { resumeAt: e.forkAt, ring: ring.slice(0, i) })
  void logEvent('turn', 'rewound', { agent: nh.agent.id, conversation: id })
  pub(id, { t: 'reset', entries: ring.slice(0, i) })
  return { text: e.content }
}

// ---- reads

export async function entries(id: string): Promise<{ entries: Entry[]; meta: ChatMeta; truncated?: boolean; missing?: boolean }> {
  const h = HANDS.get(id)
  if (h) return { entries: h.ring, meta: h.meta }
  const closed: ChatMeta = { live: false, busy: false, waiting: false }
  const kept = CLOSED_RINGS.get(id)
  if (kept) return { entries: kept, meta: closed }
  // a conversation that ran on a CLI engine or crossed engines is read from its ledger, never a Claude transcript
  const led = readLedger(id)
  if (led) return { entries: led.entries.slice(-RING), meta: closed }
  const f = await store.transcriptPath(id)
  // no transcript on disk (never started, or its file is gone): say so, never an empty history
  if (!f) return { entries: [], meta: closed, missing: true }
  try { const t = transcriptEntries(f, RING); return { entries: t.entries, meta: closed, truncated: t.truncated } }
  catch (e: any) { throw new Error(`transcript unreadable: ${e?.message ?? e}`) }
}

export const liveState = (id: string): ChatState => stateOf(HANDS.get(id))
/** the engine a live hand runs on (null = no hand open) */
export const liveEngine = (id: string): EngineId | null => HANDS.get(id)?.engine ?? null

/** did the ring's last turn END on an error? The newest top-level said-thing (assistant, error,
 *  user) decides: an error the agent answered past is not a failed turn, and the denial rows a
 *  failed result carries after its error do not hide it */
export function turnFailed(ring: Entry[]): boolean {
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i]
    if (e.nested || e.streaming || !(e.kind === 'assistant' || e.kind === 'error' || e.kind === 'user')) continue
    return e.kind === 'error'
  }
  return false
}
/** the tab light's red: null when fundd holds no ring for it (not booted since fundd started) */
export function lastTurnFailed(id: string): boolean | null {
  const ring = HANDS.get(id)?.ring ?? CLOSED_RINGS.get(id)
  return ring ? turnFailed(ring) : null
}
export const handCount = () => HANDS.size

/** every open hand as the idle reaper sees it */
export const handViews = (): HandView[] => [...HANDS.values()].map(h => ({
  id: h.id, agent: h.agent.id, busy: !!h.meta.busy, waiting: !!h.meta.waiting, spawning: SPAWNING.has(h.id), ...bg.bgOf(h.id), lastActive: h.lastActive,
}))

/**
 * close one hand the reaper chose, if it is STILL idle: a turn, a parked decision, a spawn in flight or background
 * work the process holds all refuse it. The conversation stays; the next message reopens it from its transcript.
 */
export function reapIdle(r: Reap, settleMs = 0): boolean {
  const h = HANDS.get(r.id)
  if (!h || h.meta.busy || h.meta.waiting || SPAWNING.has(r.id) || h.parked.size) return false
  if (Date.now() - h.lastActive < settleMs) return false   // it did something since the choice: work just ended
  const b = bg.bgOf(r.id)
  if (b.tasks.length || b.later.length) return false
  close(r.id, reapNote(r))
  return true
}
export function counts(): { working: number; waiting: number } {
  let working = 0, waiting = 0
  for (const h of HANDS.values()) { if (h.meta.waiting) waiting++; else if (h.meta.busy) working++ }
  return { working, waiting }
}
export function byAgent(): Map<string, { working: number; waiting: number; open: number }> {
  const m = new Map<string, { working: number; waiting: number; open: number }>()
  for (const h of HANDS.values()) {
    const r = m.get(h.agent.id) ?? { working: 0, waiting: 0, open: 0 }
    if (h.meta.waiting) r.waiting++; else if (h.meta.busy) r.working++; else r.open++
    m.set(h.agent.id, r)
  }
  return m
}

// presence heartbeat while a turn runs
setInterval(() => {
  void store.heartbeat([...HANDS.values()].filter(h => h.meta.busy || h.meta.waiting).map(h => h.id))
}, 30_000).unref()

// ---- the idle restart (B-0174 part 2, server/restart.ts)
/** what a conversation says when its agent's process ended in the middle of a turn */
export const PROCESS_CUT = 'The agent process ended in the middle of this turn. Nothing after the cut was kept: say continue to pick it up.'

/** the last thing said TO the agent was the cockpit's own continue (a turn it starts is an auto-continue) */
function lastPromptIsCockpit(ring: Entry[]): boolean {
  for (let i = ring.length - 1; i >= 0; i--) if (ring[i].kind === 'user') return isCockpitMessage(ring[i].content)
  return false
}

/** every open conversation: whether a turn runs or a decision waits, the background work its process holds,
 *  and whether the running turn is an auto-continue (never continued a second time) */
export const liveList = (): { id: string; busy: boolean; waiting: boolean; tasks: string[]; later: string[]; auto: boolean }[] =>
  [...HANDS.values()].map(h => ({ id: h.id, busy: !!h.meta.busy, waiting: !!h.meta.waiting, ...bg.bgOf(h.id), auto: !!h.meta.busy && lastPromptIsCockpit(h.ring) }))

const liveFns: (() => void)[] = []
/** fn runs whenever liveList() may have changed: a state flip, background work, a hand opening or closing */
export function onLiveChange(fn: () => void) { liveFns.push(fn) }
function liveChanged() { for (const f of liveFns) { try { f() } catch { /* a listener never breaks the runner */ } } }
// the chat header says what a hand waits on: its non-ambient background tasks (a command or a subagent), by label
bg.onBgChange(id => {
  const h = HANDS.get(id)
  if (h) {
    const tasks = bg.bgOf(id).tasks
    if (tasks.join('\n') !== (h.meta.bg ?? []).join('\n')) {
      if (tasks.length) h.meta.bg = tasks; else delete h.meta.bg
      pub(h.id, { t: 'meta', m: h.meta })
    }
  }
  liveChanged()
})

/**
 * a new fundd reopens a conversation (server/restart.ts restoreAtBoot decides what it is told): resumed
 * from its transcript; a cut turn says so on screen, and gets the ONE cockpit continue when the guards
 * allow it; a chat between turns whose background work ended is told what did not carry over
 */
export async function reopen(id: string, r: Reopen) {
  const h = await ensure(id)
  if (r.note) { sysEntry(h, r.note); void logEvent('turn', 'cut off by a fundd restart', { agent: h.agent.id, conversation: id }) }
  if (r.lost.length) {
    void logEvent('turn', `background work lost in a fundd restart: ${r.lost.join('; ')}`.slice(0, 300), { agent: h.agent.id, conversation: id })
    if (!r.say) sysEntry(h, `Background work that ended with the old process: ${r.lost.join('; ')}`)
  }
  if (r.say === 'continue') {
    void logEvent('turn', 'auto-continued after a fundd restart', { agent: h.agent.id, conversation: id })
    await send(id, continueMessage(r.at, r.lost))
  } else if (r.say === 'lost') await send(id, lostMessage(r.at, r.lost))   // between turns: it was waiting on that work
}

/**
 * THE BOOT SCAN (B-0254 part 5): a hard stop the saved list missed (a power loss, a fundd too old to
 * journal, a list gone stale). The candidates are the PRESENCE rows a fundd left behind: a hand that
 * was working or waiting writes one with fundd's pid and clears it when it settles, so a row whose pid
 * no longer runs is a hand that fundd died holding. Nothing else is a candidate - never a transcript
 * the cockpit merely adopted (a session the owner runs by hand is live in HIS terminal and has no row),
 * and never a hand of another LIVE fundd (a scratch fundd shares the store). Then its transcript must be
 * written since `since` and end mid-turn.
 */
export async function scanCut(since: number, exclude: Set<string>): Promise<ScanHit[]> {
  const alive = (pid: number) => { if (pid === process.pid) return true; try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' } }
  const out: ScanHit[] = []
  const seen = new Set<string>()
  for (const p of await ops.listPresence()) {
    const id = p.conversation_id
    if (!id || !p.hand_id.startsWith('chat:') || seen.has(id) || exclude.has(id) || HANDS.has(id)) continue
    seen.add(id)
    if (!p.pid || alive(Number(p.pid))) continue
    const c = await store.get(id)
    const a = c ? configAgent(c.agent) : undefined
    if (!c || !a || a.mode === 'dormant') continue
    const f = await store.transcriptPath(id)
    if (!f) continue
    try { if (statSync(f).mtimeMs < since) continue } catch { continue }
    const cut = transcriptCut(f)
    if (cut) out.push({ id, ...(cut.waiting ? { waiting: true } : {}), ...(cut.auto ? { auto: true } : {}) })
  }
  return out
}

/** fundd is leaving for new code: end every hand (their conversations are saved to reopen) */
export function closeForRestart() {
  for (const id of [...HANDS.keys()]) close(id)
}
