/**
 * One throwaway PostgreSQL cluster for a test file: its own data root in a temp folder, its own free
 * port, the real portable binaries (FUND_PG_BIN, else ~/fund-data/db/pgsql/bin), trust on 127.0.0.1
 * only. Nothing here touches ~/fund-data/db. Without the binaries, `PG_SKIP` is the reason every
 * database test skips (and says so) rather than passes.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

export const PG_BIN = process.env.FUND_PG_BIN || join(homedir(), 'fund-data', 'db', 'pgsql', 'bin')
const EXE = process.platform === 'win32' ? '.exe' : ''
const bin = (n: string) => join(PG_BIN, n + EXE)

/** false when the binaries are here; else the skip message */
export const PG_SKIP: string | false = existsSync(bin('initdb')) && existsSync(bin('pg_ctl'))
  ? false : `no PostgreSQL binaries at ${PG_BIN} (set FUND_PG_BIN): database tests cannot run`

function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = createServer()
    s.once('error', bad)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)) })
  })
}

/** run a binary with its output going to a FILE, never a pipe: on Windows postgres inherits
 *  pg_ctl's handles, and a pipe it holds open would hang the caller until the server exits */
function run(root: string, argv: string[], check = true): { code: number; text: string } {
  const out = join(root, 'cmd.out')
  const fd = openSync(out, 'w')
  let code: number
  try {
    code = spawnSync(argv[0], argv.slice(1), { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 120_000 }).status ?? -1
  } finally { closeSync(fd) }
  const text = readFileSync(out, 'utf8')
  if (check && code !== 0) throw new Error(`${argv[0]} exited ${code}: ${text.slice(-800)}`)
  return { code, text }
}

export interface Cluster {
  port: number
  root: string
  /** the libpq conninfo for one database of this cluster */
  dsn(database: string): string
  conn(database: string): { host: string; port: number; user: string; database: string }
  createDb(name: string, template?: string): Promise<void>
  sql(database: string, text: string, values?: unknown[]): Promise<pg.QueryResult>
  stop(): void
}

export async function startCluster(): Promise<Cluster> {
  const root = mkdtempSync(join(tmpdir(), 'fund_db_node_test_'))
  const pgdata = join(root, 'pgdata')
  const port = await freePort()
  const base = [bin('initdb'), '-D', pgdata, '-U', 'fund', '--auth=trust', '-E', 'UTF8']
  if (run(root, [...base, '--locale=C', '--locale-provider=builtin', '--builtin-locale=C.UTF-8'], false).code !== 0) {
    rmSync(pgdata, { recursive: true, force: true })
    run(root, [...base, '--no-locale'])
  }
  writeFileSync(join(pgdata, 'pg_hba.conf'), 'host all all 127.0.0.1/32 trust\n')
  appendFileSync(join(pgdata, 'postgresql.conf'),
    `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\nmax_connections = 40\ntimezone = 'UTC'\nfsync = off\n`)
  run(root, [bin('pg_ctl'), 'start', '-D', pgdata, '-l', join(root, 'postgres.log'), '-w', '-t', '60'])
  const conn = (database: string) => ({ host: '127.0.0.1', port, user: 'fund', database })
  const sql = async (database: string, text: string, values: unknown[] = []) => {
    const c = new pg.Client(conn(database))
    await c.connect()
    try { return await c.query(text, values) } finally { await c.end() }
  }
  return {
    port, root, conn, sql,
    dsn: (database: string) => `host=127.0.0.1 port=${port} user=fund dbname=${database}`,
    createDb: async (name: string, template?: string) => {
      await sql('postgres', `CREATE DATABASE ${name}${template ? ` TEMPLATE ${template}` : ''}`)
    },
    stop: () => {
      try { run(root, [bin('pg_ctl'), 'stop', '-D', pgdata, '-m', 'fast', '-w', '-t', '60'], false) }
      finally { rmSync(root, { recursive: true, force: true }) }
    },
  }
}
