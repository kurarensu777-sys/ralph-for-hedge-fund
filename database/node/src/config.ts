/**
 * Where the ops store is, resolved EXACTLY as fund_db.config does (tests/test_contract.py checks):
 * FUND_DB_DSN (a libpq keyword conninfo, `host=... port=... user=... dbname=...`) wins; else
 * host 127.0.0.1 with port/user/database from <data root>/pg.json, where the data root is
 * FUND_DB_DIR or ~/fund-data/db; FUND_DB_PORT overrides the port. Never a password.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOST = '127.0.0.1'
export const DEFAULTS = { port: 5432, user: 'fund', database: 'fund' }

export interface ConnInfo { host: string; port: number; user: string; database: string }

export function dataDir(): string {
  const env = process.env.FUND_DB_DIR
  return env ? resolve(env) : join(homedir(), 'fund-data', 'db')
}

/** the database repo root (this file is database/node/src/config.ts) */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function migrationsDir(): string {
  return process.env.FUND_DB_MIGRATIONS ?? join(REPO_ROOT, 'migrations')
}

export function settings(): { port: number; user: string; database: string } {
  const s = { ...DEFAULTS }
  const p = join(dataDir(), 'pg.json')
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
      if (typeof j.port === 'number') s.port = j.port
      if (typeof j.user === 'string') s.user = j.user
      if (typeof j.database === 'string') s.database = j.database
    } catch { /* a broken pg.json falls back to the defaults, as in python */ }
  }
  if (process.env.FUND_DB_PORT) s.port = Number(process.env.FUND_DB_PORT)
  return s
}

/** parse a libpq keyword conninfo (`k=v k='v w'`) into its pairs */
export function parseConninfo(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(\w+)\s*=\s*(?:'((?:\\.|[^'\\])*)'|(\S+))/g
  for (const m of s.matchAll(re)) out[m[1]] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]
  return out
}

export function connInfo(database?: string): ConnInfo {
  const env = process.env.FUND_DB_DSN
  if (env) {
    const kv = parseConninfo(env)
    if ('password' in kv) throw new Error('FUND_DB_DSN carries a password; the ops store is trust-auth on 127.0.0.1 only')
    return {
      host: kv.host ?? kv.hostaddr ?? HOST,
      port: Number(kv.port ?? DEFAULTS.port),
      user: kv.user ?? DEFAULTS.user,
      database: database ?? kv.dbname ?? DEFAULTS.database,
    }
  }
  const s = settings()
  return { host: HOST, port: s.port, user: s.user, database: database ?? s.database }
}

/** the same conninfo string fund_db.config.dsn() prints */
export function dsn(database?: string): string {
  const c = connInfo(database)
  return `host=${c.host} port=${c.port} user=${c.user} dbname=${c.database}`
}
