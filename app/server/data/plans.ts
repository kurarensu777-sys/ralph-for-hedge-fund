import { createHash } from 'node:crypto'

// The DATA room's pure half: the typed phrases and the plan book. Every plan the room shows is HELD
// HERE, server-side, under a key: an apply names the key and the phrase the owner typed, never the
// plan itself, so nothing the browser holds decides what moves. Tests: test/data.test.ts.

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)

/** a typed phrase as compared: whitespace collapsed, case folded */
export const normPhrase = (s: unknown) => String(s ?? '').split(/\s+/).filter(Boolean).join(' ').toLowerCase()

// ---- retention (fund_db tier / prune) ----

export const RETENTION_KINDS = ['tier', 'prune'] as const
export type RetentionKind = typeof RETENTION_KINDS[number]
export type RetentionItem = { dataset?: string; from: string; to: string; bytes: number }

/** the items in one canonical order, so two dry runs compare as strings */
export function retentionId(kind: string, dataset: string | null, items: RetentionItem[]): string {
  const canon = [...items].map(i => ({ dataset: i.dataset ?? null, from: i.from, to: i.to, bytes: int(i.bytes) })).sort((a, b) => a.from.localeCompare(b.from))
  return createHash('sha256').update(JSON.stringify({ kind, dataset, items: canon })).digest('hex').slice(0, 32)
}

/** what the owner types for a move: the terminal's words, from the plan's own totals */
export function retentionPhrase(kind: string, dataset: string | null, items: RetentionItem[]): string {
  const mb = items.reduce((n, i) => n + int(i.bytes), 0) / 1e6
  return `${kind} ${items.length} partitions ${mb.toFixed(1)} MB ${dataset ?? 'all'}`
}

// ---- the plan book ----

/** plans held server-side for their life. A fundd restart forgets them all: plan again */
export class PlanBook<T> {
  private held = new Map<string, { at: number; expires: number; plan: T }>()
  constructor(private max = 32, private clock = () => Date.now()) {}
  put(plan: T, expiresMs: number): string {
    const key = createHash('sha256').update(`${this.clock()}|${Math.random()}|${JSON.stringify(plan).length}`).digest('hex').slice(0, 20)
    this.held.set(key, { at: this.clock(), expires: expiresMs, plan })
    while (this.held.size > this.max) this.held.delete(this.held.keys().next().value!)
    return key
  }
  /** the held plan, or null when unknown or expired (an expired plan is dropped) */
  get(key: unknown): T | null {
    if (typeof key !== 'string') return null
    const h = this.held.get(key)
    if (!h) return null
    if (this.clock() > h.expires) { this.held.delete(key); return null }
    return h.plan
  }
  drop(key: string) { this.held.delete(key) }
}
