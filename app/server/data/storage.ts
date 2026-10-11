import { HttpError } from '../http.ts'
import { publish } from '../events.ts'
import { logEvent, marketFn } from '../db.ts'
import { ACTOR, Unavailable, run, storeDoor } from './job.ts'
import { PlanBook, normPhrase } from './plans.ts'

// THE STORAGE VIEW (the on-demand data migration, B-0322 / B-0327). Data is pulled on demand into a
// size-capped, REBUILDABLE cache; a recorded result PINS the exact rows it used (immutable, never
// evicted); only a short list is ARCHIVED forever (what a backtest needs and the source will not
// serve again). This file reads the first two and runs the cache's one move:
//   the cache   @fund/db market.cacheUsage()  -> {root, max_bytes, bytes, files, partitions, over_budget,
//                                                 oldest_read_ms, datasets[{dataset, bytes, files, partitions}]}
//   the pins    @fund/db market.pins({})      -> index rows {hash, created_ms, dataset, venue, symbol, interval,
//                                                 window_from, window_to, rows, bytes, refs[{ref, reason}]}
//   evict       `python -m fund_db cache --evict [--to BYTES] [--dry-run] --json` (a process, as every move
//                of this room is): whole month partitions, least-recently-read first
// The archive and the ops store stay `fund_db usage --json` (./archive.ts usage). A read the package
// cannot answer yet is {available: false, reason}: NOT AVAILABLE, never a zero.

export type CacheUsage = {
  root: string | null; max_bytes: number; bytes: number; files: number; partitions: number
  over_budget: boolean; oldest_read_ms: number | null
  datasets: { dataset: string; bytes: number; files: number; partitions: number }[]
}
export type PinRow = {
  hash: string; created_ms: number | null; dataset: string; venue: string; symbol: string; interval: string | null
  window_from: number | null; window_to: number | null; rows: number | null; bytes: number | null
  refs: { ref: string; reason: string | null }[]
}
export type Evicted = { dataset: string; venue: string; interval: string | null; month: string; bytes: number; last_read_ms: number | null }
export type EvictReply = { before_bytes: number; after_bytes: number; max_bytes: number; evicted: Evicted[] }
type NA = { available: false; reason: string }

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null)
const na = (reason: string): NA => ({ available: false, reason })

/** the package's reply -> the view's shape; anything malformed is dropped, never guessed. Pure */
export function shapeCache(d: any): CacheUsage | null {
  if (!d || typeof d !== 'object' || num(d.max_bytes) === null || num(d.bytes) === null) return null
  return {
    root: str(d.root), max_bytes: d.max_bytes, bytes: d.bytes, files: num(d.files) ?? 0, partitions: num(d.partitions) ?? 0,
    over_budget: d.over_budget === true || d.bytes > d.max_bytes, oldest_read_ms: num(d.oldest_read_ms),
    datasets: (Array.isArray(d.datasets) ? d.datasets : []).filter((x: any) => x && typeof x.dataset === 'string')
      .map((x: any) => ({ dataset: x.dataset, bytes: num(x.bytes) ?? 0, files: num(x.files) ?? 0, partitions: num(x.partitions) ?? 0 }))
      .sort((a: { bytes: number }, b: { bytes: number }) => b.bytes - a.bytes),
  }
}

/** the pins index, newest first; a row with no 64-hex hash is dropped. Pure */
export function shapePins(rows: unknown): PinRow[] {
  if (!Array.isArray(rows)) return []
  return rows.filter((r: any) => r && typeof r.hash === 'string' && /^[0-9a-f]{64}$/.test(r.hash)).map((r: any) => ({
    hash: r.hash, created_ms: num(r.created_ms), dataset: String(r.dataset ?? ''), venue: String(r.venue ?? ''), symbol: String(r.symbol ?? ''),
    interval: str(r.interval), window_from: num(r.window_from), window_to: num(r.window_to), rows: num(r.rows), bytes: num(r.bytes),
    refs: (Array.isArray(r.refs) ? r.refs : []).filter((x: any) => x && typeof x.ref === 'string').map((x: any) => ({ ref: x.ref, reason: str(x.reason) })),
  })).sort((a, b) => (b.created_ms ?? 0) - (a.created_ms ?? 0))
}

export const PINS_SHOWN = 200

export async function readCache(): Promise<(CacheUsage & { available: true }) | NA> {
  const f = marketFn<() => Promise<unknown>>('cacheUsage')
  if (!f) return na('the cache is not built yet: @fund/db has no market.cacheUsage (B-0324)')
  try {
    const c = shapeCache(await f())
    return c ? { ...c, available: true } : na('market.cacheUsage returned no budget')
  } catch (e) { return na(`the cache did not answer: ${String((e as Error)?.message ?? e).slice(0, 200)}`) }
}

export async function readPins(): Promise<{ available: true; count: number; bytes: number; rows: PinRow[] } | NA> {
  const f = marketFn<(o: Record<string, unknown>) => Promise<unknown>>('pins')
  if (!f) return na('pins are not built yet: @fund/db has no market.pins (B-0324)')
  try {
    const all = shapePins(await f({}))
    return { available: true, count: all.length, bytes: all.reduce((n, p) => n + (p.bytes ?? 0), 0), rows: all.slice(0, PINS_SHOWN) }
  } catch (e) { return na(`the pins did not answer: ${String((e as Error)?.message ?? e).slice(0, 200)}`) }
}

export async function storage() {
  const [cache, pins] = await Promise.all([readCache(), readPins()])
  return { cache, pins, read_ms: Date.now() }
}

// ---- evict to budget: a dry run held here, the phrase typed, a second dry run that must match ----

/** what the owner types: the plan's own totals */
export function evictPhrase(r: Pick<EvictReply, 'evicted'>): string {
  const mb = r.evicted.reduce((n, e) => n + (num(e.bytes) ?? 0), 0) / 1e6
  return `evict ${r.evicted.length} partitions ${mb.toFixed(1)} MB`
}
/** a partition list in one canonical order, so two dry runs compare as strings */
export const evictSig = (r: Pick<EvictReply, 'evicted'>) =>
  r.evicted.map(e => `${e.dataset}|${e.venue}|${e.interval ?? ''}|${e.month}`).sort().join('\n')

export function shapeEvict(d: any): EvictReply {
  if (!d || typeof d !== 'object' || !Array.isArray(d.evicted) || num(d.max_bytes) === null) throw new HttpError(502, 'fund_db cache --evict printed no plan')
  return {
    before_bytes: num(d.before_bytes) ?? 0, after_bytes: num(d.after_bytes) ?? 0, max_bytes: d.max_bytes,
    evicted: d.evicted.filter((e: any) => e && typeof e.dataset === 'string' && typeof e.month === 'string')
      .map((e: any) => ({ dataset: e.dataset, venue: String(e.venue ?? ''), interval: str(e.interval), month: e.month, bytes: num(e.bytes) ?? 0, last_read_ms: num(e.last_read_ms) })),
  }
}

/** --to BYTES, or the budget when absent; a positive integer only. Throws a 400 */
export function parseTo(body: any): number | null {
  const v = body?.to_bytes
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new HttpError(400, 'to_bytes: a whole number of bytes, or none for the budget')
  return v
}

type Held = { to: number | null; plan: EvictReply; sig: string; phrase: string }
const evictBook = new PlanBook<Held>(8)
const EVICT_TTL = 10 * 60_000

const evictArgs = (to: number | null, dry: boolean) => ['cache', '--evict', ...(to !== null ? ['--to', String(to)] : []), ...(dry ? ['--dry-run'] : []), '--json']

async function dryRun(to: number | null): Promise<EvictReply> {
  try { return shapeEvict(await run(storeDoor(), evictArgs(to, true), undefined, 300_000)) }
  catch (e) { if (e instanceof Unavailable) throw new HttpError(503, `the cache is not built yet (B-0324): ${e.message}`); throw e }
}

export async function evictPlan(body: unknown) {
  const to = parseTo(body)
  const plan = await dryRun(to)
  const phrase = evictPhrase(plan)
  const key = plan.evicted.length ? evictBook.put({ to, plan, sig: evictSig(plan), phrase }, Date.now() + EVICT_TTL) : null
  return { available: true as const, key, ...plan, phrase: plan.evicted.length ? phrase : null, expires_ms: Date.now() + EVICT_TTL }
}

export async function evictApply(body: any) {
  const held = evictBook.get(body?.key)
  if (!held) throw new HttpError(409, 'the plan expired or is unknown: plan again')
  if (normPhrase(body?.phrase) !== normPhrase(held.phrase)) throw new HttpError(400, 'the typed phrase does not match the plan')
  // the cache moves with every read: evict only if it would still take exactly the planned partitions
  const again = await dryRun(held.to)
  if (evictSig(again) !== held.sig) { evictBook.drop(body.key); throw new HttpError(409, 'the cache moved since the plan: plan again') }
  const done = shapeEvict(await run(storeDoor(), evictArgs(held.to, false), undefined, 600_000))
  evictBook.drop(body.key)
  const freed = done.before_bytes - done.after_bytes
  void logEvent('job', `cache evicted ${done.evicted.length} partition(s) (${(freed / 1e6).toFixed(1)} MB) to ${(done.after_bytes / 1e6).toFixed(1)} MB of ${(done.max_bytes / 1e6).toFixed(1)} MB`,
    { payload: { actor: ACTOR, partitions: done.evicted, bytes: freed, to: held.to } })
  publish('data', { kind: 'cache.evict' })
  return { ok: true, partitions: done.evicted.length, bytes: freed, after_bytes: done.after_bytes, max_bytes: done.max_bytes }
}
