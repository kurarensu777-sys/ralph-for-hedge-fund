import { HttpError } from '../http.ts'
import { publish } from '../events.ts'
import { logEvent } from '../db.ts'
import { ACTOR, Refused, Unavailable, run, storeDoor } from './job.ts'
import {
  PlanBook, RETENTION_KINDS, normPhrase, retentionId, retentionPhrase,
  type RetentionItem, type RetentionKind,
} from './plans.ts'

// ROOM: data - the lake's archive as the data layer reports it: its space and the ops store's
// (`python -m fund_db usage --json`) and retention (`fund_db tier|prune --json`: a dry run held
// here, the phrase typed, then a second dry run that must match). Every read and every move is a
// child process (./job.ts). A door that is not there answers {available: false, reason} - the room
// says NOT AVAILABLE, never a zero.

export type NotAvailable = { available: false; reason: string; read_ms: number }
const na = (e: unknown): NotAvailable => ({ available: false, reason: (e as Error).message, read_ms: Date.now() })

/** a read that turns a missing door into {available:false}; any other failure stays an HTTP error */
async function read<T>(f: () => Promise<T>): Promise<(T & { available: true }) | NotAvailable> {
  try { return { ...(await f()), available: true } }
  catch (e) { if (e instanceof Unavailable) return na(e); throw e }
}

// ---- a small cache: one run per key per ttl, concurrent asks share it, a failure is not kept ----
function cached<T>(ttl: number) {
  const hit = new Map<string, { at: number; p: Promise<T> }>()
  return {
    get(key: string, fresh: boolean, f: () => Promise<T>): Promise<T> {
      const h = hit.get(key)
      if (h && !fresh && Date.now() - h.at < ttl) return h.p
      const p = f()
      hit.set(key, { at: Date.now(), p })
      p.catch(() => { if (hit.get(key)?.p === p) hit.delete(key) })
      return p
    },
    clear() { hit.clear() },
  }
}

const usageCache = cached<any>(60_000)

// ---- reads ----

export const usage = (fresh = false) => read(async () => ({ ...(await usageCache.get('usage', fresh, () => run(storeDoor(), ['usage', '--json'], undefined, 300_000))), read_ms: Date.now() }))

// ---- retention: fund_db tier / prune, dry run then the typed phrase ----

type RetentionHeld = { kind: RetentionKind; dataset: string | null; items: RetentionItem[]; id: string }
const moves = new PlanBook<RetentionHeld>()
const RETENTION_TTL = 10 * 60_000

function retentionArgs(body: any): { kind: RetentionKind; dataset: string | null } {
  const kind = body?.kind
  if (!(RETENTION_KINDS as readonly unknown[]).includes(kind)) throw new HttpError(400, `kind: one of ${RETENTION_KINDS.join(', ')}`)
  const ds = body?.dataset == null || body.dataset === '' ? null : String(body.dataset)
  if (ds !== null && !/^[a-z_]{1,32}$/.test(ds)) throw new HttpError(400, 'dataset: a lake dataset name')
  return { kind, dataset: ds }
}

async function dryRun(kind: RetentionKind, dataset: string | null): Promise<RetentionItem[]> {
  const r = await run(storeDoor(), [kind, ...(dataset ? ['--dataset', dataset] : []), '--json'], undefined, 300_000)
  if (!Array.isArray(r.items)) throw new HttpError(502, `fund_db ${kind} --json returned no items list`)
  return r.items.map((i: any) => ({ dataset: i.dataset, from: String(i.from), to: String(i.to), bytes: Number(i.bytes) || 0 }))
}

export async function retentionPlan(body: any) {
  const { kind, dataset } = retentionArgs(body)
  return read(async () => {
    const items = await dryRun(kind, dataset)
    const expires = Date.now() + RETENTION_TTL
    const id = retentionId(kind, dataset, items)
    return {
      kind, dataset, items, expires_ms: expires,
      totals: { partitions: items.length, bytes: items.reduce((n, i) => n + i.bytes, 0) },
      key: items.length ? moves.put({ kind, dataset, items, id }, expires) : null,
      phrase: items.length ? retentionPhrase(kind, dataset, items) : null,
    }
  })
}

export async function retentionApply(body: any) {
  const held = moves.get(String(body?.key ?? ''))
  if (!held) throw new HttpError(409, 'this plan is not held here (expired, already applied, or fundd restarted): plan again')
  if (normPhrase(body?.phrase) !== retentionPhrase(held.kind, held.dataset, held.items).toLowerCase()) throw new HttpError(400, 'the typed phrase does not match the plan')
  return read(async () => {
    const now = await dryRun(held.kind, held.dataset)
    if (retentionId(held.kind, held.dataset, now) !== held.id) throw new HttpError(409, 'the lake changed since the plan (a partition moved, grew or aged into the rule): plan again')
    moves.drop(String(body.key))
    const t0 = Date.now()
    const record = async (moved: RetentionItem[], error?: string) => {
      const bytes = moved.reduce((n, i) => n + (Number(i.bytes) || 0), 0)
      await logEvent('job', `${held.kind} ${moved.length} lake partition(s) (${(bytes / 1e6).toFixed(1)} MB, ${held.dataset ?? 'all'})${error ? ` then stopped: ${error}` : ''}`,
        { payload: { actor: ACTOR, kind: held.kind, dataset: held.dataset, partitions: moved.length, bytes, seconds: (Date.now() - t0) / 1000, ...(error ? { error } : {}) } })
      return bytes
    }
    try {
      const r = await run(storeDoor(), [held.kind, ...(held.dataset ? ['--dataset', held.dataset] : []), '--apply', '--json'], undefined, 60 * 60_000)
      const moved: RetentionItem[] = Array.isArray(r.items) ? r.items : []
      const bytes = await record(moved)
      return { kind: held.kind, dataset: held.dataset, moved, partitions: moved.length, bytes }
    } catch (e) {
      // an apply that stopped part-way still lists what already moved (B-0292): say so, never "nothing moved"
      const moved: RetentionItem[] = e instanceof Refused && Array.isArray(e.reply?.items) ? e.reply.items : []
      if (!moved.length) throw e
      const bytes = await record(moved, (e as Error).message)
      throw new HttpError(500, `${(e as Error).message} - ${moved.length} partition(s) (${(bytes / 1e6).toFixed(1)} MB) had already moved: ${moved.map(i => i.from).join(', ').slice(0, 400)}`)
    } finally { usageCache.clear(); publish('data') }
  })
}
