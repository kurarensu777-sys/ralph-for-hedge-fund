import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// THE LIVE SUMMARY CARDS: the contract mirror (server/proc/summary.ts) on one fixture, and the Dash
// room polling a stub server (valid, malformed, port closed) end to end through its routes and the store.

const TMP = mkdtempSync(join(tmpdir(), 'dash-summary-'))
const ROOT = join(TMP, 'fund')
const DASH = join(ROOT, 'platform', 'dashboards')
const FEED = join(ROOT, 'platform', 'feed')


async function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = netServer()
    s.once('error', bad)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)) })
  })
}

// ---- the scratch fund: a dashboard with a summary on a stub server, one without, a tool, the feed ----
const STUB = await freePort()
const QUIET = await freePort()
const AS_OF = 1790380800000     // 2026-09-26 00:00:00 UTC in ms: a fixed instant, not a reading
const good = { as_of_ms: AS_OF, health: 'warn', headline: [
  { label: 'best net ann %', value: 12.5, tag: '[API]', hint: '7D window, read 2026-09-26' },
  { label: 'ARB count', value: 3, tag: '[API]' },
  { label: 'venues answering', value: 'n/a', hint: 'stub' },
] }
let answer: { status: number; body: string } = { status: 200, body: JSON.stringify(good) }
const dash = (id: string, port: number, order: number, extra: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), market: 'crypto', agent: `dash:${id}`, kind: 'dashboard', open: `http://127.0.0.1:${port}/`,
  start: { cmd: `platform/dashboards/${id}/.venv/Scripts/python.exe -m ${id}`, cwd: 'platform/dashboards', port },
  health: [{ id: 'port', check: 'port', port }], every: '15m', order, ...extra,
})
mkdirSync(join(ROOT, 'app', 'agents'), { recursive: true })
writeFileSync(join(ROOT, 'repos.json'), '{"repos": []}\n')
for (const d of [
  dash('carry', STUB, 1, { summary: { url: `http://127.0.0.1:${STUB}/api/summary`, every: '1m' } }),
  dash('quiet', QUIET, 2),
]) { mkdirSync(join(DASH, d.id), { recursive: true }); writeFileSync(join(DASH, d.id, 'dashboard.json'), JSON.stringify(d, null, 2) + '\n') }
// a feed folder as the tree carried it before live data v2: it claims no port any more
mkdirSync(FEED, { recursive: true })
writeFileSync(join(FEED, 'feed.json'), JSON.stringify({ id: 'feed', port: 8790 }) + '\n')
process.env.FUND_ROOT = ROOT
process.env.FUND_DATA_DIR = join(TMP, 'data')
process.env.FUND_SCHEDULER = '0'
process.env.FUND_BOARD_AUTO = '0'

const S = await import('../server/proc/summary.ts')
const { readDashboards } = await import('../server/config.ts')
const { cardModel } = await import('../src/rooms/dash/summary.ts')

let stub: Server
let server: Server
let base = ''
const UI = 'http://127.0.0.1:4688'
const get = async (path: string) => { const r = await fetch(`${base}${path}`); return { status: r.status, json: await r.json() as any } }
const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: UI }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json() as any }
}
const startStub = () => new Promise<void>(ok => {
  stub = createServer((q, s) => {
    if (q.url !== '/api/summary') { s.statusCode = 404; s.end('{}'); return }
    s.statusCode = answer.status
    s.setHeader('content-type', 'application/json')
    s.end(answer.body)
  })
  stub.listen(STUB, '127.0.0.1', () => ok())
})
const stopStub = () => new Promise<void>(ok => { stub.closeAllConnections?.(); stub.close(() => ok()) })

beforeAll(async () => {
  await startStub()
  const { Router } = await import('../server/http.ts')
  const room = await import('../server/rooms/dash.ts')
  const r = new Router()
  room.register(r)
  server = createServer((req, res) => { void r.handle(req, res).then(ok => { if (!ok) { res.statusCode = 404; res.end('{}') } }) })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(async () => {
  server?.close()
  if (stub?.listening) await stopStub()
  rmSync(TMP, { recursive: true, force: true })
})

// ---- 1. the contract: one fixture, judged by the mirror ----
const entry = (o: Record<string, unknown> = {}) => ({ label: 'DVOL BTC', value: '36.0', ...o })
const body = (o: Record<string, unknown> = {}) => ({ as_of_ms: AS_OF, health: 'ok', headline: [entry(), entry(), entry()], ...o })
const drop = (k: string) => { const b: Record<string, unknown> = body(); delete b[k]; return b }
/** [what, body, valid?, a fragment the mirror's reason must carry] */
const BODIES: [string, unknown, boolean, string][] = [
  ['three entries', body(), true, ''],
  ['a 24-char label, n/a, an int 0, no tag or hint', body({ headline: [entry({ label: 'x'.repeat(24) }), entry({ value: 'n/a' }), entry({ value: 0 })] }), true, ''],
  ['every tag, a hint, warn', body({ health: 'warn', headline: [entry({ tag: '[V]', hint: 'h' }), entry({ tag: '[1]' }), entry({ tag: '[U]', value: -1.5 })] }), true, ''],
  ['fail health, an [API] tag', body({ health: 'fail', headline: [entry({ tag: '[API]' }), entry(), entry()] }), true, ''],
  ['a 25-char label', body({ headline: [entry({ label: 'y'.repeat(25) }), entry(), entry()] }), false, 'over 24'],
  ['a 30-char label', body({ headline: [entry({ label: 'y'.repeat(30) }), entry(), entry()] }), false, 'over 24'],
  ['a blank label', body({ headline: [entry({ label: ' ' }), entry(), entry()] }), false, 'label'],
  ['a numeric label', body({ headline: [entry({ label: 7 }), entry(), entry()] }), false, 'label'],
  ['2 entries', body({ headline: [entry(), entry()] }), false, 'not exactly 3'],
  ['4 entries', body({ headline: [entry(), entry(), entry(), entry()] }), false, 'not exactly 3'],
  ['0 entries', body({ headline: [] }), false, 'not exactly 3'],
  ['no as_of_ms', drop('as_of_ms'), false, 'missing as_of_ms'],
  ['as_of in seconds', body({ as_of_ms: AS_OF / 1000 }), false, 'seconds'],
  ['as_of a string', body({ as_of_ms: String(AS_OF) }), false, 'as_of_ms'],
  ['as_of a bool', body({ as_of_ms: true }), false, 'as_of_ms'],
  ['as_of a float', body({ as_of_ms: AS_OF + 0.5 }), false, 'as_of_ms'],
  ['no health', drop('health'), false, 'missing health'],
  ['health green', body({ health: 'green' }), false, 'health'],
  ['no headline', drop('headline'), false, 'missing headline'],
  ['headline an object', body({ headline: { a: 1 } }), false, 'not a list'],
  ['an entry not an object', body({ headline: ['x', entry(), entry()] }), false, 'not an object'],
  ['a bool value', body({ headline: [entry({ value: true }), entry(), entry()] }), false, 'value'],
  ['a null value', body({ headline: [entry({ value: null }), entry(), entry()] }), false, 'value'],
  ['a list value', body({ headline: [entry({ value: [1] }), entry(), entry()] }), false, 'value'],
  ['no value', body({ headline: [{ label: 'a' }, entry(), entry()] }), false, 'missing value'],
  ['an unknown tag', body({ headline: [entry({ tag: '[X]' }), entry(), entry()] }), false, 'tag'],
  ['an unbracketed tag', body({ headline: [entry({ tag: 'V' }), entry(), entry()] }), false, 'tag'],
  ['a non-string hint', body({ headline: [entry({ hint: 7 }), entry(), entry()] }), false, 'hint'],
  ['an unknown entry key', body({ headline: [entry({ pnl: 1 }), entry(), entry()] }), false, 'unknown key'],
  ['an unknown body key', body({ extra: 1 }), false, 'unknown key'],
  ['a list', [1, 2, 3], false, 'not a JSON object'],
  ['null', null, false, 'not a JSON object'],
]
const decl = (summary: unknown, o: Record<string, unknown> = {}) => ({ kind: 'dashboard', start: { port: 8793 }, summary, ...o })
const GOOD_DECL = { url: 'http://127.0.0.1:8793/api/summary', every: '1m' }
const DECLS: [string, Record<string, unknown>, boolean][] = [
  ['its own port', decl(GOOD_DECL), true],
  ['every 30s', decl({ ...GOOD_DECL, every: '30s' }), true],
  ['every 1h', decl({ ...GOOD_DECL, every: '1h' }), true],
  ['a foreign port', decl({ ...GOOD_DECL, url: 'http://127.0.0.1:8787/api/summary' }), false],
  ['a zero-padded port', decl({ ...GOOD_DECL, url: 'http://127.0.0.1:08793/api/summary' }), false],
  ['off loopback', decl({ ...GOOD_DECL, url: 'http://localhost:8793/api/summary' }), false],
  ['https', decl({ ...GOOD_DECL, url: 'https://127.0.0.1:8793/api/summary' }), false],
  ['no port', decl({ ...GOOD_DECL, url: 'http://127.0.0.1/api/summary' }), false],
  ['no path', decl({ ...GOOD_DECL, url: 'http://127.0.0.1:8793' }), false],
  // joined, so no URL scanner reads the planted userinfo as a host
  ['credentials', decl({ ...GOOD_DECL, url: 'http://' + 'u:p@127.0.0.1:8793/api/summary' }), false],
  ['a host that only starts like loopback', decl({ ...GOOD_DECL, url: 'http://127.0.0.1:8793.example.com/api/summary' }), false],
  ["every '1 min'", decl({ ...GOOD_DECL, every: '1 min' }), false],
  ["every '5'", decl({ ...GOOD_DECL, every: '5' }), false],
  ["every '1d'", decl({ ...GOOD_DECL, every: '1d' }), false],
  ['every an int', decl({ ...GOOD_DECL, every: 60 }), false],
  ['no every', decl({ url: GOOD_DECL.url }), false],
  ['no url', decl({ every: '1m' }), false],
  ['an unknown key', decl({ ...GOOD_DECL, port: 8793 }), false],
  ['not an object', decl('http://127.0.0.1:8793/api/summary'), false],
  ['on a tool', decl(GOOD_DECL, { kind: 'tool' }), false],
  ['on a service', decl(GOOD_DECL, { kind: 'service' }), false],
]

describe('the /api/summary contract', () => {
  it('the mirror judges every fixture body as written, naming the fault', () => {
    for (const [what, b, ok, frag] of BODIES) {
      const got = S.summaryProblems(b)
      if (ok) expect(got, what).toEqual([])
      else expect(got.some(g => g.includes(frag)), `${what}: ${JSON.stringify(got)}`).toBe(true)
    }
    // a non-finite number cannot arrive through JSON, but an object in hand can carry one
    expect(S.summaryProblems(body({ headline: [entry({ value: Number.NaN }), entry(), entry()] })).join()).toMatch(/NaN/)
    expect(S.summaryProblems(body({ headline: [entry({ value: Infinity }), entry(), entry()] })).length).toBe(1)
    // the label rule counts characters as Python does (code points), not UTF-16 units
    expect(S.summaryProblems(body({ headline: [entry({ label: '\u{1F600}'.repeat(24) }), entry(), entry()] }))).toEqual([])
    expect(S.summaryProblems(body({ headline: [entry({ label: '\u{1F600}'.repeat(25) }), entry(), entry()] })).join()).toMatch(/25 chars, over 24/)
  })

  it('the mirror judges every fixture declaration as written', () => {
    for (const [what, d, ok] of DECLS) expect(S.summaryDeclProblems(d).length === 0, `${what}: ${JSON.stringify(S.summaryDeclProblems(d))}`).toBe(ok)
    expect(S.summaryDeclProblems(decl(GOOD_DECL, { start: { port: 8794 } })).join()).toMatch(/not its own start\.port 8794/)
    expect(S.loopbackPort('http://127.0.0.1:8793/x')).toBe(8793)
    expect(S.summaryEveryMs('30s')).toBe(30_000)
    expect(S.summaryEveryMs('2h')).toBe(7_200_000)
  })

  it('judges an answer: a non-2xx, a non-JSON and a malformed body are unknown with the reason', () => {
    expect(S.judgeSummary(200, JSON.stringify(good), 5)).toEqual({ status: 'ok', body: good, ts: 5 })
    expect(S.judgeSummary(503, '{}', 5)).toEqual({ status: 'unknown', reason: 'HTTP 503', ts: 5 })
    expect(S.judgeSummary(200, '<html>', 5)).toEqual({ status: 'unknown', reason: 'not JSON', ts: 5 })
    const m = S.judgeSummary(200, JSON.stringify(body({ headline: [entry()] })), 5)
    expect(m.status).toBe('unknown')
    expect(m.status === 'unknown' && m.reason).toMatch(/^malformed: headline has 1 entries, not exactly 3/)
  })
})

// ---- 2. the Dash room polling the stub ----
describe('the Dash room reads each summary while the port is up', () => {
  it('a declared summary is read and shown: three tiles and the as-of; an undeclared one says none', async () => {
    answer = { status: 200, body: JSON.stringify(good) }
    const c = await post('/api/dash/carry/check')
    expect(c.status, JSON.stringify(c.json)).toBe(200)
    expect(c.json.summary).toMatchObject({ state: 'ok', url: `http://127.0.0.1:${STUB}/api/summary`, every: '1m', body: good })
    expect(c.json.summary.readAt).toBeGreaterThan(0)
    const l = await get('/api/dash')
    const carry = l.json.items.find((x: any) => x.id === 'carry')
    expect(carry.summary.body.headline).toHaveLength(3)
    expect(l.json.items.find((x: any) => x.id === 'quiet').summary).toEqual({ state: 'none', readAt: null })
    // what the card draws from it
    const m = cardModel(carry.summary, () => '3s ago')
    expect(m).toMatchObject({ dot: 'warn', line: 'as of 3s ago', asOf: AS_OF, stale: false })
    expect(m.tiles).toEqual([
      { label: 'best net ann %', value: '12.5', tag: '[API]', hint: '7D window, read 2026-09-26' },
      { label: 'ARB count', value: '3', tag: '[API]', hint: '' },
      { label: 'venues answering', value: 'n/a', tag: null, hint: 'stub' },
    ])
    expect(cardModel(l.json.items.find((x: any) => x.id === 'quiet').summary, () => '').line).toBe('no summary published')
  })

  it('each poll is a reading of dash:<id>/summary under its own target; the checks history never counts it', async () => {
    const { ops, settled } = await import('../server/db.ts')
    await settled()
    const rows = await ops.healthHistory('dash:carry/summary')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toMatchObject({ target: 'summary', status: 'warn', reading: 'best net ann % 12.5 | ARB count 3 | venues answering n/a' })
    const h = await get('/api/dash/history?h=1')
    const carry = h.json.items.find((x: any) => x.id === 'carry')
    const checkRuns = (await ops.healthReadingsSince('dash:carry/', 'dashboard', 0)).length
    expect(carry.runs).toBe(checkRuns)       // one run per check pass, the summary readings not among them
  })

  it('a malformed summary shows unknown with the reason, and keeps what it last said as last seen', async () => {
    answer = { status: 200, body: JSON.stringify(body({ headline: [entry({ label: 'z'.repeat(25) }), entry(), entry()] })) }
    const c = await post('/api/dash/carry/check')
    expect(c.json.summary.state).toBe('unknown')
    expect(c.json.summary.reason).toMatch(/^malformed: headline\[0\]: label "z{25}" is 25 chars, over 24/)
    expect(c.json.summary.body).toBeUndefined()
    expect(c.json.summary.last.body).toEqual(good)
    const m = cardModel(c.json.summary, () => '1s ago')
    expect(m.dot).toBe('unknown')
    expect(m.stale).toBe(true)
    expect(m.line).toMatch(/^unknown: malformed: .* - last seen 1s ago$/)
    // a server error and a non-JSON page are unknown too, each with its reason
    answer = { status: 500, body: 'boom' }
    expect((await post('/api/dash/carry/check')).json.summary).toMatchObject({ state: 'unknown', reason: 'HTTP 500' })
    answer = { status: 200, body: '<html></html>' }
    expect((await post('/api/dash/carry/check')).json.summary).toMatchObject({ state: 'unknown', reason: 'not JSON' })
    const { ops, settled } = await import('../server/db.ts')
    await settled()
    const [r] = await ops.healthHistory('dash:carry/summary', { limit: 1 })
    expect(r).toMatchObject({ status: 'unknown', reading: 'not JSON' })
  })

  it('port closed: stopped (known, not unknown), the last numbers kept dimmed, and no poll is made', async () => {
    answer = { status: 200, body: JSON.stringify(good) }
    await stopStub()
    const { pollSummary } = await import('../server/rooms/dash.ts')
    const { ops, settled } = await import('../server/db.ts')
    await settled()
    const before = (await ops.healthHistory('dash:carry/summary')).length
    const c = await post('/api/dash/carry/check')
    expect(c.json.portUp).toBe(false)
    expect(c.json.summary).toMatchObject({ state: 'stopped' })
    expect(c.json.summary.reason).toBeUndefined()
    expect(c.json.summary.body).toBeUndefined()
    expect(c.json.summary.last.body).toEqual(good)
    const m = cardModel(c.json.summary, () => '9m ago')
    expect(m).toMatchObject({ dot: 'off', line: 'stopped - last seen 9m ago', asOf: null, stale: true })
    expect(m.tiles).toHaveLength(3)
    // never polled and stopped: still "stopped", no tiles, nothing dimmed
    expect(cardModel({ state: 'stopped', readAt: null }, () => '')).toMatchObject({ dot: 'off', line: 'stopped', tiles: [], stale: false })
    // a port that was never measured stays unknown
    expect(cardModel({ state: 'unknown', reason: 'not read yet', readAt: null }, () => '').line).toBe('unknown: not read yet')
    const d = readDashboards(DASH).dashboards.find(x => x.id === 'carry')!
    expect(await pollSummary(d)).toBe(false)
    await settled()
    expect((await ops.healthHistory('dash:carry/summary')).length).toBe(before)
    // up again: the next poll reads it and the card is current
    await startStub()
    const back = await post('/api/dash/carry/check')
    expect(back.json.summary).toMatchObject({ state: 'ok', body: good })
  })

  it('right after a start an http check that timed out is run once more; later passes keep the first verdict', async () => {
    const { checkDashboard, view } = await import('../server/rooms/dash.ts')
    let hits = 0
    const api = createServer((_q, s) => { hits++; if (hits === 1) return void setTimeout(() => s.end('late'), 1500); s.statusCode = 200; s.end('{}') })
    const port = await freePort()
    await new Promise<void>(ok => api.listen(port, '127.0.0.1', ok))
    const d: any = { ...dash('slowapi', port, 9), health: [{ id: 'port', check: 'port', port }, { id: 'api', check: 'http', url: `http://127.0.0.1:${port}/api/health` }] }
    try {
      await checkDashboard(d, { afterStart: true, httpTimeoutMs: 200, retryMs: 20 })
      expect(hits).toBe(2)
      const v = await view(d)
      expect(v.checks.find(c => c.id === 'api')).toMatchObject({ status: 'ok' })
      expect(v.state).toBe('running')
      // not after a start: the timeout stands as the verdict, no second request
      hits = 0
      await checkDashboard(d, { httpTimeoutMs: 200, retryMs: 20 })
      expect(hits).toBe(1)
      expect((await view(d)).checks.find(c => c.id === 'api')).toMatchObject({ status: 'fail', reading: 'timeout' })
    } finally { api.closeAllConnections?.(); await new Promise<void>(ok => api.close(() => ok())) }
  })

  it('an unreachable declared url is unknown with the reason (readSummary never throws)', async () => {
    const dead = await freePort()
    const r = await S.readSummary({ url: `http://127.0.0.1:${dead}/api/summary`, every: '1m' }, { timeoutMs: 1500 })
    expect(r.status).toBe('unknown')
    expect(r.status === 'unknown' && r.reason).toMatch(/^unreachable: /)
    const off = await S.readSummary({ url: 'http://localhost:1/api/summary', every: '1m' })
    expect(off.status === 'unknown' && off.reason).toMatch(/is not http:\/\/127\.0\.0\.1/)
  })

  it('a dashboard.json whose summary breaks the declaration rule is named and left out', () => {
    const R = join(TMP, 'baddecl')
    mkdirSync(join(R, 'odds'), { recursive: true })
    writeFileSync(join(R, 'odds', 'dashboard.json'), JSON.stringify(dash('odds', 8850, 3, { summary: { url: 'http://127.0.0.1:8851/api/summary', every: '1m' } })))
    const r = readDashboards(R)
    expect(r.dashboards).toEqual([])
    expect(r.problems.map(p => p.error)).toEqual(['summary.url "http://127.0.0.1:8851/api/summary" is on port 8851, not its own start.port 8850'])
  })
})

// ---- 3. the scaffold: the summary declaration, the stub, and the ports it refuses ----
