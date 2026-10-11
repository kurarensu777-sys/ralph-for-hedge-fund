import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * @fund/db backup - the node twin of fund_db.backup (moved here from the cockpit's
 * server/system/backup.ts, app df47855, 2026-09-25: the data layer backs up its own database; the
 * cockpit only shows the list and offers "back up now"). The nightly job is the python CLI,
 * `python -m fund_db backup`; both write the same files, named and checked the same way.
 *
 * NIGHTLY BACKUP of the cockpit's store - the WHOLE ops database in PostgreSQL: schema `ops`, the
 * lake's catalog (`market`) and the migration ledger (public.fund_migrations, without which a
 * restored copy would re-run every migration) - as ONE pg_dump custom-format archive per local day:
 * <dir>/ops-YYYY-MM-DD.dump, the newest `keep` kept. pg_dump reads one consistent snapshot while
 * fundd writes. Every archive is written to a .part file, checked with `pg_restore --list` (it must
 * list the table data of every table the dump says it holds), and only then renamed into place, so
 * a half-written file never counts as a backup. The binaries are the cluster's own
 * (<FUND_DB_DIR or ~/fund-data/db>/pgsql/bin, FUND_PG_BIN overrides), so the versions always match.
 * Backups of the retired SQLite store (cockpit-YYYY-MM-DD.db) are left where they are, untouched.
 * The backup dir: FUND_DB_BACKUP_DIR, else ~/fund-data/backups/db (backupDir()).
 */

export const BACKUP_KEEP = 14
const NAME = /^ops-(\d{4}-\d{2}-\d{2})\.dump$/

export type BackupFile = { file: string; day: string; bytes: number; mtime: number }
export type BackupResult = { file: string; path: string; bytes: number; method: 'pg_dump'; check: string; tables: number; pruned: string[]; tookMs: number }
export type Conn = { host: string; port: number; user: string; database: string }

/** the owner's local day, YYYY-MM-DD (the scheduler's cadences are local time too) */
export function localDay(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const backupName = (t: number) => `ops-${localDay(t)}.dump`

/** where the archives go: FUND_DB_BACKUP_DIR, else ~/fund-data/backups/db (fund_db.backup.backup_dir) */
export function backupDir(): string {
  return process.env.FUND_DB_BACKUP_DIR || join(homedir(), 'fund-data', 'backups', 'db')
}

/** where pg_dump / pg_restore live: FUND_PG_BIN, else the portable cluster's bin folder */
export function pgBin(): string {
  const root = process.env.FUND_DB_DIR ?? join(homedir(), 'fund-data', 'db')
  return process.env.FUND_PG_BIN || join(root, 'pgsql', 'bin')
}
const exe = (bin: string, name: string) => join(bin, name + (process.platform === 'win32' ? '.exe' : ''))

/** every backup in `dir`, newest day first; anything not named ops-YYYY-MM-DD.dump is ignored */
export function listBackups(dir: string = backupDir()): BackupFile[] {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return [] }
  const out: BackupFile[] = []
  for (const f of names) {
    const m = NAME.exec(f)
    if (!m) continue
    try { const s = statSync(join(dir, f)); out.push({ file: f, day: m[1], bytes: s.size, mtime: s.mtimeMs }) } catch { /* raced a prune */ }
  }
  return out.sort((a, b) => b.day.localeCompare(a.day))
}

/** which files a keep-N prune removes: everything past the newest `keep` days */
export function toPrune(files: { file: string; day: string }[], keep: number): string[] {
  return [...files].sort((a, b) => b.day.localeCompare(a.day)).slice(Math.max(0, keep)).map(f => f.file)
}

/** run a binary to completion; stdout kept, stderr's tail on failure */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(res => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const t = setTimeout(() => { err += `\ntimed out after ${timeoutMs} ms`; p.kill() }, timeoutMs)
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', e => { clearTimeout(t); res({ code: null, out, err: `${err}\n${e.message}` }) })
    p.on('close', code => { clearTimeout(t); res({ code, out, err }) })
  })
}

/** from `pg_restore --list`: how many TABLE DATA entries, and the tables they cover */
export function listedTables(list: string): { data: number; tables: number } {
  let data = 0, tables = 0
  for (const line of list.split(/\r?\n/)) {
    if (line.startsWith(';') || !line.trim()) continue
    if (/\bTABLE DATA\b/.test(line)) data++
    else if (/\bTABLE\b/.test(line) && !/\bTABLE DATA\b/.test(line)) tables++
  }
  return { data, tables }
}

export async function backupDb(opts: { conn: Conn; dir?: string; now?: number; keep?: number; bin?: string; timeoutMs?: number }): Promise<BackupResult> {
  const t0 = Date.now()
  const now = opts.now ?? t0
  const keep = opts.keep ?? BACKUP_KEEP
  const bin = opts.bin ?? pgBin()
  const timeoutMs = opts.timeoutMs ?? 600_000
  if (!existsSync(exe(bin, 'pg_dump'))) throw new Error(`no pg_dump at ${bin} (set FUND_PG_BIN, or run database\\scripts\\pg.py ensure)`)
  const dir = opts.dir ?? backupDir()
  mkdirSync(dir, { recursive: true })
  const file = backupName(now)
  const path = join(dir, file)
  const part = `${path}.part`
  rmSync(part, { force: true })

  const c = opts.conn
  const dump = await run(exe(bin, 'pg_dump'), ['-h', c.host, '-p', String(c.port), '-U', c.user, '-d', c.database, '-w',
    '-Fc', '-Z', '6', '-f', part], timeoutMs)
  if (dump.code !== 0) { rmSync(part, { force: true }); throw new Error(`pg_dump exited ${dump.code}: ${dump.err.trim().slice(-400)}`) }

  // the check: pg_restore must read the whole table of contents, with data for every table in it
  const list = await run(exe(bin, 'pg_restore'), ['--list', part], 120_000)
  const got = listedTables(list.out)
  const check = list.code !== 0 ? `pg_restore --list exited ${list.code}: ${list.err.trim().slice(-200)}`
    : got.tables === 0 ? 'no tables in the archive'
    : got.data < got.tables ? `${got.tables} tables but data for ${got.data}`
    : 'ok'
  if (check !== 'ok') { rmSync(part, { force: true }); throw new Error(`check on the archive: ${check}`) }

  rmSync(path, { force: true })            // today's earlier copy, if any: the newer one wins
  renameSync(part, path)
  const pruned = toPrune(listBackups(dir), keep)
  for (const f of pruned) rmSync(join(dir, f), { force: true })
  return { file, path, bytes: statSync(path).size, method: 'pg_dump', check, tables: got.tables, pruned, tookMs: Date.now() - t0 }
}

/** the reading the System room shows: ok when today's or yesterday's copy exists, warn when older */
export function backupStatus(files: BackupFile[], now: number): { status: 'ok' | 'warn' | 'unknown'; reading: string } {
  if (!files.length) return { status: 'unknown', reading: 'no backup yet' }
  const newest = files[0]
  const ageH = (now - newest.mtime) / 3_600_000
  const mb = (newest.bytes / 1048576).toFixed(1)
  return { status: ageH <= 36 ? 'ok' : 'warn', reading: `${files.length} kept · ${newest.day} · ${mb} MB` }
}
