/**
 * The migration runner for node - the SAME rules as fund_db.migrate, on the SAME files, the SAME
 * ledger (public.fund_migrations) and the SAME advisory lock, so either language may migrate a
 * database the other one made (tests on both sides prove it):
 *
 * - migrations/<track>/<NNN>_<name>.sql; track `ops` first, then the others by name; within a
 *   track by number; a number used twice in one track is refused
 * - applied exactly when (track, n) is not in the ledger
 * - one transaction per file with its ledger row, unless its first line is `-- fund_db: no-transaction`
 * - sha256 over the LF-normalised text; an applied file whose text changed is DRIFT and refuses to run
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { connInfo, migrationsDir, type ConnInfo } from './config.ts'

export const LEDGER = 'public.fund_migrations'
export const LOCK_KEY = '714600000001'
export const NO_TX = '-- fund_db: no-transaction'
const FILE_RE = /^(\d+)_[A-Za-z0-9_.-]+\.sql$/
const FIRST_TRACK = 'ops'

export interface Migration { track: string; n: number; file: string; path: string; text: string; sha256: string; transactional: boolean }
export interface Plan {
  applied: Migration[]
  pending: Migration[]
  drift: { track: string; n: number; file: string; ledgerSha256: string; fileSha256: string }[]
  unknown: { track: string; n: number; file: string }[]
}

export class MigrationError extends Error {}

export const trackOrder = (names: Iterable<string>): string[] =>
  [...names].sort((a, b) => (a === FIRST_TRACK ? 0 : 1) - (b === FIRST_TRACK ? 0 : 1) || (a < b ? -1 : a > b ? 1 : 0))

export function discover(root: string = migrationsDir()): Migration[] {
  let entries: string[]
  try { entries = readdirSync(root) } catch { throw new MigrationError(`no migrations folder at ${root}`) }
  const tracks = entries.filter(t => !t.startsWith('.') && !t.startsWith('_') && statSync(join(root, t)).isDirectory())
  const out: Migration[] = []
  for (const track of trackOrder(tracks)) {
    const seen = new Map<number, string>()
    for (const f of readdirSync(join(root, track)).sort()) {
      const p = join(root, track, f)
      if (!f.endsWith('.sql') || !statSync(p).isFile()) continue
      const m = FILE_RE.exec(f)
      if (!m) throw new MigrationError(`${track}/${f}: a migration is named <NNN>_<name>.sql`)
      const n = Number(m[1])
      if (seen.has(n)) throw new MigrationError(`${track}: number ${n} is used twice: ${seen.get(n)} and ${f}`)
      seen.set(n, f)
      const text = readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
      out.push({ track, n, file: f, path: p, text, sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        transactional: !text.trimStart().startsWith(NO_TX) })
    }
  }
  const order = trackOrder(new Set(out.map(m => m.track)))
  return out.sort((a, b) => order.indexOf(a.track) - order.indexOf(b.track) || a.n - b.n)
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${LEDGER} (
  track       text NOT NULL,
  n           integer NOT NULL,
  file        text NOT NULL,
  sha256      text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (track, n)
)`

export async function plan(c: pg.ClientBase, root?: string): Promise<Plan> {
  const files = discover(root)
  await c.query(LEDGER_DDL)
  const led = new Map<string, { file: string; sha256: string }>()
  for (const r of (await c.query(`SELECT track, n, file, sha256 FROM ${LEDGER}`)).rows) led.set(`${r.track}/${r.n}`, r)
  const have = new Set(files.map(m => `${m.track}/${m.n}`))
  const p: Plan = { applied: [], pending: [], drift: [], unknown: [] }
  for (const m of files) {
    const row = led.get(`${m.track}/${m.n}`)
    if (!row) p.pending.push(m)
    else if (row.sha256 !== m.sha256) p.drift.push({ track: m.track, n: m.n, file: m.file, ledgerSha256: row.sha256, fileSha256: m.sha256 })
    else p.applied.push(m)
  }
  for (const [k, r] of led) if (!have.has(k)) { const [t, n] = k.split('/'); p.unknown.push({ track: t, n: Number(n), file: r.file }) }
  return p
}

/** apply every pending migration; returns the `<track>/<file>` names applied (empty = up to date) */
export async function migrate(opts: { conn?: ConnInfo; root?: string; log?: (s: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? (() => {})
  const c = new pg.Client({ ...(opts.conn ?? connInfo()), application_name: 'fund_db.node.migrate' })
  await c.connect()
  const done: string[] = []
  try {
    await c.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY])
    try {
      const p = await plan(c, opts.root)
      if (p.drift.length) {
        const d = p.drift[0]
        throw new MigrationError(`DRIFT: ${d.track}/${d.file} was applied with sha256 ${d.ledgerSha256.slice(0, 12)} but the file now ` +
          `hashes ${d.fileSha256.slice(0, 12)}. An applied migration is never edited; restore it and fix forward with a new number ` +
          `(${p.drift.length} drifted).`)
      }
      for (const m of p.pending) {
        try {
          if (m.transactional) await c.query('BEGIN')
          await c.query(m.text)
          await c.query(`INSERT INTO ${LEDGER} (track, n, file, sha256) VALUES ($1, $2, $3, $4)`, [m.track, m.n, m.file, m.sha256])
          if (m.transactional) await c.query('COMMIT')
        } catch (e) {
          if (m.transactional) await c.query('ROLLBACK').catch(() => {})
          throw new MigrationError(`${m.track}/${m.file} failed: ${(e as Error).message}`)
        }
        done.push(`${m.track}/${m.file}`)
        log(`[migrate] applied ${m.track}/${m.file}`)
      }
    } finally {
      await c.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]).catch(() => {})
    }
  } finally {
    await c.end()
  }
  return done
}

export async function status(opts: { conn?: ConnInfo; root?: string } = {}): Promise<Plan> {
  const c = new pg.Client({ ...(opts.conn ?? connInfo()), application_name: 'fund_db.node.migrate' })
  await c.connect()
  try { return await plan(c, opts.root) } finally { await c.end() }
}
