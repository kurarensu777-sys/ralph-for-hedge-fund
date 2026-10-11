/**
 * @fund/db - the fund's data layer for node (the cockpit). The contract is database/CLAUDE.md.
 *
 *   import { ops, migrate, transaction } from '@fund/db'
 *   await migrate()                                   // apply pending migrations (same files, ledger and lock as fund_db)
 *   await ops.logEvent('job', 'nightly ok')
 *   await transaction(async c => { await ops.addUsage(id, agent, { tokensIn: 5 }, c) })
 *
 * The market lake (Parquet + DuckDB) is python-side (fund_db.market); node reads the ops store and
 * the market catalog (schema market) only - and, read-only, the storage classes' records:
 *   await market.cacheUsage(); await market.pins({ ref }); await market.pacerStatus()
 */
export * as ops from './ops.ts'
export * as market from './market.ts'
export { closeAll, exec, one, ping, pool, poolFor, query, transaction, type Queryable } from './db.ts'
export { connInfo, dataDir, dsn, migrationsDir, parseConninfo, type ConnInfo } from './config.ts'
export {
  discover, LEDGER, migrate, MigrationError, plan as migrationPlan, status as migrationStatus, type Migration, type Plan,
} from './migrate.ts'
export * from './rows.ts'
export {
  BACKUP_KEEP, backupDb, backupDir, backupName, backupStatus, listBackups, listedTables, localDay, pgBin, toPrune,
  type BackupFile, type BackupResult, type Conn as BackupConn,
} from './backup.ts'
