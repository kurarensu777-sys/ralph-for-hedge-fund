import { closeAll, connInfo, dsn, migrate as applyMigrations, ops, ping, pool, transaction, type ConnInfo, type Queryable } from '@fund/db'
import * as fundDb from '@fund/db'

/**
 * The cockpit's store: what HAPPENED (conversations index, events, usage, presence, health
 * readings, job runs, processes, reads, commits, the loop's grades and queues). What was DECIDED
 * stays in git as files. Since 2026-09-25 it is the fund's ONE ops store - PostgreSQL on
 * 127.0.0.1, schema `ops` - reached only through `@fund/db` (database/node) and its typed functions
 * `ops.*`: the SQL of the ops store is written in database/, never here (a read the cockpit needs
 * that no function answers is a new @fund/db function there, with its python twin and a test;
 * tools/tests/test_layering.py refuses a raw door or SQL text in server/, src/, shared/, scripts/). The
 * schema and its migrations belong to database/ (migrations/ops/NNN_*.sql); fundd applies pending
 * ones at start through the same runner, ledger and lock as `python -m fund_db migrate`.
 *
 * node-postgres is asynchronous, so a write made from a synchronous place (an SDK stream event, a
 * timer) goes through `later()`: ONE queue, in call order, never rejecting (a failed record is
 * logged, never thrown into the caller), and `settled()` waits for it - a reader that must see
 * those writes (the conversation list after a state flip, a test) awaits it first.
 */
export { closeAll, ops, transaction, type Queryable }

/** @fund/db's read-only market namespace (the cache's usage, the pins, the pacer: database B-0324),
 *  or null while the package does not export it yet. A room asks for ONE function by name
 *  (marketFn('cacheUsage')) and says NOT AVAILABLE when it is missing, never a zero */
export function marketFn<F extends (...a: any[]) => Promise<any>>(name: string): F | null {
  const m = (fundDb as unknown as Record<string, unknown>).market as Record<string, unknown> | undefined
  const f = m?.[name]
  return typeof f === 'function' ? (f as F) : null
}

export const now = () => Date.now()

/** the store every call defaults to (a lazy handle: the pool is resolved at the first query, so a
 *  test that sets FUND_DB_DSN before importing gets its own database) */
export const db: Queryable = { query: ((text: string, values?: unknown[]) => pool().query(text, values)) as Queryable['query'] }

// ---- the write queue

let chain: Promise<unknown> = Promise.resolve()
let failures = 0

/** queue `fn` behind every write queued before it; resolves to its result, or undefined when it
 *  failed (logged under `what`). Never rejects. */
export function later<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  const p = chain.then(fn).catch((e: unknown) => {
    failures++
    console.error(`[db] ${what}: ${(e as Error)?.message ?? e}`)
    return undefined
  })
  chain = p
  return p
}

/** resolves once every write queued so far (and any queued while waiting) has finished */
export async function settled(): Promise<void> {
  let c: Promise<unknown>
  do { c = chain; await c } while (c !== chain)
}

/** queued writes that failed since this process started (the system room shows it) */
export const writeFailures = () => failures

/** append one row to the events log (the activity feed of the whole cockpit). Queued: callable
 *  from anywhere, in order, never throws; await it (or settled()) to read it back. */
export function logEvent(kind: string, summary: string, extra: { agent?: string; conversation?: string; payload?: unknown } = {}): Promise<number | undefined> {
  const ts = now()
  return later(`event ${kind}`, () => ops.logEvent(kind, summary, { agent: extra.agent ?? null, conversation: extra.conversation ?? null, payload: extra.payload, ts }))
}

// ---- start: reach the store, then bring its schema current

/** where the store is, for messages and the system room (never a password: trust auth on 127.0.0.1) */
export const where = (): ConnInfo => connInfo()
export const whereText = (): string => dsn()

export class StoreDown extends Error {}

/** one round trip; a StoreDown naming the address and the command that brings it up when it fails */
export async function reach(timeoutMs = 5_000): Promise<void> {
  const ci = connInfo()
  try {
    await Promise.race([
      ping(),
      new Promise((_, bad) => setTimeout(() => bad(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs).unref()),
    ])
  } catch (e) {
    throw new StoreDown(`the ops store (PostgreSQL) is not reachable at ${ci.host}:${ci.port} database ${ci.database} as ${ci.user}: ` +
      `${(e as Error)?.message || String(e)}. Bring it up from the fund root with: ` +
      `.venv\\Scripts\\python.exe database\\scripts\\pg.py ensure   (start.bat does this before the cockpit)`)
  }
}

/** apply database/'s pending migrations (the shared ledger and advisory lock); returns what ran */
export async function migrate(log: (s: string) => void = s => console.log(s)): Promise<string[]> {
  return applyMigrations({ log })
}
