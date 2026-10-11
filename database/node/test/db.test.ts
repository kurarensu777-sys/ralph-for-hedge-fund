/**
 * @fund/db against a real, throwaway PostgreSQL (see pgtest.ts): the node migration runner on the
 * repo's own migrations and on scratch ones (ledger, idempotence, drift, rollback), then the ops
 * functions on a migrated database. Every expected value here is written by hand, never read back
 * from the code under test. Without the portable binaries the whole file skips and says why.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { closeAll, discover, LEDGER, migrate, MigrationError, migrationStatus, ops, TABLES, transaction } from '../src/index.ts'
import { PG_SKIP, startCluster, type Cluster } from './pgtest.ts'

let pg: Cluster
let n = 0
const fresh = async (template?: string) => { const name = `t${process.pid}_${++n}`; await pg.createDb(name, template); return name }
const useDb = (name: string) => { process.env.FUND_DB_DSN = pg.dsn(name) }

describe('@fund/db on a live PostgreSQL', { skip: PG_SKIP }, () => {
  let TEMPLATE = ''
  before(async () => {
    delete process.env.FUND_DB_PORT
    pg = await startCluster()
    process.env.FUND_DB_DIR = pg.root   // never ~/fund-data/db
    TEMPLATE = await fresh()
    await migrate({ conn: pg.conn(TEMPLATE) })
  })
  after(async () => { await closeAll(); pg?.stop() })

  describe('migrate', () => {
    test('applies every repo migration once, records each in the shared ledger, then is a no-op', async () => {
      const db = await fresh()
      const files = discover()
      const done = await migrate({ conn: pg.conn(db) })
      assert.deepEqual(done, files.map(m => `${m.track}/${m.file}`))
      assert.deepEqual(await migrate({ conn: pg.conn(db) }), [])
      const led = (await pg.sql(db, `SELECT track, n, file, sha256 FROM ${LEDGER} ORDER BY track, n`)).rows
      assert.equal(led.length, files.length)
      for (const m of files) assert.ok(led.some(r => r.track === m.track && r.n === m.n && r.sha256 === m.sha256), `${m.track}/${m.file}`)
      const s = await migrationStatus({ conn: pg.conn(db) })
      assert.deepEqual([s.pending.length, s.drift.length, s.unknown.length, s.applied.length], [0, 0, 0, files.length])
      // every table the registry knows exists in schema ops
      const t = (await pg.sql(db, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'ops'")).rows.map(r => r.table_name)
      for (const name of Object.keys(TABLES)) assert.ok(t.includes(name), `ops.${name} missing after migrate`)
    })

    test('a lower number landing late still runs; drift refuses; a failing file rolls back with its ledger row', async () => {
      const root = mkdtempSync(join(tmpdir(), 'fund_db_mig_'))
      try {
        mkdirSync(join(root, 'ops')); mkdirSync(join(root, 'aux'))
        writeFileSync(join(root, 'ops', '002_b.sql'), 'CREATE TABLE public.b (x int);\n')
        writeFileSync(join(root, 'aux', '001_x.sql'), 'CREATE TABLE public.x (x int);\n')
        const db = await fresh()
        assert.deepEqual(await migrate({ conn: pg.conn(db), root }), ['ops/002_b.sql', 'aux/001_x.sql'])
        writeFileSync(join(root, 'ops', '001_a.sql'), 'CREATE TABLE public.a (x int);\n')
        assert.deepEqual(await migrate({ conn: pg.conn(db), root }), ['ops/001_a.sql'])

        writeFileSync(join(root, 'ops', '003_bad.sql'), 'CREATE TABLE public.c (x int);\nSELECT nope_no_such_fn();\n')
        await assert.rejects(migrate({ conn: pg.conn(db), root }), (e: Error) => e instanceof MigrationError && /003_bad\.sql failed/.test(e.message))
        assert.equal((await pg.sql(db, "SELECT to_regclass('public.c') AS r")).rows[0].r, null)
        assert.equal((await pg.sql(db, `SELECT count(*)::int AS n FROM ${LEDGER} WHERE n = 3`)).rows[0].n, 0)
        rmSync(join(root, 'ops', '003_bad.sql'))

        writeFileSync(join(root, 'ops', '002_b.sql'), 'CREATE TABLE public.b (x int, y int);\n')
        await assert.rejects(migrate({ conn: pg.conn(db), root }), /DRIFT: ops\/002_b\.sql/)
        const s = await migrationStatus({ conn: pg.conn(db), root })
        assert.deepEqual(s.drift.map(d => d.file), ['002_b.sql'])
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  })

  describe('ops', () => {
    before(async () => { useDb(await fresh(TEMPLATE)) })

    test('events: jsonb round trip, filters, newest first', async () => {
      const a = await ops.logEvent('job', 'one', { agent: 'app', payload: [1, { a: true }], ts: 100 })
      await ops.logEvent('turn', 'two', { agent: 'fund', conversation: 'c9', ts: 200 })
      await ops.logEvent('job', 'three', { ts: 300 })
      const all = await ops.listEvents()
      assert.deepEqual(all.map(e => e.summary), ['three', 'two', 'one'])
      const one = all.find(e => e.id === a)!
      assert.deepEqual(one.payload_json, [1, { a: true }])
      assert.equal(one.ts, 100)
      assert.equal(typeof one.id, 'number')
      assert.deepEqual((await ops.listEvents({ kinds: ['job'], since: 150 })).map(e => e.summary), ['three'])
      assert.deepEqual((await ops.listEvents({ agent: 'fund' })).map(e => e.conversation_id), ['c9'])
      assert.equal((await ops.listEvents({ limit: 1 })).length, 1)
    })

    test('conversations, usage totals, forget, close', async () => {
      await ops.createConversation('k1', 'app', { transcriptUuid: 'u1', startedAt: 10, state: 'running' })
      await ops.createConversation('k2', 'fund', { startedAt: 20 })
      await ops.addUsage('k1', 'app', { tokensIn: 5, tokensOut: 7, costUsd: 0.25, ts: 30 })
      await ops.addUsage('k1', 'app', { tokensIn: 1, costUsd: 0.5, ts: 40 })
      await ops.addUsage(null, 'app', { tokensIn: 100, ts: 50 })
      const k1 = (await ops.getConversation('k1'))!
      assert.deepEqual([k1.tokens_in, k1.tokens_out, k1.cost_usd, k1.forgotten], [6, 7, 0.75, false])
      assert.equal((await ops.conversationByTranscript('u1'))!.id, 'k1')
      assert.deepEqual([...await ops.knownTranscripts()], ['u1'])
      assert.deepEqual((await ops.listUsage({ since: 35 })).map(u => u.tokens_in), [1, 100])
      await ops.updateConversation('k2', { title: 'hello', last_at: 99 })
      assert.deepEqual((await ops.listConversations()).map(c => c.id), ['k2', 'k1'])
      await ops.forgetConversation('k2')
      assert.equal(await ops.getConversation('k2'), null)
      assert.equal((await ops.getConversation('k2', { includeForgotten: true }))!.title, 'hello')
      assert.deepEqual((await ops.listConversations()).map(c => c.id), ['k1'])
      assert.equal(await ops.closeOpenConversations(), 1)  // k1 running -> closed; k2 already closed
    })

    test('transaction: a throw rolls every call back', async () => {
      await assert.rejects(transaction(async c => {
        await ops.createConversation('tx1', 'app', {}, c)
        await ops.addUsage('tx1', 'app', { tokensIn: 3 }, c)   // nests as a savepoint
        throw new Error('boom')
      }), /boom/)
      assert.equal(await ops.getConversation('tx1', { includeForgotten: true }), null)
    })

    test('messages: clip, replace, search, last', async () => {
      await ops.createConversation('m1', 'app')
      await ops.createConversation('m2', 'app')
      await ops.indexMessage('m1', 'user', 'x'.repeat(25_000), { ts: 1 })
      assert.equal((await ops.lastMessages(['m1'])).get('m1')!.length, 20_000)
      assert.equal(await ops.replaceMessages('m1', [{ role: 'user', text: 'funding basis on venue_a', ts: 5 },
        { role: 'assistant', text: 'the basis is thin today', ts: 6 }]), 2)
      await ops.indexMessage('m2', 'user', 'nothing relevant here', { ts: 7 })
      const hits = await ops.searchMessages('basis')
      assert.deepEqual([...new Set(hits.map(h => h.conversation_id))], ['m1'])
      assert.equal(hits.length, 2)
      assert.deepEqual(await ops.searchMessages('   '), [])
      const last = await ops.lastMessages(['m1', 'm2', 'none'])
      assert.deepEqual([...last.entries()].sort(), [['m1', 'the basis is thin today'], ['m2', 'nothing relevant here']])
    })

    test('presence keeps since on a heartbeat; prefix clear', async () => {
      await ops.setPresence('chat:1', 'app', { ts: 100, doing: 'a' })
      const p = await ops.setPresence('chat:1', 'app', { ts: 200, doing: 'b' })
      assert.deepEqual([p.since, p.heartbeat_at, p.doing], [100, 200, 'b'])
      await ops.setPresence('job:1', 'fund', { ts: 150 })
      assert.deepEqual((await ops.listPresence({ freshSince: 180 })).map(r => r.hand_id), ['chat:1'])
      assert.equal(await ops.clearPresencePrefix('chat:'), 1)
      assert.equal(await ops.clearPresence('job:1'), 1)
      assert.deepEqual(await ops.listPresence(), [])
    })

    test('health: latest per probe, history, prune keeps the newest', async () => {
      await ops.recordHealth('p1', 'venue', 'ok', { ts: 10, detail: { ms: 3 } })
      await ops.recordHealth('p1', 'venue', 'fail', { ts: 20, reading: 'down' })
      await ops.recordHealth('p2', 'disk', 'ok', { ts: 5 })
      assert.deepEqual((await ops.latestHealth()).map(h => [h.probe_id, h.status]), [['p1', 'fail'], ['p2', 'ok']])
      assert.deepEqual((await ops.latestHealth({ target: 'disk' })).map(h => h.probe_id), ['p2'])
      assert.deepEqual((await ops.healthHistory('p1')).map(h => h.ts), [20, 10])
      assert.equal(await ops.pruneHealth(100), 1)                      // p1@10 goes; each probe's newest stays
      assert.equal(await ops.pruneHealth(100, { keepLatest: false }), 2)
    })

    test('scheduler: start, finish, tally, latest per job prefers a non-skip', async () => {
      const r1 = await ops.startJobRun('nightly', 1000, { startedAt: 1001 })
      await ops.finishJobRun(r1, 'ok', { exitCode: 0, endedAt: 1100, conversationId: 'cv' })
      const r2 = await ops.startJobRun('nightly', 2000, { startedAt: 2001, trigger: 'manual' })
      await ops.finishJobRun(r2, 'fail', { exitCode: 1, endedAt: 2100 })
      assert.equal((await ops.getJobRun(r2))!.conversation_id, null)
      assert.equal((await ops.getJobRun(r1))!.conversation_id, 'cv')
      await ops.addJobRun('nightly', 'skipped', { dueAt: 3000, endedAt: 3000 })
      await ops.addJobRun('hourly', 'missed', { dueAt: 500, endedAt: 600 })
      const r3 = await ops.startJobRun('hourly', 700, { startedAt: 701 })
      assert.deepEqual((await ops.runningJobRuns()).map(r => r.id), [r3])
      const latest = await ops.latestJobRunPerJob()
      assert.equal(latest.get('nightly')!.id, r2)
      assert.equal(latest.get('hourly')!.id, r3)
      assert.equal((await ops.lastStartedJobRun('nightly'))!.id, r2)
      assert.deepEqual(Object.fromEntries(await ops.lastDuePerJob()), { nightly: 3000, hourly: 700 })
      assert.deepEqual(await ops.jobRunTally(0), { ran: 2, ok: 1, failed: 1, unknown: 0, missed: 1, skipped: 1, running: 1 })
      assert.deepEqual((await ops.listJobRuns({ jobId: 'nightly', limit: 2 })).map(r => r.status), ['skipped', 'fail'])
      await ops.updateJobRun(r3, { detail: 'x' })
      assert.equal((await ops.getJobRun(r3))!.detail, 'x')
    })

    test('processes, reads, commits', async () => {
      const p = await ops.addProcess('terminal', 'dev', 'npm run dev', { pid: 42, startedAt: 10 })
      assert.deepEqual((await ops.openProcesses()).map(r => r.id), [p])
      await ops.closeProcess(p, { exitCode: 0, stoppedAt: 20 })
      assert.deepEqual(await ops.openProcesses(), [])
      assert.equal((await ops.listProcesses({ dashboardId: 'terminal' }))[0].exit_code, 0)

      await ops.recordRead('app', 'library/a.md', { atBoot: true, ts: 1 })
      await ops.recordRead('app', 'library/b.md', { ts: 2 })
      assert.deepEqual((await ops.listReads({ pullsOnly: true })).map(r => r.book_path), ['library/b.md'])
      assert.equal((await ops.listReads({ agent: 'app' })).length, 2)

      await ops.upsertCommit({ repo: 'fund', sha: 'abc', ts: 5, subject: 's1', files_json: ['a'] })
      await ops.upsertCommit({ repo: 'fund', sha: 'abc', ts: 5, subject: 's2' })
      const c = (await ops.getCommit('fund', 'abc'))!
      assert.deepEqual([c.subject, c.files_json], ['s2', ['a']])
      assert.equal((await ops.listCommits({ repo: 'fund', since: 5 })).length, 1)
    })

    test('loop: metrics, lessons, passes, grades, review never reopens', async () => {
      await ops.setMetric('2026-09-24', 'app', 'turns', 3)
      await ops.setMetric('2026-09-24', 'app', 'turns', 4)
      await ops.setMetric('2026-09-25', 'app', 'turns', 1.5)
      assert.deepEqual((await ops.listMetrics({ sinceDay: '2026-09-25' })).map(m => m.value), [1.5])
      assert.equal((await ops.listMetrics()).find(m => m.day === '2026-09-24')!.value, 4)
      const l = await ops.addLesson('app', 'pull first', { ts: 1 })
      await ops.setLessonState(l, 'filed', { proposal: 'p' })
      assert.deepEqual((await ops.listLessons({ state: 'filed' })).map(x => x.proposal), ['p'])
      assert.equal((await ops.listLessons()).length, 1)
      await ops.addLoopPass('cron', true, 'fine', { detail: { k: 1 }, ts: 9 })
      assert.deepEqual((await ops.listLoopPasses())[0].detail_json, { k: 1 })
      await ops.upsertTurnGrade({ conversation_id: 'c', turn_ix: 0, ts: 1, agent_id: null, source: 'auto', key: 'k', value: 1, label: null })
      await ops.upsertTurnGrade({ conversation_id: 'c', turn_ix: 0, ts: 1, agent_id: null, source: 'auto', key: 'k', value: 2, label: 'x' })
      assert.deepEqual((await ops.listTurnGrades({ conversationId: 'c' })).map(g => g.value), [2])
      await ops.upsertReview({ conversation_id: 'c', turn_ix: 0, reason: 'r', ts: 1, excerpt: 'e1' })
      await ops.setReviewState('c', 0, 'r', 'done')
      await ops.upsertReview({ conversation_id: 'c', turn_ix: 0, reason: 'r', ts: 2, excerpt: 'e2', state: 'open' })
      assert.deepEqual(await ops.listReview(), [])
      const all = await ops.listReview({ state: null })
      assert.deepEqual([all[0].state, all[0].excerpt], ['done', 'e2'])
      const ll = await ops.addLawLoad({ conversation_id: 'c', agent_id: 'app', file_path: 'CLAUDE.md', load_reason: 'boot' })
      assert.deepEqual((await ops.listLawLoads('c')).map(r => r.id), [ll])
    })

    test('board: attest, sync keeps first_seen, done, scan', async () => {
      await ops.attestBoard('B-1', 'fp', 'ui', { ts: 1 })
      assert.equal((await ops.getBoardAttest('B-1'))!.via, 'ui')
      assert.equal(await ops.dropBoardAttest('B-1'), 1)
      const s = (fp: string) => ({ fp, source: 'scan', kind: 'todo', path: 'a.md', line: 1, ref: 'r', quote: 'q', title: 't', owner: null })
      assert.equal(await ops.syncBoardSuggestions([s('f1'), s('f2')], { ts: 10 }), 2)
      await ops.syncBoardSuggestions([s('f2'), s('f3')], { ts: 20 })
      const rows = await ops.listBoardSuggestions()
      assert.deepEqual(rows.map(r => [r.fp, r.first_seen, r.last_seen]).sort(), [['f2', 10, 20], ['f3', 20, 20]])
      await ops.markSuggestionDone('f2', 'filed', { item: 'B-2', ts: 5 })
      assert.deepEqual((await ops.listSuggestionsDone()).map(r => r.item), ['B-2'])
      await ops.setBoardScan({ ts: 1, files: 2, visited: 3, capped: false, errors_json: [], ms: 4, found: 5 })
      assert.deepEqual([(await ops.getBoardScan())!.id, (await ops.getBoardScan())!.found], [1, 5])
    })

    test('alerts: spend keep, rules keep created, log once per bar, passes', async () => {
      for (let i = 0; i < 4; i++) await ops.addSpendAlert('app', i, 1.5, { ts: i, keep: 3 })
      assert.deepEqual((await ops.listSpendAlerts()).map(r => r.billable), [3, 2, 1])
      const r = await ops.saveAlertRule({ id: 'r1', condition: 'c', subject: 's', mode: 'bar', bar: '1h', created: 7, enabled: 0 as unknown as boolean })
      assert.deepEqual([r.created, r.enabled, r.armed], [7, false, true])
      await ops.saveAlertRule({ id: 'r1', condition: 'c2', subject: 's', mode: 'bar', bar: '1h', created: 999 })
      assert.deepEqual([(await ops.getAlertRule('r1'))!.condition, (await ops.getAlertRule('r1'))!.created], ['c2', 7])
      await ops.markAlertFired('r1', { ts: 55 })
      assert.equal((await ops.listAlertRules())[0].last_fired, 55)
      assert.equal(await ops.logAlert('r1', 's', 100, 'yes', 'ui', { value: 1.25, at: 3 }), true)
      assert.equal(await ops.logAlert('r1', 's', 100, 'yes', 'ui'), false)
      assert.deepEqual((await ops.listAlertLog({ rule: 'r1' })).map(x => x.value), [1.25])
      await ops.addAlertPass(100, '1h', 1, 1, { at: 4, forced: true })
      assert.equal((await ops.listAlertPasses())[0].forced, true)
      assert.equal(await ops.deleteAlertRule('r1'), 1)
    })

    test('library: drafts unique by key, scans, book marks', async () => {
      const d = { conv: 'c', agent: 'app', shelf: 'fund', path: 'p.md', book: 'b', series_row: 'r', quote: 'q', key: 'k1' }
      const id = await ops.addLibraryDraft(d)
      assert.equal(typeof id, 'number')
      assert.equal(await ops.addLibraryDraft(d), null)
      const u = (await ops.updateLibraryDraft(id!, { state: 'landed' }))!
      assert.equal(u.state, 'landed')
      assert.equal(typeof u.updated, 'number')
      assert.equal((await ops.listLibraryDrafts({ state: 'landed' })).length, 1)
      await ops.setDraftScan('c', 50, { found: 2, costUsd: 0.1 })
      assert.equal((await ops.getDraftScan('c'))!.found, 2)
      await ops.setBookMark('library/x.md', { boot: ['app'], state: 'hot' })
      assert.deepEqual((await ops.getBookMark('library/x.md'))!.boot_json, ['app'])
      assert.deepEqual((await ops.listBookMarks({ state: 'hot' })).map(m => m.path), ['library/x.md'])
      assert.equal(await ops.dropBookMark('library/x.md'), 1)
    })

    test('comparators, prompts, chat verify', async () => {
      const s1 = await ops.addComparatorSnapshot('btc', 'ok', [1, 2], 'src', { ts: 1 })
      const s2 = await ops.addComparatorSnapshot('btc', 'ok', [3], 'src', { ts: 2 })
      assert.ok(s2 > s1)
      assert.deepEqual((await ops.latestComparatorSnapshots()).get('btc')!.series, [3])
      assert.deepEqual((await ops.comparatorHistory('btc')).map(x => x.seq), [s2, s1])
      const p = await ops.createPrompt('body', { tags: ['B', 'a', 'b'], ts: 1 })
      assert.deepEqual(p.tags, ['a', 'b'])
      assert.deepEqual((await ops.updatePrompt(p.id, { tags: ['Z'] }))!.tags, ['z'])
      assert.equal((await ops.listPrompts()).length, 1)
      assert.equal(await ops.deletePrompt(p.id), 1)
      await ops.setChatVerify('app', null, 'ok', 12, 'fp', { timedOut: true })
      assert.deepEqual([(await ops.getChatVerify('app'))!.code, (await ops.listChatVerify())[0].timed_out], [null, true])
    })

    test('the generic layer validates every identifier', async () => {
      assert.equal(await ops.count('events', { kind: ['job', 'turn'] }), 3)
      assert.equal((await ops.select('events', { where: { kind: 'job' }, orderBy: '-ts', limit: 1 }))[0].summary, 'three')
      await assert.rejects(ops.select('events', { where: { 'kind; DROP TABLE x': 1 } as never }), /has no column/)
      await assert.rejects(ops.insert('nope' as never, {} as never), /no ops table/)
      await assert.rejects(ops.update('messages', 1, { tsv: 'x' } as never), /generated/)
    })
  })
})
