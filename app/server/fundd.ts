import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import type { ServiceGroup } from '../shared/types.ts'
import { StoreDown, closeAll, logEvent, migrate, reach, settled, whereText } from './db.ts'
import { publish, register as registerEvents } from './events.ts'
import { restartHolders, stopAll, summary } from './hooks.ts'
import { refuseRequest, refuseUpgrade } from './gate.ts'
import { HttpError, Router, json, safeDecode } from './http.ts'
import { git as runGit } from './git/run.ts'
import { startPlanPoll } from './chat/planlimit.ts'
import { AutoBuild, BuildGate, distBuiltAt, liveTell, reloadCheck, viteBuild } from './uibuild.ts'
import { APP_ROOT, FUND_ROOT, PORT, DATA_DIR } from './paths.ts'
import { floorStopped } from './system/floor.ts'
import { JOURNAL_BEAT_MS, Restarter, restoreAtBoot, writeAtomic } from './restart.ts'
import { watchConfig } from './config.ts'
import * as board from './rooms/board.ts'
import * as chats from './rooms/chats.ts'
import * as context from './rooms/context.ts'
import * as dash from './rooms/dash.ts'
import * as data from './rooms/data.ts'
import * as git from './rooms/git.ts'
import * as lab from './rooms/lab.ts'
import * as library from './rooms/library.ts'
import * as loop from './rooms/loop.ts'
import * as map from './rooms/map.ts'
import * as research from './rooms/research.ts'
import * as system from './rooms/system.ts'
import { startReaper, sweepOrphans } from './system/hands.ts'

/**
 * fundd - the cockpit daemon. It owns every live thing (agent conversations, terminals,
 * dashboard processes, jobs) so the UI can reload without killing any of them. Its record is the
 * ops store (PostgreSQL through @fund/db): fundd REFUSES TO START when the store does not answer -
 * a cockpit that cannot record would show zeros it never measured - and brings the store's schema
 * current (database/ owns the migrations) before any room registers.
 */
const ROOMS = { chats, board, dash, data, library, context, lab, research, loop, git, system, map }
const STARTED = Date.now()

try {
  await reach()
  const ran = await migrate(s => console.log(`[fundd] ${s}`))
  if (ran.length) console.log(`[fundd] ops store: ${ran.length} migration(s) applied`)
} catch (e) {
  console.error(`[fundd] REFUSING TO START: ${e instanceof StoreDown ? e.message : `the ops store could not be brought current: ${(e as Error)?.message ?? e}`}`)
  await closeAll().catch(() => {})
  process.exit(1)
}
const router = new Router()
registerEvents(router)
for (const room of Object.values(ROOMS)) room.register(router)

router.get('/api/health', () => ({ ok: true, pid: process.pid, started: STARTED, fundRoot: FUND_ROOT, dataDir: DATA_DIR }))
router.get('/api/system/summary', () => summary())
// production: fundd serves the built UI from dist/ (read from disk per request)
const SERVE_DIST = process.argv.includes('--serve-dist')

/** Reload (the activity bar): rebuild a stale dist/ first, one build at a time, so landed UI code
 *  is live on the page load that follows. Dev answers that no build is needed (vite serves src/). */
const UI_BUILD = new BuildGate(viteBuild)
router.post('/api/reload', async () => {
  try {
    const a = await reloadCheck(APP_ROOT, { serveDist: SERVE_DIST, gate: UI_BUILD })
    if (a.built) void logEvent('system', `UI rebuilt for Reload (${a.stale}) in ${Math.round((a.ms ?? 0) / 1000)}s`)
    return a
  } catch (e) { throw new HttpError(500, String((e as Error)?.message ?? e)) }
})

/** the landed-but-not-live tell: fundd's start, dist/'s build and the newest commits, with the verdict */
const lastCommit = async (paths: string[]) => {
  const r = await runGit(APP_ROOT, ['log', '-1', '--format=%ct', '--', ...paths], 10_000)
  const s = Number(r.stdout.trim())
  return r.code === 0 && s > 0 ? s * 1000 : null
}
// the auto build: a landed UI commit goes live with no click; the tabs pick it up (src/shell/uifresh.ts)
const AUTO_BUILD = new AutoBuild({
  serveDist: SERVE_DIST, app: APP_ROOT, gate: UI_BUILD, uiCommit: () => lastCommit(['src', 'shared']), dist: distBuiltAt,
  log: m => { console.log(`[fundd] ${m}`); void logEvent('system', m) },
})
setInterval(() => { void AUTO_BUILD.tick().then(r => { if (r === 'built' || r === 'failed') publish('git', { ui: r }) }).catch(() => { /* next tick */ }) }, 60_000).unref()
router.get('/api/health/live', async () => {
  const [uiCommit, serverCommit, head] = await Promise.all([lastCommit(['src', 'shared']), lastCommit(['server', 'shared']), lastCommit([])])
  const times = { serveDist: SERVE_DIST, started: STARTED, dist: distBuiltAt(APP_ROOT), uiCommit, serverCommit }
  return { ...times, head, ...liveTell(times), restart: RESTART.status }
})

/**
 * THE IDLE RESTART (B-0174 part 2, server/restart.ts): new server code goes live at the first idle
 * moment, only under the supervisor (scripts/prod.mjs sets FUND_SUPERVISED=1 and starts the next
 * fundd when this one exits with RESTART_CODE). The open conversations are saved to LIVE_FILE and the
 * next fundd reopens them; BOOT_FILE holds the last start, the crash-loop guard.
 */
const LIVE_FILE = join(DATA_DIR, `fundd-live-${PORT}.json`)
const BOOT_FILE = join(DATA_DIR, `fundd-boot-${PORT}.json`)
const RESTART = new Restarter({
  now: Date.now,
  started: STARTED,
  supervised: process.env.FUND_SUPERVISED === '1',
  serverCommit: () => lastCommit(['server', 'shared']),
  blockers: async () => [...(await Promise.all(restartHolders().map(h => h.busy()))).flat(), ...(UI_BUILD.busy ? ['a UI build'] : [])],
  live: () => restartHolders().flatMap(h => h.live?.() ?? []),
  save: s => writeAtomic(LIVE_FILE, JSON.stringify(s, null, 2)),
  shutdown: async () => { for (const h of restartHolders()) { try { await h.close?.() } catch { /* the rest still close */ } } await leave() },
  exit: code => process.exit(code),
  log: m => { console.log(`[fundd] ${m}`); void logEvent('system', m) },
})
setInterval(() => { void RESTART.tick() }, 15_000).unref()
// THE JOURNAL (B-0254): the live file is kept current, so a kill or a crash still reopens what was open
for (const h of restartHolders()) h.watch?.(() => RESTART.journal())
setInterval(() => { RESTART.journal(true) }, JOURNAL_BEAT_MS).unref()
/** the owner's restart: at the next idle moment, or {force: true} now (a cut-off turn says so on reopen) */
router.post('/api/restart', async ({ body }) => {
  const b = await body()
  if (b?.force) {   // answer first: the exit would cut this very response off
    setTimeout(() => { void RESTART.request(true) }, 250)
    return { tick: 'restarting', ...RESTART.status, forced: true }
  }
  const tick = await RESTART.request(false)
  return { tick, ...RESTART.status }
})

/**
 * LEAVE for good (prod.mjs --stop, B-0254): refused (409) while a turn, a decision, background work or
 * a terminal command runs, unless {force}; the open conversations are saved for the next start first
 */
router.post('/api/system/leave', async ({ body }) => {
  const b = await body()
  const force = b?.force === true
  const who = typeof b?.who === 'string' && b.who.trim() ? b.who.trim().slice(0, 80) : 'stopped'
  if (!force) {
    const waitingOn = await RESTART.d.blockers().catch(e => [`the idle check failed: ${(e as Error)?.message ?? e}`])
    if (waitingOn.length) throw new HttpError(409, `fundd is not idle: ${waitingOn.join('; ')}`)
  }
  setTimeout(() => { void RESTART.leave(force, who) }, 250)   // answer first: the exit would cut this response off
  return { left: true }
})

router.post('/api/system/stop', async () => { await stopAll(); logEvent('system', 'STOP pressed'); publish('services'); return { ok: true } })

/** the services rail: one group per room that has something to report */
router.get('/api/services', async () => {
  const core: ServiceGroup = { id: 'core', label: 'Core', rows: [
    { id: 'fundd', label: 'fundd', status: 'ok', reading: `up ${fmtAge(Date.now() - STARTED)}`, room: 'system' },
  ] }
  const groups = await Promise.all(Object.values(ROOMS).map(r => r.services().catch(() => null)))
  return { groups: [core, ...groups.filter((g): g is ServiceGroup => !!g && g.rows.length > 0)] }
})

function fmtAge(ms: number) {
  const m = Math.floor(ms / 60000)
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

const DIST = join(APP_ROOT, 'dist')
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' }

const server = createServer((req, res) => {
  serve(req, res).catch(e => {
    console.error(`[fundd] ${req.method} ${req.url}:`, e)
    if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) })
    else res.destroy()
  })
})

async function serve(req: IncomingMessage, res: ServerResponse) {
  const refused = refuseRequest(req)
  if (refused) return json(res, 403, { error: refused })
  if (await router.handle(req, res)) return
  if (req.url?.startsWith('/api/')) return json(res, 404, { error: `no route ${req.method} ${req.url}` })
  if (SERVE_DIST && req.method === 'GET') {
    const decoded = safeDecode(new URL(req.url ?? '/', 'http://x').pathname)
    if (decoded === null) return json(res, 400, { error: 'malformed percent-encoding in path' })
    const path = normalize(decoded).replace(/^([\\/])+/, '')
    let file = join(DIST, path)
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
    if (existsSync(file)) {
      res.writeHead(200, { 'content-type': (TYPES[extname(file)] ?? 'application/octet-stream') + (extname(file) === '.html' ? '; charset=utf-8' : '') })
      return void createReadStream(file).pipe(res)
    }
  }
  json(res, 404, { error: 'not found' })
}

// one bad request must never exit the daemon: log, never crash
process.on('unhandledRejection', e => console.error('[fundd] unhandled rejection:', e))

server.on('upgrade', (req, socket, head) => {
  const refused = refuseUpgrade(req)
  if (refused) { socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${refused}`); return }
  if (!router.upgrade(req, socket, head)) socket.destroy()
})

server.listen(PORT, '127.0.0.1', () => {
  watchConfig()
  system.startScheduler()
  // the idle-hand reaper (B-0420); the orphan sweep reads the whole machine, so a scratch fundd leaves it to the real one
  startReaper()
  startPlanPoll()
  if (process.env.FUND_SCHEDULER !== '0') void sweepOrphans(m => { console.log(`[fundd] ${m}`) }).catch(e => console.error('[fundd] orphan sweep:', e))
  // reopen what the previous fundd saved when it restarted for new code (never on a crash loop)
  void restoreAtBoot({
    now: Date.now, pid: process.pid, bootFile: BOOT_FILE, liveFile: LIVE_FILE,
    reopen: async (id, r) => { for (const h of restartHolders()) if (h.reopen) return h.reopen(id, r) },
    // the hard-stop scan reads the SHARED store: only the instance that runs the scheduler (never a
    // scratch fundd with FUND_SCHEDULER=0) looks for cut turns outside its own saved list
    ...(process.env.FUND_SCHEDULER === '0' ? {} : { scan: async (since: number, exclude: Set<string>) => (await Promise.all(restartHolders().map(h => h.scan?.(since, exclude) ?? []))).flat() }),
    stopped: () => floorStopped(),
    log: m => { console.log(`[fundd] ${m}`); void logEvent('system', m) },
  }).catch(e => console.error('[fundd] restore after restart:', e))
  void logEvent('system', `fundd up on :${PORT}`)
  console.log(`[fundd] http://127.0.0.1:${PORT}  fund=${FUND_ROOT}  data=${DATA_DIR}  store=${whereText()}`)
})

// a clean exit lets the queued records land (bounded: a store that went away never holds it up)
async function leave() {
  server.close()
  await Promise.race([settled(), new Promise(r => setTimeout(r, 3_000).unref())])
  await closeAll().catch(() => {})
}
async function shutdown() {
  await leave()
  process.exit(0)
}
// a signal ends fundd unplanned: freeze the journal first, so the agents dying with it (Ctrl+C reaches
// the whole console) do not empty the list the next fundd reopens
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { RESTART.freeze(); void shutdown() })
