// The standing sweep of EVERY room: headless Chrome opens each room and each of its views and
// targets (the first conversation, board item, dashboard, desk, book, agent and repo the API
// lists, every System view, every Loop range) and fails on any console error, page error, or API
// answer of 500 or worse.
//   node scripts/e2e-rooms.mjs [--url http://127.0.0.1:4688] [--width 1440] [--settle 1500] [--routes '#/chats,#/board']
// --routes skips the discovery (the API lists) and opens exactly those views.
// Read-only: it only navigates (hash routes) and reads; it clicks nothing. A fresh browser profile,
// so no remembered pane or selection leaks in. Exit 0 clean, 1 any error, 2 could not run.
import { chromium } from 'playwright-core'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const base = arg('--url', 'http://127.0.0.1:4688').replace(/\/$/, '')
const width = Number(arg('--width', 1440))
const settle = Number(arg('--settle', 1500))
const get = async p => { const r = await fetch(base + p, { signal: AbortSignal.timeout(60_000) }); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json() }
const enc = t => t.split('/').map(encodeURIComponent).join('/')

let routes = arg('--routes', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null
if (!routes) try {
  const [chats, board, dash, lib, libAgents, ctx, lab, git] = await Promise.all([
    get('/api/chats?limit=5'), get('/api/board'), get('/api/dash'), get('/api/library/books'),
    get('/api/library/agents'), get('/api/context'), get('/api/lab/runs').catch(() => null), get('/api/git/repos'),
  ])
  const first = (xs, f) => (Array.isArray(xs) && xs.length ? f(xs[0]) : null)
  routes = [
    '#/chats', first(chats.conversations, c => `#/chats/${enc(c.id)}`),
    '#/board', first(board.items, i => `#/board/${enc(i.id)}`),
    '#/dash', first(dash.dashboards ?? dash.items, d => `#/dash/${enc(d.id)}`),
    '#/library', first(lib.books, b => `#/library/${enc(b.path)}`), first(libAgents.agents, a => `#/library/${enc(`agent:${a.id}`)}`),
    '#/context', first(ctx.agents, a => `#/context/${enc(a.id)}`),
    '#/lab', first(lab?.desks ?? lab?.items, d => `#/lab/${enc(d.desk ?? d.id)}`),
    '#/loop', '#/loop/7d', '#/loop/all',
    '#/git', first(git.repos, r => `#/git/${enc(r.id)}`),
    ...['controls', 'health', 'schedule', 'spend', 'agents', 'connectors', 'remote'].map(v => `#/system/${v}`),
  ].filter(Boolean)
} catch (e) { console.error(`e2e-rooms: cannot read the API at ${base}: ${e.message}`); process.exit(2) }

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const bad = []
try {
  const page = await browser.newPage({ viewport: { width, height: Math.round(width * 0.5625) } })
  let here = ''
  page.on('console', m => { if (m.type() === 'error') bad.push(`${here}: console: ${m.text()}`) })
  page.on('pageerror', e => bad.push(`${here}: page error: ${e.message ?? e}`))
  page.on('response', r => {
    if (!r.url().startsWith(base + '/')) return
    // a 5xx is always an error; a 4xx is named (Chrome's console line for it carries no URL)
    if (r.status() >= 500) bad.push(`${here}: ${r.status()} ${r.url().slice(base.length)}`)
    else if (r.status() >= 400) console.log(`  (${here}: ${r.status()} ${r.url().slice(base.length)})`)
  })
  for (const route of routes) {
    here = route
    const before = bad.length
    const t0 = Date.now()
    // a full load per view (not a same-document hash change): every view fetches what it shows fresh
    await page.goto('about:blank')
    await page.goto(`${base}/${route}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => { /* the event stream keeps one request open */ })
    await page.waitForTimeout(settle)
    const text = (await page.locator('body').innerText().catch(() => '')).trim()
    if (!text) bad.push(`${route}: rendered nothing`)
    console.log(`${bad.length === before ? 'ok  ' : 'BAD '} ${route}  (${Date.now() - t0} ms)`)
  }
} finally { await browser.close() }
for (const b of bad) console.log(`  ${b}`)
console.log(`${routes.length} views, ${bad.length} error(s)`)
process.exit(bad.length ? 1 : 0)
