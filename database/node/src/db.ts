/**
 * Connections to the ops store. One pool per conninfo, created on first use.
 *
 *   await query('SELECT ...', [a, b])            rows as objects
 *   await transaction(async c => { ... })         several ops calls as one transaction
 *
 * Every ops function takes an optional last `q` argument (a pool or a transaction client). Types
 * come back as fund_db returns them: bigint (epoch ms, ids) as number, jsonb as objects, boolean.
 */
import pg from 'pg'
import { connInfo, type ConnInfo } from './config.ts'

const { Pool, types } = pg

/** int8 as number: every bigint here is epoch ms, an id or a count, all well under 2^53 */
const parsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === types.builtins.INT8) return (v: string) => (v === null ? null : Number(v))
    return types.getTypeParser(oid, format as 'text')
  },
} as unknown as pg.CustomTypesConfig

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient

const pools = new Map<string, pg.Pool>()

export function poolFor(ci: ConnInfo = connInfo()): pg.Pool {
  const key = `${ci.host}:${ci.port}/${ci.database}@${ci.user}`
  let p = pools.get(key)
  if (!p) {
    p = new Pool({ ...ci, types: parsers, max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
      application_name: 'fund_db.node' })
    p.on('error', () => { /* an idle client died (server restart); the pool replaces it */ })
    pools.set(key, p)
  }
  return p
}

/** the default pool (config.connInfo()) */
export const pool = (): pg.Pool => poolFor()

export async function query<T = Record<string, unknown>>(text: string, values: unknown[] = [], q?: Queryable): Promise<T[]> {
  const r = await (q ?? pool()).query(text, values)
  return r.rows as T[]
}

export async function one<T = Record<string, unknown>>(text: string, values: unknown[] = [], q?: Queryable): Promise<T | null> {
  return (await query<T>(text, values, q))[0] ?? null
}

export async function exec(text: string, values: unknown[] = [], q?: Queryable): Promise<number> {
  const r = await (q ?? pool()).query(text, values)
  return r.rowCount ?? 0
}

/** run fn inside one transaction; committed when it resolves, rolled back when it throws. Given a
 *  client already in a transaction (q), it nests as a SAVEPOINT. */
export async function transaction<T>(fn: (c: pg.PoolClient) => Promise<T>, q?: Queryable): Promise<T> {
  if (q && 'release' in q) {
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
    await q.query(`SAVEPOINT ${sp}`)
    try { const r = await fn(q); await q.query(`RELEASE SAVEPOINT ${sp}`); return r }
    catch (e) { await q.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e }
  }
  const c = await (q && 'connect' in q ? (q as pg.Pool) : pool()).connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

/** one round trip to the store; resolves when it answers, rejects with the driver's error */
export async function ping(q?: Queryable): Promise<void> {
  await (q ?? pool()).query('SELECT 1')
}

export async function closeAll(): Promise<void> {
  const ps = [...pools.values()]
  pools.clear()
  await Promise.all(ps.map(p => p.end()))
}
