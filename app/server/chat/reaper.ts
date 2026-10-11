import { readFileSync } from 'node:fs'

// THE IDLE-HAND REAPER (B-0420). Every open conversation is one claude.exe (~390 MB with its MCP
// children), and nothing used to close one: 48 hands held ~19 GB of 31 GB on 2026-10-04, 46 of them
// idle. A hand is closed only when NOTHING of it runs: no turn, no decision parked on the owner, no
// background work or wake-up its process holds, no spawn in flight. The conversation is not lost: the
// transcript stays, and the next message reopens it (runner.ts ensure -> spawn resumes it).
//
// Three reasons, one pure function (pickReaps, injected clock and free-memory reading, tested in
// test/chats-reaper.test.ts):
//   idle      idle for idleMs (default 2 h)
//   pressure  free RAM under pressureFreeBytes: oldest-first, idle at least pressureMinIdleMs, a batch a sweep
//   cap       more than maxIdleHands idle hands open: the least recently active go first
// Unknown free RAM (null) never closes anything: no reading is not pressure. Under ALL three, a hand active
// within settleMs (default 5 min) stays: work that has just ended is about to start a turn the process has not
// yet announced (B-0609). lastActive moves on every message from the process (runner.ts isActivity).

const MIN = 60_000
const GB = 1024 ** 3

export type ReapConfig = {
  idleMs: number
  sweepMs: number
  pressureFreeBytes: number
  pressureMinIdleMs: number
  pressureBatch: number
  maxIdleHands: number
  settleMs: number
}
export const REAP_DEFAULTS: ReapConfig = { idleMs: 120 * MIN, sweepMs: 60_000, pressureFreeBytes: 3 * GB, pressureMinIdleMs: 10 * MIN, pressureBatch: 4, maxIdleHands: 8, settleMs: 5 * MIN }

/** app/reaper.json: idleMinutes, sweepSeconds, pressureFreeGb, pressureMinIdleMinutes, pressureBatch, maxIdleHands, settleMinutes;
 *  a key that is missing or not a positive number takes its default, never a made-up limit */
export function parseReapConfig(raw: unknown): ReapConfig {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const num = (k: string, scale: number, dflt: number, whole = false) => {
    const v = o[k]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? (whole ? Math.max(1, Math.round(v)) : v * scale) : dflt
  }
  const d = REAP_DEFAULTS
  return {
    idleMs: num('idleMinutes', MIN, d.idleMs),
    sweepMs: Math.max(5_000, num('sweepSeconds', 1000, d.sweepMs)),
    pressureFreeBytes: num('pressureFreeGb', GB, d.pressureFreeBytes),
    pressureMinIdleMs: num('pressureMinIdleMinutes', MIN, d.pressureMinIdleMs),
    pressureBatch: num('pressureBatch', 1, d.pressureBatch, true),
    maxIdleHands: num('maxIdleHands', 1, d.maxIdleHands, true),
    settleMs: num('settleMinutes', MIN, d.settleMs),
  }
}
export function readReapConfig(file: string): ReapConfig {
  try { return parseReapConfig(JSON.parse(readFileSync(file, 'utf8'))) } catch { return { ...REAP_DEFAULTS } }
}

/** one open hand as the sweep sees it; `lastActive` is when it last did anything (a turn ended, any message came in from its process) */
export type HandView = { id: string; agent?: string; busy: boolean; waiting: boolean; spawning: boolean; tasks: string[]; later: string[]; lastActive: number }
export type ReapWhy = 'idle' | 'pressure' | 'cap'
export type Reap = { id: string; agent?: string; why: ReapWhy; idleMs: number }

/** does a message from the agent process show the hand is alive? Only the two that arrive with nothing happening do not */
export const isActivity = (type: string): boolean => type !== 'keep_alive' && type !== 'rate_limit_event'

/** a hand with nothing running: no turn, no parked decision, no spawn, and no background work or wake-up its process would lose */
export const isIdle = (h: HandView): boolean => !h.busy && !h.waiting && !h.spawning
export const reapable = (h: HandView): boolean => isIdle(h) && h.tasks.length === 0 && h.later.length === 0

/** which hands to close now, each once, in the order they go */
export function pickReaps(hands: HandView[], now: number, freeBytes: number | null, cfg: ReapConfig): Reap[] {
  const out: Reap[] = []
  const taken = new Set<string>()
  const take = (h: HandView, why: ReapWhy) => { taken.add(h.id); out.push({ id: h.id, ...(h.agent ? { agent: h.agent } : {}), why, idleMs: Math.max(0, now - h.lastActive) }) }
  const idleFor = (h: HandView) => now - h.lastActive
  const oldestFirst = (a: HandView, b: HandView) => a.lastActive - b.lastActive
  // a hand active within settleMs is never taken, whatever the reason: its background work may have just ended
  const open = () => hands.filter(h => reapable(h) && idleFor(h) >= cfg.settleMs && !taken.has(h.id)).sort(oldestFirst)

  for (const h of open()) if (idleFor(h) >= cfg.idleMs) take(h, 'idle')
  if (freeBytes !== null && freeBytes < cfg.pressureFreeBytes) {
    let n = 0
    for (const h of open()) { if (n >= cfg.pressureBatch) break; if (idleFor(h) >= cfg.pressureMinIdleMs) { take(h, 'pressure'); n++ } }
  }
  // the cap counts every idle hand still open, those holding background work included (they cannot go, but they are open)
  const stay = hands.filter(h => isIdle(h) && !taken.has(h.id)).length
  let excess = stay - cfg.maxIdleHands
  for (const h of open()) { if (excess <= 0) break; take(h, 'cap'); excess-- }
  return out
}

export type SweepDeps = {
  now: () => number
  hands: () => HandView[]
  /** free RAM in bytes, null when it cannot be read */
  free: () => number | null
  config: () => ReapConfig
  /** close one hand; false when it was no longer idle (the runner checks again) */
  reap: (r: Reap) => boolean
  log?: (r: Reap) => void
}

/** one sweep: synchronous end to end, so a hand cannot start a turn between the choice and the close */
export function sweep(d: SweepDeps): Reap[] {
  const done: Reap[] = []
  for (const r of pickReaps(d.hands(), d.now(), d.free(), d.config())) {
    if (!d.reap(r)) continue
    done.push(r)
    d.log?.(r)
  }
  return done
}

const WHY_TEXT: Record<ReapWhy, string> = { idle: 'idle too long', pressure: 'memory is low', cap: 'too many idle hands open' }
/** what the conversation says when its hand is closed, and the event's summary */
export function reapNote(r: Reap): string {
  const m = Math.round(r.idleMs / MIN)
  const idle = m >= 120 ? `${(m / 60).toFixed(1)} h` : `${m} min`
  return `Closed after ${idle} idle (${WHY_TEXT[r.why]}). Your next message reopens it where it stood.`
}

/** the event kind a reap logs: the System room counts today's */
export const REAP_EVENT = 'reap'
