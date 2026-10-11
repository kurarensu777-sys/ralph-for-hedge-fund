/**
 * The node half of the python/node contract, checked WITHOUT a database: the ops names match
 * fund_db.ops.__all__ one for one (snake_case there, camelCase here), the migration runner shares
 * python's ledger, lock key and no-transaction marker, and the DSN resolves by the same rules.
 * (tests/test_contract.py holds the python half and the cross-language round trip.)
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import * as ops from '../src/ops.ts'
import * as config from '../src/config.ts'
import * as migrate from '../src/migrate.ts'
import { REPO_ROOT } from '../src/config.ts'

const PY = (p: string) => readFileSync(join(REPO_ROOT, 'py', 'fund_db', ...p.split('/')), 'utf8')
const SPECIAL: Record<string, string> = { delete: 'del' } // JS forbids a function named `delete`
const PY_ONLY = new Set(['TABLES'])                        // @fund/db exports it from index (rows.ts)

const camel = (n: string) => SPECIAL[n] ?? (/^[A-Z0-9_]+$/.test(n) ? n : n.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()))

function pythonAll(): string[] {
  const m = /__all__ = \[([\s\S]*?)\n\]/.exec(PY('ops/__init__.py'))
  assert.ok(m, 'fund_db/ops/__init__.py has no __all__ list')
  return [...m[1].matchAll(/"(\w+)"/g)].map(x => x[1])
}

test('every fund_db.ops name has its camelCase twin in ops.ts, and nothing extra', () => {
  const want = new Set(pythonAll().filter(n => !PY_ONLY.has(n)).map(camel))
  const have = new Set(Object.keys(ops))
  assert.ok(want.size > 100, `only ${want.size} python names parsed; the parser is broken`)
  assert.deepEqual([...want].filter(n => !have.has(n)).sort(), [], 'in fund_db.ops but missing from ops.ts')
  assert.deepEqual([...have].filter(n => !want.has(n)).sort(), [], 'in ops.ts but missing from fund_db.ops')
  for (const n of have) if (!/^[A-Z0-9_]+$/.test(n)) assert.equal(typeof (ops as Record<string, unknown>)[n], 'function', `${n} is not a function`)
})

test('the migration runner shares the ledger, lock key and marker with fund_db.migrate', () => {
  const py = PY('migrate.py')
  const str = (name: string) => new RegExp(`^${name} = "([^"]+)"`, 'm').exec(py)?.[1]
  assert.equal(migrate.LEDGER, str('LEDGER'))
  assert.equal(migrate.NO_TX, str('NO_TX'))
  const lock = /^LOCK_KEY = ([\d_]+)/m.exec(py)?.[1]?.replace(/_/g, '')
  assert.equal(migrate.LOCK_KEY, lock)
})

test('discover reads the repo migrations: ops first, then the rest by name, LF-normalised sha256', () => {
  const ms = migrate.discover()
  assert.ok(ms.length >= 1)
  assert.equal(ms[0].track, 'ops')
  const tracks = ms.map(m => m.track)
  assert.deepEqual(tracks, [...tracks].sort((a, b) => (a === 'ops' ? -1 : b === 'ops' ? 1 : a < b ? -1 : a > b ? 1 : 0)))
  for (const m of ms) assert.match(m.sha256, /^[0-9a-f]{64}$/)
})

let tmp: string | undefined
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = undefined })

test('discover refuses a number used twice and a badly named file', () => {
  tmp = mkdtempSync(join(tmpdir(), 'fund_db_mig_'))
  const t = join(tmp, 'ops')
  mkdirSync(t)
  writeFileSync(join(tmp, 'README.txt'), 'a stray file at the root is not a track')
  writeFileSync(join(t, '001_a.sql'), 'SELECT 1;')
  writeFileSync(join(t, '001_b.sql'), 'SELECT 2;')
  assert.throws(() => migrate.discover(tmp), /number 1 is used twice/)
  rmSync(join(t, '001_b.sql'))
  writeFileSync(join(t, 'two.sql'), 'SELECT 3;')
  assert.throws(() => migrate.discover(tmp), /is named <NNN>_<name>\.sql/)
})

test('the same text hashes the same under CRLF and LF (the ledger is line-ending blind)', () => {
  tmp = mkdtempSync(join(tmpdir(), 'fund_db_mig_'))
  mkdirSync(join(tmp, 'ops')); mkdirSync(join(tmp, 'zz'))
  writeFileSync(join(tmp, 'ops', '001_a.sql'), 'SELECT 1;\r\nSELECT 2;\r\n')
  writeFileSync(join(tmp, 'zz', '001_a.sql'), 'SELECT 1;\nSELECT 2;\n')
  const [a, b] = migrate.discover(tmp)
  assert.equal(a.track, 'ops')
  assert.equal(a.sha256, b.sha256)
})

const ENV = ['FUND_DB_DSN', 'FUND_DB_PORT', 'FUND_DB_DIR'] as const
function withEnv(env: Partial<Record<typeof ENV[number], string>>, fn: () => void) {
  const old = Object.fromEntries(ENV.map(k => [k, process.env[k]]))
  try {
    for (const k of ENV) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
    fn()
  } finally {
    for (const k of ENV) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k] }
  }
}

test('dsn: pg.json, then FUND_DB_PORT, and FUND_DB_DSN wins; a password is refused', () => {
  tmp = mkdtempSync(join(tmpdir(), 'fund_db_cfg_'))
  writeFileSync(join(tmp, 'pg.json'), JSON.stringify({ port: 5999, user: 'fund', database: 'fund' }))
  withEnv({ FUND_DB_DIR: tmp }, () => assert.equal(config.dsn(), 'host=127.0.0.1 port=5999 user=fund dbname=fund'))
  withEnv({ FUND_DB_DIR: tmp, FUND_DB_PORT: '6543' }, () => assert.equal(config.dsn('x'), 'host=127.0.0.1 port=6543 user=fund dbname=x'))
  withEnv({ FUND_DB_DIR: tmp, FUND_DB_DSN: "host=127.0.0.1 port=7777 user=fund dbname='a b'" },
    () => assert.equal(config.dsn(), 'host=127.0.0.1 port=7777 user=fund dbname=a b'))
  withEnv({ FUND_DB_DSN: 'host=127.0.0.1 password=x' }, () => assert.throws(() => config.dsn(), /password/))
})
