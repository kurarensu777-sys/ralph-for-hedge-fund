import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE UI BUILD: is dist/ current, rebuild it when it is not, and the landed-but-not-live tell.
 *
 * Shared by fundd (the activity bar's Reload asks POST /api/reload, B-0174) and scripts/prod.mjs
 * (start.cmd builds when stale), which imports this file straight through node's type stripping:
 * so node builtins only, and erasable TypeScript only (no enums, no parameter properties).
 * fundd serves dist/ from disk per request, so a rebuild goes live on the next page load with no
 * restart and no agent touched. The build takes the working tree as it sits, other conversations'
 * uncommitted UI edits included.
 */

type Newest = { t: number; f: string }

function newest(dir: string, acc: Newest = { t: 0, f: '' }): Newest {
  let names: import('node:fs').Dirent[] = []
  try { names = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of names) {
    const p = join(dir, e.name)
    if (e.isDirectory()) newest(p, acc)
    else { const t = statSync(p).mtimeMs; if (t > acc.t) { acc.t = t; acc.f = p } }
  }
  return acc
}

/** when dist/ was built (dist/index.html's mtime, written last by vite), null when there is none */
export function distBuiltAt(app: string): number | null {
  const built = join(app, 'dist', 'index.html')
  return existsSync(built) ? statSync(built).mtimeMs : null
}

/** why dist/ is out of date (a UI source newer than dist/index.html, or no dist/), null when current */
export function distStale(app: string): string | null {
  const t = distBuiltAt(app)
  if (t === null) return 'no dist/'
  const src = [newest(join(app, 'src')), newest(join(app, 'shared'))]
  for (const f of ['index.html', 'vite.config.ts', 'package.json']) { const p = join(app, f); if (existsSync(p)) src.push({ t: statSync(p).mtimeMs, f: p }) }
  const n = src.sort((a, b) => b.t - a.t)[0]
  return n && n.t > t ? `${n.f.slice(app.length + 1).replace(/\\/g, '/')} is newer than dist/` : null
}

export type BuildResult = { ok: boolean; ms: number; out: string }
export type BuildRunner = (app: string) => Promise<BuildResult>

/** vite build, run by node itself (no shell, no npx shim); the output's tail rides on a failure */
export const viteBuild: BuildRunner = app => new Promise(resolve => {
  const t0 = Date.now()
  let out = ''
  const child = spawn(process.execPath, [join(app, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { cwd: app, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const keep = (b: Buffer) => { out = (out + b.toString()).slice(-4000) }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  child.on('error', e => resolve({ ok: false, ms: Date.now() - t0, out: String(e.message) }))
  child.on('close', code => resolve({ ok: code === 0, ms: Date.now() - t0, out: out.trim() }))
})

/** ONE build at a time: a request that arrives while a build runs joins it (the same promise) */
export class BuildGate {
  runner: BuildRunner
  inflight: Promise<BuildResult> | null = null
  constructor(runner: BuildRunner) { this.runner = runner }
  get busy(): boolean { return this.inflight !== null }
  run(app: string): Promise<BuildResult> {
    if (!this.inflight) this.inflight = this.runner(app).finally(() => { this.inflight = null })
    return this.inflight
  }
}

export type ReloadAnswer = { mode: 'dist' | 'dev'; stale: string | null; built: boolean; ms: number | null }

/**
 * what Reload does before the page reloads: in dev (vite serves the source) nothing is ever built;
 * in production a stale dist/ is rebuilt through the gate. A failed build throws with vite's tail.
 */
export async function reloadCheck(app: string, o: { serveDist: boolean; gate: BuildGate; stale?: (app: string) => string | null }): Promise<ReloadAnswer> {
  if (!o.serveDist) return { mode: 'dev', stale: null, built: false, ms: null }
  const stale = (o.stale ?? distStale)(app)
  if (!stale && !o.gate.busy) return { mode: 'dist', stale: null, built: false, ms: null }
  const r = await o.gate.run(app)
  if (!r.ok) throw new Error(`vite build failed: ${r.out.split(/\r?\n/).slice(-6).join(' | ') || 'no output'}`)
  return { mode: 'dist', stale: stale ?? 'a build was already running', built: true, ms: r.ms }
}

export type LiveTimes = {
  serveDist: boolean
  started: number              // fundd's start (ms)
  dist: number | null          // dist/index.html's mtime (ms), null when there is none
  uiCommit: number | null      // newest commit touching the UI (src/, shared/), ms; null unread
  serverCommit: number | null  // newest commit touching the daemon (server/, shared/), ms; null unread
}
export type LiveTell = { uiStale: boolean; serverStale: boolean }

/**
 * landed but not live: dist/ older than the newest UI commit (production only; in dev vite serves
 * the source, so the UI is never stale), fundd started before the newest server commit. An unread
 * commit time is never a verdict; a production cockpit with no dist/ at all is stale.
 */
export function liveTell(t: LiveTimes): LiveTell {
  const uiStale = t.serveDist && t.uiCommit !== null && (t.dist === null || t.dist < t.uiCommit)
  const serverStale = t.serverCommit !== null && t.started < t.serverCommit
  return { uiStale, serverStale }
}

export type AutoBuildResult = 'dev' | 'current' | 'busy' | 'unread' | 'failed-before' | 'built' | 'failed'

/**
 * THE AUTO BUILD (the owner, 2026-09-28: "auto"): fundd rebuilds dist/ by itself once a UI commit
 * lands, so landed UI code needs no Reload click and no restart. Keyed on the COMMIT, never on file
 * mtimes, so a hand mid-edit in the working tree does not set it off; the build still takes the
 * working tree as it sits (like Reload). A failed build is not retried until a newer UI commit.
 */
export class AutoBuild {
  failedFor: number | null = null
  o: { serveDist: boolean; app: string; gate: BuildGate; uiCommit: () => Promise<number | null>; dist: (app: string) => number | null; log: (m: string) => void }
  constructor(o: AutoBuild['o']) { this.o = o }
  async tick(): Promise<AutoBuildResult> {
    const o = this.o
    if (!o.serveDist) return 'dev'
    if (o.gate.busy) return 'busy'
    const commit = await o.uiCommit()
    if (commit === null) return 'unread'
    const dist = o.dist(o.app)
    if (dist !== null && dist >= commit) return 'current'
    if (this.failedFor === commit) return 'failed-before'
    const r = await o.gate.run(o.app)
    if (!r.ok) {
      this.failedFor = commit
      o.log(`UI auto-build failed (kept the old dist/): ${r.out.split(/\r?\n/).slice(-6).join(' | ') || 'no output'}`)
      return 'failed'
    }
    this.failedFor = null
    o.log(`UI rebuilt by itself for a landed UI commit in ${Math.round(r.ms / 1000)}s`)
    return 'built'
  }
}
