/**
 * @fund/db's read models (the queries the cockpit used to spell itself), the platform logs of
 * migration ops/002 and the backup, against a real throwaway PostgreSQL (pgtest.ts). The same
 * fixtures as the python tests/test_ops_views.py; every expected value is written by hand.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  backupDb, backupName, backupStatus, closeAll, listBackups, listedTables, migrate, ops, ping, poolFor, toPrune,
} from '../src/index.ts'
import { PG_BIN, PG_SKIP, startCluster, type Cluster } from './pgtest.ts'

let pg: Cluster
let n = 0
const fresh = async (template?: string) => { const name = `v${process.pid}_${++n}`; await pg.createDb(name, template); return name }
const useDb = (name: string) => { process.env.FUND_DB_DSN = pg.dsn(name) }

describe('@fund/db read models, platform logs, backup', { skip: PG_SKIP }, () => {
  let TEMPLATE = ''
  before(async () => {
    delete process.env.FUND_DB_PORT
    pg = await startCluster()
    process.env.FUND_DB_DIR = pg.root
    TEMPLATE = await fresh()
    await migrate({ conn: pg.conn(TEMPLATE) })
  })
  after(async () => { await closeAll(); pg?.stop() })

  test('ping answers on a live store', async () => {
    useDb(await fresh(TEMPLATE))
    await ping()
  })

  test('events: windows, turns, payload lookup, reverted, error counts', async () => {
    useDb(await fresh(TEMPLATE))
    await ops.logEvent('turn', 't1', { agent: 'app', conversation: 'c1', ts: 100 })
    await ops.logEvent('tool', 'Edit a.py', { agent: 'app', conversation: 'c1', ts: 150 })
    await ops.logEvent('turn', 't2', { agent: 'app', conversation: 'c1', ts: 200 })
    await ops.logEvent('turn', 'u1', { agent: 'fund', conversation: 'c0', ts: 120 })
    await ops.logEvent('error', 'boom', { conversation: 'c1', ts: 210 })
    await ops.logEvent('wake', 'woke', { payload: { dashboard: 'terminal' }, ts: 300 })
    await ops.logEvent('job', 'reverted abc', { conversation: 'c9', ts: 50 })
    assert.deepEqual((await ops.eventsInWindow(100, 210)).map(e => e.summary), ['t1', 'u1', 'Edit a.py', 't2'])
    assert.deepEqual((await ops.eventsInWindow(0, 1000, { kinds: ['turn', 'error'], agentOnly: true })).map(e => e.summary), ['t1', 'u1', 't2'])
    assert.deepEqual((await ops.turnEvents()).map(e => `${e.conversation_id}:${e.summary}`), ['c0:u1', 'c1:t1', 'c1:t2'])
    assert.deepEqual((await ops.turnEvents({ conversation: 'c1' })).map(e => e.summary), ['t1', 't2'])
    assert.deepEqual((await ops.turnWindowEvents('c1', 'tool', 100, 200)).map(e => e.summary), ['Edit a.py'])
    assert.deepEqual(await ops.turnWindowEvents('c1', 'tool', 150, 200), [])
    assert.equal(await ops.lastEventTs('wake', 'dashboard', 'terminal'), 300)
    assert.equal(await ops.lastEventTs('wake', 'dashboard', 'preds'), null)
    assert.deepEqual(await ops.revertedConversations(), ['c9'])
    assert.deepEqual([...await ops.errorCountsByConversation()], [['c1', 1]])
  })

  test('conversations and messages', async () => {
    useDb(await fresh(TEMPLATE))
    await ops.createConversation('a', 'app', { startedAt: 10, transcriptUuid: 'u', cwd: 'C:/x' })
    await ops.createConversation('b', 'app', { startedAt: 20 })
    await ops.createConversation('c', 'fund', { startedAt: 30 })
    await ops.forgetConversation('c')
    assert.equal(await ops.touchConversation('b', { ts: 99, title: 'first' }), 1)
    await ops.touchConversation('b', { ts: 100, title: 'second' })
    const b = (await ops.getConversation('b'))!
    assert.deepEqual([b.last_at, b.title], [100, 'first'])
    assert.deepEqual(await ops.nextUnindexedConversation(), { id: 'a', cwd: 'C:/x', transcript_uuid: 'u' })
    assert.deepEqual([...await ops.conversationCounts()], [['app', 2]])
    assert.deepEqual(await ops.listConversationIds(), ['a', 'b', 'c'])
    await ops.updateConversation('a', { state: 'idle', last_at: 500 })
    await ops.updateConversation('b', { state: 'closed', last_at: 600 })
    assert.deepEqual((await ops.conversationsDueForDraftScan(1000, 0)).map(r => r.id), ['b', 'a'])
    await ops.bumpDraftScan('b', 600, { found: 1, costUsd: 0.25, ts: 700 })
    const r = await ops.bumpDraftScan('b', 650, { found: 2, costUsd: 0.5, note: 'n', ts: 710 })
    assert.deepEqual([r.last_at, r.found, r.cost_usd, r.note], [650, 3, 0.75, 'n'])
    assert.deepEqual((await ops.conversationsDueForDraftScan(1000, 0)).map(r => r.id), ['a'])
    await ops.indexMessage('c1', 'user', 'the funding cadence question', { ts: 1 })
    await ops.indexMessage('c1', 'assistant', 'venue_g funding settles hourly', { ts: 2 })
    assert.deepEqual(ops.prefixWords('Fund; DROP & | !cad'), ['fund', 'drop', 'cad'])
    const hits = await ops.searchMessagesPrefix('fund cad')
    assert.deepEqual(hits.map(h => h.conversation_id), ['c1'])
    assert.match(hits[0].snippet, /cadence/)
    assert.deepEqual(await ops.searchMessagesPrefix('&|!:*'), [])
    assert.deepEqual(await ops.assistantText('c1', 0, 2), ['venue_g funding settles hourly'])
    await ops.setPresence('chat:a', 'app', { ts: 1 })
    assert.equal(await ops.heartbeatPresence(['chat:a'], { ts: 50 }), 1)
    assert.equal((await ops.listPresence()).find(p => p.hand_id === 'chat:a')!.heartbeat_at, 50)
  })

  test('pulls, commits, loop reads, grade clearing', async () => {
    useDb(await fresh(TEMPLATE))
    assert.equal(await ops.recordReadOnce('app', 'a.md', { conversationId: 'c1', ts: 100 }), true)
    assert.equal(await ops.recordReadOnce('app', 'a.md', { conversationId: 'c1', ts: 150 }), false)
    assert.equal(await ops.recordReadOnce('app', 'b.md', { conversationId: 'c1', ts: 200 }), true)
    assert.deepEqual([...await ops.countReadsByBook('c1')].sort(), [['a.md', 1], ['b.md', 1]])
    assert.deepEqual(await ops.booksReadInConversation('c1'), ['b.md', 'a.md'])
    assert.deepEqual(await ops.pullLedgerSpan(), { first: 100, n: 2 })
    assert.deepEqual(await ops.pulledBooks(), ['a.md', 'b.md'])
    assert.deepEqual((await ops.readStatsByBook(150)).map(r => [r.book_path, r.n_since]), [['a.md', 0], ['b.md', 1]])
    assert.deepEqual((await ops.pullersByBook(0)).map(r => r.book_path), ['a.md', 'b.md'])
    assert.deepEqual((await ops.pullsByAgent(0)).map(r => r.book_path), ['b.md', 'a.md'])
    assert.deepEqual((await ops.listPulls()).map(r => r.ts), [100, 200])
    assert.deepEqual(await ops.conversationsWithPulls(), ['c1'])
    await ops.upsertCommit({ repo: 'app', sha: 'a1', ts: 10, subject: 'one', conversation_id: 'c1', files_json: ['x.ts'] })
    await ops.upsertCommit({ repo: 'app', sha: 'a2', ts: 20, subject: 'two', shrink_json: { n: 2 } })
    assert.deepEqual((await ops.commitSubjects()).map(c => c.sha), ['a1', 'a2'])
    assert.deepEqual(await ops.commitFiles('c1', 0, 10), [['x.ts']])
    assert.deepEqual([...await ops.knownCommits('app', ['a1', 'zz'])], ['a1'])
    assert.deepEqual([...await ops.commitShrinks('app', ['a1', 'a2'])], [['a2', { n: 2 }]])
    await ops.addLesson('app', 'old', { ts: 10 }); await ops.addLesson('app', 'new', { ts: 20 })
    assert.deepEqual((await ops.lessonsSince({ since: 15 })).map(l => l.text), ['new'])
    for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) await ops.setMetric(d, 'app', 'turns', 1)
    assert.deepEqual((await ops.metricsBetween('2026-09-02', '2026-09-03')).map(m => m.day), ['2026-09-02', '2026-09-03'])
    assert.equal(await ops.clearMetrics('2026-09-02'), 2)
    await ops.addUsage(null, 'app', { tokensIn: 1, ts: 5 }); await ops.addUsage(null, 'app', { tokensIn: 2, ts: 15 })
    assert.deepEqual((await ops.usageInWindow(5, 15)).map(u => u.tokens_in), [1])
    await ops.upsertTurnGrade({ conversation_id: 'c1', turn_ix: 0, source: 'owner', key: 'good', value: 1, ts: 30, agent_id: null, label: null })
    await ops.upsertTurnGrade({ conversation_id: 'c1', turn_ix: 0, source: 'check', key: 'nodash', value: 0, ts: 30, agent_id: null, label: null })
    assert.deepEqual((await ops.gradesInWindow('check', 0, 40)).map(g => g.turn_ix), [0])
    assert.deepEqual(await ops.gradedTurns('check'), [{ conversation_id: 'c1', turn_ix: 0 }])
    await ops.upsertReview({ conversation_id: 'c1', turn_ix: 0, reason: 'a', state: 'open', ts: 1 })
    await ops.upsertReview({ conversation_id: 'c1', turn_ix: 0, reason: 'b', state: 'open', ts: 2 })
    assert.equal(await ops.setReviewStateAll('c1', 0, 'done'), 2)
    assert.deepEqual((await ops.listReviewAll()).map(r => `${r.reason}:${r.state}`), ['b:done', 'a:done'])
    assert.equal(await ops.clearOwnerGrade('c1', 0), 1)
    assert.deepEqual((await ops.listReviewAll()).map(r => r.state), ['open', 'open'])
  })

  test('board, alerts, drafts, processes, health, jobs, usage', async () => {
    useDb(await fresh(TEMPLATE))
    await ops.attestBoard('B-2', 'f', 'ui', { ts: 2 }); await ops.attestBoard('B-1', 'f', 'ui', { ts: 1 })
    assert.deepEqual((await ops.listBoardAttest()).map(r => r.id), ['B-1', 'B-2'])
    await ops.syncBoardSuggestions([
      { fp: 'f1', source: 'code', kind: 'todo', path: 'a', line: 3, ref: 'r', quote: 'q', title: 'x', owner: null },
      { fp: 'f2', source: 'code', kind: 'todo', path: 'a', line: null, ref: 'r', quote: 'q', title: 'y', owner: null }], { ts: 5 })
    await ops.markSuggestionDone('f1', 'filed')
    assert.deepEqual((await ops.listOpenBoardSuggestions()).map(s => s.fp), ['f2'])
    await ops.logAlert('r1', 's', 100, 'ok', 'log', { at: 100 })
    await ops.logAlert('r1', 't', 200, 'fail', 'log', { at: 200 })
    assert.deepEqual(await ops.alertLogKeys(['r1'], [100]), [{ rule: 'r1', subject: 's', bar: 100 }])
    assert.deepEqual([...await ops.alertDeliveredCounts(['r1'], 150)], [['r1', 1]])
    await ops.addAlertPass(1, '1h', 1, 1, { at: 10 }); await ops.addAlertPass(2, '1h', 1, 1, { at: 20 })
    assert.equal(await ops.firstAlertPass(), 10)
    assert.equal(await ops.pruneAlertPasses(15), 1)
    const lid = await ops.addLesson('app', 'l', { conversationId: 'c1', ts: 1 })
    assert.equal(await ops.conversationHasUndraftedLesson('c1'), true)
    await ops.addLibraryDraft({ conv: 'c1', agent: 'app', shelf: 's', path: 'p.md', book: 'b', series_row: 'r', quote: 'q', key: 'k1', lesson_id: lid, state: 'saved' })
    assert.equal(await ops.conversationHasUndraftedLesson('c1'), false)
    assert.equal(await ops.libraryDraftExists('k1'), true)
    assert.deepEqual(await ops.libraryDraftTally(), { saved: 1, dismissed: 0, last_scan_ts: null })
    const pid = await ops.addProcess('terminal', 'managed', 'python server.py', { startedAt: 1 })
    assert.equal(await ops.closeProcessOnce(pid, { exitCode: 3, stoppedAt: 5 }), 1)
    assert.equal(await ops.closeProcessOnce(pid, { exitCode: 9, stoppedAt: 6 }), 0)
    await ops.recordHealth('dash:terminal/port', 'dashboard', 'ok', { reading: 'up', ts: 10 })
    await ops.recordHealth('dash:terminal/port', 'dashboard', 'fail', { reading: 'down', detail: { window_s: 60 }, ts: 20 })
    assert.deepEqual((await ops.healthReadingsSince('dash:', 'dashboard', 15)).map(r => r.status), ['fail'])
    assert.deepEqual([...await ops.healthProbesSeen(['dash:terminal/port', 'x'], 15)], ['dash:terminal/port'])
    assert.deepEqual([...await ops.lastHealthTs(['dash:terminal/port'])], [['dash:terminal/port', 20]])
    assert.deepEqual((await ops.healthBetween(['dash:terminal/port'], 10, 20)).map(r => r.ts), [10, 20])
    assert.deepEqual((await ops.healthBefore(['dash:terminal/port'], 20)).map(r => r.reading), ['up'])
    await ops.addJobRun('sweep', 'missed', { dueAt: 100, endedAt: 101 })
    await ops.addJobRun('probe', 'ok', { startedAt: 150, endedAt: 160, trigger: 'manual' })
    assert.deepEqual((await ops.jobRunsInWindow(100, 160)).map(r => r.job_id), ['sweep', 'probe'])
    const span = await ops.jobRunSpan()
    assert.deepEqual([span.first, [...span.first_due]], [101, [['sweep', 100]]])
    await ops.addUsage(null, 'app', { tokensIn: 10, tokensOut: 5, cacheWrite: 1, ts: 1_790_000_000_000 })
    await ops.addUsage(null, 'fund', { tokensIn: 100, ts: 1_790_000_000_002 })
    assert.deepEqual((await ops.usageByDay(0, 'UTC')).map(d => [d.agent, d.day, d.billable]), [['app', '2026-09-21', 16], ['fund', '2026-09-21', 100]])
    assert.deepEqual(await ops.billableOnDay('2026-09-21', 'UTC', 0), { billable: 116, n: 2 })
    assert.deepEqual((await ops.billableRows(0, 1_790_000_000_001)).map(r => r.billable), [16])
    assert.deepEqual([...await ops.billableByAgent(0)].sort(), [['app', 16], ['fund', 100]])
    await ops.addSpendAlert('app', 10, 2, { ts: 9 })
    assert.deepEqual([...await ops.lastSpendAlerts()], [['app', 9]])
  })

  test('platform logs: data audit, the wire, no-lesson (python writes the same shapes)', async () => {
    useDb(await fresh(TEMPLATE))
    for (let i = 0; i < 3; i++) await ops.addDataAudit('delete.apply', 'tester', { request: { i }, result: { ok: true }, planId: `p${i}`, ts: 10 + i })
    assert.deepEqual((await ops.listDataAudit({ limit: 2 })).map(r => r.plan_id), ['p1', 'p2'])
    assert.equal(await ops.addWireChanges([
      { ts_ms: 100, prev_ms: 50, venue: 'venue_a', kind: 'cadence', subject: 'BTC', before: 8, after: 4, source: 'fundingInfo' },
      { ts_ms: 200, venue: 'venue_a', kind: 'list', subject: 'ETH', before: null, after: 'listed' },
    ], { logged: 999 }), 2)
    const w = await ops.listWireChanges()
    assert.deepEqual(w.map(r => [r.subject, r.before, r.after, r.tag, r.logged]), [['ETH', null, 'listed', '[API]', 999], ['BTC', 8, 4, '[API]', 999]])
    assert.deepEqual((await ops.listWireChanges({ oldestFirst: true, limit: null })).map(r => r.subject), ['BTC', 'ETH'])
    assert.equal(await ops.countWireChanges({ venue: 'venue_a', since: 150 }), 1)
    await ops.setWireSnapshot('venue_a', '2026-09-25', 20, { BTC: { cadence_h: 4 }, ETH: {} }, { source: 'b' })
    assert.deepEqual((await ops.latestWireSnapshot('venue_a'))!.markets, { BTC: { cadence_h: 4 }, ETH: {} })
    assert.deepEqual([...await ops.wireSnapshotHeads()], [['venue_a', { ts_ms: 20, markets: 2, source: 'b' }]])
    await ops.setWireState('special_scan_ms', 12345)
    assert.equal(await ops.getWireState('special_scan_ms'), 12345)
    await ops.addNoLesson('.', 's1', 'r', { ts: 1 })
    await ops.addNoLesson('lab/x', 's2', 'r', { touched: ['a.md'], ts: 2 })
    assert.deepEqual((await ops.listNoLesson()).map(r => r.subject), ['s2', 's1'])
    assert.deepEqual((await ops.listNoLesson({ desk: 'lab/x' }))[0].touched, ['a.md'])
  })

  describe('backup (pg_dump of a throwaway database)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fund_db_backup_'))
    after(() => { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* temp */ } })

    test('dumps into one checked archive that restores to the same rows, the ledger with it', async () => {
      const db = await fresh(TEMPLATE)
      useDb(db)
      for (let i = 0; i < 3; i++) await ops.logEvent('system', `backup fixture ${i}`)
      const dir = join(tmp, 'bk')
      const r = await backupDb({ conn: pg.conn(db), dir, bin: PG_BIN, now: new Date(2026, 8, 24, 3, 0).getTime() })
      assert.equal(r.file, 'ops-2026-09-24.dump')
      assert.equal(r.check, 'ok')
      assert.ok(r.tables >= 35, `tables ${r.tables}`)
      assert.equal(existsSync(`${r.path}.part`), false)
      const target = await fresh()
      const exe = join(PG_BIN, 'pg_restore' + (process.platform === 'win32' ? '.exe' : ''))
      const c = pg.conn(target)
      const out = spawnSync(exe, ['-h', c.host, '-p', String(c.port), '-U', c.user, '-d', target, '-w', r.path], { encoding: 'utf8', timeout: 120_000 })
      assert.equal(out.status, 0, out.stderr)
      const back = poolFor(c)
      assert.equal(Number((await back.query("SELECT count(*) AS n FROM ops.events WHERE summary LIKE 'backup fixture %'")).rows[0].n), 3)
      assert.ok(Number((await back.query('SELECT count(*) AS n FROM public.fund_migrations')).rows[0].n) >= 3)
    })

    test('the same day replaces; past keep is pruned; other files are left alone', async () => {
      const db = await fresh(TEMPLATE)
      const dir = join(tmp, 'bk2'); mkdirSync(dir, { recursive: true })
      for (let d = 1; d <= 16; d++) writeFileSync(join(dir, `ops-2026-09-${String(d).padStart(2, '0')}.dump`), 'old')
      writeFileSync(join(dir, 'cockpit-2026-09-01.db'), 'a retired sqlite backup')
      const r = await backupDb({ conn: pg.conn(db), dir, bin: PG_BIN, now: new Date(2026, 8, 24, 3).getTime(), keep: 14 })
      const left = listBackups(dir).map(f => f.day)
      assert.equal(left.length, 14)
      assert.deepEqual([left[0], left.at(-1)], ['2026-09-24', '2026-09-04'])
      assert.ok(r.pruned.includes('ops-2026-09-01.dump'))
      assert.equal(existsSync(join(dir, 'cockpit-2026-09-01.db')), true)
    })

    test('a store that does not answer fails loudly and leaves nothing; no binaries is said', async () => {
      const dir = join(tmp, 'bk3')
      await assert.rejects(backupDb({ conn: { ...pg.conn('nope'), port: 1 }, dir, bin: PG_BIN, timeoutMs: 60_000 }), /pg_dump exited/)
      assert.deepEqual(readdirSync(dir), [])
      await assert.rejects(backupDb({ conn: pg.conn('x'), dir: join(tmp, 'bk5'), bin: join(tmp, 'no-bin') }), /no pg_dump at .*pg\.py ensure/)
      assert.equal(existsSync(join(tmp, 'bk5')), false)
    })

    test('pure parts: the TOC check, status, prune order, day from the name', () => {
      const toc = ['215; 1259 16391 TABLE ops events fund', '216; 1259 16392 TABLE ops usage fund',
        '3345; 0 16391 TABLE DATA ops events fund'].join('\n')
      assert.deepEqual(listedTables(toc), { data: 1, tables: 2 })
      const now = Date.now()
      assert.equal(backupStatus([], now).status, 'unknown')
      const f = { file: backupName(now), day: '2026-09-24', bytes: 1048576, mtime: now - 3_600_000 }
      assert.deepEqual(backupStatus([f], now), { status: 'ok', reading: '1 kept · 2026-09-24 · 1.0 MB' })
      assert.equal(backupStatus([{ ...f, mtime: now - 37 * 3_600_000 }], now).status, 'warn')
      const files = ['2026-09-03', '2026-09-01', '2026-09-02'].map(day => ({ file: `ops-${day}.dump`, day }))
      assert.deepEqual(toPrune(files, 2), ['ops-2026-09-01.dump'])
      const dir = join(tmp, 'bk4'); mkdirSync(dir)
      writeFileSync(join(dir, 'ops-2026-09-20.dump'), 'x')
      utimesSync(join(dir, 'ops-2026-09-20.dump'), new Date(2020, 0, 1), new Date(2020, 0, 1))
      assert.equal(listBackups(dir)[0].day, '2026-09-20')
    })
  })
})
