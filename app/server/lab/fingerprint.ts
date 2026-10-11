/**
 * The window fingerprint (app/loop/tools/fingerprint.py writes it into a result or read row as
 * `fingerprint: {digest, window: {from, to} (ms), inputs[]}`). Pure: no file, no clock.
 *
 * Two runs that read the same stored rows are ONE observation. `sameWindow` says so when:
 *  - their digests are equal (the very same rows), or
 *  - they name the SAME set of inputs (venue/symbol/dataset/interval) and every pair overlaps
 *    on [first_ts, last_ts]: they read shared rows, whatever they were labelled.
 * A legacy row (no fingerprint) is never "same" as anything: unknown is not a match.
 *
 * PINS (the on-demand data migration, B-0322): the cache evicts, so a recorded result PINS the rows
 * it read, and a pin's content hash IS the input's sha256 (database B-0324 agreed the digest). An
 * input is pinned when its row carries `pin` or the pin index holds its sha256 (the backfill pins
 * legacy inputs without rewriting any ledger row). A pinned input's truncation is read from the
 * pinned rows themselves (first_ts), never from what the cache happens to hold now.
 */

export type FpInput = {
  venue: string; symbol: string; dataset: string; interval: string
  first_ts: number | null; last_ts: number | null; rows: number; sha256: string
  stored_first?: number | null; trunc?: boolean
  pin?: string | null                  // the pin's content hash, when the loop pinned it at record time
}
export type Fingerprint = { digest: string; window: { from: number; to: number } | null; inputs: FpInput[] }

const IV_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
/** a series stored without an interval (settled funding) is tolerated one 8h settlement late */
const NO_IV_TOL = 8 * 3_600_000

const HASH = /^[0-9a-f]{64}$/
const n = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null

/** a row's fingerprint when it is well-formed; null for a legacy row or a malformed one */
export function fpOf(row: Record<string, any> | null | undefined): Fingerprint | null {
  const f = row?.fingerprint
  if (!f || typeof f !== 'object' || typeof f.digest !== 'string' || !/^[0-9a-f]{8}$/.test(f.digest)) return null
  const inputs: FpInput[] = Array.isArray(f.inputs) ? f.inputs.filter((i: any) => i && typeof i.venue === 'string' && typeof i.sha256 === 'string').map((i: any) => ({
    venue: i.venue, symbol: String(i.symbol ?? ''), dataset: String(i.dataset ?? ''), interval: String(i.interval ?? ''),
    first_ts: n(i.first_ts), last_ts: n(i.last_ts), rows: n(i.rows) ?? 0, sha256: i.sha256,
    stored_first: n(i.stored_first), trunc: typeof i.trunc === 'boolean' ? i.trunc : undefined,
    pin: typeof i.pin === 'string' && HASH.test(i.pin) ? i.pin : null,
  })) : []
  const w = f.window && n(f.window.from) !== null && n(f.window.to) !== null ? { from: f.window.from, to: f.window.to } : null
  return { digest: f.digest, window: w, inputs }
}

export const inputKey = (i: Pick<FpInput, 'venue' | 'symbol' | 'dataset' | 'interval'>) => `${i.venue}:${i.symbol}:${i.dataset}:${i.interval}`

const overlaps = (a: FpInput, b: FpInput) =>
  a.first_ts !== null && a.last_ts !== null && b.first_ts !== null && b.last_ts !== null
  && a.first_ts <= b.last_ts && b.first_ts <= a.last_ts

export function sameWindow(a: Fingerprint | null, b: Fingerprint | null): boolean {
  if (!a || !b) return false
  if (a.digest === b.digest) return true
  if (!a.inputs.length || a.inputs.length !== b.inputs.length) return false
  const bm = new Map(b.inputs.map(i => [inputKey(i), i]))
  return a.inputs.every(i => { const j = bm.get(inputKey(i)); return !!j && overlaps(i, j) })
}

function tolerance(interval: string): number {
  const m = /^(\d+(?:\.\d+)?)([mhdw])$/.exec(interval)
  return m ? Number(m[1]) * IV_MS[m[2]] : NO_IV_TOL
}

function isoMs(s: unknown): number | null {
  if (typeof s !== 'string' || !s.trim()) return null
  let t = s.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00:00Z'
  else if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) t += 'Z'
  const v = Date.parse(t)
  return Number.isFinite(v) ? v : null
}

/**
 * Truncated: an input's first STORED stamp is later than the window's `from` (by more than one
 * interval, since funding settles milliseconds after the hour). `from` is the fingerprint's own
 * window, else the run's written window. null = cannot tell (no fingerprint, no from).
 */
export function truncated(fp: Fingerprint | null, runFrom?: unknown, pinned: ReadonlySet<string> | null = null): boolean | null {
  if (!fp) return null
  const isPinned = (i: FpInput) => !!i.pin || !!pinned?.has(i.sha256)
  if (fp.inputs.some(i => !isPinned(i) && i.trunc === true)) return true
  const from = fp.window?.from ?? isoMs(runFrom)
  if (from === null) return null
  return fp.inputs.some(i => {
    // a pinned input: the rows the result used ARE the pin, so its head is its first row
    const first = isPinned(i) ? i.first_ts : i.stored_first ?? i.first_ts
    return first === null || first > from + tolerance(i.interval)
  })
}

/** how many of a fingerprint's inputs are pinned (their rows kept past any eviction). null = no
 *  fingerprint; `known` false = the pin index could not be read, so only pins the rows carry count */
export type PinCount = { pinned: number; of: number; known: boolean }
export function pinCount(fp: Fingerprint | null, pinned: ReadonlySet<string> | null): PinCount | null {
  if (!fp || !fp.inputs.length) return null
  return { pinned: fp.inputs.filter(i => !!i.pin || !!pinned?.has(i.sha256)).length, of: fp.inputs.length, known: pinned !== null }
}

/** for each keyed fingerprint, the OTHER keys whose window it shares */
export function chains(items: { key: string; fp: Fingerprint | null }[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const a of items) out.set(a.key, [])
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j]
    if (sameWindow(a.fp, b.fp)) { out.get(a.key)!.push(b.key); out.get(b.key)!.push(a.key) }
  }
  return out
}
