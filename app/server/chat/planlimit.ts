import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from '../paths.ts'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { publish } from '../events.ts'

/**
 * THE PLAN'S USAGE WINDOWS, as Claude Code reports them. Every agent process the cockpit runs streams a
 * `rate_limit_event` (a claude.ai subscription's 5-hour and 7-day windows: utilization and when it resets);
 * the runner hands each to `observe`, and the rail's Usage card reads the latest per window. Nothing here
 * estimates: no event seen yet means the window is unknown, and a window whose reset has passed is stale
 * (its figure is from before the reset, so it is not shown as current).
 *
 * `utilization` is read as a fraction of the window (0..1, as the unified rate-limit headers carry it); the
 * raw number rides along so a different scale is visible at once, and a value outside 0..1 is not drawn.
 * The event alone is thin (the 7-day window arrives only near a limit, and carries no figure), so `probe` also asks
 * Claude Code for the structured data behind its `/usage` screen (the SDK's usage control request: percent used and
 * reset per window, no model turn, about a second) every few minutes, and the two feed the same rows. That reading is
 * a percentage 0..100, stored as the same 0..1 fraction.
 * Kept in <fund-data>/plan-limit.json so a restart does not blank the card until a chat next runs.
 */

export const WINDOWS = ['five_hour', 'seven_day'] as const
export type WindowId = (typeof WINDOWS)[number]
export type PlanWindow = { id: WindowId; utilization: number | null; raw: number | null; resetsAt: number | null; status: string; seenAt: number }
export type RateInfo = { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number }

const FILE = join(DATA_DIR, 'plan-limit.json')
const seen = new Map<WindowId, PlanWindow>()
let loaded = false

const ms = (t: unknown): number | null => (typeof t === 'number' && Number.isFinite(t) && t > 0 ? (t < 1e12 ? t * 1000 : t) : null)

/** pure: one event into a window row; null when it is not one of the two windows */
export function windowOf(info: RateInfo, now: number): PlanWindow | null {
  const id = WINDOWS.find(w => w === info?.rateLimitType)
  if (!id) return null
  const raw = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : null
  return { id, utilization: raw !== null && raw >= 0 && raw <= 1 ? raw : null, raw, resetsAt: ms(info.resetsAt), status: String(info.status ?? 'unknown'), seenAt: now }
}

export type UsageRows = { five_hour?: { utilization: number | null; resets_at: string | null } | null; seven_day?: { utilization: number | null; resets_at: string | null } | null }

/** pure: the /usage rows into window rows; a window the answer lacks, or whose figure is not 0..100, is not drawn */
export function windowsFromUsage(rows: UsageRows | null | undefined, now: number): PlanWindow[] {
  if (!rows) return []
  return WINDOWS.flatMap(id => {
    const r = rows[id]
    if (!r) return []
    const raw = typeof r.utilization === 'number' && Number.isFinite(r.utilization) ? r.utilization : null
    const at = r.resets_at ? Date.parse(r.resets_at) : NaN
    return [{ id, utilization: raw !== null && raw >= 0 && raw <= 100 ? raw / 100 : null, raw, resetsAt: Number.isFinite(at) ? at : null, status: 'usage', seenAt: now }]
  })
}

function store(w: PlanWindow) {
  load()
  const prev = seen.get(w.id)
  seen.set(w.id, w)
  try {
    if (!existsSync(dirname(FILE))) mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE, JSON.stringify({ windows: [...seen.values()] }, null, 2))
  } catch { /* a read-only floor: the card still has the memory */ }
  if (!prev || prev.utilization !== w.utilization || prev.resetsAt !== w.resetsAt || prev.status !== w.status) publish('plan', { window: w.id })
}

function load() {
  if (loaded) return
  loaded = true
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'))
    for (const w of Array.isArray(j?.windows) ? j.windows : []) if (WINDOWS.includes(w?.id)) seen.set(w.id, w)
  } catch { /* none yet */ }
}

export function observe(info: RateInfo, now = Date.now()): void {
  const w = windowOf(info, now)
  if (!w) return
  load()
  const prev = seen.get(w.id)
  // an event carries no figure of its own when the probe already read one for the same window: keep that figure
  if (prev && w.utilization === null && prev.utilization !== null && prev.resetsAt === w.resetsAt) store({ ...prev, status: w.status, seenAt: now })
  else store(w)
}

export type Asker = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(o?: { skipBehaviors?: boolean }): Promise<{ rate_limits: UsageRows | null }> }
let probeError: string | null = null
export const probeFailure = () => probeError

/** one read of /usage through `ask`; resolves true when a window was stored. A failure is kept for the card, never a zero. */
export async function probe(ask: Asker, now = Date.now()): Promise<boolean> {
  try {
    const rows = windowsFromUsage((await ask.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })).rate_limits, now)
    if (!rows.length) { probeError = 'the usage read named no window (not a subscription login?)'; return false }
    probeError = null
    for (const w of rows) store(w)
    return true
  } catch (e) { probeError = e instanceof Error ? e.message : String(e); return false }
}

/** a throwaway Claude Code process that is asked once and closed: no prompt is ever sent, so it costs no tokens */
async function probeOnce(): Promise<void> {
  const idle = (async function* () { await new Promise<void>(() => {}) })()
  const q = query({ prompt: idle as never, options: { cwd: DATA_DIR, settingSources: [] } })
  try { await probe(q as unknown as Asker) } finally { try { q.close() } catch { /* already gone */ } }
}

let timer: ReturnType<typeof setInterval> | null = null
/** read /usage now and every `everyMs` after; one at a time, and a scratch fundd (no jobs) does not start it */
export function startPlanPoll(everyMs = 120_000): void {
  if (timer || process.env.FUND_SCHEDULER === '0') return
  let running = false
  const tick = () => { if (running) return; running = true; void probeOnce().finally(() => { running = false }) }
  tick()
  timer = setInterval(tick, everyMs)
  timer.unref()
}

/** both windows, in order; a window never seen is null, one past its reset is marked stale */
export function readPlan(now = Date.now()): { windows: (PlanWindow & { stale: boolean })[]; seen: WindowId[]; error: string | null } {
  load()
  const windows = WINDOWS.flatMap(id => { const w = seen.get(id); return w ? [{ ...w, stale: w.resetsAt !== null && w.resetsAt <= now }] : [] })
  return { windows, seen: windows.map(w => w.id), error: probeError }
}
