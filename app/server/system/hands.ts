import { freemem } from 'node:os'
import type { Router } from '../http.ts'
import { logEvent, ops } from '../db.ts'
import { publish } from '../events.ts'
import { reaperConfig } from '../config.ts'
import { listProcs, readHands, type HandsReading } from '../chat/handprocs.ts'
import { REAP_EVENT, reapNote, sweep, type Reap } from '../chat/reaper.ts'
import * as runner from '../chat/runner.ts'
import { killTree } from '../proc/ports.ts'
import { localMidnight } from './cap.ts'

// THE HANDS - the System room's line about the agent processes fundd holds (B-0420): how many are open,
// what they weigh, how many the reaper closed today; and the keeper that closes them (chat/reaper.ts)
// and clears the ones a dead fundd left behind.

const config = reaperConfig

/** one sweep now (the loop below calls it; a test or a route may too) */
export function sweepNow(): Reap[] {
  return sweep({
    now: Date.now, hands: runner.handViews, free: () => { const f = freemem(); return Number.isFinite(f) && f > 0 ? f : null }, config,
    reap: r => runner.reapIdle(r, config().settleMs),
    log: r => {
      const summary = `closed an idle hand: ${reapNote(r).replace(/ Your next message.*$/, '')}`
      void logEvent(REAP_EVENT, summary, { ...(r.agent ? { agent: r.agent } : {}), conversation: r.id, payload: { why: r.why, idleMs: r.idleMs } })
      console.log(`[hands] ${r.id} ${summary}`)
    },
  })
}

/** the reaper's loop: re-reads app/reaper.json each round, so an edit takes effect within one sweep */
export function startReaper() {
  const round = () => {
    try { if (sweepNow().length) publish('system', { hands: true }) } catch (e) { console.error('[hands] sweep:', e) }
    setTimeout(round, config().sweepMs).unref()
  }
  setTimeout(round, config().sweepMs).unref()
}

/**
 * THE BOOT SWEEP: a hand whose parent process is gone (a fundd that was killed or crashed took nothing
 * with it) is closed with its MCP children. Only the SDK binary of THIS app in stream-json mode counts,
 * and only when its parent pid is absent from the process list; a hand of a live fundd and the owner's
 * terminal sessions are never touched. An unreadable listing kills nothing.
 */
export async function sweepOrphans(log: (m: string) => void = m => console.log(`[hands] ${m}`)): Promise<{ killed: number[]; unread: boolean }> {
  const procs = await listProcs()
  if (!procs) { log('orphan sweep: the process list could not be read, nothing closed'); return { killed: [], unread: true } }
  const killed: number[] = []
  for (const o of readHands(procs).orphans) {
    const r = await killTree(o.pid)
    if (r.ok) killed.push(o.pid)
    else log(`orphan hand ${o.pid} could not be closed: ${r.out}`)
  }
  if (killed.length) {
    const msg = `closed ${killed.length} orphaned agent process${killed.length === 1 ? '' : 'es'} left by a fundd that is gone (pid ${killed.join(', ')})`
    log(msg)
    void logEvent('system', msg)
  }
  return { killed, unread: false }
}

export type HandsView = {
  open: number
  /** open hands with no turn and no parked decision */
  idle: number
  /** bytes the hands and their children hold; null when the process list could not be read */
  bytes: number | null
  /** hands of a gone fundd still running (the boot sweep clears them); null when unread */
  orphans: number | null
  /** the owner's own claude sessions: counted, never closed; null when unread */
  terminals: { n: number; bytes: number } | null
  /** hands closed since local midnight; null when the event log could not be read */
  reapedToday: number | null
  idleMinutes: number
  freeBytes: number | null
}

let cached: { at: number; r: HandsReading | null } | null = null
async function reading(): Promise<HandsReading | null> {
  if (cached && Date.now() - cached.at < 20_000) return cached.r
  const procs = await listProcs()
  cached = { at: Date.now(), r: procs ? readHands(procs) : null }
  return cached.r
}

export async function handsView(): Promise<HandsView> {
  const now = Date.now()
  const [r, reaped] = await Promise.all([
    reading().catch(() => null),
    ops.eventsInWindow(localMidnight(now), now + 1, { kinds: [REAP_EVENT] }).then(x => x.length).catch(() => null),
  ])
  const views = runner.handViews()
  const f = freemem()
  return {
    open: views.length, idle: views.filter(h => !h.busy && !h.waiting).length,
    bytes: r ? r.bytes : null, orphans: r ? r.orphans.length : null,
    terminals: r ? { n: r.others.length, bytes: r.others.reduce((s, o) => s + o.bytes, 0) } : null,
    reapedToday: reaped, idleMinutes: Math.round(config().idleMs / 60_000), freeBytes: Number.isFinite(f) && f > 0 ? f : null,
  }
}

export function registerHands(r: Router) {
  r.get('/api/system/hands', () => handsView())
}
