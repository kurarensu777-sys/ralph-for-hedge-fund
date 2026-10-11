import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * REMOTE - the owner's phone driving a repo, through `claude remote-control`.
 *
 * `claude remote-control` is a standalone SERVER for one DIRECTORY: it holds a bridge to
 * claude.ai and spawns each incoming session itself. So fundd owns at most ONE bridge per repo of
 * repos.json, started and stopped from System > Remote. Ported from the old cockpit's
 * server/remote.ts (2026-09-24); the parser keys off the bridge's own output, never an exit code.
 *
 * THE LAW HAS TO BE IN THE ROOM. Measured 2026-09-24 on CLI 2.1.281: `remote-control` accepts no
 * `--settings`, and a `--settings` before the verb is REFUSED ("is not carried over to the
 * sessions Remote Control starts"). So a bridge's sessions load only the settings their own cwd
 * finds. At the fund root that is <fund>/.claude/settings.json - the deny list, the whole gate.
 * A sub-repo under repos/ is its own workspace and would run WITHOUT the deny list, so its bridge
 * is BLOCKED here, with the reason on the row, rather than started with the rails off.
 */

export type RemoteStatus = 'off' | 'starting' | 'connecting' | 'connected' | 'error'
export type Bridge = {
  repo: string
  path: string
  allowed: boolean
  blocked: string | null         // why this repo cannot have a bridge
  running: boolean
  status: RemoteStatus
  name: string | null
  pid: number | null
  url: string | null             // claude.ai/code?environment=... - the phone's door
  sessions: number
  capacity: number
  error: string | null
  since: number | null
  tail: string[]
}
type Live = { child: ChildProcess | null; state: Bridge }

const ANSI = /\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g

/** the claude CLI as a real executable (no shell: a shell wrapper would survive a kill) */
export function claudeBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.CLAUDE_CLI
  if (explicit && existsSync(explicit)) return explicit
  const home = homedir()
  const appdata = env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const cands = process.platform === 'win32'
    ? [join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), join(home, 'AppData', 'Local', 'claude', 'claude.exe'), join(home, '.local', 'bin', 'claude.exe')]
    : [join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
  return cands.find(c => existsSync(c)) ?? null
}

/** does `claude remote-control --help` output describe the verb? (an unknown verb prints the
 *  top-level help or an error, which never carries the verb's own usage line) */
export function helpSaysAvailable(out: string, code: number): boolean {
  return /claude remote-control \[options\]/i.test(out) || (code === 0 && /^Remote Control\b/im.test(out))
}

/** may this repo carry a bridge? Only where the fund's deny list loads by itself: the fund root */
export function lawFor(repoPath: string, fundRoot: string): { allowed: boolean; blocked: string | null } {
  const abs = resolve(fundRoot, repoPath)
  const norm = (p: string) => resolve(p).toLowerCase().replace(/[\\/]+$/, '')
  if (norm(abs) === norm(fundRoot)) {
    return existsSync(join(fundRoot, '.claude', 'settings.json'))
      ? { allowed: true, blocked: null }
      : { allowed: false, blocked: '.claude/settings.json is missing at the fund root: no deny list to carry' }
  }
  return { allowed: false, blocked: 'own workspace: remote-control cannot carry the fund deny list (--settings is refused), so its sessions would run without it' }
}

/** fold one chunk of the bridge's output into its state; returns true when something visible moved */
export function absorb(s: Bridge, chunk: string): boolean {
  const before = `${s.status}|${s.url}|${s.sessions}|${s.capacity}|${s.error}`
  for (const raw of chunk.replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (s.tail[s.tail.length - 1] !== line) { s.tail.push(line); if (s.tail.length > 40) s.tail.splice(0, s.tail.length - 40) }
    const env = line.match(/Environment ID:\s*(env_[A-Za-z0-9]+)/) ?? line.match(/claude\.ai\/code\?environment=(env_[A-Za-z0-9]+)/)
    if (env) s.url = `https://claude.ai/code?environment=${env[1]}`
    const settled = /(^|\s)(Ready|Connected)(\s|$)/.test(line) || /^·[^·]*✔/.test(line)
    if (settled && s.status !== 'error') s.status = 'connected'
    else if (/(^|\s)Connecting(\s|$)/.test(line) && s.status !== 'connected' && s.status !== 'error') s.status = 'connecting'
    const cap = line.match(/Capacity:\s*(\d+)\s*\/\s*(\d+)/)
    if (cap) { s.sessions = Number(cap[1]); s.capacity = Number(cap[2]) }
    const why = /Remote Control is not yet enabled for your account/i.test(line) ? 'not enabled on this account: re-login to refresh entitlements'
      : /not available inside a cloud session/i.test(line) ? 'cannot run inside a cloud session'
      : /disableRemoteControl|Remote Control is disabled/i.test(line) ? 'disabled by managed settings'
      : /^Error:/i.test(line) ? line.slice(0, 300) : null
    if (why) { s.status = 'error'; s.error = why }
  }
  return before !== `${s.status}|${s.url}|${s.sessions}|${s.capacity}|${s.error}`
}

export type RemoteDeps = {
  fundRoot: string
  stateFile: string                                // where running bridges are written down (reap / re-raise)
  repos: () => { id: string; path: string }[]
  env: () => Record<string, string | undefined>    // the scrubbed agent env
  onChange: () => void
  log: (msg: string) => void
  killTree: (pid: number) => Promise<unknown>
  bin?: () => string | null
}

const off = (repo: string, path: string, law: { allowed: boolean; blocked: string | null }): Bridge => ({
  repo, path, allowed: law.allowed, blocked: law.blocked, running: false, status: 'off', name: null, pid: null, url: null,
  sessions: 0, capacity: 0, error: null, since: null, tail: [],
})

export class Remote {
  private live = new Map<string, Live>()
  private probe: { at: number; available: boolean; reason: string | null; version: string | null } | null = null
  private account: { at: number; loggedIn: boolean; plan: string | null } | null = null
  constructor(private d: RemoteDeps) {}

  private bin() { return (this.d.bin ?? claudeBin)() }

  /** does this CLI have `remote-control`? `--help` exits 0 and names it; cached 10 minutes */
  async availability(): Promise<{ available: boolean; reason: string | null; version: string | null; bin: string | null }> {
    const bin = this.bin()
    if (!bin) return { available: false, reason: 'claude CLI not found (set CLAUDE_CLI)', version: null, bin: null }
    if (!this.probe || Date.now() - this.probe.at > 600_000) {
      // measured 2026-09-24 on 2.1.281: `remote-control --help` prints its usage and then does NOT
      // exit, so the timeout kills it; the verdict is the usage text, never the exit code
      const help = await run(bin, ['remote-control', '--help'], 8_000)
      const ver = await run(bin, ['--version'], 20_000)
      const ok = helpSaysAvailable(help.out, help.code)
      this.probe = { at: Date.now(), available: ok, reason: ok ? null : `claude remote-control --help: ${help.out.trim().split(/\r?\n/)[0] || `exit ${help.code}`}`, version: ver.code === 0 ? ver.out.trim().split(/\s+/)[0] : null }
    }
    return { available: this.probe.available, reason: this.probe.reason, version: this.probe.version, bin }
  }

  /** logged in, and on which plan; never the email (no person's name or address on a page) */
  async whoami(): Promise<{ loggedIn: boolean; plan: string | null } | null> {
    const bin = this.bin()
    if (!bin) return null
    if (!this.account || Date.now() - this.account.at > 300_000) {
      const r = await run(bin, ['auth', 'status', '--json'], 20_000)
      let loggedIn = false, plan: string | null = null
      try { const j = JSON.parse(r.out.slice(r.out.indexOf('{'))); loggedIn = !!j.loggedIn; plan = j.subscriptionType ?? j.authMethod ?? null } catch { /* not logged in or no JSON */ }
      this.account = { at: Date.now(), loggedIn, plan }
    }
    return { loggedIn: this.account.loggedIn, plan: this.account.plan }
  }

  list(): Bridge[] {
    return this.d.repos().map(r => {
      const law = lawFor(r.path, this.d.fundRoot)
      const l = this.live.get(r.id)
      return l ? { ...l.state, path: r.path, allowed: law.allowed, blocked: law.blocked, tail: [...l.state.tail] } : off(r.id, r.path, law)
    })
  }

  start(repoId: string, name?: string): Bridge {
    const repo = this.d.repos().find(r => r.id === repoId)
    if (!repo) throw Object.assign(new Error(`no repo ${repoId} in repos.json`), { status: 404 })
    const law = lawFor(repo.path, this.d.fundRoot)
    if (!law.allowed) throw Object.assign(new Error(`${repoId}: ${law.blocked}`), { status: 409 })
    const cur = this.live.get(repoId)
    if (cur?.child) return this.list().find(b => b.repo === repoId)!
    const bin = this.bin()
    if (!bin) throw Object.assign(new Error('claude CLI not found'), { status: 503 })
    const nm = (name || `fund-${repoId}`).replace(/[^\w.-]/g, '-').slice(0, 60)
    const state: Bridge = { ...off(repoId, repo.path, law), running: true, status: 'starting', name: nm, since: Date.now() }
    const live: Live = { child: null, state }
    this.live.set(repoId, live)
    // no --permission-mode: the settings file at the cwd decides, the same law as every other hand
    let child: ChildProcess
    try {
      child = spawn(bin, ['remote-control', '--name', nm], {
        cwd: resolve(this.d.fundRoot, repo.path), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...this.d.env(), FORCE_COLOR: '0', NO_COLOR: '1' } as NodeJS.ProcessEnv,
      })
    } catch (e: any) {
      state.running = false; state.status = 'error'; state.error = `cannot start the CLI: ${e?.message ?? e}`
      this.d.onChange(); return { ...state }
    }
    live.child = child
    state.pid = child.pid ?? null
    const feed = (b: Buffer) => { if (absorb(state, b.toString('utf8'))) this.d.onChange() }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', e => { state.status = 'error'; state.error = `cannot start the CLI: ${e.message}`; state.running = false; live.child = null; this.save(); this.d.onChange() })
    child.on('exit', (code, signal) => {
      if (live.child !== child) return
      live.child = null
      state.running = false; state.pid = null
      if (state.status !== 'error' && (code || signal)) {
        state.status = 'error'
        state.error = `the bridge exited (${signal ?? `code ${code}`})${state.tail.length ? ` - ${state.tail[state.tail.length - 1]}` : ''}`
      } else if (state.status !== 'error') state.status = 'off'
      this.d.log(`remote ${repoId}: exited ${signal ?? code}`)
      this.save(); this.d.onChange()
    })
    this.d.log(`remote ${repoId}: started ${nm} (pid ${child.pid})`)
    this.save(); this.d.onChange()
    return { ...state }
  }

  async stop(repoId: string): Promise<Bridge | undefined> {
    const l = this.live.get(repoId)
    if (l) {
      const c = l.child
      l.child = null
      this.live.delete(repoId)
      if (c?.pid) await this.d.killTree(c.pid)
      this.d.log(`remote ${repoId}: stopped`)
      this.save(); this.d.onChange()
    }
    return this.list().find(b => b.repo === repoId)
  }

  async stopAll() { for (const id of [...this.live.keys()]) await this.stop(id) }

  /** fundd is going away: take every bridge with it (sync, so it runs inside process 'exit') */
  killAllSync() {
    for (const l of this.live.values()) {
      const pid = l.child?.pid
      if (!pid) continue
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      else { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    }
  }

  /** running bridges, written down so the next fundd can reap orphans and re-raise them */
  private save() {
    const rows = [...this.live.values()].filter(l => l.child?.pid).map(l => ({ repo: l.state.repo, name: l.state.name, pid: l.child!.pid }))
    try { writeFileSync(this.d.stateFile, JSON.stringify({ at: Date.now(), bridges: rows }, null, 2)) } catch { /* data dir gone */ }
  }

  /** at boot: kill any bridge a previous fundd left behind (only if it is still claude), then raise it again */
  async resume(opts: { raise: boolean }) {
    let prev: { repo: string; name: string | null; pid: number }[] = []
    try { prev = JSON.parse(readFileSync(this.d.stateFile, 'utf8')).bridges ?? [] } catch { return }
    for (const b of prev) {
      if (b.pid && await isClaude(b.pid)) { await this.d.killTree(b.pid); this.d.log(`remote ${b.repo}: reaped orphan pid ${b.pid}`) }
    }
    this.save()
    if (!opts.raise) return
    for (const b of prev) { try { this.start(b.repo, b.name ?? undefined) } catch (e: any) { this.d.log(`remote ${b.repo}: not re-raised - ${e.message}`) } }
  }
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise(res => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, env: { ...process.env, FORCE_COLOR: '0' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
      res({ code, out: String(stdout) + String(stderr) })
    })
  })
}

async function isClaude(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') { try { process.kill(pid, 0); return true } catch { return false } }
  const r = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 8000)
  return /^"claude(\.exe)?"/im.test(r.out.trim())
}
