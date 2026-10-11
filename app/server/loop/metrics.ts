import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ops, transaction, type Queryable } from '../db.ts'
import type { Agent } from '../../shared/types.ts'
import { listAllItems } from '../board/store.ts'
import { closedBy } from './boardreview.ts'
import { allDesks, parseJsonl, type Raw } from '../lab/runs.ts'
import { BOARD_REL, deskDir, deskRel } from '../paths.ts'

/**
 * METRICS - one row per (UTC day, agent) of RAW COUNTS, read from real records only:
 *   the cockpit database  turns (turn events), errors (error events), cost (usage rows),
 *                         reopened board items (a status=done followed by any other status; a done
 *                         the loop's board reviewer closed also counts against that reviewer)
 *   the lab ledgers       pre-registered results graded against their band, verify passes
 *   the board files       items done (status done, dated by `updated`, credited to the owner)
 *   the owner's grades    good / bad on a turn (turn_grades, source owner), dated by the TURN
 * and a SCORE derived from the counts. A component with no data is absent, never a zero: an
 * agent that took no turns has no reliability, not a perfect one. Counts, not ratios, are what
 * the table keeps, so any window can be pooled honestly (sum the counts, then divide).
 */

export const COUNTS = ['turns', 'errors', 'cost_usd', 'graded', 'in_band', 'verify_passed', 'verify_total', 'board_done', 'board_reopened', 'owner_good', 'owner_bad'] as const
export type CountKey = typeof COUNTS[number]
export type Counts = Record<CountKey, number>
export const zero = (): Counts => Object.fromEntries(COUNTS.map(k => [k, 0])) as Counts

const DAY = 86_400_000
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const dayMs = (day: string) => Date.parse(day + 'T00:00:00Z')

export type Components = { reliability: number | null; calibration: number | null; verify: number | null; delivery: number | null; taste: number | null }

/** the parts of the score this window can measure; null = no data for that part */
export function components(c: Counts): Components {
  return {
    reliability: c.turns > 0 ? 1 - Math.min(1, c.errors / c.turns) : null,
    calibration: c.graded > 0 ? c.in_band / c.graded : null,
    verify: c.verify_total > 0 ? c.verify_passed / c.verify_total : null,
    delivery: c.board_done + c.board_reopened > 0 ? c.board_done / (c.board_done + c.board_reopened) : null,
    // the owner's own good / bad on graded turns: absent (never 0) on a day he graded nothing
    taste: c.owner_good + c.owner_bad > 0 ? c.owner_good / (c.owner_good + c.owner_bad) : null,
  }
}

/**
 * How many scored events a window holds: turns, graded results, board outcomes, owner grades.
 * (verify_total counts CHECKS inside runs, not runs, so it is not a sample size.) A score over
 * three turns is one bad turn away from a 0.33 drop; the watch reads it as no-signal instead.
 */
export function evidence(c: Counts): number {
  return c.turns + c.graded + c.board_done + c.board_reopened + c.owner_good + c.owner_bad
}

/** the mean of the measured components, 0..1; null when nothing was measured */
export function scoreOf(c: Counts): number | null {
  const v = Object.values(components(c)).filter((x): x is number => x !== null)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

export function add(a: Counts, b: Partial<Counts>): Counts {
  const o = { ...a }
  for (const k of COUNTS) o[k] += b[k] ?? 0
  return o
}

/** the agent that owns a lab desk: the longest `writes` prefix covering the folder */
export function ownerOf(path: string, agents: Pick<Agent, 'id' | 'writes'>[]): string | null {
  const p = path.replace(/\\/g, '/').replace(/\/?$/, '/')
  let best: { id: string; n: number } | null = null
  for (const a of agents) for (const w of a.writes ?? []) {
    const pre = w.replace(/\\/g, '/')
    const hit = pre.endsWith('/') ? p.startsWith(pre) : (p === pre + '/' || p.startsWith(pre + '/'))
    if (hit && (!best || pre.length > best.n)) best = { id: a.id, n: pre.length }
  }
  return best?.id ?? null
}

const BAND = /^\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*$/

/** a pre-registered result graded against its band: null = not gradeable (no band, no metric) */
export function inBand(predicted: Record<string, unknown>, metrics: Record<string, unknown>): boolean | null {
  let graded = false
  for (const [k, v] of Object.entries(predicted ?? {})) {
    const m = BAND.exec(String(v))
    const x = metrics?.[k]
    if (!m || typeof x !== 'number' || !Number.isFinite(x)) continue
    const lo = Math.min(Number(m[1]), Number(m[2])), hi = Math.max(Number(m[1]), Number(m[2]))
    graded = true
    if (x < lo || x > hi) return false
  }
  return graded ? true : null
}

function isoMs(s: unknown): number | null {
  if (typeof s !== 'string' || !s) return null
  let t = s.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00:00Z'
  else if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) t += 'Z'
  const n = Date.parse(t)
  return Number.isFinite(n) ? n : null
}

type Acc = Map<string, Counts>   // "day|agent" -> counts
const bump = (acc: Acc, day: string, agent: string, k: CountKey, n = 1) => {
  const key = `${day}|${agent}`
  const c = acc.get(key) ?? zero()
  c[k] += n
  acc.set(key, c)
}

export type Sources = { db: Queryable; fundRoot: string; agents: Agent[] }

/** every (day, agent) count from `sinceMs` to `untilMs` (exclusive), from the three sources */
export async function collect(s: Sources, sinceMs: number, untilMs: number): Promise<Acc> {
  const acc: Acc = new Map()
  const known = new Set(s.agents.map(a => a.id))
  const agentOk = (a: unknown): a is string => typeof a === 'string' && known.has(a)

  // the store: turns and errors (events), cost (usage)
  const ev = await ops.eventsInWindow(sinceMs, untilMs, { kinds: ['turn', 'error'], agentOnly: true }, s.db)
  for (const e of ev) {
    if (!agentOk(e.agent_id)) continue
    if (e.kind === 'turn' && e.summary.startsWith('turn done')) bump(acc, dayOf(e.ts), e.agent_id, 'turns')
    else if (e.kind === 'error') bump(acc, dayOf(e.ts), e.agent_id, 'errors')
  }
  const us = await ops.usageInWindow(sinceMs, untilMs, s.db)
  for (const u of us) if (agentOk(u.agent_id) && u.cost_usd > 0) bump(acc, dayOf(u.ts), u.agent_id, 'cost_usd', u.cost_usd)

  // the owner's grades: dated by the turn, so a late grade lands where the work happened
  const gs = await ops.gradesInWindow('owner', sinceMs, untilMs, s.db)
  for (const g of gs) if (agentOk(g.agent_id)) bump(acc, dayOf(g.ts), g.agent_id, g.value >= 0.5 ? 'owner_good' : 'owner_bad')

  // the board: done from the files, reopened from the change log
  // the archive included: a recompute over an older window must still count what has moved to done/
  let items: ReturnType<typeof listAllItems> = []
  try { items = listAllItems(join(s.fundRoot, ...BOARD_REL.split('/'))) } catch { items = [] }
  const ownerOfItem = new Map(items.map(i => [i.id, i.owner]))
  const itemOf = new Map(items.map(i => [i.id, i]))
  for (const i of items) {
    if (i.status !== 'done' || !agentOk(i.owner)) continue
    const t = isoMs(i.updated)
    if (t !== null && t >= sinceMs && t < untilMs) bump(acc, dayOf(t), i.owner, 'board_done')
  }
  const bev = await ops.eventsInWindow(0, untilMs, { kinds: ['board'] }, s.db)
  const last = new Map<string, string>()
  const doneAt = new Map<string, number>()
  for (const e of bev) {
    const m = /^(B-\d+)\b.*\bstatus=(\S+)/.exec(e.summary)
    if (!m) continue
    const [, id, st] = m
    const prev = last.get(id)
    last.set(id, st)
    if (st === 'done') doneAt.set(id, e.ts)
    const owner = ownerOfItem.get(id)
    if (prev === 'done' && st !== 'done' && e.ts >= sinceMs) {
      if (agentOk(owner)) bump(acc, dayOf(e.ts), owner, 'board_reopened')
      // a done the loop's reviewer closed (boardreview.ts) that comes back counts against that reviewer too
      const item = itemOf.get(id)
      const reviewer = item ? closedBy(item, doneAt.get(id) ?? NaN) : null
      if (reviewer && reviewer !== owner && agentOk(reviewer)) bump(acc, dayOf(e.ts), reviewer, 'board_reopened')
    }
  }

  // the lab: pre-registered results only (imports carry no prediction to grade)
  for (const desk of allDesks(s.fundRoot)) {
    const f = join(deskDir(desk, s.fundRoot), 'data', 'runs.jsonl')
    if (!existsSync(f)) continue
    const owner = ownerOf(deskRel(desk, s.fundRoot), s.agents)
    if (!owner) continue
    let rows: Raw[] = []
    try { rows = parseJsonl(readFileSync(f, 'utf8')).rows } catch { continue }
    for (const r of rows) {
      if (r.stage !== 'result' || r.preregistered === false) continue
      const t = isoMs(r.ts)
      if (t === null || t < sinceMs || t >= untilMs) continue
      const day = dayOf(t)
      const hit = inBand(r.predicted ?? {}, r.metrics ?? {})
      if (hit !== null) { bump(acc, day, owner, 'graded'); if (hit) bump(acc, day, owner, 'in_band') }
      const v = r.verify ?? {}
      if (typeof v.total === 'number' && v.total > 0 && typeof v.passed === 'number') {
        bump(acc, day, owner, 'verify_total', v.total)
        bump(acc, day, owner, 'verify_passed', Math.min(v.passed, v.total))
      }
    }
  }
  return acc
}

export type MetricRow = { day: string; agent: string; counts: Counts; score: number | null }

export function toRows(acc: Acc): MetricRow[] {
  return [...acc.entries()].map(([k, c]) => {
    const [day, agent] = k.split('|')
    return { day, agent, counts: c, score: scoreOf(c) }
  }).sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent))
}

/** recompute the last `days` whole UTC days up to now and REPLACE them in loop_metrics */
export async function refresh(s: Sources, now: number, days = 35): Promise<MetricRow[]> {
  const since = dayMs(dayOf(now - (days - 1) * DAY))
  const rows = toRows(await collect(s, since, now + 1))
  await transaction(async c => {
    await ops.clearMetrics(dayOf(since), c)
    for (const r of rows) {
      for (const k of COUNTS) if (r.counts[k]) await ops.setMetric(r.day, r.agent, k, r.counts[k], c)
      if (r.score !== null) await ops.setMetric(r.day, r.agent, 'score', r.score, c)
    }
  }, s.db)
  return rows
}

/** counts per (day, agent) as stored, for days in [fromDay, toDay] */
export async function stored(db: Queryable, fromDay: string, toDay: string, agents?: string[]): Promise<MetricRow[]> {
  const rows = await ops.metricsBetween(fromDay, toDay, db)
  const acc: Acc = new Map()
  const want = agents ? new Set(agents) : null
  for (const r of rows) {
    if (want && !want.has(r.agent_id)) continue
    if (!(COUNTS as readonly string[]).includes(r.metric)) continue
    bump(acc, r.day, r.agent_id, r.metric as CountKey, r.value)
  }
  return toRows(acc)
}

/** the cohort pooled over [fromMs, toMs): summed counts and their score */
export async function pooled(db: Queryable, agents: string[], fromMs: number, toMs: number): Promise<{ counts: Counts; score: number | null; days: number }> {
  const rows = await stored(db, dayOf(fromMs), dayOf(toMs - 1), agents)
  let c = zero()
  for (const r of rows) c = add(c, r.counts)
  return { counts: c, score: scoreOf(c), days: new Set(rows.map(r => r.day)).size }
}

/** the cohort's daily pooled series, one point per day in range (score null on a day with no data) */
export async function series(db: Queryable, agents: string[], fromMs: number, toMs: number): Promise<{ day: string; score: number | null; turns: number; cost: number }[]> {
  const rows = await stored(db, dayOf(fromMs), dayOf(toMs), agents)
  const by = new Map<string, Counts>()
  for (const r of rows) by.set(r.day, add(by.get(r.day) ?? zero(), r.counts))
  const out: { day: string; score: number | null; turns: number; cost: number }[] = []
  for (let t = dayMs(dayOf(fromMs)); t <= toMs; t += DAY) {
    const d = dayOf(t)
    const c = by.get(d)
    out.push({ day: d, score: c ? scoreOf(c) : null, turns: c?.turns ?? 0, cost: c?.cost_usd ?? 0 })
  }
  return out
}

/** closed days (before today) as metrics.jsonl lines not already in `existing` */
export function jsonlLines(rows: MetricRow[], now: number, existing: string): string[] {
  const have = new Set<string>()
  for (const line of existing.split('\n')) {
    try { const o = JSON.parse(line); if (o?.day && o?.agent) have.add(`${o.day}|${o.agent}`) } catch { /* skip */ }
  }
  const today = dayOf(now)
  return rows.filter(r => r.day < today && !have.has(`${r.day}|${r.agent}`)).map(r => {
    const counts = Object.fromEntries(COUNTS.filter(k => r.counts[k]).map(k => [k, k === 'cost_usd' ? Math.round(r.counts[k] * 1e4) / 1e4 : r.counts[k]]))
    return JSON.stringify({ day: r.day, agent: r.agent, score: r.score === null ? null : Math.round(r.score * 1e4) / 1e4, ...counts })
  })
}
