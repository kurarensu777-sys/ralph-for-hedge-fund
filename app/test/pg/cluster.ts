/**
 * The test run's PostgreSQL: ONE throwaway cluster per `vitest run` (its own data folder in the temp
 * dir, its own free port on 127.0.0.1, trust auth on 127.0.0.1 only), built from the portable
 * binaries the live cluster uses (FUND_PG_BIN, else <FUND_DB_DIR or ~/fund-data/db>/pgsql/bin). The
 * live cluster and its data are never touched. Each test FILE then gets its own database, cloned
 * from a migrated template (setup.ts), so files run in parallel without seeing each other's rows.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const PG_BIN = process.env.FUND_PG_BIN || join(process.env.FUND_DB_DIR ?? join(homedir(), 'fund-data', 'db'), 'pgsql', 'bin')
const EXE = process.platform === 'win32' ? '.exe' : ''
export const pgExe = (name: string) => join(PG_BIN, name + EXE)

/** why the store tests cannot run here, or null when the binaries are present */
export const missing = (): string | null => existsSync(pgExe('initdb')) && existsSync(pgExe('pg_ctl'))
  ? null
  : `no PostgreSQL binaries at ${PG_BIN}: run \`.venv\\Scripts\\python.exe database\\scripts\\pg.py ensure\` from the fund root, or set FUND_PG_BIN`

export function freePort(): Promise<number> {
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

export type Cluster = { root: string; port: number; stop(): void }

export async function startCluster(): Promise<Cluster> {
  const why = missing()
  if (why) throw new Error(why)
  const root = mkdtempSync(join(tmpdir(), 'fund-app-pg-'))
  const pgdata = join(root, 'pgdata')
  const port = await freePort()
  // --no-sync: a throwaway cluster never needs initdb's fsync pass (most of its time on Windows)
  const base = [pgExe('initdb'), '-D', pgdata, '-U', 'fund', '--auth=trust', '-E', 'UTF8', '--no-sync']
  if (run(root, [...base, '--locale=C', '--locale-provider=builtin', '--builtin-locale=C.UTF-8'], false).code !== 0) {
    rmSync(pgdata, { recursive: true, force: true })
    run(root, [...base, '--no-locale'])
  }
  writeFileSync(join(pgdata, 'pg_hba.conf'), 'host all all 127.0.0.1/32 trust\n')
  appendFileSync(join(pgdata, 'postgresql.conf'),
    `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\nmax_connections = 300\ntimezone = 'UTC'\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n`)
  run(root, [pgExe('pg_ctl'), 'start', '-D', pgdata, '-l', join(root, 'postgres.log'), '-w', '-t', '60'])
  return {
    root, port,
    stop: () => {
      try { run(root, [pgExe('pg_ctl'), 'stop', '-D', pgdata, '-m', 'fast', '-w', '-t', '60'], false) }
      finally { rmSync(root, { recursive: true, force: true }) }
    },
  }
}

export const TEMPLATE = 'fund_tpl'
export const conninfo = (port: number, database: string) => `host=127.0.0.1 port=${port} user=fund dbname=${database}`
