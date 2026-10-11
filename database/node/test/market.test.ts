/**
 * @fund/db market: the read-only storage-class views (cacheUsage, pins) against a real throwaway
 * PostgreSQL (pgtest.ts), rows written by hand exactly as fund_db.market's cache.py / pins.py
 * write them. Every expected value is written by hand.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { closeAll, market, migrate, query } from '../src/index.ts'
import { PG_SKIP, startCluster, type Cluster } from './pgtest.ts'

let pg: Cluster
let n = 0
const fresh = async (template?: string) => { const name = `m${process.pid}_${++n}`; await pg.createDb(name, template); return name }
const useDb = (name: string) => { process.env.FUND_DB_DSN = pg.dsn(name) }
const H = 'a'.repeat(64)

describe('@fund/db market (read-only)', { skip: PG_SKIP }, () => {
  let TEMPLATE = ''
  before(async () => {
    delete process.env.FUND_DB_PORT
    pg = await startCluster()
    process.env.FUND_DB_DIR = pg.root
    TEMPLATE = await fresh()
    await migrate({ conn: pg.conn(TEMPLATE) })
  })
  after(async () => { await closeAll(); pg?.stop() })

  test('cacheMaxBytes reads [cache] max_bytes, and defaults to 500 MB', () => {
    const d = mkdtempSync(join(tmpdir(), 'fund_db_ret_'))
    const p = join(d, 'retention.toml')
    writeFileSync(p, '[defaults]\nkeep_days = 0\n\n[cache]\n# the budget\nmax_bytes = 1_000  # bytes\n')
    assert.equal(market.cacheMaxBytes(p), 1000)
    writeFileSync(p, '[defaults]\nmax_bytes = 5\n')
    assert.equal(market.cacheMaxBytes(p), 500_000_000)
    assert.equal(market.cacheMaxBytes(join(d, 'missing.toml')), 500_000_000)
  })

  test('cacheUsage sums the recorded months against the budget', async () => {
    useDb(await fresh(TEMPLATE))
    const empty = await market.cacheUsage()
    assert.equal(empty.bytes, 0)
    assert.equal(empty.partitions, 0)
    assert.equal(empty.oldest_read_ms, null)
    assert.equal(empty.over_budget, false)
    await query(`INSERT INTO market.cache_parts (dataset, venue, "interval", month, bytes, files, written_ms, last_read_ms) VALUES
      ('funding', 'venue_a', '', '2026-08', 300, 1, 1000, 5000),
      ('funding', 'venue_a', '', '2026-09', 200, 2, 2000, NULL),
      ('candles', 'venue_l', '1h', '2026-09', 700, 1, 3000, 4000)`)
    const u = await market.cacheUsage()
    assert.equal(u.bytes, 1200)
    assert.equal(u.files, 4)
    assert.equal(u.partitions, 3)
    assert.equal(u.oldest_read_ms, 2000)
    assert.equal(u.measured, 'recorded')
    assert.deepEqual(u.datasets, [
      { dataset: 'candles', bytes: 700, files: 1, partitions: 1 },
      { dataset: 'funding', bytes: 500, files: 3, partitions: 2 },
    ])
    assert.equal(u.max_bytes, market.cacheMaxBytes())
  })

  test('pacerStatus refills tokens to the read time, caps at capacity, filters by venue', async () => {
    useDb(await fresh(TEMPLATE))
    assert.deepEqual(await market.pacerStatus(), [])
    await query(`INSERT INTO market.pacer (venue, capacity, refill_per_s, tokens, refilled_ms, blocked_until_ms, reason, source, updated_ms) VALUES
      ('venue_l', 10, 3, 4, 1000, NULL, NULL, 'venue_l/rate-limit', 1000),
      ('venue_h', 5, 1, -3, 2000, 90000, 'pacing violation', 'venue_h/pacing', 2000)`)
    const at = async (nowMs: number, venue?: string) => market.pacerStatus({ nowMs, venue })
    const a = await at(4000)                       // venue_l: 4 + 3s * 3 = 13 -> capped at 10; venue_h: -3 + 2s * 1 = -1
    assert.deepEqual(a.map(r => [r.venue, r.tokens]), [['venue_h', -1], ['venue_l', 10]])
    assert.equal(a[0].blocked_until_ms, 90000)
    assert.equal(a[0].reason, 'pacing violation')
    assert.equal(a[1].source, 'venue_l/rate-limit')
    assert.equal((await at(2000))[1].tokens, 7)    // venue_l: 4 + 1s * 3
    assert.equal((await at(0))[1].tokens, 4)       // a clock behind the stamp never drains
    assert.deepEqual((await at(4000, 'venue_l')).map(r => r.venue), ['venue_l'])
    assert.ok(!('refilled_ms' in a[0]))
  })

  test('pins: the index with every ref, filtered by ref and venue', async () => {
    useDb(await fresh(TEMPLATE))
    assert.deepEqual(await market.pins(), [])
    await query(`INSERT INTO market.pins (hash, created_ms, dataset, venue, symbol, "interval", what, window_from, window_to,
      first_ts, last_ts, rows, bytes) VALUES ($1, 10, 'candles', 'venue_g', 'BTC', '1h', '', 0, 99, 0, 90, 3, 1234),
      ($2, 20, 'funding', 'venue_a', 'BTCUSDT', '', '', NULL, NULL, 5, 6, 2, 99)`, [H, 'b'.repeat(64)])
    await query(`INSERT INTO market.pin_refs (hash, ref, reason, created_ms) VALUES ($1, 'lab/carry#2', 'input', 30),
      ($1, 'lab/carry#1', 'input', 30), ($2, 'study-3', 'input', 40)`, [H, 'b'.repeat(64)])
    const all = await market.pins()
    assert.deepEqual(all.map(p => p.hash), [H, 'b'.repeat(64)])
    assert.deepEqual(all[0].refs, [
      { ref: 'lab/carry#1', reason: 'input', created_ms: 30 },
      { ref: 'lab/carry#2', reason: 'input', created_ms: 30 },
    ])
    assert.equal(all[0].rows, 3)
    assert.deepEqual((await market.pins({ ref: 'study-3' })).map(p => p.symbol), ['BTCUSDT'])
    assert.deepEqual((await market.pins({ venue: 'venue_g' })).map(p => p.symbol), ['BTC'])
    assert.deepEqual(await market.pins({ ref: 'nobody' }), [])
  })
  test('blobs: the index with every ref, filtered by seat, prefix and ref', async () => {
    useDb(await fresh(TEMPLATE))
    assert.deepEqual(await market.blobs(), [])
    await query(`INSERT INTO market.blobs (dataset, "key", hash, bytes, meta, built_from, created_ms) VALUES
      ('raw', 'l2/2026-10-06/btc/a.bin', $1, 2048, '{"rows": 7}', '{}', 10),
      ('derived', 'days/2026-10-03@v2', $2, 99, '{}', '{"git": "abc"}', 20)`, [H, 'b'.repeat(64)])
    await query(`INSERT INTO market.blob_refs (dataset, "key", ref, reason, created_ms) VALUES
      ('raw', 'l2/2026-10-06/btc/a.bin', 'lab/u#2', 'input', 30),
      ('raw', 'l2/2026-10-06/btc/a.bin', 'lab/u#1', 'input', 30),
      ('derived', 'days/2026-10-03@v2', 'lab/u#1', 'day', 40)`)
    const all = await market.blobs()
    assert.deepEqual(all.map(b => [b.dataset, b.key]), [['derived', 'days/2026-10-03@v2'], ['raw', 'l2/2026-10-06/btc/a.bin']])
    assert.deepEqual(all[0].built_from, { git: 'abc' })                       // jsonb comes back parsed
    assert.deepEqual(all[1].meta, { rows: 7 })
    assert.deepEqual(all[1].refs.map(r => r.ref), ['lab/u#1', 'lab/u#2'])
    assert.deepEqual((await market.blobs({ dataset: 'raw', prefix: 'l2/2026-10-06/' })).map(b => b.hash), [H])
    assert.deepEqual((await market.blobs({ ref: 'lab/u#1' })).length, 2)
    assert.deepEqual((await market.blobs({ ref: 'lab/u#2' })).map(b => b.dataset), ['raw'])
    assert.deepEqual(await market.blobs({ key: 'nope' }), [])
  })
})
