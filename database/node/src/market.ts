/**
 * @fund/db market - READ-ONLY views of the storage classes for the cockpit's Data room (B-0322 /
 * B-0324). The python side (fund_db.market: cache.py, pins.py) writes, evicts and pins; node only
 * reads what it recorded in the ops store (migration market/004):
 *
 *   await market.cacheUsage()                 the cache months as last recorded, against the budget
 *   await market.pins({ ref: 'lab/carry#12' }) the pin index with every ref
 *   await market.blobs({ dataset: 'derived' }) the blob seat's index (pinned bytes, B-0648) with every ref
 *   await market.pacerStatus()                the per-venue request budgets (fund_db.pacer.status())
 *
 * cacheUsage() reads market.cache_parts (bytes as recorded by the write that last touched each
 * month) and retention.toml's [cache] max_bytes; `python -m fund_db cache --usage` measures the
 * disk itself. The keys are the python ones (snake_case), so one renderer serves both.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, REPO_ROOT } from './config.ts'
import { query, type Queryable } from './db.ts'

/** 500 MB (decimal), the owner's number (B-0335): retention.py's default when [cache] names none */
export const DEFAULT_CACHE_MAX_BYTES = 500_000_000

export interface CacheDataset { dataset: string; bytes: number; files: number; partitions: number }
export interface CacheUsage {
  root: string; max_bytes: number; bytes: number; files: number; partitions: number
  over_budget: boolean; oldest_read_ms: number | null; datasets: CacheDataset[]; measured: 'recorded'
}
export interface PinRef { ref: string; reason: string; created_ms: number }
export interface Pin {
  hash: string; created_ms: number; dataset: string; venue: string; symbol: string; interval: string
  what: string; window_from: number | null; window_to: number | null; first_ts: number | null
  last_ts: number | null; rows: number; bytes: number; refs: PinRef[]
}
export interface Blob {
  dataset: string; key: string; hash: string; bytes: number; meta: Record<string, unknown>
  built_from: Record<string, unknown>; created_ms: number; refs: PinRef[]
}

/** retention.toml [cache] max_bytes (FUND_DB_RETENTION overrides the path, as in python) */
export function cacheMaxBytes(path = process.env.FUND_DB_RETENTION ?? join(REPO_ROOT, 'retention.toml')): number {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return DEFAULT_CACHE_MAX_BYTES }
  let inCache = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const t = line.match(/^\[([^\]]+)\]$/)
    if (t) { inCache = t[1].trim() === 'cache'; continue }
    const m = inCache ? line.match(/^max_bytes\s*=\s*([\d_]+)$/) : null
    if (m) return Number(m[1].replace(/_/g, ''))
  }
  return DEFAULT_CACHE_MAX_BYTES
}

export async function cacheUsage(q?: Queryable): Promise<CacheUsage> {
  const rows = await query<{ dataset: string; bytes: number; files: number; written_ms: number; last_read_ms: number | null }>(
    'SELECT dataset, bytes, files, written_ms, last_read_ms FROM market.cache_parts', [], q)
  const per = new Map<string, CacheDataset>()
  let bytes = 0; let files = 0; let oldest: number | null = null
  for (const r of rows) {
    const d = per.get(r.dataset) ?? { dataset: r.dataset, bytes: 0, files: 0, partitions: 0 }
    d.bytes += r.bytes; d.files += r.files; d.partitions += 1
    per.set(r.dataset, d)
    bytes += r.bytes; files += r.files
    const o = Math.max(r.last_read_ms ?? 0, r.written_ms ?? 0)
    oldest = oldest === null ? o : Math.min(oldest, o)
  }
  const max = cacheMaxBytes()
  return {
    root: join(dataDir(), 'cache'), max_bytes: max, bytes, files, partitions: rows.length,
    over_budget: bytes > max, oldest_read_ms: oldest,
    datasets: [...per.values()].sort((a, b) => b.bytes - a.bytes), measured: 'recorded',
  }
}

export interface PacerRow {
  venue: string; capacity: number; refill_per_s: number; tokens: number
  blocked_until_ms: number | null; reason: string | null; source: string; updated_ms: number
}

/** fund_db.pacer.status() for node: every paced venue, tokens refilled to `nowMs` (negative = reservations queued) */
export async function pacerStatus(o: { venue?: string; nowMs?: number } = {}, q?: Queryable): Promise<PacerRow[]> {
  const now = o.nowMs ?? Date.now()
  const rows = await query<PacerRow & { refilled_ms: number }>(
    'SELECT * FROM market.pacer WHERE ($1::text IS NULL OR venue = $1) ORDER BY venue', [o.venue?.toLowerCase() ?? null], q)
  return rows.map(({ refilled_ms, ...r }) => ({
    ...r, tokens: Math.min(r.capacity, r.tokens + Math.max(0, now - Number(refilled_ms)) / 1000 * r.refill_per_s),
  }))
}

export async function pins(o: { ref?: string; hash?: string; dataset?: string; venue?: string; symbol?: string } = {},
  q?: Queryable): Promise<Pin[]> {
  const w: string[] = []; const a: unknown[] = []
  for (const k of ['hash', 'dataset', 'venue', 'symbol'] as const) {
    const v = k === 'venue' ? o.venue?.toLowerCase() : o[k]
    if (v !== undefined) { a.push(v); w.push(`p.${k} = $${a.length}`) }
  }
  if (o.ref !== undefined) { a.push(o.ref); w.push(`p.hash IN (SELECT hash FROM market.pin_refs WHERE ref = $${a.length})`) }
  return query<Pin>(
    `SELECT p.*, coalesce((SELECT jsonb_agg(jsonb_build_object('ref', r.ref, 'reason', r.reason, 'created_ms', r.created_ms)
       ORDER BY r.created_ms, r.ref) FROM market.pin_refs r WHERE r.hash = p.hash), '[]'::jsonb) AS refs
     FROM market.pins p${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY p.created_ms, p.hash`, a, q)
}

/** The blob seat's index (fund_db.market.blobs; migration market/005), the files themselves stay python-side. */
export async function blobs(o: { dataset?: string; key?: string; prefix?: string; ref?: string } = {},
  q?: Queryable): Promise<Blob[]> {
  const w: string[] = []; const a: unknown[] = []
  if (o.dataset !== undefined) { a.push(o.dataset); w.push(`b.dataset = $${a.length}`) }
  if (o.key !== undefined) { a.push(o.key); w.push(`b."key" = $${a.length}`) }
  if (o.prefix !== undefined) { a.push(o.prefix); w.push(`starts_with(b."key", $${a.length})`) }
  if (o.ref !== undefined) {
    a.push(o.ref)
    w.push(`EXISTS (SELECT 1 FROM market.blob_refs r WHERE r.dataset = b.dataset AND r."key" = b."key" AND r.ref = $${a.length})`)
  }
  return query<Blob>(
    `SELECT b.*, coalesce((SELECT jsonb_agg(jsonb_build_object('ref', r.ref, 'reason', r.reason, 'created_ms', r.created_ms)
       ORDER BY r.created_ms, r.ref) FROM market.blob_refs r WHERE r.dataset = b.dataset AND r."key" = b."key"), '[]'::jsonb) AS refs
     FROM market.blobs b${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY b.dataset, b."key"`, a, q)
}
