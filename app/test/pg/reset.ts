/**
 * Empty every ops table of THIS test file's database (test/pg/setup.ts made it; nothing else can
 * reach it), identities restarted: the fresh store a suite that wants one per test used to get from
 * `new DatabaseSync(':memory:')`. The schema and its migration ledger stay as they are.
 */
import { query } from '@fund/db'
import { settled } from '../../server/db.ts'

export async function resetStore(): Promise<void> {
  if (!/dbname=t_/.test(process.env.FUND_DB_DSN ?? '')) throw new Error('resetStore runs only on a test database (test/pg/setup.ts)')
  await settled()
  const tables = await query<{ t: string }>("SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables WHERE schemaname = 'ops'")
  if (tables.length) await query(`TRUNCATE ${tables.map(x => x.t).join(', ')} RESTART IDENTITY`)
}
