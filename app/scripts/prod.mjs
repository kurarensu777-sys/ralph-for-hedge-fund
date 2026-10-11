// node scripts/prod.mjs [--foreground] [--no-open] [--build] [--status] [--stop]
// PRODUCTION MODE: one detached fundd serving the built UI AND the API on one port (:4688 by
// default, FUND_UI_PORT overrides), outliving the window that started it. Idempotent: a cockpit
// already answering (prod on the UI port, or `npm run dev` with its fundd on :4689) with the same
// data dir is ADOPTED, never restarted and never doubled (two fundds on one database would run
// two schedulers). Development stays `npm run dev` (fundd :4689 + vite :4688).
//   --foreground  run fundd ATTACHED to this console (stdio inherited): closing the window or
//              Ctrl+C stops it. What start.bat uses. Without it fundd is detached and logs to a file.
//   --build    rebuild the UI even when dist/ looks current
//   --status   print what is running and exit (0 up, 1 down)
//   --stop     ASK the prod fundd this script started to leave: it saves the open conversations and
//              REFUSES (exit 1) while a turn, a decision, background work or a terminal command runs
//   --force    with --stop: leave anyway, cutting what runs (saved; reopened with a note on the next start)
//   --no-open  do not open the browser
//   --supervise  (internal) the detached supervisor: runs fundd, starts it again when it exits to
//              restart (server/restart.ts RESTART_CODE, new server code taken at an idle moment)
// fundd always runs UNDER A SUPERVISOR here (this script in --foreground, a detached copy of it
// otherwise), so it may restart itself for landed server code: FUND_SUPERVISED=1 tells it so.
// Windows has no exec, so the supervisor, not fundd, starts the next fundd (server/restart.ts).
// Env: FUND_UI_PORT (prod port, 4688) · FUNDD_PORT (the dev fundd port to look for, 4689) ·
// FUND_DATA_DIR (~/fund-data) · FUND_SCHEDULER=0 (a test instance that must run no jobs).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { distStale as staleIn } from '../server/uibuild.ts'   // node strips the types; fundd's Reload uses the same check
import { stopProd, supervise } from '../server/restart.ts'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const has = k => process.argv.includes(k)
const PORT = Number(process.env.FUND_UI_PORT ?? 4688)
const DEV_FUNDD = Number(process.env.FUNDD_PORT ?? 4689)
const DATA = resolve(process.env.FUND_DATA_DIR ?? join(homedir(), 'fund-data'))
const PIDFILE = join(DATA, `fundd-prod-${PORT}.json`)
const LOG = join(DATA, 'logs', `fundd-prod-${PORT}.log`)
const URL = `http://127.0.0.1:${PORT}/`
const say = m => console.log(`[cockpit] ${m}`)

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500) })
    const j = await r.json()
    return j && j.ok ? j : null
  } catch { return null }
}
const sameData = h => h && typeof h.dataDir === 'string' && resolve(h.dataDir).toLowerCase() === DATA.toLowerCase()
const readPid = () => { try { return JSON.parse(readFileSync(PIDFILE, 'utf8')) } catch { return null } }
const open = () => { if (!has('--no-open')) spawn('cmd', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref() }

/** what is up: a prod fundd on PORT, or dev (vite on PORT proxying to a fundd on DEV_FUNDD) */
async function look() {
  const onPort = await health(PORT)
  const dev = await health(DEV_FUNDD)
  const pid = readPid()
  const prod = onPort && pid && pid.pid === onPort.pid ? onPort : null
  return { onPort, dev, prod, pid }
}

const FUNDD_ARGS = ['--import', 'tsx', 'server/fundd.ts', '--serve-dist']
const funddEnv = () => ({ ...process.env, FUNDD_PORT: String(PORT), FUND_DATA_DIR: DATA, FUND_MODE: 'prod', FUND_SUPERVISED: '1' })
const writePid = (pid, log) => writeFileSync(PIDFILE, JSON.stringify({ pid, port: PORT, started: Date.now(), log, supervisor: process.pid }, null, 2))

/** fundd under this process, again after each restart exit; resolves with the exit that ended it */
function superviseFundd(log, said) {
  return supervise({
    start: () => {
      const child = spawn(process.execPath, FUNDD_ARGS, { cwd: APP, stdio: 'inherit', env: funddEnv() })
      return { pid: child.pid, exited: new Promise(r => { child.on('exit', c => r(c)); child.on('error', () => r(1)) }) }
    },
    started: (pid, n) => { writePid(pid, log); if (n) say(`fundd restarted: pid ${pid}`); else said?.(pid) },
    log: say,
  })
}

function run(cmd, args) {
  const r = spawnSync([cmd, ...args].join(' '), { cwd: APP, stdio: 'inherit', shell: true, windowsHide: true })   // npm/npx are .cmd shims: a shell, fixed args only
  return r.status ?? 1
}

async function main() {
  if (has('--supervise')) {   // the detached supervisor (below): stdio is the log file
    const code = await superviseFundd(LOG)
    rmSync(PIDFILE, { force: true })
    say(`fundd exited (${code ?? 'signal'}): the supervisor stops`)
    process.exit(code ?? 0)
  }
  const s = await look()

  if (has('--status')) {
    if (s.prod) say(`prod fundd pid ${s.prod.pid} on :${PORT} (UI + API), data ${s.prod.dataDir}`)
    else if (s.onPort) say(`:${PORT} answers (pid ${s.onPort.pid}${s.dev && s.dev.pid === s.onPort.pid ? ', the dev fundd behind vite' : ''}), not this script's prod fundd`)
    else say(`nothing answers on :${PORT}`)
    if (s.dev) say(`dev fundd pid ${s.dev.pid} on :${DEV_FUNDD}`)
    process.exit(s.onPort || s.dev ? 0 : 1)
  }

  if (has('--stop')) {
    if (!s.prod) { say(s.onPort ? `:${PORT} is not this script's prod fundd: left alone` : `no prod fundd on :${PORT}`); rmSync(PIDFILE, { force: true }); return }
    say(`stopping prod fundd pid ${s.prod.pid}${has('--force') ? ' (--force: whatever runs is cut, saved and reopened with a note)' : ''}`)
    // ASK it to leave (B-0254: a kill at 12:54:46Z 2026-09-27 cut three running turns, saved nothing):
    // refused while work runs, unless --force; the kill is the fallback for a fundd that cannot be asked
    const code = await stopProd({
      leave: async force => {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/api/system/leave`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force, who: 'stopped by prod.mjs --stop' }), signal: AbortSignal.timeout(15_000) })
          return { status: r.status, body: await r.json().catch(() => ({})) }
        } catch { return null }
      },
      gone: async () => !(await health(PORT)),
      kill: async () => {
        // the supervisor first (alone), so it cannot start another fundd; then fundd and its tree
        if (s.pid.supervisor && s.pid.supervisor !== process.pid) spawnSync('taskkill', ['/PID', String(s.pid.supervisor), '/F'], { windowsHide: true, stdio: 'ignore' })
        spawnSync('taskkill', ['/PID', String(s.prod.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        for (let i = 0; i < 20 && await health(PORT); i++) await new Promise(r => setTimeout(r, 500))
      },
      say,
    }, has('--force'))
    if (!code) rmSync(PIDFILE, { force: true })
    process.exit(code)
  }

  // ADOPT: one fundd per data dir, whichever mode started it
  if (s.onPort && (sameData(s.onPort) || !s.onPort.dataDir)) { say(`adopted: :${PORT} is up (${s.prod ? 'prod' : 'dev'} fundd pid ${s.onPort.pid})`); open(); return }
  if (s.onPort) { say(`:${PORT} is taken by a fundd on another data dir (${s.onPort.dataDir}); not starting`); process.exit(1) }
  if (s.dev && sameData(s.dev)) { say(`the dev fundd (pid ${s.dev.pid}, :${DEV_FUNDD}) owns ${DATA} but no UI answers on :${PORT}; start its UI with npm run dev, or stop it first`); process.exit(1) }

  if (!existsSync(join(APP, 'node_modules', 'vite')) || !existsSync(join(APP, 'node_modules', 'tsx'))) {
    say('first run: installing packages')
    if (run('npm', ['install'])) process.exit(1)
  }
  const stale = has('--build') ? 'asked' : staleIn(APP)
  if (stale) {
    say(`building the UI (${stale})`)
    if (run('npx', ['vite', 'build', '--logLevel', 'warn'])) { say('vite build failed'); process.exit(1) }
  }

  if (has('--foreground')) {
    // this window supervises: fundd attached to it, started again after a restart exit
    let ended = false
    superviseFundd('console', pid => say(`fundd pid ${pid} on :${PORT} - this window IS the cockpit: close it or press Ctrl+C to stop`))
      .then(code => { ended = true; rmSync(PIDFILE, { force: true }); say(`fundd exited (${code ?? 'signal'})`); process.exit(code ?? 0) })
    for (let i = 0; i < 60 && !ended; i++) {
      if (await health(PORT)) { say(`up: ${URL}`); open(); return }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!ended) say(`fundd did not answer on :${PORT} within 30 s; it is still running here`)
    return
  }

  // detached: a copy of this script in --supervise mode runs fundd and outlives this window
  mkdirSync(dirname(LOG), { recursive: true })
  const fd = openSync(LOG, 'a')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervise'], { cwd: APP, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: funddEnv() })
  child.unref()
  say(`supervisor pid ${child.pid} starting fundd on :${PORT} (log ${LOG})`)
  for (let i = 0; i < 60; i++) {
    const h = await health(PORT)
    if (h) { say(`up: ${URL}`); open(); return }
    if (child.exitCode !== null) break
    await new Promise(r => setTimeout(r, 500))
  }
  // fundd refuses to start without its store (server/db.ts reach): say why here, not only in the log
  let why = ''
  try { why = readFileSync(LOG, 'utf8').split(/\r?\n/).filter(l => l.includes('REFUSING TO START')).pop() ?? '' } catch { /* no log */ }
  say(why ? why.replace(/^\[fundd\]\s*/, 'fundd ') : `fundd did not answer on :${PORT} within 30 s; read ${LOG}`)
  process.exit(1)
}

main().catch(e => { console.error(`[cockpit] ${e?.stack ?? e}`); process.exit(1) })
