/**
 * vitest setupFiles: before a test file loads, FUND_DB_DSN points @fund/db (and so server/db.ts) at
 * a database of the run's throwaway cluster (global.ts) that holds NOTHING: every ops table empty,
 * identities restarted. Nothing here reaches the live cluster.
 *
 * One database per worker SLOT (VITEST_POOL_ID), not per file: a slot runs its files one after
 * another, so a file owns its slot's database while it runs and empties it first. Cloning the
 * migrated template costs ~2.5 s on Windows (measured 2026-09-25), so it happens once per slot,
 * the first time the slot is used, one clone at a time (two CREATE DATABASE ... TEMPLATE at the
 * same instant refuse each other).
 */
import { afterAll, inject } from 'vitest'
import { closeAll, poolFor } from '@fund/db'
import { TEMPLATE, conninfo } from './cluster.ts'

const port = inject('pgPort')
if (!port) throw new Error('no test PostgreSQL: test/pg/global.ts did not run (vitest.config.ts globalSetup)')

const slot = String(process.env.VITEST_POOL_ID ?? '0').replace(/\D/g, '') || '0'
export const TEST_DB = `t_slot_${slot}`
const CLONE_LOCK = 714_600_000_099

const admin = await poolFor({ host: '127.0.0.1', port, user: 'fund', database: 'postgres' }).connect()
try {
  await admin.query('SELECT pg_advisory_lock($1)', [CLONE_LOCK])
  try {
    const have = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB])).rowCount
    if (!have) await admin.query(`CREATE DATABASE ${TEST_DB} TEMPLATE ${TEMPLATE}`)
  } finally { await admin.query('SELECT pg_advisory_unlock($1)', [CLONE_LOCK]) }
} finally { admin.release() }
process.env.FUND_DB_DSN = conninfo(port, TEST_DB)

// the previous file of this slot left its rows: this file starts from an empty store
const own = await poolFor({ host: '127.0.0.1', port, user: 'fund', database: TEST_DB }).connect()
try {
  const tables = (await own.query("SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables WHERE schemaname = 'ops'")).rows.map(r => r.t)
  if (tables.length) await own.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY`)
} finally { own.release() }

afterAll(async () => { await closeAll() })
