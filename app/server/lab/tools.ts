import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The cockpit runs the loop's OWN tools; it never re-implements their contract.
 *   preregister.py  - synchronous; its REFUSED line is shown verbatim
 *   remeasure.py    - async (it re-runs an engine: minutes to an hour); logged under
 *                     <DATA_DIR>/logs/lab/, and `onChange` fires on start and on exit
 * Both run as `<fund>/.venv python app/loop/tools/<tool>.py ...` with cwd = the fund root, no shell,
 * every value passed as `--flag=value` so a band like `-6..-2` can never parse as a flag.
 */

export type SpawnFn = (exe: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean; shell: false; stdio?: any }) => ChildProcess
export type ToolDeps = { python: string; fundRoot: string; env: NodeJS.ProcessEnv; spawn?: SpawnFn }

const DESK = /^lab(\/[A-Za-z0-9_.-]+)+$/
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/

export class BadInput extends Error {}

export function checkDesk(desk: unknown): string {
  const d = String(desk ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!DESK.test(d) || d.split('/').includes('..')) throw new BadInput('desk must be a lab/... folder')
  return d
}

export type PreregForm = {
  desk: string; run: string; mechanic: string; kind: string
  variant?: string; experiment?: string; ancestor?: string; variables?: string[]
  predict?: string[]; judge?: string[]; belief?: string[]
  cmd?: string; cwd?: string; window?: string; from?: string; to?: string
  hours?: number | string; regimes?: number | string; comparator?: string
  metricPattern?: string[]; title?: string; note?: string
  dry?: boolean
}

const one = (v: unknown) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim()
const many = (v: unknown) => (Array.isArray(v) ? v : []).map(one).filter(Boolean)

/**
 * The form -> preregister.py argv. Only SHAPE is checked here (a desk path, a single-token run,
 * a known cwd); every CONTRACT refusal - mechanic, ancestor, band, window, belief - is the tool's,
 * so the cockpit can never be looser or stricter than the ledger's own gate.
 */
export function preregArgs(f: PreregForm): string[] {
  const desk = checkDesk(f.desk)
  const run = one(f.run)
  if (!TOKEN.test(run)) throw new BadInput('run must be a single token, e.g. 009')
  const cwd = one(f.cwd) || 'platform'
  if (!['platform', 'research'].includes(cwd) && !cwd.startsWith('research/')) throw new BadInput('cwd must be platform or research')
  if (cwd.includes('..')) throw new BadInput('cwd must stay inside the fund')
  const window = one(f.window) || (one(f.from) || one(f.to) ? `${one(f.from)}..${one(f.to)}` : '')
  const a: string[] = ['app/loop/tools/preregister.py', `--desk=${desk}`, `--run=${run}`, `--mechanic=${one(f.mechanic)}`, `--kind=${one(f.kind) || 'exploit'}`]
  const opt = (flag: string, v: unknown) => { const s = one(v); if (s) a.push(`--${flag}=${s}`) }
  opt('variant', f.variant)
  opt('experiment', f.experiment)
  opt('ancestor', f.ancestor)
  for (const v of many(f.variables)) a.push(`--variables=${v}`)
  for (const v of many(f.predict)) a.push(`--predict=${v}`)
  for (const v of many(f.judge)) a.push(`--judge=${v}`)
  for (const v of many(f.belief)) a.push(`--belief=${v}`)
  opt('cmd', f.cmd)
  a.push(`--cwd=${cwd}`)
  opt('window', window)
  const int = (flag: string, v: unknown) => { const s = one(v); if (!s) return; if (!/^\d+$/.test(s)) throw new BadInput(`${flag} must be a whole number`); a.push(`--${flag}=${s}`) }
  int('hours', f.hours)
  int('regimes', f.regimes)
  opt('comparator', f.comparator)
  for (const v of many(f.metricPattern)) a.push(`--metric-pattern=${v}`)
  opt('title', f.title)
  opt('note', f.note)
  a.push('--provenance=[API]')
  if (f.dry) a.push('--dry')
  else a.push('--json')
  return a
}

export function readArgs(desk: string, run: string, age: string, dry: boolean): string[] {
  const d = checkDesk(desk)
  const r = one(run)
  if (!TOKEN.test(r)) throw new BadInput('run must be a single token')
  if (age !== '7d' && age !== '30d') throw new BadInput('age must be 7d or 30d')
  return ['app/loop/tools/remeasure.py', `--desk=${d}`, `--run=${r}`, `--age=${age}`, ...(dry ? ['--dry'] : ['--json'])]
}

export type ToolOut = { code: number | null; stdout: string; stderr: string; ms: number }

/** run a loop tool to completion (bounded); stdout/stderr kept whole up to 1 MB each */
export function runTool(deps: ToolDeps, args: string[], timeoutMs = 120_000): Promise<ToolOut> {
  const t0 = Date.now()
  const sp = deps.spawn ?? (nodeSpawn as unknown as SpawnFn)
  return new Promise(res => {
    let out = '', err = '', settled = false
    let child: ChildProcess
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); res({ code, stdout: out, stderr: err, ms: Date.now() - t0 }) }
    try {
      child = sp(deps.python, args, { cwd: deps.fundRoot, env: { ...deps.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true, shell: false })
    } catch (e: any) { res({ code: -1, stdout: '', stderr: String(e?.message ?? e), ms: 0 }); return }
    const timer = setTimeout(() => { err += `\n[cockpit] killed after ${Math.round(timeoutMs / 1000)}s`; try { child.kill() } catch { /* gone */ } }, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => { if (out.length < 1 << 20) out += b.toString('utf8') })
    child.stderr?.on('data', (b: Buffer) => { if (err.length < 1 << 20) err += b.toString('utf8') })
    child.on('error', e => { err += String(e.message); finish(-1) })
    child.on('close', code => finish(code))
  })
}

/** the tool's own `REFUSED: ...` line(s), verbatim; null when the tool did not refuse */
export function refusalOf(o: ToolOut): string | null {
  if (o.code !== 1) return null
  const lines = o.stderr.split(/\r?\n/).filter(l => l.startsWith('REFUSED:'))
  return lines.length ? lines.join('\n') : (o.stderr.trim() || o.stdout.trim() || 'refused (no message)')
}

// ---- remeasure jobs ----

export type ReadJob = {
  key: string                  // "<desk>#<run>@<age>"
  desk: string; run: string; age: string; dry: boolean
  started: number; ended: number | null; code: number | null
  log: string                  // absolute path of the log file
  tail: string                 // last ~2 KB of output
}

export type JobDeps = ToolDeps & { logDir: string; timeoutMs?: number; onChange?: (j: ReadJob) => void }

const slug = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_')
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

export class ReadJobs {
  private jobs = new Map<string, ReadJob>()
  constructor(private deps: JobDeps) {}

  list(): ReadJob[] { return [...this.jobs.values()].sort((a, b) => b.started - a.started) }
  get(key: string): ReadJob | undefined { return this.jobs.get(key) }
  running(): ReadJob[] { return this.list().filter(j => j.ended === null) }

  /** start one read in the background; a second start of the same read while it runs is refused */
  start(desk: string, run: string, age: string, dry = false): ReadJob {
    const args = readArgs(desk, run, age, dry)
    const key = `${checkDesk(desk)}#${run}@${age}`
    if (this.jobs.get(key)?.ended === null) throw new BadInput(`the ${age} read for ${run} is already running`)
    mkdirSync(this.deps.logDir, { recursive: true })
    const started = Date.now()
    const log = join(this.deps.logDir, `${slug(desk.replace(/^lab\//, ''))}__${slug(run)}__${age}__${stamp(started)}${dry ? '__dry' : ''}.log`)
    const job: ReadJob = { key, desk: checkDesk(desk), run, age, dry, started, ended: null, code: null, log, tail: '' }
    this.jobs.set(key, job)
    const fd = openSync(log, 'a')
    const w = (s: string) => { try { writeSync(fd, s) } catch { /* closed */ } job.tail = (job.tail + s).slice(-2000) }
    w(`# ${this.deps.python} ${args.join(' ')}\n# cwd ${this.deps.fundRoot}\n# started ${new Date(started).toISOString()}\n\n`)
    const sp = this.deps.spawn ?? (nodeSpawn as unknown as SpawnFn)
    let child: ChildProcess | null = null
    let timer: NodeJS.Timeout | null = null
    const done = (code: number | null, why?: string) => {
      if (job.ended !== null) return
      if (timer) clearTimeout(timer)
      if (why) w(`\n[cockpit] ${why}\n`)
      job.ended = Date.now(); job.code = code
      w(`\n# exit ${code} after ${((job.ended - started) / 1000).toFixed(1)}s\n`)
      try { closeSync(fd) } catch { /* closed */ }
      this.deps.onChange?.(job)
    }
    try {
      child = sp(this.deps.python, args, { cwd: this.deps.fundRoot, env: { ...this.deps.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, windowsHide: true, shell: false })
    } catch (e: any) { done(-1, `spawn failed: ${e?.message ?? e}`); return job }
    const to = this.deps.timeoutMs ?? 3_700_000   // remeasure's own --timeout is 3600 s; this is the backstop
    timer = setTimeout(() => { w(`\n[cockpit] killed after ${Math.round(to / 1000)}s\n`); try { child?.kill() } catch { /* gone */ } }, to)
    child.stdout?.on('data', (b: Buffer) => w(b.toString('utf8')))
    child.stderr?.on('data', (b: Buffer) => w(b.toString('utf8')))
    child.on('error', e => done(-1, `spawn error: ${e.message}`))
    child.on('close', code => done(code))
    this.deps.onChange?.(job)
    return job
  }
}

/** the lab log folder's most recent files (reads started before a fundd restart are still here) */
export function recentLogs(logDir: string, n = 20): { name: string; mtime: number; size: number }[] {
  let names: string[] = []
  try { names = readdirSync(logDir).filter(x => x.endsWith('.log')) } catch { return [] }
  return names.map(name => { const s = statSync(join(logDir, name)); return { name, mtime: s.mtimeMs, size: s.size } })
    .sort((a, b) => b.mtime - a.mtime).slice(0, n)
}

export function readLog(logDir: string, name: string): string | null {
  if (!/^[A-Za-z0-9_.-]+\.log$/.test(name)) return null
  try { return readFileSync(join(logDir, name), 'utf8').slice(-200_000) } catch { return null }
}
