import { logEvent, ops } from '../db.ts'
import { HttpError } from '../http.ts'
import { agentsDoc } from '../config.ts'
import { ceilings } from './spend.ts'

/**
 * THE SPEND CAP: the roster's `budgetTokensPerDay` turned from a reading into a gate.
 *
 * used    = billable tokens (input + cache writes + output, spend.ts's metric) in the `usage`
 *           table since LOCAL midnight
 * ceiling = spend.ts ceilings(): the agent's own, else defaults; none = never capped (null)
 * capped  = used >= ceiling, unless the owner lifted the cap for the rest of the local day
 *
 * Enforced where work starts: chat/runner.ts start() + send() await spendGate() (HTTP 429), and
 * board/auto.ts holdReason() says "capped" for an owner the spendable() snapshot refuses (the item
 * stays where it is). The owner's lift is held in memory (a restart re-arms it) and logged.
 */

export type CapState = { used: number; ceiling: number; capped: boolean; lifted: boolean }

/** local midnight of `now` */
export function localMidnight(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** the pure verdict: no ceiling -> null, never an invented limit */
export function capOf(used: number, ceiling: number | null | undefined, lifted = false): CapState | null {
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0) return null
  return { used, ceiling, capped: !lifted && used >= ceiling, lifted }
}

/** billable tokens `agent` spent since `since` (ms) */
export async function usedSince(agent: string, since: number): Promise<number> {
  return (await usedSinceAll(since)).get(agent) ?? 0
}

/** billable tokens per agent since `since` (ms); an agent with no usage is absent */
export async function usedSinceAll(since: number): Promise<Map<string, number>> {
  return ops.billableByAgent(since)
}

/** the roster ceiling of one agent (the roster read fresh: an edit binds at once) */
export function configCeiling(agent: string): number | null {
  const raw = agentsDoc()
  if (!raw) return null
  const c = ceilings(raw)
  return agent in c.byAgent ? c.byAgent[agent] : c.fallback
}

// ---- the owner's lift: agent -> the local midnight of the day it was lifted ----
const lifts = new Map<string, number>()
export const liftedToday = (agent: string, now = Date.now()) => lifts.get(agent) === localMidnight(now)
export function liftCap(agent: string, now = Date.now()) {
  lifts.set(agent, localMidnight(now))
  logEvent('system', `spend cap lifted for ${agent} until local midnight`, { agent })
}
/** test seam */
export function resetLifts() { lifts.clear() }

export async function capState(agent: string, now = Date.now(), ceilingOf: (a: string) => number | null = configCeiling): Promise<CapState | null> {
  const ceiling = ceilingOf(agent)
  if (ceiling === null) return null
  return capOf(await usedSince(agent, localMidnight(now)), ceiling, liftedToday(agent, now))
}

/** may `agent` start or continue a conversation now? (an agent with no ceiling always may) */
export async function canSpend(agent: string, now = Date.now(), ceilingOf: (a: string) => number | null = configCeiling): Promise<boolean> {
  return !(await capState(agent, now, ceilingOf))?.capped
}

/** canSpend for many agents at once, as the synchronous predicate board/auto.ts takes: one read
 *  of today's usage, judged per agent (an agent not in `agents` may spend: nothing was read for it) */
export async function spendable(agents: string[], now = Date.now(), ceilingOf: (a: string) => number | null = configCeiling): Promise<(agent: string) => boolean> {
  const used = await usedSinceAll(localMidnight(now))
  const capped = new Set(agents.filter(a => capOf(used.get(a) ?? 0, ceilingOf(a), liftedToday(a, now))?.capped))
  return a => !capped.has(a)
}

/** the refusal chat/runner.ts throws: HTTP 429 "capped: <used>/<ceiling>" */
export async function spendGate(agent: string, now = Date.now(), ceilingOf: (a: string) => number | null = configCeiling): Promise<void> {
  const s = await capState(agent, now, ceilingOf)
  if (s?.capped) throw new HttpError(429, `capped: ${s.used}/${s.ceiling}`)
}
