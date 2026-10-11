/**
 * In-process seams between rooms, so no room imports another room's internals.
 *   onStop      - STOP pressed: every room that owns live work stops it (agents, jobs...)
 *   summary     - numbers for the status bar (working agents, needs-you, dashboards...)
 *   runJob      - ask the scheduler (the system room) to run one schedule.json job now
 *   turnDone    - a chat turn finished (chat/runner.ts); the loop room grades it at once
 */
type StopFn = () => void | Promise<void>
type SummaryFn = () => Record<string, unknown> | Promise<Record<string, unknown>>

const stops: StopFn[] = []
const summaries: SummaryFn[] = []

export function onStop(fn: StopFn) { stops.push(fn) }
export function onSummary(fn: SummaryFn) { summaries.push(fn) }

export async function stopAll() {
  await Promise.allSettled(stops.map(f => f()))
}

export async function summary(): Promise<Record<string, unknown>> {
  const parts = await Promise.allSettled(summaries.map(f => f()))
  return Object.assign({}, ...parts.map(p => (p.status === 'fulfilled' ? p.value : {})))
}

type RunJobFn = (id: string) => Promise<unknown>
let jobRunner: RunJobFn | null = null
export function onRunJob(fn: RunJobFn) { jobRunner = fn }
/** run a scheduled job now; false when no scheduler is wired (tests) or it refused (running, STOP) */
export async function runJob(id: string): Promise<boolean> {
  if (!jobRunner) return false
  try { await jobRunner(id); return true } catch { return false }
}

type TurnFn = (conv: string) => void
const turnFns: TurnFn[] = []
export function onTurn(fn: TurnFn) { turnFns.push(fn) }
/** a conversation finished a turn; every listener runs, none can break the runner */
export function turnDone(conv: string) {
  for (const f of turnFns) { try { f(conv) } catch { /* a listener never breaks a turn */ } }
}

/**
 * the idle restart (B-0174 part 2, server/restart.ts): a room that holds live work says why fundd
 * must not restart now ([] = nothing of mine runs), and may save, close and reopen what it holds.
 * The chats room registers the conversations and the terminals.
 */
export type RestartHolder = {
  busy: () => string[] | Promise<string[]>
  live?: () => { id: string; busy: boolean; waiting: boolean; tasks?: string[]; later?: string[]; auto?: boolean }[]
  close?: () => void | Promise<void>
  /** reopen a saved conversation: the cut note, the background work that ended with it, the message it is sent */
  reopen?: (id: string, r: { note: string | null; lost: string[]; say: 'continue' | 'lost' | null; at: number }) => Promise<void>
  /** the boot scan for turns cut by a hard stop (B-0254 part 5) */
  scan?: (since: number, exclude: Set<string>) => Promise<{ id: string; waiting?: boolean; auto?: boolean }[]>
  /** call fn whenever what live() returns may have changed (the journal, B-0254) */
  watch?: (fn: () => void) => void
}
const holders: RestartHolder[] = []
export function onRestart(h: RestartHolder) { holders.push(h) }
export const restartHolders = (): readonly RestartHolder[] => holders
