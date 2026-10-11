import { marketFn } from '../db.ts'

/**
 * The pin index as the Lab reads it: the set of content hashes database holds (B-0324, @fund/db
 * market.pins). A pin's hash IS a fingerprint input's sha256, so a run's input is pinned when its
 * sha256 is in this set, whether the loop pinned it at record time or the backfill pinned it later.
 * Read at most once a minute, in the background; null until the first read and while the package
 * has no pins yet, so the room never calls an input unpinned that it could not look up.
 */

let hashes: Set<string> | null = null
let why: string | null = 'not read yet'
let at = 0
let running: Promise<void> | null = null

export function refreshPins(force = false): Promise<void> {
  if (running) return running
  if (!force && Date.now() - at < 60_000) return Promise.resolve()
  const f = marketFn<(o: Record<string, unknown>) => Promise<unknown>>('pins')
  running = (f ? f({}) : Promise.resolve(null))
    .then(rows => {
      if (rows === null) { hashes = null; why = 'the pin index is not built yet (B-0324)'; return }
      const list = Array.isArray(rows) ? rows : []
      hashes = new Set(list.map((r: any) => r?.hash).filter((h: unknown): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)))
      why = null
    })
    .catch(e => { hashes = null; why = `the pin index did not answer: ${String((e as Error)?.message ?? e).slice(0, 200)}` })
    .finally(() => { at = Date.now(); running = null })
  return running
}

/** the pinned hashes as last read (null = unknown: not built, not read or failed, `pinsWhy()` says which) */
export const pinnedHashes = (): ReadonlySet<string> | null => hashes
export const pinsWhy = (): string | null => why
